"""Time-aware evacuation routing.

For each candidate relief camp we fetch a road route from OSRM (free, open source),
then walk along the route and compare *when you reach each point* against *when the
flood reaches that point*. A route is:
  SAFE     never enters a HIGH or EXTREME zone
  CAUTION  passes a flood zone, but at least SAFETY_MARGIN_MIN ahead of the water
  UNSAFE   the water gets to some point on the route before you do
"""
import httpx

from config import OSRM_TIMEOUT_S, OSRM_URL, WALK_SPEED_KMPH
from services.data_store import PLACES
from services.geo import haversine_m
from services.risk_engine import assess_point

SAFETY_MARGIN_MIN = 10
CANDIDATES = 3
STATUS_ORDER = {"SAFE": 0, "CAUTION": 1, "UNSAFE": 2}


async def _osrm_route(client, o_lat, o_lng, d_lat, d_lng):
    url = (f"{OSRM_URL}/route/v1/driving/{o_lng},{o_lat};{d_lng},{d_lat}"
           "?overview=full&geometries=geojson")
    try:
        r = await client.get(url, timeout=OSRM_TIMEOUT_S)
        r.raise_for_status()
        data = r.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            return None
        route = data["routes"][0]
        coords = [[lat, lng] for lng, lat in route["geometry"]["coordinates"]]
        return {"coords": coords, "distance_m": route["distance"],
                "drive_s": route["duration"], "source": "osrm"}
    except Exception:
        return None


def _straight_line(o_lat, o_lng, d_lat, d_lng):
    """Fallback when OSRM is unreachable: straight line with a road-detour factor."""
    dist = haversine_m(o_lat, o_lng, d_lat, d_lng) * 1.3
    steps = 20
    coords = [[o_lat + (d_lat - o_lat) * i / steps, o_lng + (d_lng - o_lng) * i / steps]
              for i in range(steps + 1)]
    return {"coords": coords, "distance_m": dist, "drive_s": dist / (25_000 / 3600),
            "source": "straight_line_estimate"}


def _thin(coords, max_points=60):
    if len(coords) <= max_points:
        return coords
    step = len(coords) / max_points
    out = [coords[int(i * step)] for i in range(max_points)]
    out.append(coords[-1])
    return out


def _evaluate(route, mode):
    dist_km = route["distance_m"] / 1000.0
    travel_min = (dist_km / WALK_SPEED_KMPH * 60.0) if mode == "walk" else route["drive_s"] / 60.0

    samples = _thin(route["coords"])
    # Cumulative distance so we know how far along (and therefore when) we reach each sample.
    cum = [0.0]
    for (a1, b1), (a2, b2) in zip(samples, samples[1:]):
        cum.append(cum[-1] + haversine_m(a1, b1, a2, b2))
    total = cum[-1] or 1.0

    status = "SAFE"
    worst_margin = None
    hazards = []
    for (lat, lng), c in zip(samples, cum):
        r = assess_point(lat, lng)
        if r["level"] not in ("EXTREME", "HIGH"):
            continue
        reach_min = travel_min * (c / total)
        margin = (r["arrival_in_min"] or 0) - reach_min
        worst_margin = margin if worst_margin is None else min(worst_margin, margin)
        hazards.append({"lat": lat, "lng": lng, "level": r["level"],
                        "margin_min": round(margin)})
        if margin < SAFETY_MARGIN_MIN:
            status = "UNSAFE"
        elif status == "SAFE":
            status = "CAUTION"

    return {
        "status": status,
        "travel_min": round(travel_min),
        "distance_km": round(dist_km, 2),
        "worst_margin_min": None if worst_margin is None else round(worst_margin),
        "hazard_points": hazards[:10],
    }


async def evacuation_plan(lat, lng, mode="walk"):
    origin = assess_point(lat, lng)
    shelters = sorted(
        (s for s in PLACES["shelters"] if assess_point(s["lat"], s["lng"])["level"] == "SAFE"),
        key=lambda s: haversine_m(lat, lng, s["lat"], s["lng"]),
    )[:CANDIDATES]

    options = []
    async with httpx.AsyncClient() as client:
        for s in shelters:
            route = await _osrm_route(client, lat, lng, s["lat"], s["lng"])
            if route is None:
                route = _straight_line(lat, lng, s["lat"], s["lng"])
            ev = _evaluate(route, mode)
            window = None
            if origin["arrival_in_min"] is not None:
                window = origin["arrival_in_min"] - ev["travel_min"]
            options.append({
                "shelter": s,
                **ev,
                "safety_window_min": window,
                "route_source": route["source"],
                "coords": route["coords"],
            })

    options.sort(key=lambda o: (STATUS_ORDER[o["status"]], o["travel_min"]))
    best = options[0] if options else None
    alternatives = [{k: v for k, v in o.items() if k != "coords"} for o in options[1:]]
    return {"origin": origin, "mode": mode, "best": best, "alternatives": alternatives}
