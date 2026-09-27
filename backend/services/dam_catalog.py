"""Dam catalogue: CWC NRLD 2019 (India) + OpenStreetMap / published figures (Nepal).

Built by scripts/build_dam_catalog.py into data/dams.json. Any other named dam in the world can
be found live through OpenStreetMap (`search_osm`), with the user entering its figures.
"""
import json
import re
import time
from pathlib import Path

import httpx

DATA = Path(__file__).resolve().parent.parent / "data" / "dams.json"
OVERPASS = "https://overpass-api.de/api/interpreter"
UA = {"User-Agent": "JalDrishti/0.2 (SIH 2026 prototype)"}

_raw = json.loads(DATA.read_text()) if DATA.exists() else {"dams": [], "built": None}
DAMS = {d["id"]: d for d in _raw["dams"]}
BUILT = _raw.get("built")


def _norm(s):
    return re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())


def checks(d):
    """Plain-language data-quality warnings for a catalogue entry."""
    out = []
    h, s, a = d.get("height_m"), d.get("gross_storage_mm3"), d.get("reservoir_area_km2")
    if not s:
        out.append("Reservoir storage is missing. Enter the gross storage to run the model.")
    if not h:
        out.append("Dam height is missing. Enter it to run the model.")
    if h and s and a:
        mean_depth = s / a
        if mean_depth > 0.8 * h:
            out.append(f"Storage ({s:g} Mm³) and area ({a:g} km²) imply an average depth of "
                       f"{mean_depth:.0f} m, more than this {h:g} m dam can hold. One value is "
                       "probably mis-reported in the source. Check before relying on results.")
        elif mean_depth < 0.05 * h:
            out.append(f"Storage ({s:g} Mm³) looks small for a {a:g} km² reservoir. Check the units.")
    for f in d.get("estimated", []):
        out.append(f"'{f}' is an estimate, not a published figure. Adjust it if you have better data.")
    return out


def public(d):
    return {**d, "checks": checks(d)}


def search(q="", country=None, limit=30):
    words = _norm(q).split()
    hits = []
    for d in DAMS.values():
        if country and d["country"] != country:
            continue
        hay = _norm(f"{d['name']} {d.get('river')} {d.get('state')} {d.get('nearest_city')} {d['country']}")
        if all(w in hay for w in words):
            name = _norm(d["name"])
            # Name matches first, then bigger reservoirs (more likely what people look for).
            score = (0 if words and name.startswith(words[0]) else 1 if words and words[0] in name else 2,
                     -(d.get("gross_storage_mm3") or 0))
            hits.append((score, d))
    hits.sort(key=lambda x: x[0])
    return [public(d) for _, d in hits[:limit]]


def get(dam_id):
    d = DAMS.get(dam_id)
    return public(d) if d else None


def search_osm(q, limit=15):
    """Named dams / reservoirs anywhere in the world (OpenStreetMap). Figures must be entered."""
    safe = re.sub(r'["\\\\]', "", q)[:60]
    query = f"""[out:json][timeout:40];
(nwr["waterway"="dam"]["name"~"{safe}",i]; nwr["water"="reservoir"]["name"~"{safe}",i];);
out center tags {limit};"""
    r = httpx.post(OVERPASS, data={"data": query}, headers=UA, timeout=60)
    r.raise_for_status()
    out = []
    for e in r.json()["elements"]:
        tags = e.get("tags", {})
        c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
        if c.get("lat") is None:
            continue
        d = {"id": f"osm-{e['type'][0]}{e['id']}", "name": tags.get("name:en") or tags.get("name"),
             "country": tags.get("addr:country", ""), "state": "", "lat": round(c["lat"], 5),
             "lng": round(c["lon"], 5), "river": tags.get("river", ""), "type":
             "Dam" if tags.get("waterway") == "dam" else "Reservoir", "height_m": None,
             "length_m": None, "gross_storage_mm3": None, "reservoir_area_km2": None,
             "spillway_m3s": None, "catchment_km2": None, "source": "OpenStreetMap (live search)",
             "location_is": "lake_centre" if tags.get("water") == "reservoir" else "dam"}
        DAMS.setdefault(d["id"], d)  # so /api/dams/{id} works for the rest of this session
        out.append(public(d))
    return out


def stats():
    by = {}
    for d in DAMS.values():
        by[d["country"]] = by.get(d["country"], 0) + 1
    return {"total": len(DAMS), "by_country": by, "built": BUILT,
            "sources": ["CWC National Register of Large Dams 2019 (India)",
                        "OpenStreetMap + ICIMOD / NEA published figures (Nepal)"]}
