"""Endpoints for the Disaster Officer mode. Protected by a simple demo token."""
import time
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from config import OFFICER_PIN, OFFICER_TOKEN
from services.alerts import add_alert, manager
from services.data_store import SCENARIOS, state
from services.risk_engine import impact_summary

router = APIRouter(prefix="/api/officer", tags=["officer"])


def require_officer(x_officer_token: str = Header(default="")):
    if x_officer_token != OFFICER_TOKEN:
        raise HTTPException(status_code=401, detail="Officer login required")


class LoginRequest(BaseModel):
    pin: str


@router.post("/login")
def login(req: LoginRequest):
    if req.pin != OFFICER_PIN:
        raise HTTPException(status_code=401, detail="Incorrect PIN")
    return {"token": OFFICER_TOKEN, "role": "officer"}


@router.get("/summary", dependencies=[Depends(require_officer)])
def summary():
    return impact_summary()


class ScenarioRequest(BaseModel):
    scenario_id: str | None = None  # None means stand down (no active threat)


@router.post("/scenario", dependencies=[Depends(require_officer)])
async def set_scenario(req: ScenarioRequest):
    if req.scenario_id is not None and req.scenario_id not in SCENARIOS:
        raise HTTPException(status_code=404, detail="Unknown scenario")
    state.active_scenario_id = req.scenario_id
    state.activated_at = time.time()
    sc = SCENARIOS.get(req.scenario_id) if req.scenario_id else None
    await manager.broadcast({"type": "scenario", "scenario": sc})
    return {"active_scenario": sc}


class AlertRequest(BaseModel):
    title: str = Field(min_length=3, max_length=120)
    message: str = Field(min_length=3, max_length=1000)
    severity: Literal["EXTREME", "HIGH", "MODERATE", "INFO"] = "HIGH"
    area: str = "Mutha river downstream of Khadakwasla"


@router.post("/alerts", dependencies=[Depends(require_officer)])
async def broadcast_alert(req: AlertRequest):
    alert = add_alert(req.title, req.message, req.severity, req.area)
    await manager.broadcast({"type": "alert", "alert": alert})
    return alert
