"""Digital elevation model (DEM) access.

Sources, in order of preference:
  1. Local GeoTIFFs in backend/data/dem/ (drop in CartoDEM from Bhoonidhi, SRTM / ASTER from
     USGS EarthExplorer, or a COP30 / SRTM download from OpenTopography). Any CRS works; the
     file is reprojected on read.
  2. OpenTopography Global DEM API (Copernicus GLO-30) when OPENTOPO_API_KEY is set.
  3. AWS Terrain Tiles (terrarium PNG, no key). Built from SRTM, GMTED2010, ETOPO1 and national
     datasets; about 30 m ground resolution at zoom 12 in India and Nepal.

Everything is returned on a local metric grid centred on the area of interest:
x east, y north, in metres, row 0 = south edge.
"""
import io
import math
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TILE_CACHE = ROOT / "cache" / "dem"
LOCAL_DEM_DIR = ROOT / "data" / "dem"
TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
OPENTOPO = "https://portal.opentopography.org/API/globaldem"
UA = {"User-Agent": "JalDrishti/0.2 (SIH 2026 prototype)"}
M_PER_DEG_LAT = 110_574.0


@dataclass
class Grid:
    """A regular local grid. Cell (j, i) centre is at (x0 + i*cell, y0 + j*cell) metres."""
    lat0: float          # grid origin reference (centre of the area of interest)
    lng0: float
    x0: float
    y0: float
    cell: float
    nx: int
    ny: int

    @property
    def m_per_deg_lng(self):
        return 111_320.0 * math.cos(math.radians(self.lat0))

    def xy(self, lat, lng):
        return ((lng - self.lng0) * self.m_per_deg_lng, (lat - self.lat0) * M_PER_DEG_LAT)

    def latlng(self, x, y):
        return (self.lat0 + y / M_PER_DEG_LAT, self.lng0 + x / self.m_per_deg_lng)

    def ij(self, lat, lng):
        x, y = self.xy(lat, lng)
        return int(round((x - self.x0) / self.cell)), int(round((y - self.y0) / self.cell))

    def cell_latlng(self):
        """Arrays (lat, lng) of every cell centre, shape (ny, nx)."""
        xs = self.x0 + np.arange(self.nx) * self.cell
        ys = self.y0 + np.arange(self.ny) * self.cell
        X, Y = np.meshgrid(xs, ys)
        return self.lat0 + Y / M_PER_DEG_LAT, self.lng0 + X / self.m_per_deg_lng

    def bounds(self):
        """(south, west, north, east) of the cell centres, degrees."""
        s, w = self.latlng(self.x0, self.y0)
        n, e = self.latlng(self.x0 + (self.nx - 1) * self.cell, self.y0 + (self.ny - 1) * self.cell)
        return s, w, n, e

    def to_dict(self):
        s, w, n, e = self.bounds()
        half = self.cell / 2
        ds, dw = half / M_PER_DEG_LAT, half / self.m_per_deg_lng
        return {"nx": self.nx, "ny": self.ny, "cell_m": round(self.cell, 2),
                "bounds": [round(s - ds, 6), round(w - dw, 6), round(n + ds, 6), round(e + dw, 6)],
                "origin": [self.lat0, self.lng0], "x0": round(self.x0, 1), "y0": round(self.y0, 1)}


def grid_around(lat, lng, half_w_m, half_h_m, cell_m, cx=0.0, cy=0.0):
    nx = int(math.ceil(2 * half_w_m / cell_m)) + 1
    ny = int(math.ceil(2 * half_h_m / cell_m)) + 1
    return Grid(lat, lng, cx - half_w_m, cy - half_h_m, cell_m, nx, ny)


# ------------------------------------------------------------------ terrarium tiles

def _tile_xy(lat, lng, z):
    n = 2 ** z
    x = (lng + 180.0) / 360.0 * n
    y = (1.0 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def _fetch_tile(client, z, x, y):
    path = TILE_CACHE / str(z) / str(x) / f"{y}.png"
    if not path.exists():
        r = client.get(TERRARIUM.format(z=z, x=x, y=y))
        r.raise_for_status()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.content)
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


def _terrarium_sample(lat, lng, zoom):
    """Bilinear sample of terrarium elevation at arrays of lat/lng."""
    fx, fy = _tile_xy(lat, lng, zoom)
    px, py = fx * 256.0 - 0.5, fy * 256.0 - 0.5
    tx0, tx1 = int(np.floor(px.min() / 256)), int(np.floor(px.max() / 256)) + 1
    ty0, ty1 = int(np.floor(py.min() / 256)), int(np.floor(py.max() / 256)) + 1
    tiles = [(x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)]
    if len(tiles) > 400:
        raise ValueError("Area too large for this zoom level")
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), dtype=np.float32)
    with httpx.Client(headers=UA, timeout=30) as client, ThreadPoolExecutor(8) as pool:
        arrays = list(pool.map(lambda t: _fetch_tile(client, zoom, *t), tiles))
    for (x, y), a in zip(tiles, arrays):
        mosaic[(y - ty0) * 256:(y - ty0 + 1) * 256, (x - tx0) * 256:(x - tx0 + 1) * 256] = a
    mx, my = px - tx0 * 256, py - ty0 * 256
    x0 = np.clip(np.floor(mx).astype(int), 0, mosaic.shape[1] - 2)
    y0 = np.clip(np.floor(my).astype(int), 0, mosaic.shape[0] - 2)
    wx, wy = np.clip(mx - x0, 0, 1), np.clip(my - y0, 0, 1)
    top = mosaic[y0, x0] * (1 - wx) + mosaic[y0, x0 + 1] * wx
    bot = mosaic[y0 + 1, x0] * (1 - wx) + mosaic[y0 + 1, x0 + 1] * wx
    return top * (1 - wy) + bot * wy


# ------------------------------------------------------------------ GeoTIFF sources

def _geotiff_sample(path, lat, lng):
    import rasterio
    from rasterio.warp import transform as warp_transform

    with rasterio.open(path) as ds:
        xs, ys = lng.ravel(), lat.ravel()
        if ds.crs and ds.crs.to_epsg() != 4326:
            xs, ys = warp_transform("EPSG:4326", ds.crs, xs.tolist(), ys.tolist())
        vals = np.array([v[0] for v in ds.sample(zip(xs, ys))], dtype=np.float32)
        if ds.nodata is not None:
            vals[vals == ds.nodata] = np.nan
    return vals.reshape(lat.shape)


def _local_geotiff_for(bounds):
    """First GeoTIFF in data/dem/ that fully covers the bounds, or None."""
    if not LOCAL_DEM_DIR.exists():
        return None
    try:
        import rasterio
        from rasterio.warp import transform_bounds
    except ImportError:
        return None
    s, w, n, e = bounds
    for path in sorted(LOCAL_DEM_DIR.glob("*.tif*")):
        with rasterio.open(path) as ds:
            b = transform_bounds(ds.crs, "EPSG:4326", *ds.bounds) if ds.crs else ds.bounds
        if b[0] <= w and b[1] <= s and b[2] >= e and b[3] >= n:
            return path
    return None


def _opentopo_geotiff(bounds):
    key = os.getenv("OPENTOPO_API_KEY")
    if not key:
        return None
    s, w, n, e = bounds
    pad = 0.01
    name = f"cop30_{s:.3f}_{w:.3f}_{n:.3f}_{e:.3f}.tif"
    path = ROOT / "cache" / "opentopo" / name
    if not path.exists():
        r = httpx.get(OPENTOPO, timeout=120, params={
            "demtype": "COP30", "south": s - pad, "north": n + pad, "west": w - pad, "east": e + pad,
            "outputFormat": "GTiff", "API_Key": key})
        if r.status_code != 200 or not r.content.startswith((b"II", b"MM")):
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.content)
    return path


def zoom_for_cell(cell_m, lat):
    """Coarsest terrarium zoom whose pixel is at most half the grid cell."""
    for z in range(8, 15):
        px = 156_543.03 * math.cos(math.radians(lat)) / 2 ** z
        if px <= cell_m / 2:
            return z
    return 14


def elevation(grid: Grid, source="auto"):
    """Elevation (m) on the grid, shape (ny, nx), plus a description of the source used."""
    lat, lng = grid.cell_latlng()
    bounds = grid.bounds()
    if source in ("auto", "local"):
        path = _local_geotiff_for(bounds)
        if path:
            z = _geotiff_sample(path, lat, lng)
            if np.isfinite(z).mean() > 0.95:
                return _fill_nan(z), {"name": f"Local DEM file {path.name}", "kind": "local"}
    if source in ("auto", "opentopo"):
        try:
            path = _opentopo_geotiff(bounds)
        except httpx.HTTPError:
            path = None
        if path:
            z = _geotiff_sample(path, lat, lng)
            if np.isfinite(z).mean() > 0.95:
                return _fill_nan(z), {"name": "Copernicus GLO-30 via OpenTopography", "kind": "opentopo"}
    zoom = zoom_for_cell(grid.cell, grid.lat0)
    z = _terrarium_sample(lat, lng, zoom)
    return z.astype(np.float32), {
        "name": f"AWS Terrain Tiles (SRTM-based), zoom {zoom}",
        "kind": "terrarium",
        "resolution_m": round(156_543.03 * math.cos(math.radians(grid.lat0)) / 2 ** zoom, 1),
    }


def _fill_nan(z):
    if np.isnan(z).any():
        z = np.where(np.isnan(z), np.nanmedian(z), z)
    return z.astype(np.float32)


def available_local_files():
    if not LOCAL_DEM_DIR.exists():
        return []
    return [p.name for p in sorted(LOCAL_DEM_DIR.glob("*.tif*"))]
