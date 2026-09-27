"""Run with:  pytest -q   (from the backend folder)"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)
OFFICER = {"X-Officer-Token": "demo-officer-token"}


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_risk_levels_by_location():
    riverside = client.get("/api/risk", params={"lat": 18.5150, "lng": 73.8465}).json()
    kothrud = client.get("/api/risk", params={"lat": 18.5074, "lng": 73.8077}).json()
    assert riverside["level"] in ("EXTREME", "HIGH")
    assert riverside["arrival_in_min"] is not None
    assert kothrud["level"] == "SAFE"


def test_zones_geojson():
    fc = client.get("/api/zones").json()
    kinds = [f["properties"]["kind"] for f in fc["features"]]
    assert kinds.count("zone") == 3 and "river" in kinds


def test_route_returns_plan():
    plan = client.post("/api/route", json={"lat": 18.5150, "lng": 73.8465, "mode": "walk"}).json()
    assert plan["best"]["status"] in ("SAFE", "CAUTION", "UNSAFE")
    assert len(plan["best"]["coords"]) >= 2


def test_medibot():
    r = client.post("/api/medibot", json={"message": "snake bite on leg"}).json()
    assert r["intent"] == "snake"


def test_officer_flow():
    assert client.post("/api/officer/login", json={"pin": "0000"}).status_code == 401
    tok = client.post("/api/officer/login", json={"pin": "2026"}).json()["token"]
    h = {"X-Officer-Token": tok}
    assert client.get("/api/officer/summary").status_code == 401
    s = client.get("/api/officer/summary", headers=h).json()
    assert s["population_by_level"]["EXTREME"] >= 0
    assert client.post("/api/officer/scenario", json={"scenario_id": "S2"}, headers=h).status_code == 200
    a = client.post("/api/officer/alerts", headers=h,
                    json={"title": "Evacuate now", "message": "Move to high ground", "severity": "EXTREME"}).json()
    assert client.get("/api/alerts").json()[0]["id"] == a["id"]
    client.post("/api/officer/scenario", json={"scenario_id": "S1"}, headers=h)


def test_websocket_receives_alert():
    tok = client.post("/api/officer/login", json={"pin": "2026"}).json()["token"]
    with client.websocket_connect("/ws/alerts") as ws:
        client.post("/api/officer/alerts", headers={"X-Officer-Token": tok},
                    json={"title": "Test alert", "message": "Testing live alerts"})
        msg = ws.receive_json()
        assert msg["type"] == "alert" and msg["alert"]["title"] == "Test alert"


def test_simulation_defaults_and_overrides():
    sim = client.get("/api/simulation", params={"scenario_id": "S2"}).json()
    assert sim["scenario"]["id"] == "S2"
    assert len(sim["frames"]) == 121 and len(sim["stations"]) == 32
    assert sim["peak_q_m3s"] > sim["peak_q_delft_m3s"] > 0  # far-field peak is attenuated
    piping = client.get("/api/simulation", params={"scenario_id": "S2", "failure_mode": "piping"}).json()
    assert piping["peak_q_m3s"] < sim["peak_q_m3s"]
    assert client.get("/api/simulation", params={"scenario_id": "nope"}).status_code == 404


def test_simulation_terrain():
    ter = client.get("/api/simulation/terrain").json()
    assert len(ter["z_m"]) == ter["nx"] * ter["ny"] == len(ter["chainage_km"])
    assert ter["dam_m"] == [0, 0]


def test_medibot_detailed_answers():
    r = client.post("/api/medibot", json={"message": "my child has loose motion and vomiting"}).json()
    assert r["intent"] == "water" and len(r["steps"]) >= 5 and r["dont"] and r["get_help"]
    assert client.post("/api/medibot", json={"message": "सांप ने काटा"}).json()["intent"] == "snake"
    assert client.post("/api/medibot", json={"message": "hello"}).json()["intent"] == "fallback"


def test_dam_catalogue_india_and_nepal():
    r = client.get("/api/dams/search", params={"q": "khadakwasla"}).json()
    assert r["results"][0]["country"] == "India" and r["results"][0]["lat"]
    nepal = client.get("/api/dams/search", params={"q": "kulekhani", "country": "Nepal"}).json()["results"]
    assert nepal and nepal[0]["gross_storage_mm3"] == 85.3


def test_reservoir_routing_rain_causes_overtopping():
    from services import hydro
    base = dict(height_m=40, length_m=300, gross_storage_mm3=50, reservoir_area_km2=3, catchment_km2=400,
                runoff_coeff=0.6, spillway_m3s=0, dam_type="Earthfill", failure_mode="overtopping",
                breach_width_m=60, breach_depth_m=35, formation_h=1, side_slope=1, storage_pct=95, rain_hours=24)
    dry = hydro.route_reservoir({**base, "rain_mm": 0, "breach_trigger": "auto"})
    storm = hydro.route_reservoir({**base, "rain_mm": 300, "breach_trigger": "auto"})
    assert dry["status"] == "safe" and storm["status"] == "breach" and storm["peak_breach_m3s"] > 1000


def test_flood_solver_conserves_mass():
    import numpy as np
    from services import flood2d
    jj, ii = np.mgrid[0:40, 0:100]
    z = 100 - ii * 0.1 + 0.02 * (jj - 20) ** 2
    r = flood2d.simulate(z, np.full(z.shape, 0.04), 50.0, np.full(100, 500.0), 60.0, [(20, 3)], 3600)
    balance = r["volume_in_mm3"] - r["volume_out_mm3"] - r["volume_left_mm3"]
    assert abs(balance) < 0.01 * r["volume_in_mm3"]
