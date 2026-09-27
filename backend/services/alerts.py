"""Alert store and WebSocket broadcaster (Akashwani alerts)."""
import itertools
import time
from datetime import datetime, timezone

from fastapi import WebSocket

_ids = itertools.count(1)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


ALERTS = []


def add_alert(title, message, severity="HIGH", area="Mutha river downstream of Khadakwasla",
              source="Disaster Officer"):
    alert = {
        "id": next(_ids),
        "title": title,
        "message": message,
        "severity": severity,
        "area": area,
        "source": source,
        "created_at": _now_iso(),
        "ts": time.time(),
    }
    ALERTS.insert(0, alert)
    del ALERTS[100:]
    return alert


# Seed alerts so the app has something to show on first launch.
add_alert("Akashwani: reservoir level rising",
          "Khadakwasla reservoir is above normal level after heavy rainfall in the catchment. "
          "Monitoring is ongoing.", severity="MODERATE", source="Akashwani")
add_alert("Flood watch for riverside areas",
          "Residents of Warje, Erandwane and Deccan riverside areas should stay alert and "
          "keep an emergency kit ready.", severity="HIGH", source="Disaster Officer")


class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, payload: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()
