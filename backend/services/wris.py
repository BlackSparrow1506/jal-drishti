"""India-WRIS (CWC + NRSC) reservoir storage, via the public dataset API.

Request format follows github.com/DrJagadeeshG/india-water-data (POST /Dataset/Reservoir with
stateName, districtName, agencyName, startdate, enddate). WRIS is often unreachable from outside
India, so every call has a short timeout and the app treats "unavailable" as a normal answer.
The response schema is not documented, so records are returned as-is after matching the dam name.
"""
import re
import time
from datetime import date, timedelta

import httpx

WRIS = "https://indiawris.gov.in/Dataset/Reservoir"
NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
UA = {"User-Agent": "JalDrishti/0.2 (SIH 2026 prototype)"}
_cache = {}


def _district(lat, lng):
    try:
        r = httpx.get(NOMINATIM, headers=UA, timeout=10,
                      params={"lat": lat, "lon": lng, "format": "json", "zoom": 10})
        a = r.json().get("address", {})
        return (a.get("state_district") or a.get("county") or "").replace(" District", "")
    except httpx.HTTPError:
        return ""


def latest_storage(dam):
    if dam.get("country") != "India":
        return {"status": "not_applicable", "note": "India-WRIS covers Indian reservoirs only."}
    key = dam["id"]
    if key in _cache and time.time() - _cache[key][0] < 3600:
        return _cache[key][1]
    district = _district(dam["lat"], dam["lng"])
    params = {"stateName": dam.get("state", ""), "districtName": district, "agencyName": "CWC",
              "startdate": (date.today() - timedelta(days=30)).isoformat(),
              "enddate": date.today().isoformat(), "download": "false", "page": 0, "size": 500}
    try:
        r = httpx.post(WRIS, params=params, headers=UA, timeout=8)
        r.raise_for_status()
        records = r.json().get("data") or []
    except (httpx.HTTPError, ValueError) as e:
        out = {"status": "unreachable", "note": f"India-WRIS did not respond ({type(e).__name__}). "
               "It is usually reachable only from Indian networks.", "query": params}
        _cache[key] = (time.time(), out)
        return out
    words = [w for w in re.findall(r"[a-z]{4,}", dam["name"].lower())]
    hits = [rec for rec in records if any(w in str(rec).lower() for w in words)]
    out = {"status": "ok" if hits else "no_match", "query": params, "records": hits[-10:],
           "note": None if hits else f"WRIS returned {len(records)} records for {district}, none named like this dam."}
    _cache[key] = (time.time(), out)
    return out
