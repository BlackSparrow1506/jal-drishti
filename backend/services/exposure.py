"""Who and what the flood reaches: buildings, shops, facilities, towns and main roads.

Buildings and places come from Overture Maps (public GeoParquet, no key, no rate limit). Its
building layer merges OpenStreetMap, Google Open Buildings and Microsoft ML footprints, which
covers India and Nepal far better than OpenStreetMap alone. Only the files whose extent overlaps
the flood are read (found through Overture's STAC index), so a query takes seconds.
Towns and main roads come from Overture's divisions and transportation themes.
"""
import hashlib
import json
import re
import threading
import time
from pathlib import Path

import httpx

CACHE = Path(__file__).resolve().parent.parent / "cache" / "exposure"
OVERTURE_STAC = "https://stac.overturemaps.org"
UA = {"User-Agent": "JalDrishti/0.2 (SIH 2026 prototype)"}
MAX_BUILDINGS = 40_000
_duck = threading.local()
_release = {"id": None, "at": 0}

HOSPITAL = {"hospital", "health_care", "clinic", "medical_center", "urgent_care_clinic", "emergency_room",
            "dental_clinic", "doctor", "health_and_medical"}
SCHOOL = {"education", "educational_service", "place_of_learning", "college_university", "school",
          "elementary_school", "high_school", "preschool", "specialty_school"}
EMERGENCY = {"police_department", "fire_department", "fire_station", "police_station", "emergency_service"}
SHELTER = {"homeless_shelter", "community_center", "social_or_community_service"}


def _con():
    if getattr(_duck, "con", None) is None:
        import duckdb
        con = duckdb.connect()
        con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
        _duck.con = con
    return _duck.con


def release():
    """Newest Overture release id (from the STAC root catalog), cached for a day."""
    if _release["id"] and time.time() - _release["at"] < 86400:
        return _release["id"]
    cat = httpx.get(f"{OVERTURE_STAC}/catalog.json", headers=UA, timeout=30).json()
    ids = sorted(m.group(1) for l in cat["links"] if l["rel"] == "child"
                 for m in [re.search(r"/(\d{4}-\d{2}-\d{2}\.\d+)/", l["href"])] if m)
    _release.update(id=ids[-1], at=time.time())
    return ids[-1]


def _files(theme, typ, box):
    """Parquet files (s3://) whose extent overlaps box (s, w, n, e)."""
    rel = release()
    key = CACHE / f"stac_{rel}_{theme}_{typ}.json"
    if key.exists():
        col = json.loads(key.read_text())
    else:
        c = httpx.get(f"{OVERTURE_STAC}/{rel}/{theme}/{typ}/collection.json", headers=UA, timeout=60).json()
        items = [l["href"] for l in c["links"] if l["rel"] == "item"]
        bbs = c["extent"]["spatial"]["bbox"]
        # STAC puts the overall extent first, then one box per item (a one-file theme has only one).
        col = {"items": items, "bboxes": bbs[1:] if len(bbs) == len(items) + 1 else bbs, "hrefs": {}}
        CACHE.mkdir(parents=True, exist_ok=True)
        key.write_text(json.dumps(col))
    s, w, n, e = box
    out = []
    for item, b in zip(col["items"], col["bboxes"]):
        if b[2] < w or b[0] > e or b[3] < s or b[1] > n:
            continue
        href = col["hrefs"].get(item)
        if not href:
            it = httpx.get(item, headers=UA, timeout=30).json()
            href = col["hrefs"][item] = it["assets"]["aws"]["href"].replace(
                "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/", "s3://overturemaps-us-west-2/")
            key.write_text(json.dumps(col))
        out.append(href)
    return out


def _where(boxes):
    # The plain range on the union comes first: DuckDB can skip Parquet row groups with it.
    # The per-box OR then trims to the flooded strip.
    s, w, n, e = _union(boxes)
    union = f"bbox.xmin BETWEEN {w:.6f} AND {e:.6f} AND bbox.ymin BETWEEN {s:.6f} AND {n:.6f}"
    each = " OR ".join(f"(bbox.xmin <= {e:.6f} AND bbox.xmax >= {w:.6f} AND bbox.ymin <= {n:.6f} AND bbox.ymax >= {s:.6f})"
                       for s, w, n, e in boxes)
    return f"({union}) AND ({each})"


def _union(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def _cached(name, boxes, fn):
    key = CACHE / f"{name}_{hashlib.sha1(json.dumps(boxes).encode()).hexdigest()[:20]}.json"
    if key.exists() and time.time() - key.stat().st_mtime < 30 * 86400:
        return json.loads(key.read_text())
    data = fn()
    CACHE.mkdir(parents=True, exist_ok=True)
    key.write_text(json.dumps(data))
    return data


def _height(h, floors, cls):
    if h:
        return max(3.0, min(200.0, float(h)))
    if floors:
        return max(3.0, min(200.0, float(floors) * 3.2))
    return 9.0 if cls in ("apartments", "commercial", "office", "hospital", "school") else 6.0


def _buildings(boxes):
    files = _files("buildings", "building", _union(boxes))
    if not files:
        return []
    q = f"""SELECT height, num_floors, class, sources[1].dataset AS src,
                   ST_AsText(ST_SimplifyPreserveTopology(geometry, 0.00001)) AS wkt
            FROM read_parquet({json.dumps(files)}) WHERE {_where(boxes)} LIMIT {MAX_BUILDINGS + 1}"""
    out = []
    for h, floors, cls, src, wkt in _con().execute(q).fetchall():
        m = re.search(r"\(\(([^()]+)\)", wkt or "")
        if not m:
            continue
        ring = [[round(float(y), 6), round(float(x), 6)] for x, y in
                (p.split()[:2] for p in m.group(1).split(","))]
        kind = "hospital" if cls == "hospital" else "school" if cls in ("school", "university", "college") \
            else "shop" if cls in ("retail", "commercial", "supermarket", "kiosk") else "building"
        out.append({"ring": ring, "kind": kind, "height_m": _height(h, floors, cls), "name": "", "src": src})
    return out


def _places(boxes):
    files = _files("places", "place", _union(boxes))
    if not files:
        return []
    q = f"""SELECT names."primary", basic_category, taxonomy.hierarchy, ST_X(geometry), ST_Y(geometry)
            FROM read_parquet({json.dumps(files)})
            WHERE ({_where(boxes)}) AND confidence >= 0.5"""
    out = []
    for name, cat, hier, x, y in _con().execute(q).fetchall():
        hier = hier or []
        top = hier[0] if hier else ""
        cats = set(hier) | {cat or ""}
        if cats & HOSPITAL or top == "health_care":
            kind = "hospital"
        elif cats & SCHOOL or top == "education":
            kind = "school"
        elif cats & EMERGENCY:
            kind = "emergency"
        elif cats & SHELTER:
            kind = "shelter"
        elif top in ("shopping", "food_and_drink") or "store" in (cat or ""):
            kind = "shop"
        else:
            continue
        out.append({"kind": kind, "type": cat or top, "name": name or "", "lat": y, "lng": x})
    return out


def _towns(boxes):
    files = _files("divisions", "division", _union(boxes))
    q = f"""SELECT COALESCE(names.common['en'], names."primary"), subtype, population, ST_X(geometry), ST_Y(geometry)
            FROM read_parquet({json.dumps(files)})
            WHERE ({_where(boxes)}) AND subtype IN ('locality', 'localadmin', 'neighborhood')"""
    seen, out = set(), []
    for name, sub, pop, x, y in _con().execute(q).fetchall():
        if name and name not in seen:
            seen.add(name)
            out.append({"name": name, "kind": sub, "lat": y, "lng": x, "population": pop})
    return out


def _roads(boxes):
    files = _files("transportation", "segment", _union(boxes))
    q = f"""SELECT class, COALESCE(names.common['en'], names."primary"), ST_AsText(geometry)
            FROM read_parquet({json.dumps(files)})
            WHERE ({_where(boxes)}) AND subtype = 'road'
              AND class IN ('motorway', 'trunk', 'primary', 'secondary', 'tertiary')"""
    out = []
    for cls, name, wkt in _con().execute(q).fetchall():
        pts = re.findall(r"(-?\d+\.?\d*) (-?\d+\.?\d*)", wkt or "")
        if len(pts) >= 2:
            out.append({"line": [[round(float(y), 6), round(float(x), 6)] for x, y in pts],
                        "class": cls, "name": name or ""})
    return out


def fetch(boxes, progress=None):
    """Buildings, places (shops, hospitals, schools...), towns and main roads inside boxes (s, w, n, e)."""
    boxes = [tuple(round(v, 5) for v in b) for b in boxes]
    notes = []

    def step(f):
        if progress:
            progress(f)

    try:
        buildings = _cached("bld", boxes, lambda: _buildings(boxes))
    except Exception as e:
        buildings = []
        notes.append(f"Building footprints unavailable ({type(e).__name__}).")
    step(0.6)
    try:
        pois = _cached("poi", boxes, lambda: _places(boxes))
    except Exception as e:
        pois = []
        notes.append(f"Shops and facilities unavailable ({type(e).__name__}).")
    step(0.8)
    places, roads = [], []
    try:
        places = _cached("towns", boxes, lambda: _towns(boxes))
    except Exception as e:
        notes.append(f"Town names unavailable ({type(e).__name__}).")
    step(0.9)
    try:
        roads = _cached("roads", boxes, lambda: _roads(boxes))
    except Exception as e:
        notes.append(f"Roads unavailable ({type(e).__name__}).")
    step(1.0)
    return {"buildings": buildings[:MAX_BUILDINGS], "buildings_capped": len(buildings) > MAX_BUILDINGS,
            "pois": pois, "places": places, "roads": roads, "notes": notes,
            "source": f"Overture Maps {release()}: buildings (OpenStreetMap + Google Open Buildings + "
                      "Microsoft ML Buildings), places, divisions and roads"}


def assess(data, grid, hmax, arrival):
    """Attach max depth and arrival time to every feature; summarise impacts."""
    def sample(lat, lng):
        i, j = grid.ij(lat, lng)
        if 0 <= i < grid.nx and 0 <= j < grid.ny:
            return float(hmax[j, i]), float(arrival[j, i])
        return 0.0, -1.0

    counts = {"buildings": 0, "shops": 0, "hospitals": 0, "schools": 0, "emergency": 0, "shelters": 0}
    for b in data["buildings"]:
        lat = sum(p[0] for p in b["ring"]) / len(b["ring"])
        lng = sum(p[1] for p in b["ring"]) / len(b["ring"])
        d, a = sample(lat, lng)
        b["depth_m"], b["arrival_min"] = round(d, 2), round(a, 1)
        if d > 0.1:
            counts["buildings"] += 1
    key = {"shop": "shops", "hospital": "hospitals", "school": "schools", "emergency": "emergency", "shelter": "shelters"}
    for p in data["pois"]:
        d, a = sample(p["lat"], p["lng"])
        p["depth_m"], p["arrival_min"] = round(d, 2), round(a, 1)
        if d > 0.1:
            counts[key[p["kind"]]] += 1
    towns = []
    for pl in data["places"]:
        # A settlement counts as reached if flooding is within ~300 m of its centre.
        i, j = grid.ij(pl["lat"], pl["lng"])
        if not (0 <= i < grid.nx and 0 <= j < grid.ny):
            continue
        r = max(1, int(300 / grid.cell))
        win = hmax[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1]
        warr = arrival[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1]
        if win.size and win.max() > 0.1:
            first = warr[warr >= 0]
            towns.append({**pl, "max_depth_m": round(float(win.max()), 2),
                          "arrival_min": round(float(first.min()), 1) if first.size else None})
    towns.sort(key=lambda x: x["arrival_min"] if x["arrival_min"] is not None else 1e9)
    roads_cut = 0
    for rd in data["roads"]:
        rd["flooded"] = any(sample(la, ln)[0] > 0.3 for la, ln in rd["line"])
        roads_cut += rd["flooded"]
    counts["roads_cut"] = roads_cut
    counts["places"] = len(towns)
    return counts, towns
