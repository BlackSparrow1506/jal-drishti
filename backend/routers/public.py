"""Endpoints used by the citizen app."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services import akashwani, simulation
from services.alerts import ALERTS
from services.data_store import DEFAULT_SCENARIO, PLACES, RIVER, SCENARIOS, active_scenario
from services.medibot import reply as medibot_reply
from services.risk_engine import assess_point, zones_geojson
from services.routing import evacuation_plan

router = APIRouter(prefix="/api", tags=["citizen"])


@router.get("/overview")
def overview():
    """Dam info, active scenario and demo locations in a single call for app start-up."""
    sc = active_scenario()
    return {
        "dam": RIVER["dam"],
        "active_scenario": sc,
        "scenarios": list(SCENARIOS.values()),
        "demo_locations": PLACES["demo_locations"],
        "sample_data": True,
    }


@router.get("/risk")
def risk(lat: float = Query(..., ge=-90, le=90), lng: float = Query(..., ge=-180, le=180)):
    return assess_point(lat, lng)


@router.get("/zones")
def zones(scenario_id: str | None = None):
    return zones_geojson(scenario_id)


@router.get("/places")
def places():
    return {"shelters": PLACES["shelters"], "facilities": PLACES["facilities"]}


class RouteRequest(BaseModel):
    lat: float
    lng: float
    mode: Literal["walk", "drive"] = "walk"


@router.post("/route")
async def route(req: RouteRequest):
    return await evacuation_plan(req.lat, req.lng, req.mode)


@router.get("/simulation")
def run_simulation(
    scenario_id: str | None = None,
    volume_mm3: float | None = Query(None, ge=1, le=500),
    height_m: float | None = Query(None, ge=5, le=300),
    formation_min: float | None = Query(None, ge=5, le=240),
    failure_mode: Literal["overtopping", "piping"] | None = None,
):
    """SPH + Delft3D flood-wave timeline. Missing inputs fall back to the scenario defaults."""
    sid = scenario_id or (active_scenario() or {}).get("id") or DEFAULT_SCENARIO
    if sid not in SCENARIOS:
        raise HTTPException(status_code=404, detail="Unknown scenario")
    b = SCENARIOS[sid]["breach"]
    return simulation.run_simulation(
        sid,
        round(volume_mm3 if volume_mm3 is not None else b["volume_mm3"], 1),
        round(height_m if height_m is not None else b["height_m"], 1),
        round(formation_min if formation_min is not None else b["formation_min"], 1),
        failure_mode or b["failure_mode"],
    )


@router.get("/simulation/terrain")
def simulation_terrain():
    """Terrain grid for the 3D view (synthetic DEM around the river, local metres)."""
    return simulation.terrain()


@router.get("/alerts")
def alerts(limit: int = 30):
    return ALERTS[:limit]


@router.get("/akashwani/status")
def akashwani_status():
    return akashwani.status()


class ChatRequest(BaseModel):
    message: str
    lang: str = "en"


@router.post("/medibot")
def medibot(req: ChatRequest):
    return medibot_reply(req.message, req.lang)
