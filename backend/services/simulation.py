"""Illustrative SPH (near-field) + Delft3D (far-field) dam-break simulation.

Stand-in for real solver output. It produces everything the Simulation screen draws:
  * hydrographs at the breach (SPH) and at the downstream gauge (Delft3D),
  * a timeline of flood-wave frames (depth and wet width at stations along the river),
  * a synthetic 3D terrain grid around the river for the 3D view.

When DualSPHysics / Delft3D-FM results are available, replace `run_simulation` with a
reader for those files (NetCDF / GeoTIFF) and keep the same return shape. The app does
not need to change. `terrain()` can be swapped for a real DEM (SRTM / Cartosat) sampled
on the same grid.
"""
import math
from functools import lru_cache

from services.data_store import PLACES, RIVER, SCENARIOS
from services.geo import M_PER_DEG_LAT, M_PER_DEG_LNG, project_on_polyline, to_latlng, to_xy

N_STEPS = 120          # timeline frames
MAX_T_MIN = 240        # simulate 4 hours after breach
N_STATIONS = 32        # cross-sections along the river
NEAR_FIELD_KM = 4.0    # SPH domain length downstream of the breach
GRID_MAX_CELLS = 72    # terrain grid resolution along the longer side
GRID_MARGIN_M = 2500   # terrain padding around the river
MODE_FACTOR = {"overtopping": 1.0, "piping": 0.8}
FULL_BREACH_WIDTH_M = 180  # scenario breach widths are scaled against a full breach


def froehlich_peak_q(volume_mm3, height_m, mode):
    """Froehlich (1995) peak breach outflow in m3/s. Volume in million m3, height in m."""
    return 0.607 * (volume_mm3 * 1e6) ** 0.295 * height_m ** 1.24 * MODE_FACTOR[mode]


def _pulse(x):
    """Unit-peak hydrograph shape: 0 at x<=0, peak 1 at x=1, then recession."""
    return x * math.exp(1.0 - x) if x > 0 else 0.0


# ---------------------------------------------------------------- river stations

@lru_cache(maxsize=1)
def stations():
    """Resample the centerline into equally spaced stations with unit normals."""
    pts = [to_xy(a, b) for a, b in RIVER["centerline"]]
    seg = [math.hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in zip(pts, pts[1:])]
    total = sum(seg)
    out = []
    for i in range(N_STATIONS):
        s = total * i / (N_STATIONS - 1)
        run, k = 0.0, 0
        while k < len(seg) - 1 and run + seg[k] < s:
            run += seg[k]
            k += 1
        t = (s - run) / seg[k] if seg[k] else 0.0
        (x1, y1), (x2, y2) = pts[k], pts[k + 1]
        x, y = x1 + t * (x2 - x1), y1 + t * (y2 - y1)
        dx, dy = (x2 - x1) / (seg[k] or 1), (y2 - y1) / (seg[k] or 1)
        lat, lng = to_latlng(x, y)
        # Unit normal (left bank) expressed in degrees per metre, so the app can offset lat/lng.
        nlat, nlng = to_latlng(-dy, dx)
        out.append({
            "chainage_km": round(s / 1000, 3),
            "lat": round(lat, 6), "lng": round(lng, 6),
            "nlat": nlat, "nlng": nlng,
        })
    return out, total / 1000


# ---------------------------------------------------------------- terrain (3D view)

def _ground(chain_km, dist_m, x, y, reach_km):
    """Synthetic DEM: valley floor sloping downstream, banks rising, gentle hills."""
    floor = 585.0 - 40.0 * min(1.0, chain_km / reach_km)
    banks = 22.0 * (1.0 - math.exp(-dist_m / 650.0))
    hills = max(0.0, min(dist_m, 4500.0) - 1200.0) / 1000.0 * (
        14.0 + 9.0 * math.sin(x / 1700.0) * math.cos(y / 2100.0) + 5.0 * math.sin((x + y) / 900.0))
    channel = -5.0 * math.exp(-(dist_m / 70.0) ** 2)
    return floor + banks + hills + channel


@lru_cache(maxsize=1)
def terrain():
    """Terrain grid in local metres, origin at the dam. Row-major, y (north) rows, x (east) cols."""
    line = RIVER["centerline"]
    ox, oy = to_xy(RIVER["dam"]["lat"], RIVER["dam"]["lng"])
    xs = [to_xy(a, b)[0] - ox for a, b in line]
    ys = [to_xy(a, b)[1] - oy for a, b in line]
    x0, x1 = min(xs) - GRID_MARGIN_M, max(xs) + GRID_MARGIN_M
    y0, y1 = min(ys) - GRID_MARGIN_M, max(ys) + GRID_MARGIN_M
    cell = max(x1 - x0, y1 - y0) / (GRID_MAX_CELLS - 1)
    nx = int(math.ceil((x1 - x0) / cell)) + 1
    ny = int(math.ceil((y1 - y0) / cell)) + 1
    _, reach_km = stations()

    z, chain, dist = [], [], []
    for j in range(ny):
        for i in range(nx):
            x, y = x0 + i * cell, y0 + j * cell
            lat, lng = to_latlng(x + ox, y + oy)
            d, c, _ = project_on_polyline(lat, lng, line)
            z.append(round(_ground(c / 1000, d, x, y, reach_km), 1))
            chain.append(round(c / 1000, 3))
            dist.append(round(d))

    def local(lat, lng):
        x, y = to_xy(lat, lng)
        return [round(x - ox), round(y - oy)]

    return {
        "nx": nx, "ny": ny, "cell_m": round(cell, 2),
        "origin_m": [round(x0), round(y0)],
        "z_m": z,
        "chainage_km": chain,    # per cell: nearest position along the river
        "dist_m": dist,          # per cell: distance to river centerline
        "river_m": [local(a, b) for a, b in line],
        "dam_m": local(RIVER["dam"]["lat"], RIVER["dam"]["lng"]),
        "localities": [{"name": l["name"], "pos_m": local(l["lat"], l["lng"])} for l in PLACES["localities"]],
        "shelters": [{"name": s["name"], "pos_m": local(s["lat"], s["lng"])} for s in PLACES["shelters"]],
        # Stations in local metres with their unit normal: [x, y, nx, ny].
        "stations_m": [
            [*local(s["lat"], s["lng"]), round(s["nlng"] * M_PER_DEG_LNG, 4), round(s["nlat"] * M_PER_DEG_LAT, 4)]
            for s in stations()[0]
        ],
        "station_ground_m": [
            round(_ground(s["chainage_km"], 0, *local(s["lat"], s["lng"]), reach_km), 1)
            for s in stations()[0]
        ],
    }


# ---------------------------------------------------------------- hydraulics

def _station_q(sc, qp, tf, s_km, t_min):
    """Discharge at chainage s_km and time t_min: delayed, attenuated, broadened pulse."""
    _, reach_km = stations()
    arrive = sc["start_delay_min"] + s_km / sc["wave_speed_kmph"] * 60.0
    atten = math.exp(-s_km / sc["decay_km"])
    broaden = 1.0 + 1.4 * s_km / reach_km
    return qp * atten * _pulse((t_min - arrive) / (tf * broaden))


@lru_cache(maxsize=64)
def run_simulation(scenario_id, volume_mm3, height_m, formation_min, mode):
    sc = SCENARIOS[scenario_id]
    b = sc["breach"]
    # Froehlich ignores breach width, so a partial breach is scaled down against a full one.
    width_factor = min(1.0, sc["breach_width_m"] / FULL_BREACH_WIDTH_M) ** 0.5
    qp = froehlich_peak_q(volume_mm3, height_m, mode) * width_factor
    # Reference peak for the scenario's own defaults: at that discharge the depth equals
    # the scenario's peak_depth_m, so the map and the risk engine agree.
    q_ref = froehlich_peak_q(b["volume_mm3"], b["height_m"], b["failure_mode"]) * width_factor
    st, reach_km = stations()
    w_mod = sc["zone_width_m"]["MODERATE"]

    frames = []
    for k in range(N_STEPS + 1):
        t = MAX_T_MIN * k / N_STEPS
        depth, w_delft, w_sph = [], [], []
        area = 0.0
        for i, s in enumerate(st):
            q = _station_q(sc, qp, formation_min, s["chainage_km"], t)
            d = sc["peak_depth_m"] * (q / q_ref) ** 0.6 if q > 0 else 0.0   # Manning-like stage
            w = w_mod * min(1.6, (d / sc["peak_depth_m"]) ** 0.8) if d > 0.05 else 0.0
            depth.append(round(d, 2))
            w_delft.append(round(w))
            w_sph.append(round(w * 1.15) if s["chainage_km"] <= NEAR_FIELD_KM else 0)
            if i and w:
                area += 2 * w * (s["chainage_km"] - st[i - 1]["chainage_km"]) * 1000
        front = max(0.0, t - sc["start_delay_min"]) * sc["wave_speed_kmph"] / 60.0
        frames.append({
            "t_min": round(t, 1),
            "q_sph": round(_station_q(sc, qp, formation_min, 0.0, t)),
            "q_delft": round(_station_q(sc, qp, formation_min, reach_km, t)),
            "front_km": round(min(front, reach_km), 2),
            "area_km2": round(area / 1e6, 2),
            "max_depth_m": max(depth),
            "depth_m": depth,
            "width_delft_m": w_delft,
            "width_sph_m": w_sph,
        })

    arrivals = []
    for loc in PLACES["localities"]:
        dist, chain, _ = project_on_polyline(loc["lat"], loc["lng"], RIVER["centerline"])
        if dist > w_mod * 1.6:
            continue
        arrivals.append({
            "name": loc["name"],
            "chainage_km": round(chain / 1000, 2),
            "arrival_min": round(sc["start_delay_min"] + chain / 1000 / sc["wave_speed_kmph"] * 60),
            "population": loc["population"],
        })
    arrivals.sort(key=lambda a: a["arrival_min"])

    return {
        "sample_data": True,
        "scenario": {"id": sc["id"], "name": sc["name"], "trigger": sc["trigger"]},
        "params": {"volume_mm3": volume_mm3, "height_m": height_m,
                   "formation_min": formation_min, "failure_mode": mode},
        "peak_q_m3s": round(qp),
        "peak_q_delft_m3s": max(f["q_delft"] for f in frames),
        "reach_km": round(reach_km, 2),
        "near_field_km": NEAR_FIELD_KM,
        "end_arrival_min": round(sc["start_delay_min"] + reach_km / sc["wave_speed_kmph"] * 60),
        "stations": st,
        "frames": frames,
        "arrivals": arrivals,
    }
