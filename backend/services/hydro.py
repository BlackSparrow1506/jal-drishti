"""Hydrology for the dam studio: terrain analysis, live rainfall and reservoir routing.

terrain analysis   Priority-Flood + epsilon depression filling (Barnes et al. 2014), D8 flow
                   directions and flow accumulation on the real DEM. Finds the reservoir
                   outlet / breach location, the downstream river path and the catchment area.
rainfall           Open-Meteo hourly precipitation, past 3 days + next 3 days (no key).
reservoir routing  Level-pool water balance, 1-minute steps: rainfall runoff in, spillway and
                   overtopping out, then a parametric breach (trapezoidal broad-crested weir with
                   linear breach growth, as in HEC-RAS / NWS BREACH). Stage-storage follows the
                   power law S = S_frl (h / h_frl)^m, with m fitted from NRLD storage and area.
                   Froehlich (2008) peak outflow and breach-size regressions are reported as a check.
"""
import heapq
import math
import time
from functools import lru_cache

import httpx
import numpy as np

from services import dem

G = 9.81
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
UA = {"User-Agent": "JalDrishti/0.2 (SIH 2026 prototype)"}
ERODIBLE = ("earth", "rock", "moraine", "embankment", "fill", "glof")
D8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


# ------------------------------------------------------------------ terrain analysis

def _priority_flood(z):
    """Depression filling with a tiny gradient on flats so every cell drains to the edge."""
    ny, nx = z.shape
    filled = z.astype(np.float64).copy()
    closed = np.zeros(z.shape, bool)
    heap, pit = [], []
    for j in range(ny):
        for i in (0, nx - 1):
            heapq.heappush(heap, (filled[j, i], j, i)); closed[j, i] = True
    for i in range(1, nx - 1):
        for j in (0, ny - 1):
            heapq.heappush(heap, (filled[j, i], j, i)); closed[j, i] = True
    eps = 1e-4
    while heap or pit:
        if pit:
            _, j, i = pit.pop()
        else:
            _, j, i = heapq.heappop(heap)
        c = filled[j, i]
        for dj, di in D8:
            y, x = j + dj, i + di
            if 0 <= y < ny and 0 <= x < nx and not closed[y, x]:
                closed[y, x] = True
                if filled[y, x] <= c + eps:
                    filled[y, x] = c + eps
                    pit.append((0, y, x))
                else:
                    heapq.heappush(heap, (filled[y, x], y, x))
    return filled


def _d8(filled, cell):
    """Receiver index (flattened) of each cell; -1 on edges that drain out."""
    ny, nx = filled.shape
    pad = np.pad(filled, 1, mode="constant", constant_values=np.inf)
    best = np.zeros(filled.shape)
    rec = np.full(filled.shape, -1, dtype=np.int64)
    jj, ii = np.mgrid[0:ny, 0:nx]
    for dj, di in D8:
        nb = pad[1 + dj:1 + dj + ny, 1 + di:1 + di + nx]
        slope = (filled - nb) / (cell * math.hypot(dj, di))
        better = slope > best
        best = np.where(better, slope, best)
        y, x = jj + dj, ii + di
        rec = np.where(better, y * nx + x, rec)
    return rec.ravel()


def _accumulation(filled, rec):
    order = np.argsort(-filled.ravel(), kind="stable")
    acc = np.ones(filled.size)
    for c in order:
        r = rec[c]
        if r >= 0:
            acc[r] += acc[c]
    return acc


def _upstream_touches_edge(rec, outlet, shape):
    """True when the catchment above `outlet` reaches the analysis window edge."""
    ny, nx = shape
    edge = np.zeros(shape, bool)
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
    edge = edge.ravel()
    # Walk each edge cell downstream; if it passes through the outlet, the catchment is cut.
    for c in np.flatnonzero(edge):
        steps = 0
        while c >= 0 and steps < 20000:
            if c == outlet:
                return True
            c = rec[c]
            steps += 1
    return False


@lru_cache(maxsize=32)
def analyse_site(lat, lng, reach_km=25.0, dam_height_m=30.0, lake_centre=False, lake_area_km2=0.0):
    """Outlet, downstream river path and catchment for a dam or lake at (lat, lng)."""
    t0 = time.time()
    radius = reach_km * 1000 + 6000
    cell = max(90.0, radius / 260)  # keeps the analysis grid near 520 x 520
    grid = dem.grid_around(lat, lng, radius, radius, cell)
    z, source = dem.elevation(grid)
    filled = _priority_flood(z)
    rec = _d8(filled, cell)
    acc = _accumulation(filled, rec)
    ny, nx = z.shape

    i, j = grid.ij(lat, lng)
    start = j * nx + i
    if lake_centre:
        # Lake centre may sit on a DEM artefact: start from the flattest nearby cell.
        r = int(max(2, math.sqrt(max(lake_area_km2, 0.2) * 1e6 / math.pi) / cell))
        win = filled[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1]
        jj, ii = np.unravel_index(np.argmin(np.abs(win - np.median(win))), win.shape)
        start = (max(0, j - r) + jj) * nx + (max(0, i - r) + ii)
    pool = float(filled.ravel()[start])

    # Follow the flow path. The breach sits where the ground first drops clearly below the pool.
    drop = max(5.0, min(15.0, 0.3 * dam_height_m))
    path, c, breach = [], start, None
    run = 0.0
    zr = z.ravel()
    while c >= 0 and len(path) < 20000:
        path.append(c)
        if breach is None and pool - zr[c] >= drop:
            breach = len(path) - 1
            run = 0.0
        nxt = rec[c]
        if nxt < 0:
            break
        run += cell * math.hypot((nxt // nx) - (c // nx), (nxt % nx) - (c % nx))
        if breach is not None and run >= reach_km * 1000:
            path.append(nxt)
            break
        c = nxt
    if breach is None:
        breach = min(len(path) - 1, 3)

    # The traced path can run down the dam face. Snap to the main channel just below the dam:
    # the cell with the largest upstream area within ~600 m that is not above the path cell.
    bj, bi = divmod(path[breach], nx)
    r = max(3, int(600 / cell))
    js, is_ = slice(max(0, bj - r), bj + r + 1), slice(max(0, bi - r), bi + r + 1)
    win_acc = np.where(z[js, is_] <= zr[path[breach]] + 2, acc.reshape(z.shape)[js, is_], 0)
    wj, wi = np.unravel_index(np.argmax(win_acc), win_acc.shape)
    outlet = (js.start + wj) * nx + (is_.start + wi)
    catchment = float(acc[outlet]) * cell * cell / 1e6
    down, c, run = [], outlet, 0.0
    while c >= 0 and run < reach_km * 1000 and len(down) < 20000:
        down.append(c)
        nxt = rec[c]
        if nxt >= 0:
            run += cell * math.hypot((nxt // nx) - (c // nx), (nxt % nx) - (c % nx))
        c = nxt
    lat_c, lng_c = grid.cell_latlng()
    pts, chain, prev = [], 0.0, None
    for c in down:
        cj, ci = divmod(c, nx)
        if prev is not None:
            chain += cell * math.hypot(cj - prev[0], ci - prev[1])
        prev = (cj, ci)
        pts.append([round(float(lat_c[cj, ci]), 6), round(float(lng_c[cj, ci]), 6),
                    round(chain / 1000, 3), round(float(zr[c]), 1)])
    return {
        "breach": {"lat": pts[0][0], "lng": pts[0][1], "ground_m": round(float(zr[outlet]), 1)},
        "pool_elevation_m": round(pool, 1),
        "river_path": pts,  # [lat, lng, chainage_km, bed_elevation_m]
        "reach_km": round(chain / 1000, 2),
        "catchment_km2": round(catchment, 1),
        "catchment_window_limited": bool(_upstream_touches_edge(rec, int(outlet), z.shape)),
        "dem": source,
        "analysis_cell_m": round(cell, 1),
        "seconds": round(time.time() - t0, 1),
    }


# ------------------------------------------------------------------ rainfall

_rain_cache = {}


def rainfall(lat, lng):
    """Hourly precipitation for the past 72 h and the next 72 h (Open-Meteo)."""
    key = (round(lat, 2), round(lng, 2))
    hit = _rain_cache.get(key)
    if hit and time.time() - hit[0] < 1800:
        return hit[1]
    r = httpx.get(OPEN_METEO, headers=UA, timeout=30, params={
        "latitude": lat, "longitude": lng, "hourly": "precipitation",
        "past_days": 3, "forecast_days": 3, "timezone": "auto"})
    r.raise_for_status()
    j = r.json()
    times, mm = j["hourly"]["time"], [v or 0.0 for v in j["hourly"]["precipitation"]]
    now = time.strftime("%Y-%m-%dT%H:00", time.gmtime(time.time() + j.get("utc_offset_seconds", 0)))
    k = next((n for n, tm in enumerate(times) if tm >= now), len(times) // 2)
    out = {
        "source": "Open-Meteo (ECMWF / GFS / ICON blend, radar and gauge assimilated)",
        "timezone": j.get("timezone"),
        "now_index": k,
        "times": times,
        "mm": [round(v, 2) for v in mm],
        "past_24h_mm": round(sum(mm[max(0, k - 24):k]), 1),
        "past_72h_mm": round(sum(mm[max(0, k - 72):k]), 1),
        "next_24h_mm": round(sum(mm[k:k + 24]), 1),
        "next_72h_mm": round(sum(mm[k:k + 72]), 1),
    }
    _rain_cache[key] = (time.time(), out)
    return out


# ------------------------------------------------------------------ reservoir routing

def froehlich_2008(volume_m3, head_m, mode):
    """Froehlich (2008): average breach width, formation time, and peak outflow."""
    ko = 1.3 if mode == "overtopping" else 1.0
    width = 0.27 * ko * volume_m3 ** 0.32 * head_m ** 0.04
    tf_h = 63.2 * math.sqrt(volume_m3 / (G * head_m ** 2)) / 3600
    qp = 0.607 * volume_m3 ** 0.295 * head_m ** 1.24
    return {"avg_width_m": round(float(width), 1), "formation_h": round(float(tf_h), 2), "peak_q_m3s": round(float(qp))}


def suggest_breach(p):
    """Starting breach inputs for a dam from its size (Froehlich 2008)."""
    h = p["height_m"]
    v = p["gross_storage_mm3"] * 1e6
    f = froehlich_2008(v, h, p.get("failure_mode", "overtopping"))
    depth = h if any(k in (p.get("type") or "").lower() for k in ERODIBLE) else 0.7 * h
    bottom = max(5.0, f["avg_width_m"] - depth * p.get("side_slope", 1.0))
    return {"breach_width_m": round(min(bottom, p.get("length_m") or bottom), 1),
            "breach_depth_m": round(depth, 1),
            "formation_h": max(0.1, f["formation_h"]),
            "froehlich": f}


def route_reservoir(p, rain=None):
    """Level-pool routing with rainfall inflow and a parametric breach.

    p keys (SI units): height_m, length_m, gross_storage_mm3, reservoir_area_km2, storage_pct,
    catchment_km2, runoff_coeff, rain_mm (event total), rain_hours, spillway_m3s, freeboard_m,
    breach_width_m, breach_depth_m, side_slope, formation_h, failure_mode, breach_trigger
    ('auto' | 'now' | 'none'), duration_h, dam_type. `rain` optional hourly series (mm) that
    shapes the event; otherwise the total falls uniformly over rain_hours.
    """
    H = p["height_m"]
    f = p.get("freeboard_m") or max(1.0, 0.06 * H)
    h_frl = max(1.0, H - f)
    S_frl = p["gross_storage_mm3"] * 1e6
    A_frl = (p.get("reservoir_area_km2") or 0) * 1e6
    m = A_frl * h_frl / S_frl if A_frl > 0 else 2.5
    m_clamped = min(4.0, max(1.2, m))

    def storage(h):
        return S_frl * (max(h, 0.0) / h_frl) ** m_clamped

    def stage(S):
        return h_frl * (max(S, 0.0) / S_frl) ** (1 / m_clamped)

    dt = 60.0
    # Always route the whole rain event plus time for the reservoir to respond.
    duration_h = max(p.get("duration_h", 24), p.get("rain_hours", 24) + 12)
    n = int(duration_h * 3600 / dt) + 1
    # Runoff: rainfall on the catchment through a linear reservoir (lag k hours).
    area = p.get("catchment_km2") or 0
    k_h = max(1.0, 0.6 * max(area, 1) ** 0.3)
    hours = max(1, int(p.get("rain_hours", 24)))
    total = p.get("rain_mm", 0) or 0
    if rain and sum(rain) > 0:
        shape = np.array(rain[:hours], float)
        shape = shape / shape.sum() if shape.sum() > 0 else np.full(hours, 1 / hours)
    else:
        shape = np.full(hours, 1 / hours)
    rain_rate = np.zeros(n)  # m3/s of effective rainfall
    for hr, frac in enumerate(shape):
        a, b = int(hr * 3600 / dt), int((hr + 1) * 3600 / dt)
        rain_rate[a:min(b, n)] = total / 1000 * frac * area * 1e6 * p.get("runoff_coeff", 0.5) / 3600
    q_in = np.zeros(n)
    kq = dt / (k_h * 3600)
    for t in range(1, n):
        q_in[t] = q_in[t - 1] + kq * (rain_rate[t - 1] - q_in[t - 1])

    erodible = any(k in (p.get("dam_type") or "").lower() for k in ERODIBLE)
    trigger = p.get("breach_trigger", "auto")
    Qs, L = p.get("spillway_m3s") or 0.0, p.get("length_m") or 100.0
    Bw, Hb, z = p["breach_width_m"], p["breach_depth_m"], p.get("side_slope", 1.0)
    tf = max(60.0, p["formation_h"] * 3600)
    piping = p.get("failure_mode") == "piping"

    S = storage(h_frl) * p.get("storage_pct", 100) / 100
    t_breach = 0.0 if trigger == "now" else None
    t_overtop = None
    out = {k: np.zeros(n) for k in ("h", "q_in", "q_spill", "q_over", "q_breach")}
    for t in range(n):
        h = stage(S)
        qs = Qs * min(1.0, ((h - h_frl) / (0.9 * f))) ** 1.5 if h > h_frl and Qs else 0.0
        over = h - H
        qo = 1.7 * L * over ** 1.5 if over > 0 else 0.0
        if over > 0 and t_overtop is None:
            t_overtop = t * dt
        if t_breach is None and trigger == "auto" and (
                (erodible and over >= 0.3) or (not erodible and over >= 1.5)):
            t_breach = t * dt
        qb = 0.0
        if t_breach is not None:
            grow = min(1.0, (t * dt - t_breach) / tf)
            zb = H - Hb * grow                 # breach bottom above the dam base
            b = Bw * grow
            head = h - zb
            if head > 0:
                qb = 1.7 * b * head ** 1.5 + 1.35 * z * head ** 2.5
                if piping and grow < 1.0:
                    qb *= 0.6 + 0.4 * grow     # pipe / orifice phase before the roof collapses
        q_total_out = qs + qo + qb
        S = max(0.0, S + (q_in[t] - q_total_out) * dt)
        out["h"][t], out["q_in"][t], out["q_spill"][t], out["q_over"][t], out["q_breach"][t] = h, q_in[t], qs, qo, qb

    q_down = out["q_spill"] + out["q_over"] + out["q_breach"]
    step = max(1, int(600 / dt))  # report every 10 minutes
    s0 = storage(h_frl) * p.get("storage_pct", 100) / 100
    pool_h = out["h"].max()
    # Froehlich check uses the water stored above the final breach bottom when the breach starts.
    h_at_breach = out["h"][min(n - 1, int(t_breach / dt))] if t_breach is not None else stage(s0)
    v_above = max(1.0, storage(h_at_breach) - storage(H - Hb))
    return {
        "stage_storage_exponent": round(m_clamped, 2),
        "stage_storage_note": None if abs(m - m_clamped) < 1e-6 else
            f"Reported storage / area imply exponent {m:.2f}; clamped to {m_clamped:.2f}. Check NRLD values.",
        "full_supply_level_m": round(h_frl, 2),
        "crest_m": H,
        "initial_level_m": round(stage(s0), 2),
        "peak_level_m": round(float(pool_h), 2),
        "freeboard_left_m": round(H - float(pool_h), 2),
        "inflow_volume_mm3": round(float(q_in.sum() * dt / 1e6), 2),
        "peak_inflow_m3s": round(float(q_in.max())),
        "overtop_at_h": None if t_overtop is None else round(t_overtop / 3600, 2),
        "breach_at_h": None if t_breach is None else round(t_breach / 3600, 2),
        "peak_breach_m3s": round(float(out["q_breach"].max())),
        "peak_outflow_m3s": round(float(q_down.max())),
        "released_mm3": round(float(q_down.sum() * dt / 1e6), 2),
        "froehlich_check": froehlich_2008(v_above, max(1.0, Hb), p.get("failure_mode", "overtopping")),
        "status": ("breach" if t_breach is not None else "overtopping" if t_overtop is not None
                   else "spilling" if out["q_spill"].max() > 1 else "safe"),
        "series": {
            "t_h": [round(t * dt / 3600, 3) for t in range(0, n, step)],
            "level_m": [round(float(v), 2) for v in out["h"][::step]],
            "q_in": [round(float(v), 1) for v in out["q_in"][::step]],
            "q_out": [round(float(v), 1) for v in q_down[::step]],
            "q_breach": [round(float(v), 1) for v in out["q_breach"][::step]],
        },
        "_q_down": q_down,  # full-resolution outflow for the flood model (not sent to the app)
        "_dt": dt,
    }
