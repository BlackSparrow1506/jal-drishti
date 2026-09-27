"""Loads the sample JSON data once. Swap these files for real simulation output later."""
import json
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def _load(name):
    with open(DATA_DIR / name, encoding="utf-8") as f:
        return json.load(f)


RIVER = _load("river.json")
SCENARIOS = {s["id"]: s for s in _load("scenarios.json")["scenarios"]}
DEFAULT_SCENARIO = _load("scenarios.json")["default_active"]
PLACES = _load("places.json")


class State:
    """In-memory runtime state. Replace with PostgreSQL / PostGIS later."""
    active_scenario_id = DEFAULT_SCENARIO
    # Time (epoch seconds) when the active scenario started, i.e. breach time T0.
    activated_at = time.time()


state = State()


def active_scenario():
    if state.active_scenario_id is None:
        return None
    return SCENARIOS.get(state.active_scenario_id)
