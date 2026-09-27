"""Akashwani monitoring stub.

Generates a deterministic sample time series of rainfall, reservoir level and inflow,
then flags anomalies with a rolling z-score. Replace `_sample_series` with real feeds
(GEE, CWC gauges, IMD rainfall) when available.
"""
import math
import statistics
from datetime import datetime, timedelta, timezone

from services.data_store import active_scenario

WINDOW = 12
Z_THRESHOLD = 2.0


def _sample_series(hours=48):
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    out = []
    for i in range(hours):
        t = now - timedelta(hours=hours - 1 - i)
        storm = max(0.0, i - 36) ** 1.6  # a rain event in the last 12 hours
        rain = 2 + 1.5 * math.sin(i / 3) + 0.9 * storm
        level = 88 + 0.05 * i + 0.25 * storm
        inflow = 120 + 10 * math.sin(i / 4) + 14 * storm
        out.append({"time": t.isoformat(), "rainfall_mm": round(rain, 1),
                    "reservoir_level_pct": round(min(level, 104), 1),
                    "inflow_cumecs": round(inflow, 1)})
    return out


def _zscore(values):
    if len(values) <= WINDOW:
        return 0.0
    base = values[-WINDOW - 1:-1]
    sd = statistics.pstdev(base) or 1e-6
    return (values[-1] - statistics.mean(base)) / sd


def status():
    series = _sample_series()
    metrics = {}
    for key, label, unit in (("rainfall_mm", "Rainfall", "mm/h"),
                             ("reservoir_level_pct", "Reservoir level", "%"),
                             ("inflow_cumecs", "Inflow", "m3/s")):
        vals = [p[key] for p in series]
        z = _zscore(vals)
        metrics[key] = {"label": label, "unit": unit, "latest": vals[-1],
                        "z_score": round(z, 2), "anomaly": abs(z) >= Z_THRESHOLD,
                        "recent": vals[-12:]}
    threat = any(m["anomaly"] for m in metrics.values())
    return {
        "stage": "WARN" if active_scenario() else ("ASSESS" if threat else "MONITOR"),
        "pipeline": ["MONITOR", "DETECT", "ASSESS", "PREDICT", "WARN"],
        "threat_detected": threat,
        "metrics": metrics,
        "note": "Sample data. Connect GEE / gauge feeds for real monitoring.",
    }
