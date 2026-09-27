"""Dam studio API: pick any dam, enter breach and rainfall inputs, run the inundation model on real
terrain, and compare with what satellites see now."""
import hashlib
import json
import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from services import dam_catalog, hydro, satellite, studio, wris

router = APIRouter(prefix="/api", tags=["dam studio"])


# ------------------------------------------------------------------ dam catalogue

@router.get("/dams/search")
def dams_search(q: str = "", country: Literal["India", "Nepal"] | None = None, limit: int = Query(30, le=100)):
    return {"results": dam_catalog.search(q, country, limit), "stats": dam_catalog.stats()}


@router.get("/dams/osm")
def dams_osm(q: str = Query(..., min_length=3, max_length=60)):
    """Live search of named dams and reservoirs anywhere (OpenStreetMap)."""
    try:
        return {"results": dam_catalog.search_osm(q)}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"OpenStreetMap search unavailable: {type(e).__name__}")


@router.get("/dams/{dam_id}")
def dam(dam_id: str):
    d = dam_catalog.get(dam_id)
    if not d:
        raise HTTPException(status_code=404, detail="Unknown dam")
    return d


@router.get("/dams/{dam_id}/prepare")
def prepare(dam_id: str, reach_km: float = Query(25, ge=3, le=60),
            failure_mode: Literal["overtopping", "piping"] = "overtopping"):
    """Everything needed to pre-fill the input form: terrain analysis, live rainfall, breach suggestion."""
    d = dam_catalog.get(dam_id)
    if not d:
        raise HTTPException(status_code=404, detail="Unknown dam")
    site = hydro.analyse_site(d["lat"], d["lng"], reach_km, float(d.get("height_m") or 30),
                              d.get("location_is") == "lake_centre", float(d.get("reservoir_area_km2") or 0))
    try:
        rain = hydro.rainfall(d["lat"], d["lng"])
    except Exception as e:
        rain = {"error": f"Live rainfall unavailable ({type(e).__name__})"}
    suggestion = None
    if d.get("height_m") and d.get("gross_storage_mm3"):
        suggestion = hydro.suggest_breach({**d, "failure_mode": failure_mode})
    return {"dam": d, "site": site, "rainfall": rain, "suggested_breach": suggestion}


@router.get("/dams/{dam_id}/wris")
def dam_wris(dam_id: str):
    d = dam_catalog.get(dam_id)
    if not d:
        raise HTTPException(status_code=404, detail="Unknown dam")
    return wris.latest_storage(d)


# ------------------------------------------------------------------ model inputs

class StudioInputs(BaseModel):
    dam_id: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    location_is: str | None = None
    type: str = ""
    height_m: float = Field(ge=2, le=350)
    length_m: float | None = Field(None, ge=5, le=20000)
    gross_storage_mm3: float = Field(ge=0.01, le=60000)
    reservoir_area_km2: float | None = Field(None, ge=0.001, le=5000)
    catchment_km2: float | None = Field(None, ge=0.1, le=1_000_000)
    spillway_m3s: float | None = Field(0, ge=0, le=200_000)
    freeboard_m: float | None = Field(None, ge=0.2, le=30)
    storage_pct: float = Field(90, ge=0, le=120)
    rain_mm: float = Field(0, ge=0, le=3000)
    rain_hours: int = Field(24, ge=1, le=168)
    rain_source: Literal["manual", "live"] = "manual"
    rain_window: Literal["past", "next"] = "next"
    runoff_coeff: float = Field(0.5, ge=0.05, le=1.0)
    breach_width_m: float = Field(ge=1, le=3000)
    breach_depth_m: float = Field(ge=0.5, le=350)
    formation_h: float = Field(ge=0.05, le=24)
    side_slope: float = Field(1.0, ge=0, le=3)
    failure_mode: Literal["overtopping", "piping"] = "overtopping"
    breach_trigger: Literal["auto", "now", "none"] = "auto"
    reach_km: float = Field(25, ge=3, le=60)
    flood_hours: float = Field(6, ge=1, le=24)


def _clean(p: StudioInputs):
    d = p.model_dump()
    d["breach_depth_m"] = min(d["breach_depth_m"], d["height_m"])
    if d.get("length_m"):
        d["breach_width_m"] = min(d["breach_width_m"], d["length_m"])
    return d


@router.post("/studio/reservoir")
def reservoir_preview(p: StudioInputs):
    """Fast water-balance preview (no flood routing): how rainfall changes the reservoir and breach."""
    d = _clean(p)
    rain_series = None
    if d["rain_source"] == "live":
        try:
            live = hydro.rainfall(d["lat"], d["lng"])
            k = live["now_index"]
            rain_series = (live["mm"][max(0, k - d["rain_hours"]):k] if d["rain_window"] == "past"
                           else live["mm"][k:k + d["rain_hours"]])
        except Exception:
            rain_series = None
    if not d.get("catchment_km2"):
        site = hydro.analyse_site(d["lat"], d["lng"], d["reach_km"], d["height_m"],
                                  d.get("location_is") == "lake_centre", float(d.get("reservoir_area_km2") or 0))
        d["catchment_km2"] = site["catchment_km2"]
    r = hydro.route_reservoir({**d, "dam_type": d["type"]}, rain_series)
    r.pop("_q_down", None)
    r.pop("_dt", None)
    r["catchment_used_km2"] = d["catchment_km2"]
    return r


@router.post("/studio/runs")
def start_run(p: StudioInputs):
    rid = studio.start(_clean(p))
    return studio.status(rid)


@router.get("/studio/runs/{rid}")
def run_status(rid: str):
    s = studio.status(rid)
    if not s:
        raise HTTPException(status_code=404, detail="Unknown run")
    return s


@router.get("/studio/runs/{rid}/scene")
def run_scene(rid: str):
    s = studio.status(rid)
    if not s or s["status"] != "done":
        raise HTTPException(status_code=409, detail="Run not finished")
    return studio.scene(rid)


@router.get("/studio/runs/{rid}/overlay/{layer}.png")
def run_overlay(rid: str, layer: Literal["frame", "max", "arrival", "hazard"], k: int = 0):
    s = studio.status(rid)
    if not s or s["status"] != "done":
        raise HTTPException(status_code=409, detail="Run not finished")
    return Response(studio.overlay_png(rid, layer, k), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/studio/compare")
def compare_runs(a: str, b: str):
    for rid in (a, b):
        s = studio.status(rid)
        if not s or s["status"] != "done":
            raise HTTPException(status_code=409, detail=f"Run {rid} not finished")
    return studio.compare(a, b)


# ------------------------------------------------------------------ satellite check

_SAT = {}  # key -> (time, result with PNG layers)


class SatelliteRequest(BaseModel):
    inputs: StudioInputs
    run_id: str | None = None


@router.post("/studio/satellite")
def satellite_check(req: SatelliteRequest):
    """Satellite now vs baseline vs model, and whether the prediction changes with satellite storage."""
    d = _clean(req.inputs)
    dam = dam_catalog.get(d["dam_id"]) or {**d, "name": d["dam_id"], "country": ""}
    dam = {**dam, "reservoir_area_km2": d.get("reservoir_area_km2") or dam.get("reservoir_area_km2")}
    site = hydro.analyse_site(d["lat"], d["lng"], d["reach_km"], d["height_m"],
                              d.get("location_is") == "lake_centre", float(d.get("reservoir_area_km2") or 0))
    user_route = hydro.route_reservoir({**d, "catchment_km2": d.get("catchment_km2") or site["catchment_km2"],
                                        "dam_type": d["type"]})
    model_hmax = model_grid = None
    if req.run_id and (studio.status(req.run_id) or {}).get("status") == "done":
        model_hmax = studio._load_arrays(req.run_id)["hmax"]
        model_grid = studio._grid_of(studio._load_json(req.run_id))
    try:
        sat = satellite.compare(dam, site, d["reach_km"], model_hmax, model_grid,
                                user_route["stage_storage_exponent"])
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Satellite data unavailable: {type(e).__name__}: {e}")

    key = hashlib.sha1(json.dumps([d, req.run_id, time.strftime("%Y%m%d%H")], sort_keys=True).encode()).hexdigest()[:16]
    _SAT[key] = (time.time(), sat.pop("layers"))
    for k in [k for k, v in _SAT.items() if time.time() - v[0] > 6 * 3600]:
        _SAT.pop(k, None)

    # Does the prediction change if we use what the satellite sees instead of the user's input?
    check = None
    sat_pct = sat.get("reservoir", {}).get("implied_storage_pct")
    if sat_pct is not None:
        sat_route = hydro.route_reservoir({**d, "storage_pct": sat_pct,
                                           "catchment_km2": d.get("catchment_km2") or site["catchment_km2"],
                                           "dam_type": d["type"]})
        fields = ("status", "initial_level_m", "peak_level_m", "freeboard_left_m", "overtop_at_h",
                  "breach_at_h", "peak_outflow_m3s", "released_mm3")
        check = {"user": {"storage_pct": d["storage_pct"], **{f: user_route[f] for f in fields}},
                 "satellite": {"storage_pct": sat_pct, **{f: sat_route[f] for f in fields}},
                 "changed": user_route["status"] != sat_route["status"] or
                 abs(user_route["peak_outflow_m3s"] - sat_route["peak_outflow_m3s"]) >
                 0.1 * max(1, user_route["peak_outflow_m3s"])}
    return {**sat, "layers_key": key, "layers": list(_SAT[key][1].keys()), "prediction_check": check}


@router.get("/studio/satellite/{key}/{layer}.png")
def satellite_layer(key: str, layer: Literal["change", "baseline"]):
    hit = _SAT.get(key)
    if not hit or layer not in hit[1]:
        raise HTTPException(status_code=404, detail="Layer expired; run the satellite check again")
    return Response(hit[1][layer], media_type="image/png")
