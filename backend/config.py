"""App settings. Override any value with an environment variable."""
import os

# Demo officer PIN. Change it before any real deployment.
OFFICER_PIN = os.getenv("OFFICER_PIN", "2026")
OFFICER_TOKEN = os.getenv("OFFICER_TOKEN", "demo-officer-token")

# Free public OSRM demo server: fine for development and demos only.
# For production, self-host OSRM with Docker (free) and point this URL to it.
OSRM_URL = os.getenv("OSRM_URL", "https://router.project-osrm.org")
OSRM_TIMEOUT_S = float(os.getenv("OSRM_TIMEOUT_S", "6"))

WALK_SPEED_KMPH = 4.5
