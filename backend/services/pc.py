"""Microsoft Planetary Computer: STAC search and raster reads (no account or key needed).

Used for Sentinel-2 L2A (optical), Sentinel-1 RTC (radar, sees through cloud), JRC Global
Surface Water (1984-2021 water history) and ESA WorldCover (land cover).
Reads go through the Planetary Computer data API, which crops and resamples server-side and
returns a NumPy array, so no GDAL work is needed here.
"""
import hashlib
import io
import json
import time
from pathlib import Path

import httpx
import numpy as np

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
DATA = "https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/"
CACHE = Path(__file__).resolve().parent.parent / "cache" / "pc"
UA = {"User-Agent": "JalDrishti/0.2 (SIH 2026 prototype)"}


def search(collection, bbox, datetime=None, query=None, sort="desc", sort_field="datetime", limit=5):
    """bbox is (west, south, east, north). Returns STAC features, newest first by default."""
    body = {"collections": [collection], "bbox": list(bbox), "limit": limit,
            "sortby": [{"field": sort_field, "direction": sort}]}
    if datetime:
        body["datetime"] = datetime
    if query:
        body["query"] = query
    r = httpx.post(STAC, json=body, headers=UA, timeout=60)
    r.raise_for_status()
    return r.json().get("features", [])


def read(collection, item_id, bbox, size, expression=None, assets=None, extra=None):
    """Read an item over bbox (w, s, e, n) at `size` = (width, height) pixels.

    Returns (data, valid): data has shape (bands, h, w); valid is a boolean mask (h, w).
    Cached on disk, so repeating a request (same item, bbox, size) is instant.
    """
    params = {"collection": collection, "item": item_id}
    if expression:
        params["expression"] = expression
        params["asset_as_band"] = "true"
    for a in assets or []:
        params.setdefault("assets", [])
        params["assets"].append(a)
    params.update(extra or {})
    w, s, e, n = bbox
    url = f"{DATA}{w:.6f},{s:.6f},{e:.6f},{n:.6f}/{size[0]}x{size[1]}.npy"
    key = CACHE / (hashlib.sha1((url + json.dumps(params, sort_keys=True)).encode()).hexdigest() + ".npy")
    if key.exists():
        arr = np.load(key)
    else:
        for attempt in range(3):
            r = httpx.get(url, params=params, headers=UA, timeout=180)
            if r.status_code == 200:
                break
            if r.status_code not in (429, 500, 502, 503, 504):
                r.raise_for_status()
            time.sleep(3 * (attempt + 1))
        r.raise_for_status()
        arr = np.load(io.BytesIO(r.content))
        CACHE.mkdir(parents=True, exist_ok=True)
        np.save(key, arr)
    # The data API appends a mask band (0 = nodata, 255 = valid).
    data, mask = arr[:-1], arr[-1] > 0
    # Row 0 of the response is the north edge; our grids have row 0 at the south edge.
    return data[:, ::-1, :], mask[::-1, :]


def read_mosaic(collection, items, bbox, size, **kw):
    """Read several items over the same bbox and fill gaps from the next one (first wins)."""
    data = valid = None
    used = []
    for item in items:
        try:
            d, m = read(collection, item["id"], bbox, size, **kw)
        except httpx.HTTPError:
            continue
        if data is None:
            data, valid = np.zeros_like(d, dtype=np.float32), np.zeros(m.shape, bool)
        take = m & ~valid
        if take.any():
            data[:, take] = d[:, take]
            valid |= take
            used.append(item)
        if valid.all():
            break
    return data, valid, used
