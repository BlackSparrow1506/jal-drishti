# Jal Drishti mobile app

Team Bluemoon, Smart India Hackathon 2026 (SIH26161, Dam Break Inundation Modelling).

One React Native codebase that runs on **Android and iOS**, plus a **FastAPI (Python)** backend.
The whole project opens and runs in VS Code. No Android Studio, Xcode or Flutter needed for development.

> **Prototype notice.** Flood zones, arrival times, populations and relief camps are **sample data**
> around the Mutha river downstream of Khadakwasla Dam, Pune. The risk engine is a simplified
> stand-in for SPH / Delft3D results. Do not use it for real emergency decisions.

## What's inside

```
jal-drishti/
├── mobile/                  React Native app (Expo SDK 57, JavaScript)
│   ├── App.js               Navigation: citizen tabs, officer tabs, Settings, SOS
│   └── src/
│       ├── config.js        Finds the backend automatically (same Wi-Fi)
│       ├── context/         Global state: location, risk, alerts, language, role
│       ├── services/        api.js (with offline cache), socket.js (live alerts)
│       ├── components/      RiskHero (water gauge), FloodMap, AlertCard, UI kit,
│       │                    Flood3D (three.js on expo-gl), Hydrograph (SVG)
│       ├── screens/         Home, Map, Evacuate, Alerts, MediBot, SOS, Settings,
│       │                    OfficerDashboard, Broadcast, Simulation
│       └── i18n/strings.js  English, Hindi, Marathi
├── backend/                 FastAPI
│   ├── main.py              App entry + WebSocket /ws/alerts
│   ├── routers/             public.py (citizen), officer.py (PIN protected)
│   ├── services/            risk_engine, routing (time-aware), akashwani,
│   │                        medibot (scripted), alerts, geo, simulation (SPH + Delft3D stand-in)
│   ├── data/                river.json, scenarios.json, places.json (SAMPLE)
│   └── tests/test_api.py    9 automated tests
└── .vscode/                 Debug configs for the backend
```

## Features mapped to the SIH deck

| Deck feature | Where in the app |
|---|---|
| View Risk and Stay Safe | Home: risk level, water gauge, live countdown to flood arrival |
| Real-time flood alerts / Akashwani alert | Alerts tab + live pop-up banner over any screen (WebSocket) |
| Location-based risk | Home + Map (GPS or demo locations) |
| Flood arrival time | Home countdown, Officer dashboard per area |
| Safe evacuation routes (time-aware) | Evacuate tab: compares when you reach each road point vs when water does |
| MediBot | MediBot tab (scripted first aid now, same API for an LLM later) |
| Disaster Officer: manage warning zones | Officer Dashboard: switch dam-break scenario, pushes to all phones |
| Identify people / infrastructure at risk | Officer Dashboard + Map "Populated areas" layer |
| Akashwani Monitor, Detect, Assess, Predict, Warn | Officer Dashboard pipeline with anomaly flags (z-score) |
| Broadcast warnings | Officer Broadcast tab |
| SPH near-field + Delft3D far-field simulation | Simulate tab (officer) or "Open 3D flood simulation" on Home (citizen) |
| 3D inundation view | Simulation: 3D terrain, flood water, SPH particles, areas turn red when flooded |
| Breach parameters, failure mode, hydrograph, timeline | Simulation: sliders, Overtopping / Piping, SPH vs Delft3D hydrograph, play / scrub |
| GIS export for responders | Simulation: share flood extent as GeoJSON or KML |

## One-time setup

You need: **Node.js 20 or newer**, **Python 3.10 or newer**, **VS Code**, and the **Expo Go** app on your phone
(Play Store / App Store, keep it updated so it supports SDK 57).

```bash
# Backend
cd backend
python -m venv .venv
# Windows:      .venv\Scripts\activate
# Mac / Linux:  source .venv/bin/activate
pip install -r requirements.txt

# Mobile
cd ../mobile
npm install
```

## Run it (two VS Code terminals)

**Terminal 1, backend**
```bash
cd backend
# activate the venv first (see above)
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```
Open http://localhost:8000/docs in your browser. You can test every API there without the app.

**Terminal 2, mobile**
```bash
cd mobile
npx expo start
```
Scan the QR code with Expo Go (Android) or the Camera app (iPhone). The app opens on your phone.

Phone and laptop must be on the **same Wi-Fi**. The app finds the backend automatically.

**Run it in a browser (same Expo server)**

With `npx expo start` running, press **`w`**, or open http://localhost:8081. Or start browser-only:
```bash
cd mobile
npx expo start --web
```
Differences in the browser:
- Maps use Leaflet with OpenStreetMap tiles; phones use native maps. `metro.config.js` makes this switch, so screens don't change.
- Confirmations (officer scenario switch, Broadcast) use the browser's own dialog.
- Simulation export downloads a `.geojson` / `.kml` file instead of opening the share sheet.
- 3D view: drag to rotate, mouse wheel to zoom.
- The backend is reached at `http://localhost:8000`. Browsing from another device? Set `EXPO_PUBLIC_API_URL` in `mobile/.env`.

## Debugging in VS Code

| What | How |
|---|---|
| See app logs | `console.log()` output appears in Terminal 2 |
| Breakpoints / network in the app | Press `j` in Terminal 2 to open React Native DevTools |
| Reload the app | Save any file (hot reload), or press `r` in Terminal 2 |
| Red error screen on phone | Read the file and line shown, fix, save |
| Breakpoints in the backend | Stop Terminal 1, then Run and Debug panel, choose "Backend: FastAPI (debug)" |
| Run backend tests | `pytest -q` inside `backend/`, or "Backend: run tests" in Run and Debug |
| Is the app talking to the server? | App: Settings, Server section shows the URL and connection status |

### Common problems

| Symptom | Fix |
|---|---|
| "Can't reach the Jal Drishti server" | Backend running with `--host 0.0.0.0`? Same Wi-Fi? On Windows, allow Python through the firewall for Private networks |
| College Wi-Fi blocks devices from seeing each other | Turn on your phone hotspot and connect the laptop to it |
| Still not connecting | Copy `mobile/.env.example` to `mobile/.env`, set your laptop IP, restart `npx expo start` |
| Expo Go says SDK not supported | Update Expo Go from the store |
| Map is blank | Needs internet for map tiles; check the phone has data |
| Browser shows a blank map or `react-native-maps` error | Restart `npx expo start` (with `-c`) so `metro.config.js` is picked up |

## Demo walkthrough (for judges)

1. **Home** opens at the demo location "Deccan riverside": red Extreme risk, water gauge, live countdown.
2. **Evacuate**: safest relief camp, travel time, and time to spare before water arrives. Toggle Walk / Drive.
3. **Map**: flood zones by severity, river, relief camps.
4. **MediBot**: tap "Snake bite" or type "not breathing".
5. **Settings**: switch to Disaster Officer (PIN `2026`).
6. **Dashboard**: Akashwani pipeline with anomalies; switch to scenario S2 "Full breach". Every connected phone updates.
7. **Broadcast**: send "Evacuate now". A second phone in citizen mode vibrates and shows the alert banner instantly.
8. **Simulate** (officer tab, or the dark "Open 3D flood simulation" card on Home): press Play.
   Drag the 3D view to rotate, pinch to zoom. Switch to Map for SPH / Delft3D extents.
   Try S2, switch Overtopping to Piping, or drag the breach sliders: the hydrograph and flood re-run.
9. **Settings**: change language to हिन्दी or मराठी.

## Cost check (college stage = ₹0)

| Piece | Cost now | Before going commercial |
|---|---|---|
| Expo, React Native, FastAPI, PostgreSQL / PostGIS | Free, open source | None |
| Map display (react-native-maps) | Free in Expo Go | Standalone Android builds need a Google Maps API key, or move to MapLibre + free tiles |
| Road routing (OSRM public demo server) | Free, testing only | Self-host OSRM with Docker (free) and set `OSRM_URL` |
| Google Earth Engine | Free for research / education | Commercial use needs a paid licence |
| MediBot | Scripted, free | Check current LLM API pricing before switching |
| App Store publishing | Not needed for demo | Apple developer account (yearly fee); Google Play one-time fee |

## Dam studio (any dam, real terrain)

Officer Dashboard → "Model any dam", or Simulation → "Model any dam (India / Nepal)".

1. Search 5,722 Indian dams (CWC National Register of Large Dams 2019) or 67 in Nepal (OpenStreetMap, with
   NEA / ICIMOD figures for Kulekhani, Tsho Rolpa and Imja Tsho). Data-quality warnings are shown per dam.
2. Enter capacity, current storage, rainfall (or use live Open-Meteo rain), breach width / depth / formation time.
3. "Check how rainfall affects the reservoir": level-pool routing shows level, freeboard, overtopping and breach time.
4. "Run inundation model": 2D local-inertial flood routing (LISFLOOD-FP scheme) on the real DEM with ESA WorldCover
   friction, then buildings, shops, hospitals, schools, roads and settlements from Overture Maps.
5. "Compare with satellite data": Sentinel-1 radar + Sentinel-2 vs JRC 1984-2021 water history; satellite storage
   estimate fed back into the model to show whether the prediction changes.

| Source | Used for | Access |
|---|---|---|
| CWC NRLD 2019 | Indian dam catalogue | `backend/scripts/build_dam_catalog.py` rebuilds `data/dams.json` |
| AWS Terrain Tiles (SRTM-based) | Terrain (default) | No key |
| OpenTopography COP30 | Terrain | Set `OPENTOPO_API_KEY` |
| Bhoonidhi CartoDEM / USGS EarthExplorer | Terrain | Drop the GeoTIFF in `backend/data/dem/` (needs their login to download) |
| Sentinel-1/2, JRC GSW, ESA WorldCover | Satellite check, 3D imagery, friction | Microsoft Planetary Computer, no key |
| Overture Maps | Buildings, shops, facilities, towns, roads | No key |
| Open-Meteo | Live rainfall | No key |
| India-WRIS (CWC + NRSC) | Reservoir storage | `/api/dams/{id}/wris`; usually reachable only from Indian networks |

Backend needs the new packages: `pip install -r requirements.txt`. Results are cached in `backend/cache/`.

## How to plug in your real simulation data

The app never needs to change. Only the backend files do:

| Replace | With |
|---|---|
| `data/river.json` centerline | River centerline extracted from your DEM (SRTM / ASTER) |
| `data/scenarios.json` + `assess_point()` in `services/risk_engine.py` | Lookups into DualSPHysics / Delft3D-FM outputs (NetCDF / GeoTIFF of depth, velocity, arrival time). Keep the same return fields |
| `zones_geojson()` | Flood extent polygons exported from your model (GeoJSON / SHP) |
| `data/places.json` | OSM hospitals / schools / bridges + census population, ideally from PostGIS |
| `services/akashwani.py` `_sample_series()` | GEE / gauge / rainfall feeds |
| `services/medibot.py` `reply()` | LLM call with the same input and output shape |
| `services/simulation.py` `run_simulation()` | Reader for DualSPHysics (near-field) + Delft3D-FM (far-field) output: hydrographs, depth and wet width per river cross-section per time step |
| `services/simulation.py` `terrain()` | Real DEM (SRTM / Cartosat) sampled on the same grid |

## Next steps (not in this version)

1. Push notifications when the app is closed (needs a development build via EAS, free tier).
2. PostgreSQL / PostGIS instead of in-memory data.
3. Proper officer accounts instead of a shared PIN.
4. Offline map tiles for the evacuation area.
5. LLM-powered, multilingual MediBot.
