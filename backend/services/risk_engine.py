"""Simplified flood risk engine.

This is a stand-in for real SPH / Delft3D results. It estimates depth, velocity and
flood arrival time from distance to the river and distance downstream of the dam.
When real simulation rasters (NetCDF / GeoTIFF) are available, replace
`assess_point` with a lookup into those rasters and keep the same return shape.
"""
import math
import time
from datetime import datetime, timezone

from services.data_store import PLACES, RIVER, SCENARIOS, active_scenario, state
from services.geo import buffer_polyline, project_on_polyline

LEVELS = ["EXTREME", "HIGH", "MODERATE", "SAFE"]
ADVICE = {
    "EXTREME": "Evacuate now. Move to the nearest relief camp on high ground.",
    "HIGH": "Prepare to evacuate. Pack essentials and follow official alerts.",
    "MODERATE": "Stay alert. Avoid the riverbank and low-lying roads.",
    "SAFE": "No flood expected at your location for this scenario.",
}


def _level_for_distance(dist_m, widths):
    for lvl in ("EXTREME", "HIGH", "MODERATE"):
        if dist_m <= widths[lvl]:
            return lvl
    return "SAFE"


def assess_point(lat, lng, scenario=None):
    sc = scenario or active_scenario()
    line = RIVER["centerline"]
    dist_m, chainage_m, side = project_on_polyline(lat, lng, line)

    if sc is None:
        return {
            "scenario_id": None,
            "level": "SAFE",
            "advice": "No active flood threat. Akashwani is monitoring conditions.",
            "distance_to_river_m": round(dist_m),
            "chainage_km": round(chainage_m / 1000, 2),
            "bank": "left" if side > 0 else "right",
            "arrival_min": None,
            "arrival_in_min": None,
            "flood_arrives_at": None,
            "depth_m": 0.0,
            "velocity_mps": 0.0,
        }

    widths = sc["zone_width_m"]
    level = _level_for_distance(dist_m, widths)
    chain_km = chainage_m / 1000.0
    arrival_min = sc["start_delay_min"] + chain_km / sc["wave_speed_kmph"] * 60.0

    decay = math.exp(-chain_km / sc["decay_km"])
    lateral = max(0.0, 1.0 - dist_m / widths["MODERATE"])
    depth = sc["peak_depth_m"] * decay * lateral
    velocity = sc["peak_velocity_mps"] * decay * lateral

    at_risk = level != "SAFE"
    elapsed_min = (time.time() - state.activated_at) / 60.0
    arrival_in = max(0.0, arrival_min - elapsed_min) if at_risk else None
    arrives_at = (datetime.fromtimestamp(state.activated_at + arrival_min * 60, tz=timezone.utc)
                  .isoformat() if at_risk else None)

    return {
        "scenario_id": sc["id"],
        "level": level,
        "advice": ADVICE[level],
        "distance_to_river_m": round(dist_m),
        "chainage_km": round(chain_km, 2),
        "bank": "left" if side > 0 else "right",
        "arrival_min": round(arrival_min) if at_risk else None,
        "arrival_in_min": round(arrival_in) if at_risk else None,
        "flood_arrives_at": arrives_at,
        "depth_m": round(depth, 2),
        "velocity_mps": round(velocity, 2),
    }


def zones_geojson(scenario_id=None):
    sc = SCENARIOS.get(scenario_id) if scenario_id else active_scenario()
    features = [{
        "type": "Feature",
        "properties": {"kind": "river", "name": RIVER["dam"]["river"]},
        "geometry": {"type": "LineString",
                     "coordinates": [[b, a] for a, b in RIVER["centerline"]]},
    }]
    if sc:
        # Largest first so smaller, more severe zones draw on top.
        for lvl in ("MODERATE", "HIGH", "EXTREME"):
            ring = buffer_polyline(RIVER["centerline"], sc["zone_width_m"][lvl])
            features.append({
                "type": "Feature",
                "properties": {"kind": "zone", "level": lvl, "scenario_id": sc["id"]},
                "geometry": {"type": "Polygon", "coordinates": [[[b, a] for a, b in ring]]},
            })
    return {"type": "FeatureCollection", "features": features}


def impact_summary(scenario_id=None):
    sc = SCENARIOS.get(scenario_id) if scenario_id else active_scenario()
    if sc is None:
        return {"scenario_id": None, "population_by_level": {}, "localities": [], "facilities": []}

    pop = {lvl: 0 for lvl in LEVELS}
    localities = []
    for loc in PLACES["localities"]:
        r = assess_point(loc["lat"], loc["lng"], sc)
        pop[r["level"]] += loc["population"]
        if r["level"] != "SAFE":
            localities.append({**loc, "level": r["level"], "arrival_in_min": r["arrival_in_min"],
                               "depth_m": r["depth_m"]})

    facilities = []
    for f in PLACES["facilities"]:
        r = assess_point(f["lat"], f["lng"], sc)
        if r["level"] != "SAFE":
            facilities.append({**f, "level": r["level"], "arrival_in_min": r["arrival_in_min"]})

    order = {lvl: i for i, lvl in enumerate(LEVELS)}
    localities.sort(key=lambda x: (order[x["level"]], x["arrival_in_min"] or 0))
    facilities.sort(key=lambda x: (order[x["level"]], x["arrival_in_min"] or 0))
    return {"scenario_id": sc["id"], "population_by_level": pop,
            "localities": localities, "facilities": facilities}
