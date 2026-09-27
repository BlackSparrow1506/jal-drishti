"""Build backend/data/dams.json from public sources.

    python scripts/build_dam_catalog.py            (from the backend folder)

Sources
  India  National Register of Large Dams 2019, Central Water Commission (CWC)
         https://cwc.gov.in/sites/default/files/nrld-2019.pdf
         Name, lat/lng, height, crest length, gross storage, reservoir area,
         spillway capacity, river, basin, dam type. (NRLD 2023 has no public
         machine-readable copy; the 2019 edition is the latest one with coordinates.)
  Nepal  OpenStreetMap (Overpass API): named dams, reservoirs and glacial lakes.
         Attributes for well-documented sites come from NEPAL_PUBLISHED below.

Needs: pdfplumber, httpx.
"""
import json
import re
import sys
import time
from pathlib import Path

import httpx
import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "dams.json"
CACHE = ROOT / "cache"
NRLD_URL = "https://cwc.gov.in/sites/default/files/nrld-2019.pdf"
OVERPASS = "https://overpass-api.de/api/interpreter"
UA = {"User-Agent": "JalDrishti/0.2 (SIH 2026 prototype; dam catalogue build)"}

# PIC code prefix -> state (NRLD "Project Identification Code").
STATES = {
    "AN": "Andaman and Nicobar", "AP": "Andhra Pradesh", "AR": "Arunachal Pradesh", "AS": "Assam",
    "BR": "Bihar", "CG": "Chhattisgarh", "CT": "Chhattisgarh", "GA": "Goa", "GJ": "Gujarat",
    "HR": "Haryana", "HP": "Himachal Pradesh", "JK": "Jammu and Kashmir", "JH": "Jharkhand",
    "KA": "Karnataka", "KL": "Kerala", "MP": "Madhya Pradesh", "MH": "Maharashtra", "MN": "Manipur",
    "ML": "Meghalaya", "MZ": "Mizoram", "NL": "Nagaland", "OR": "Odisha", "OD": "Odisha",
    "PB": "Punjab", "RJ": "Rajasthan", "RA": "Rajasthan", "TL": "Telangana", "SK": "Sikkim", "TN": "Tamil Nadu", "TG": "Telangana",
    "TS": "Telangana", "TR": "Tripura", "UP": "Uttar Pradesh", "UK": "Uttarakhand", "UT": "Uttarakhand", "UA": "Uttarakhand",
    "WB": "West Bengal",
}

# Published figures for well-documented Nepal sites. Values are approximate and should be
# checked against the latest survey before operational use. Fields listed in `estimated` are
# not published figures: they are editable starting values (for glacial lakes, `height_m` is an
# assumed moraine breach depth, not the lake depth).
NEPAL_PUBLISHED = {
    "kulekhani": {
        "match": r"kulekhani|indra\s*sarowar|indra\s*sarovar", "lookup": "Kulekhani Reservoir", "name": "Kulekhani Dam (Indrasarowar)", "type": "Rockfill",
        "river": "Kulekhani Khola", "height_m": 114, "length_m": 406, "gross_storage_mm3": 85.3,
        "reservoir_area_km2": 2.2, "catchment_km2": 126, "source": "Nepal Electricity Authority (NEA)",
        "estimated": ["length_m"],
    },
    "tsho_rolpa": {
        "match": r"tsho\s*rolpa|छो रोल्पा", "lookup": "Tsho Rolpa", "name": "Tsho Rolpa glacial lake", "type": "Moraine (GLOF)",
        "river": "Rolwaling Khola", "height_m": 20, "length_m": 500, "gross_storage_mm3": 86,
        "reservoir_area_km2": 1.54, "catchment_km2": 77, "source": "ICIMOD / DHM Nepal surveys",
        "estimated": ["height_m", "length_m", "catchment_km2"],
    },
    "imja_tsho": {
        "match": r"imja", "lookup": "Imja Tsho", "name": "Imja Tsho glacial lake", "type": "Moraine (GLOF)",
        "river": "Imja Khola", "height_m": 20, "length_m": 600, "gross_storage_mm3": 75,
        "reservoir_area_km2": 1.28, "catchment_km2": 36, "source": "ICIMOD / DHM Nepal surveys",
        "estimated": ["height_m", "length_m", "catchment_km2"],
    },
    "thulagi": {
        "match": r"thulagi|dona", "lookup": "Thulagi Lake", "name": "Thulagi glacial lake", "type": "Moraine (GLOF)",
        "river": "Dona Khola", "height_m": 15, "length_m": 400, "gross_storage_mm3": 36,
        "reservoir_area_km2": 0.94, "catchment_km2": 40, "source": "ICIMOD / DHM Nepal surveys",
        "estimated": ["height_m", "length_m", "catchment_km2"],
    },
}


def _num(v):
    if v is None:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", str(v).replace(",", ""))
    return float(m.group()) if m else None


def _dms(v):
    """'17° 20 '\\n21"' -> 17.3392. Returns None if it doesn't look like a coordinate."""
    if not v:
        return None
    parts = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", str(v))]
    if not parts:
        return None
    d = parts[0] + (parts[1] if len(parts) > 1 else 0) / 60 + (parts[2] if len(parts) > 2 else 0) / 3600
    return round(d, 5)


def _clean(v):
    return re.sub(r"\s+", " ", str(v or "")).strip().rstrip(".")


def parse_nrld(pdf_path):
    dams, seen = [], set()
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    if len(row) != 20 or not re.match(r"^[A-Z]{2}\d", str(row[1] or "")):
                        continue
                    pic = _clean(row[1])
                    lat, lng = _dms(row[4]), _dms(row[5])
                    if pic in seen or not lat or not lng or not (6 < lat < 37 and 68 < lng < 98):
                        continue
                    seen.add(pic)
                    storage = _num(row[15])
                    area = _num(row[16])
                    dams.append({
                        "id": f"nrld-{pic}",
                        "name": _clean(row[2]).title(),
                        "country": "India",
                        "state": STATES.get(pic[:2], ""),
                        "lat": lat, "lng": lng,
                        "river": _clean(row[8]), "basin": _clean(row[7]), "nearest_city": _clean(row[9]),
                        "type": _clean(row[11]).replace("_", " "),
                        "year": _clean(row[6]),
                        "height_m": _num(row[12]),
                        "length_m": _num(row[13]),
                        "gross_storage_mm3": round(storage / 1e6, 3) if storage else None,
                        "reservoir_area_km2": round(area / 1e6, 3) if area else None,
                        "spillway_m3s": _num(row[19]),
                        "catchment_km2": None,
                        "source": "CWC National Register of Large Dams 2019",
                    })
    return dams


# Unnamed or non-dam features that OSM mappers tagged as dams / reservoirs.
JUNK = re.compile(r"^(bridge|embankment|dam|reservoir|water reserv\w*)$|\?|pond|pokhari$", re.I)


def _overpass(query):
    for attempt in range(3):
        r = httpx.post(OVERPASS, data={"data": query}, headers=UA, timeout=180)
        if r.status_code == 200:
            return r.json()["elements"]
        time.sleep(10 * (attempt + 1))  # 429 / 504: the public server is busy
    r.raise_for_status()


def fetch_nepal():
    """Named dams and reservoirs in Nepal from OSM, plus the documented sites from NEPAL_PUBLISHED."""
    out, seen = [], set()
    for sel in ('nwr["waterway"="dam"]["name"](area.np);', 'nwr["water"="reservoir"]["name"](area.np);'):
        q = f'[out:json][timeout:120];area["ISO3166-1"="NP"]->.np;{sel}out center tags;'
        for e in _overpass(q):
            tags = e.get("tags", {})
            name = tags.get("name:en") or tags.get("name")
            c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
            if not name or c.get("lat") is None or name.lower() in seen or JUNK.search(name):
                continue
            seen.add(name.lower())
            out.append({
                "id": f"osm-{e['type'][0]}{e['id']}",
                "name": name, "country": "Nepal", "state": "",
                "lat": round(c["lat"], 5), "lng": round(c["lon"], 5),
                "river": tags.get("river", ""), "basin": "", "nearest_city": "",
                "type": "Dam" if tags.get("waterway") == "dam" else "Reservoir",
                "year": tags.get("start_date", "")[:4],
                "height_m": _num(tags.get("height")), "length_m": None,
                "gross_storage_mm3": None, "reservoir_area_km2": None, "spillway_m3s": None,
                "catchment_km2": None, "source": "OpenStreetMap",
            })
        time.sleep(2)

    for key, pub in NEPAL_PUBLISHED.items():
        fields = {k: v for k, v in pub.items() if k not in ("match", "lookup")}
        hit = next((d for d in out if re.search(pub["match"], d["name"], re.I)), None)
        if not hit:
            loc = _nominatim(pub["lookup"])
            if not loc:
                print(f"  note: {pub['name']}: no verified location in OSM, skipped")
                continue
            hit = {"id": f"np-{key}", "country": "Nepal", "state": "", "basin": "", "nearest_city": "",
                   "year": "", "spillway_m3s": None, **loc}
            out.append(hit)
        hit.update(fields)
        hit["source"] = f"Location: OpenStreetMap. Figures: {pub['source']}"
    return out


def _nominatim(query):
    time.sleep(1.1)  # Nominatim usage policy: max 1 request per second
    r = httpx.get("https://nominatim.openstreetmap.org/search", headers=UA, timeout=30,
                  params={"q": query, "format": "json", "limit": 5, "countrycodes": "np"})
    hits = [h for h in r.json() if h.get("class") == "water"]
    if not hits:
        return None
    # A lake / reservoir centre. The flood model finds the actual outlet from the terrain.
    return {"lat": round(float(hits[0]["lat"]), 5), "lng": round(float(hits[0]["lon"]), 5),
            "location_is": "lake_centre"}


def main():
    CACHE.mkdir(exist_ok=True)
    pdf = CACHE / "nrld-2019.pdf"
    if not pdf.exists():
        print("Downloading NRLD 2019 ...")
        r = httpx.get(NRLD_URL, headers=UA, timeout=300, follow_redirects=True)
        r.raise_for_status()
        pdf.write_bytes(r.content)
    t = time.time()
    india = parse_nrld(pdf)
    print(f"India: {len(india)} dams from NRLD 2019 ({time.time() - t:.0f}s)")
    try:
        nepal = fetch_nepal()
        print(f"Nepal: {len(nepal)} dams / reservoirs / lakes from OpenStreetMap")
    except Exception as e:  # keep India even if Overpass is down
        print(f"Nepal fetch failed ({e}); keeping previous Nepal entries if any")
        old = json.loads(OUT.read_text()) if OUT.exists() else {"dams": []}
        nepal = [d for d in old["dams"] if d["country"] == "Nepal"]
    OUT.write_text(json.dumps({
        "_note": "Built by scripts/build_dam_catalog.py. India: CWC NRLD 2019. Nepal: OpenStreetMap "
                 "+ published figures. Verify values before operational use.",
        "built": time.strftime("%Y-%m-%d"),
        "dams": india + nepal,
    }, ensure_ascii=False, separators=(",", ":")))
    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    sys.exit(main())
