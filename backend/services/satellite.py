"""Satellite check: compare what satellites see now with the historical baseline and the model.

  now       Sentinel-1 RTC radar (sees through cloud, the key sensor in monsoon) water mask
            VV backscatter < -18 dB, and the latest low-cloud Sentinel-2 L2A NDWI > 0.
  baseline  JRC Global Surface Water occurrence 1984-2021 (>= 50 % = normally water).
  model     the user's latest run for this dam (maximum flood extent).

From these it reports: reservoir water-spread area now vs baseline vs the NRLD full-supply area,
a satellite-implied storage (via the same stage-storage power law the model uses), water outside
the normal channel downstream ("new water"), and how well the model's extent matches it.
Feeding the satellite storage back into the model shows whether the prediction changes.
"""
import io
import math
from datetime import date, timedelta

import numpy as np
from PIL import Image

from services import dem, pc

S1_DB = -18.0
NDWI = 0.0


def _aoi(dam, site, reach_km):
    """Grid covering the reservoir (upstream of the dam) and the downstream reach."""
    lats = [dam["lat"]] + [p[0] for p in site["river_path"]]
    lngs = [dam["lng"]] + [p[1] for p in site["river_path"]]
    area = dam.get("reservoir_area_km2") or 2.0
    # Reservoirs are often long and narrow, so look well beyond a circle of the same area.
    r_res = max(4000.0, 4.0 * math.sqrt(area * 1e6 / math.pi))
    lat_c, lng_c = (min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2
    m_lng = 111_320.0 * math.cos(math.radians(lat_c))
    half_w = (max(lngs) - min(lngs)) / 2 * m_lng + r_res
    half_h = (max(lats) - min(lats)) / 2 * dem.M_PER_DEG_LAT + r_res
    cell = max(20.0, math.sqrt(4 * half_w * half_h / 90_000))
    return dem.grid_around(lat_c, lng_c, half_w, half_h, cell), r_res


def _bbox(grid):
    s, w, n, e = grid.bounds()
    return (w, s, e, n)


def _latest(collection, bbox, days, query=None):
    since = (date.today() - timedelta(days=days)).isoformat()
    return pc.search(collection, bbox, datetime=f"{since}/{date.today()}", query=query, limit=6)


def _same_day(items):
    """Items acquired on the newest date (one pass can span several tiles)."""
    if not items:
        return []
    day = items[0]["properties"]["datetime"][:10]
    return [i for i in items if i["properties"]["datetime"][:10] == day]


def _component(mask, seed_j, seed_i, radius_cells):
    """Connected water body containing (or nearest to) the seed, limited to a radius."""
    ny, nx = mask.shape
    jj, ii = np.ogrid[:ny, :nx]
    near = (jj - seed_j) ** 2 + (ii - seed_i) ** 2 <= radius_cells ** 2
    m = mask & near
    if not m.any():
        return m
    cand = np.argwhere(m)
    d = (cand[:, 0] - seed_j) ** 2 + (cand[:, 1] - seed_i) ** 2
    sj, si = cand[np.argmin(d)]
    out = np.zeros_like(m)
    stack = [(sj, si)]
    out[sj, si] = True
    while stack:
        j, i = stack.pop()
        for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            y, x = j + dj, i + di
            if 0 <= y < ny and 0 <= x < nx and m[y, x] and not out[y, x]:
                out[y, x] = True
                stack.append((y, x))
    return out


def compare(dam, site, reach_km, model_hmax=None, model_grid=None, stage_exponent=2.5):
    grid, r_res = _aoi(dam, site, reach_km)
    bbox = _bbox(grid)
    size = (grid.nx, grid.ny)
    cell_km2 = grid.cell ** 2 / 1e6
    out = {"grid": grid.to_dict(), "layers": {}, "notes": []}

    # Baseline: JRC occurrence.
    jrc = pc.search("jrc-gsw", bbox, limit=4, sort_field="datetime")
    occ, occ_valid, _ = pc.read_mosaic("jrc-gsw", jrc, bbox, size, assets=["occurrence"],
                                       extra={"resampling": "nearest"})
    occ = np.where(occ_valid, occ[0], 0)
    baseline = occ >= 50
    ever = occ > 0

    # Now: Sentinel-1 radar (last 24 days), newest pass.
    s1_items = _same_day(_latest("sentinel-1-rtc", bbox, 24))
    s1_water = None
    if s1_items:
        vv, vv_valid, used = pc.read_mosaic("sentinel-1-rtc", s1_items, bbox, size, assets=["vv"])
        if vv is not None and vv_valid.mean() > 0.5:
            db = 10 * np.log10(np.clip(vv[0], 1e-6, None))
            # 3x3 median to suppress speckle before thresholding.
            pad = np.pad(db, 1, mode="edge")
            stack = np.stack([pad[1 + a:1 + a + db.shape[0], 1 + b:1 + b + db.shape[1]]
                              for a in (-1, 0, 1) for b in (-1, 0, 1)])
            s1_water = (np.median(stack, axis=0) < S1_DB) & vv_valid
            out["sentinel1"] = {"date": s1_items[0]["properties"]["datetime"][:16].replace("T", " ") + " UTC",
                                "items": [i["id"] for i in used], "coverage": round(float(vv_valid.mean()), 2)}
    if s1_water is None:
        out["notes"].append("No Sentinel-1 radar pass over this area in the last 24 days.")

    # Now: Sentinel-2 optical (last 45 days, < 40 % cloud), newest date.
    s2_items = _same_day(_latest("sentinel-2-l2a", bbox, 45, {"eo:cloud_cover": {"lt": 40}}))
    s2_water = None
    if s2_items:
        nd, nd_valid, used = pc.read_mosaic("sentinel-2-l2a", s2_items, bbox, size,
                                            expression="(B03_b1-B08_b1)/(B03_b1+B08_b1)")
        if nd is not None and nd_valid.mean() > 0.5:
            s2_water = (nd[0] > NDWI) & nd_valid
            out["sentinel2"] = {"date": s2_items[0]["properties"]["datetime"][:10],
                                "cloud_pct": round(s2_items[0]["properties"]["eo:cloud_cover"], 1),
                                "items": [i["id"] for i in used], "coverage": round(float(nd_valid.mean()), 2)}
    if s2_water is None:
        out["notes"].append("No usable Sentinel-2 image (cloud under 40 %) in the last 45 days.")

    now = s1_water if s1_water is not None else s2_water
    sensor = "Sentinel-1 radar" if s1_water is not None else "Sentinel-2 optical" if s2_water is not None else None
    out["now_sensor"] = sensor

    # Reservoir: the water body at the dam.
    dj, di = grid.ij(dam["lat"], dam["lng"])[::-1]
    radius = int(r_res / grid.cell)
    res_base = _component(baseline, dj, di, radius)
    base_km2 = float(res_base.sum() * cell_km2)
    # Full extent: water seen at least 5 % of the time since 1984, same window, connected to the dam.
    res_full = _component(occ >= 5, dj, di, radius)
    full_km2 = float(res_full.sum() * cell_km2)
    res = {"baseline_km2": round(base_km2, 2), "full_extent_km2": round(full_km2, 2),
           "nrld_full_km2": dam.get("reservoir_area_km2")}
    if now is not None:
        res_now = _component(now, dj, di, radius)
        now_km2 = float(res_now.sum() * cell_km2)
        res["now_km2"] = round(now_km2, 2)
        if full_km2 > 0 and now_km2 > 0:
            # A ~ h^(m-1), S ~ h^m  =>  S/S_full = (A/A_full)^(m/(m-1)). Both areas come from the same
            # window, so a reservoir longer than the window affects both equally.
            m = stage_exponent
            frac = min(1.2, (now_km2 / full_km2) ** (m / (m - 1)))
            res["implied_storage_pct"] = round(100 * frac, 1)
            res["vs_usual_pct"] = round(100 * now_km2 / base_km2, 1) if base_km2 else None
            res["method"] = (f"Water-spread now {now_km2:.2f} km² vs historical full extent {full_km2:.2f} km² "
                             f"(JRC 1984-2021), stage-storage exponent {m:.2f}. Radar can miss water in steep, "
                             "shadowed valleys and under vegetation, so treat this as an estimate.")
            nrld = dam.get("reservoir_area_km2")
            if nrld and full_km2 < 0.5 * nrld:
                out["notes"].append(f"Only {full_km2:.1f} km² of the registered {nrld:g} km² reservoir falls in "
                                    "the satellite window or has been seen as water; storage is estimated "
                                    "from the part that is visible.")
        if s2_water is not None and s1_water is not None:
            both = float((_component(s2_water, dj, di, radius)).sum() * cell_km2)
            res["sentinel2_km2"] = round(both, 2)
    out["reservoir"] = res

    # Downstream: water that is not normally there.
    downstream = np.zeros(baseline.shape, bool)
    for p in site["river_path"]:
        i, j = grid.ij(p[0], p[1])
        r = max(2, int(1500 / grid.cell))
        downstream[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1] = True
    if now is not None:
        new = now & ~ever & downstream
        out["downstream"] = {"new_water_km2": round(float(new.sum() * cell_km2), 2),
                             "normal_water_km2": round(float((baseline & downstream).sum() * cell_km2), 2)}
        if model_hmax is not None and model_grid is not None:
            lat_c, lng_c = grid.cell_latlng()
            mi = np.round((model_grid.xy(lat_c, lng_c)[0] - model_grid.x0) / model_grid.cell).astype(int)
            mj = np.round((model_grid.xy(lat_c, lng_c)[1] - model_grid.y0) / model_grid.cell).astype(int)
            inside = (mi >= 0) & (mi < model_grid.nx) & (mj >= 0) & (mj < model_grid.ny)
            pred = np.zeros(baseline.shape, bool)
            pred[inside] = model_hmax[mj[inside], mi[inside]] > 0.1
            pred &= ~baseline
            hit = float((pred & new).sum())
            out["model_check"] = {
                "predicted_km2": round(float(pred.sum() * cell_km2), 2),
                "observed_new_km2": round(float(new.sum() * cell_km2), 2),
                "overlap_km2": round(hit * cell_km2, 2),
                "observed_captured_pct": round(100 * hit / new.sum(), 1) if new.sum() else None,
                "note": "The model shows a hypothetical dam-break flood. Observed new water comes from "
                        "today's river and rain. A large overlap means the flood path already carries water.",
            }
        change = np.zeros(baseline.shape + (4,), np.uint8)
        change[baseline & now] = (27, 108, 168, 200)       # normal water, still there
        change[now & ~ever] = (215, 48, 39, 225)           # new water
        change[now & ever & ~baseline] = (120, 190, 230, 200)  # seasonal water present now
        change[baseline & ~now] = (240, 180, 40, 210)      # normally wet, dry now
        out["layers"]["change"] = _png(change)
    base_img = np.zeros(baseline.shape + (4,), np.uint8)
    base_img[baseline] = (27, 108, 168, 200)
    out["layers"]["baseline"] = _png(base_img)
    return out


def _png(rgba):
    im = Image.fromarray(rgba[::-1], "RGBA")
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()
