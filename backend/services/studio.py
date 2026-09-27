"""Dam studio: orchestrates a full inundation run for any catalogue dam and user inputs.

  dam + inputs -> terrain analysis (outlet, river path, catchment)
               -> reservoir routing (rainfall inflow, spillway, overtopping, breach hydrograph)
               -> 2D flood routing on the real DEM with land-cover friction
               -> OpenStreetMap exposure (buildings, shops, facilities, towns, roads)
               -> Sentinel-2 true-colour drape for the 3D view

Runs execute in a background thread; the app polls status. Results are cached on disk under
cache/runs/ keyed by a hash of the inputs, so the same scenario opens instantly next time.
"""
import base64
import hashlib
import io
import json
import math
import threading
import time
import traceback
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from PIL import Image

from services import dem, exposure, flood2d, hydro, pc

RUNS_DIR = Path(__file__).resolve().parent.parent / "cache" / "runs"
MAX_CELLS = 55_000
SCENE_MAX_FLOODED = 4000        # flooded buildings sent to the 3D view
SCENE_CONTEXT_BUILDINGS = 1500  # plus a sample of dry ones for context
RUNS = {}
_lock = threading.Lock()
_slots = threading.Semaphore(2)  # flood runs are CPU-heavy; queue the rest


def run_key(params):
    blob = json.dumps(params, sort_keys=True, default=str)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def _b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


# ------------------------------------------------------------------ run lifecycle

def start(params):
    rid = run_key(params)
    with _lock:
        if rid in RUNS and RUNS[rid]["status"] in ("running", "done"):
            return rid
        if (RUNS_DIR / f"{rid}.json").exists():
            RUNS[rid] = {"status": "done", "progress": 1.0, "stage": "done", "params": params}
            return rid
        RUNS[rid] = {"status": "running", "progress": 0.0, "stage": "Starting", "params": params,
                     "started": time.time()}
    threading.Thread(target=_execute, args=(rid, params), daemon=True).start()
    return rid


def status(rid):
    r = RUNS.get(rid)
    if r is None and (RUNS_DIR / f"{rid}.json").exists():
        r = RUNS[rid] = {"status": "done", "progress": 1.0, "stage": "done"}
    if r is None:
        return None
    out = {"run_id": rid, "status": r["status"], "progress": round(r["progress"], 3), "stage": r["stage"],
           "impacts_progress": r.get("impacts_progress")}
    if r["status"] == "done":
        out["summary"] = _load_json(rid)
    if r["status"] == "error":
        out["error"] = r.get("error")
    return out


def _set(rid, progress, stage):
    RUNS[rid]["progress"], RUNS[rid]["stage"] = progress, stage


def _load_json(rid):
    return json.loads((RUNS_DIR / f"{rid}.json").read_text())


def _load_arrays(rid):
    return np.load(RUNS_DIR / f"{rid}.npz")


# ------------------------------------------------------------------ the run itself

def _domain(path, reach_km):
    lats = [p[0] for p in path]
    lngs = [p[1] for p in path]
    lat_c, lng_c = (min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2
    buf = min(5000.0, max(2500.0, 1500 + 100 * reach_km))
    m_lng = 111_320.0 * math.cos(math.radians(lat_c))
    half_w = (max(lngs) - min(lngs)) / 2 * m_lng + buf
    half_h = (max(lats) - min(lats)) / 2 * dem.M_PER_DEG_LAT + buf
    cell = max(30.0, math.sqrt(4 * half_w * half_h / MAX_CELLS))
    return dem.grid_around(lat_c, lng_c, half_w, half_h, cell)


def _landcover_n(grid):
    s, w, n, e = grid.bounds()
    try:
        items = pc.search("esa-worldcover", (w, s, e, n), limit=4, sort_field="datetime")
        data, valid, _ = pc.read_mosaic("esa-worldcover", items, (w, s, e, n), (grid.nx, grid.ny),
                                        assets=["map"], extra={"resampling": "nearest"})
        cls = np.where(valid, data[0], 30).astype(int)
        lut = np.full(256, 0.05)
        for k, v in flood2d.N_BY_LANDCOVER.items():
            lut[k] = v
        return lut[cls], cls.astype(np.uint8), "ESA WorldCover 10 m (2021)"
    except Exception as e:  # land cover is a refinement; fall back to one value
        return np.full((grid.ny, grid.nx), 0.05), None, f"uniform n = 0.05 ({type(e).__name__})"


def _true_colour(grid):
    s, w, n, e = grid.bounds()
    since = (date.today() - timedelta(days=365)).isoformat()
    try:
        items = pc.search("sentinel-2-l2a", (w, s, e, n), datetime=f"{since}/{date.today()}",
                          query={"eo:cloud_cover": {"lt": 15}}, sort="asc", sort_field="eo:cloud_cover", limit=6)
        data, valid, used = pc.read_mosaic("sentinel-2-l2a", items, (w, s, e, n), (grid.nx, grid.ny),
                                           assets=["visual"])
        if data is None or valid.mean() < 0.6:
            return None, None
        rgb = np.clip(data[:3].transpose(1, 2, 0), 0, 255).astype(np.uint8)
        rgb[~valid] = 110
        return rgb, {"items": [u["id"] for u in used],
                     "dates": sorted({u["properties"]["datetime"][:10] for u in used})}
    except Exception:
        return None, None


def _burn_channel(z, grid, path, depth=2.0):
    """Lower the DEM along the river path: SRTM records the water surface, not the bed."""
    z = z.copy()
    for a, b in zip(path, path[1:]):
        (i0, j0), (i1, j1) = grid.ij(a[0], a[1]), grid.ij(b[0], b[1])
        steps = max(abs(i1 - i0), abs(j1 - j0), 1)
        for k in range(steps + 1):
            i = round(i0 + (i1 - i0) * k / steps)
            j = round(j0 + (j1 - j0) * k / steps)
            if 0 <= i < grid.nx and 0 <= j < grid.ny:
                z[j, i] -= depth
    return z


def _execute(rid, p):
    _set(rid, 0.0, "Waiting for a free model slot")
    with _slots:
        _run(rid, p)


def _run(rid, p):
    try:
        _set(rid, 0.02, "Analysing terrain and river path")
        site = hydro.analyse_site(p["lat"], p["lng"], float(p["reach_km"]), float(p["height_m"]),
                                  p.get("location_is") == "lake_centre", float(p.get("reservoir_area_km2") or 0))
        catchment = p.get("catchment_km2") or site["catchment_km2"]

        _set(rid, 0.08, "Routing rainfall through the reservoir")
        rain_series = None
        if p.get("rain_source") == "live":
            try:
                live = hydro.rainfall(p["lat"], p["lng"])
                k = live["now_index"]
                rain_series = live["mm"][max(0, k - int(p["rain_hours"])):k] if p.get("rain_window") == "past" \
                    else live["mm"][k:k + int(p["rain_hours"])]
            except Exception:
                rain_series = None
        routing = hydro.route_reservoir({**p, "catchment_km2": catchment, "dam_type": p.get("type", "")},
                                        rain_series)
        q = routing.pop("_q_down")
        dt_in = routing.pop("_dt")

        # Start the flood clock shortly before water starts leaving in earnest.
        peak = float(q.max())
        if peak < 1.0:
            first = 0
        else:
            first = int(np.argmax(q > 0.05 * peak))
            if routing["breach_at_h"] is not None:
                first = min(first, int(routing["breach_at_h"] * 3600 / dt_in))
        start_i = max(0, first - int(1200 / dt_in))
        t0_h = start_i * dt_in / 3600
        inflow = q[start_i:]

        _set(rid, 0.12, "Loading elevation and land cover")
        grid = _domain(site["river_path"], float(p["reach_km"]))
        z, dem_src = dem.elevation(grid)
        n_man, lc, lc_src = _landcover_n(grid)
        zb = _burn_channel(z, grid, site["river_path"])
        # Line source: the valley cells along the first stretch below the breach, so the outflow
        # enters the channel instead of piling onto one cell.
        sources = set()
        for pt in site["river_path"]:
            if pt[2] * 1000 > max(3 * grid.cell, 600):
                break
            ci, cj = grid.ij(pt[0], pt[1])
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    if 1 <= ci + di < grid.nx - 1 and 1 <= cj + dj < grid.ny - 1:
                        sources.add((cj + dj, ci + di))
        sources = sorted(sources)

        _set(rid, 0.18, "Simulating the flood wave")
        duration = float(p["flood_hours"]) * 3600
        sim = flood2d.simulate(zb, n_man, grid.cell, inflow, dt_in, sources, duration,
                               snap_s=max(120.0, duration / 48), max_level=site["pool_elevation_m"],
                               progress=lambda f: _set(rid, 0.18 + 0.62 * f, "Simulating the flood wave"))
        hazard = flood2d.hazard_class(sim["hmax"], sim["vmax"])

        _set(rid, 0.82, "Draping satellite imagery")
        rgb, rgb_src = _true_colour(grid)

        wet = sim["hmax"] > flood2d.WET
        area_km2 = float(wet.sum() * grid.cell ** 2 / 1e6)
        arrivals = sim["arrival_min"]
        summary = {
            "run_id": rid,
            "params": p,
            "site": site,
            "catchment_used_km2": catchment,
            "routing": routing,
            "flood": {
                "start_offset_h": round(t0_h, 2),
                "duration_h": p["flood_hours"],
                "times_min": sim["times_min"],
                "inundated_km2": round(area_km2, 2),
                "max_depth_m": round(float(sim["hmax"].max()), 2),
                "max_speed_mps": round(float(sim["vmax"].max()), 2),
                "hazard_km2": {name: round(float((hazard == k).sum() * grid.cell ** 2 / 1e6), 2)
                               for k, name in ((1, "low"), (2, "moderate"), (3, "significant"), (4, "extreme"))},
                "reach_end_arrival_min": _arrival_at(grid, arrivals, site["river_path"][-1]),
                "volume": {k: sim[k] for k in ("volume_in_mm3", "volume_out_mm3", "volume_left_mm3",
                                               "volume_waiting_mm3")},
                "solver": {"steps": sim["steps"], "wall_s": sim["wall_s"], "cell_m": round(grid.cell, 1),
                           "cells": grid.nx * grid.ny, "scheme": "local-inertial 2D (LISFLOOD-FP)"},
            },
            "impacts": {},
            "impacts_status": "pending" if wet.any() else "done",
            "towns": [],
            "sources": {
                "dem": dem_src, "landcover": lc_src,
                "imagery": rgb_src, "osm": "", "osm_note": None,
                "rainfall": "Open-Meteo" if p.get("rain_source") == "live" else "User input",
            },
            "grid": grid.to_dict(),
            "created": time.strftime("%Y-%m-%d %H:%M"),
        }
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            RUNS_DIR / f"{rid}.npz",
            z=z.astype(np.float32), frames=np.array(sim["frames"], dtype=np.uint8),
            hmax=sim["hmax"].astype(np.float32), vmax=sim["vmax"].astype(np.float32),
            arrival=arrivals.astype(np.float32), hazard=hazard,
            rgb=rgb if rgb is not None else np.zeros((0,), np.uint8),
            landcover=lc if lc is not None else np.zeros((0,), np.uint8),
        )
        (RUNS_DIR / f"{rid}.osm.json").write_text(json.dumps(
            {"buildings": [], "pois": [], "places": [], "roads": []}))
        (RUNS_DIR / f"{rid}.json").write_text(json.dumps(summary, default=_jsonable))
        _set(rid, 1.0, "done")
        RUNS[rid]["status"] = "done"
        if wet.any():
            # Buildings and shops can take a while on the public Overpass server; the flood
            # result is already usable, so load them afterwards and update the saved summary.
            _exposure(rid, grid, sim["hmax"], arrivals)
    except Exception as e:
        traceback.print_exc()
        RUNS[rid].update(status="error", error=f"{type(e).__name__}: {e}")


def _wet_tiles(grid, wet, tile_m=1500.0, pad_m=300.0):
    """Small boxes (s, w, n, e) covering the flooded cells plus a margin."""
    k = max(1, int(tile_m / grid.cell))
    boxes = []
    for j0 in range(0, grid.ny, k):
        for i0 in range(0, grid.nx, k):
            if wet[j0:j0 + k, i0:i0 + k].any():
                s, w = grid.latlng(grid.x0 + i0 * grid.cell - pad_m, grid.y0 + j0 * grid.cell - pad_m)
                n, e = grid.latlng(grid.x0 + (i0 + k) * grid.cell + pad_m, grid.y0 + (j0 + k) * grid.cell + pad_m)
                boxes.append((s, w, n, e))
    return boxes


def _exposure(rid, grid, hmax, arrival):
    RUNS.setdefault(rid, {"status": "done", "progress": 1.0, "stage": "done"})["impacts_progress"] = 0.0
    status = "done"
    data = {"buildings": [], "pois": [], "places": [], "roads": [], "notes": []}
    counts, towns = {}, []
    try:
        data = exposure.fetch(_wet_tiles(grid, hmax > flood2d.WET),
                              progress=lambda f: RUNS[rid].__setitem__("impacts_progress", round(f, 3)))
        counts, towns = exposure.assess(data, grid, hmax, arrival)
        if data["notes"]:
            status = "partial"
        if data.get("buildings_capped"):
            data["notes"].append(f"Building footprints capped at {exposure.MAX_BUILDINGS}; counts are a lower bound.")
    except Exception as e:
        status = "error"
        data["notes"].append(str(e))
    summary = _load_json(rid)
    summary.update(impacts=counts, towns=towns[:40], impacts_status=status)
    summary["sources"]["osm"] = data.get("source", "")
    summary["sources"]["osm_note"] = " ".join(data["notes"]) or None
    (RUNS_DIR / f"{rid}.osm.json").write_text(json.dumps(data))
    (RUNS_DIR / f"{rid}.json").write_text(json.dumps(summary, default=_jsonable))
    RUNS[rid]["impacts_progress"] = 1.0


def _jsonable(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(type(o))


def _arrival_at(grid, arrival, pt):
    i, j = grid.ij(pt[0], pt[1])
    r = 2
    win = arrival[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1]
    got = win[win >= 0]
    return round(float(got.min()), 1) if got.size else None


# ------------------------------------------------------------------ outputs for the app

def _grid_of(summary):
    g = summary["grid"]
    return dem.Grid(g["origin"][0], g["origin"][1], g["x0"], g["y0"], g["cell_m"], g["nx"], g["ny"])


def scene(rid):
    """Everything the 3D view needs, packed compactly (base64 typed arrays)."""
    summary = _load_json(rid)
    a = _load_arrays(rid)
    grid = _grid_of(summary)
    osm = json.loads((RUNS_DIR / f"{rid}.osm.json").read_text())
    z = a["z"]
    zmin = float(z.min())
    arrival = a["arrival"]
    arr16 = np.where(arrival >= 0, np.minimum(arrival, 65534), 65535).astype(np.uint16)

    def local(lat, lng):
        x, y = grid.xy(lat, lng)
        return [round(x, 1), round(y, 1)]

    near = [b for b in osm["buildings"] if b["depth_m"] > 0.05]
    rest = [b for b in osm["buildings"] if b["depth_m"] <= 0.05]
    rest = rest[::max(1, len(rest) // max(1, SCENE_CONTEXT_BUILDINGS))][:SCENE_CONTEXT_BUILDINGS]
    buildings = [{"xy": [local(la, ln) for la, ln in (b["ring"][:-1] or b["ring"])], "kind": b["kind"],
                  "h": b["height_m"], "d": b["depth_m"], "a": b["arrival_min"], "name": b["name"]}
                 for b in near[:SCENE_MAX_FLOODED] + rest]
    return {
        "grid": summary["grid"],
        "zmin": zmin,
        "z_dm": _b64(np.round((z - zmin) * 10).astype(np.uint16)),     # decimetres above zmin
        "rgb": _b64(a["rgb"]) if a["rgb"].size else None,
        "frames": [_b64(f) for f in a["frames"]],
        "times_min": summary["flood"]["times_min"],
        "hmax": _b64(flood2d.depth_code(a["hmax"])),
        "arrival_min": _b64(arr16),
        "hazard": _b64(a["hazard"]),
        "breach_xy": local(summary["site"]["breach"]["lat"], summary["site"]["breach"]["lng"]),
        "dam_xy": local(summary["params"]["lat"], summary["params"]["lng"]),
        "river_xy": [local(p[0], p[1]) for p in summary["site"]["river_path"]],
        "buildings": buildings,
        "pois": [{**{k: v for k, v in p.items() if k not in ("lat", "lng")}, "xy": local(p["lat"], p["lng"])}
                 for p in osm["pois"]],
        "towns": [{**t, "xy": local(t["lat"], t["lng"])} for t in summary["towns"]],
        "roads": [{"xy": [local(la, ln) for la, ln in r["line"]], "flooded": r.get("flooded", False),
                   "class": r["class"]} for r in osm["roads"]],
        "depth_code": "depth_m = (code / 40)^2",
    }


# Colour ramps for map overlays (RGBA).
def _ramp(stops, v):
    xs = np.array([s[0] for s in stops])
    out = np.zeros(v.shape + (4,), np.uint8)
    for c in range(4):
        out[..., c] = np.interp(v, xs, [s[1][c] for s in stops]).astype(np.uint8)
    return out


DEPTH_RAMP = [(0.0, (160, 220, 255, 0)), (0.1, (140, 210, 250, 150)), (0.5, (70, 160, 230, 185)),
              (1.5, (30, 100, 200, 205)), (3.0, (40, 50, 170, 220)), (6.0, (90, 20, 130, 230))]
ARRIVAL_RAMP = [(0, (200, 20, 20, 220)), (30, (240, 110, 30, 210)), (60, (245, 190, 40, 200)),
                (120, (120, 190, 90, 190)), (240, (60, 140, 200, 180)), (720, (90, 90, 160, 170))]
HAZARD_COLOURS = np.array([[0, 0, 0, 0], [227, 181, 59, 170], [230, 130, 40, 190],
                           [200, 70, 30, 205], [150, 20, 20, 220]], np.uint8)


def overlay_png(rid, layer, k=0):
    a = _load_arrays(rid)
    if layer == "frame":
        frames = a["frames"]
        h = flood2d.depth_from_code(frames[min(max(k, 0), len(frames) - 1)])
        img = _ramp(DEPTH_RAMP, h)
        img[h < 0.05, 3] = 0
    elif layer == "max":
        h = a["hmax"]
        img = _ramp(DEPTH_RAMP, h)
        img[h < flood2d.WET, 3] = 0
    elif layer == "arrival":
        t = a["arrival"]
        img = _ramp(ARRIVAL_RAMP, np.maximum(t, 0))
        img[t < 0, 3] = 0
    elif layer == "hazard":
        img = HAZARD_COLOURS[a["hazard"]]
    else:
        raise ValueError("unknown layer")
    img = img[::-1]  # row 0 of our grid is south; PNG row 0 is the top (north)
    im = Image.fromarray(img, "RGBA").resize((img.shape[1] * 2, img.shape[0] * 2), Image.NEAREST)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def compare(a_id, b_id):
    """Differences between two runs (for example user inputs vs satellite-derived storage)."""
    A, B = _load_json(a_id), _load_json(b_id)

    def pick(s):
        return {
            "storage_pct": s["params"]["storage_pct"],
            "rain_mm": s["params"]["rain_mm"],
            "status": s["routing"]["status"],
            "peak_outflow_m3s": s["routing"]["peak_outflow_m3s"],
            "breach_at_h": s["routing"]["breach_at_h"],
            "released_mm3": s["routing"]["released_mm3"],
            "inundated_km2": s["flood"]["inundated_km2"],
            "max_depth_m": s["flood"]["max_depth_m"],
            "reach_end_arrival_min": s["flood"]["reach_end_arrival_min"],
            "buildings": s["impacts"].get("buildings", 0),
            "shops": s["impacts"].get("shops", 0),
            "hospitals": s["impacts"].get("hospitals", 0),
            "schools": s["impacts"].get("schools", 0),
            "places": s["impacts"].get("places", 0),
        }
    a, b = pick(A), pick(B)
    delta = {k: (round(b[k] - a[k], 2) if isinstance(a[k], (int, float)) and isinstance(b[k], (int, float))
                 and not isinstance(a[k], bool) else None) for k in a}
    # Agreement of the two flood extents (critical success index).
    ha, hb = _load_arrays(a_id)["hmax"], _load_arrays(b_id)["hmax"]
    csi = None
    if ha.shape == hb.shape:
        wa, wb = ha > flood2d.WET, hb > flood2d.WET
        union = (wa | wb).sum()
        csi = round(float((wa & wb).sum() / union), 3) if union else 1.0
    return {"a": a, "b": b, "delta": delta, "extent_agreement_csi": csi}
