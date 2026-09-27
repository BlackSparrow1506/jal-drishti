"""Jal Drishti API.

Run for development (phone and laptop on the same Wi-Fi):
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
Interactive API docs: http://localhost:8000/docs
"""
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from routers import officer, public, studio
from services.alerts import manager

app = FastAPI(title="Jal Drishti API", version="0.2.0")
app.add_middleware(GZipMiddleware, minimum_size=2000)  # 3D scenes shrink ~10x

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for production
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(public.router)
app.include_router(officer.router)
app.include_router(studio.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.websocket("/ws/alerts")
async def ws_alerts(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            await ws.receive_text()  # keep-alive pings from the app
    except WebSocketDisconnect:
        manager.disconnect(ws)
