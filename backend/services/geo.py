"""Small geometry helpers using a local flat projection (accurate enough at city scale)."""
import math

LAT0 = 18.5
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LNG = 111_320.0 * math.cos(math.radians(LAT0))


def to_xy(lat, lng):
    return (lng * M_PER_DEG_LNG, lat * M_PER_DEG_LAT)


def to_latlng(x, y):
    return (y / M_PER_DEG_LAT, x / M_PER_DEG_LNG)


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def project_on_polyline(lat, lng, line):
    """Return (distance_m, chainage_m, side) of a point relative to a polyline.

    chainage_m: distance along the line from its first vertex (the dam).
    side: +1 left bank, -1 right bank (looking downstream).
    """
    px, py = to_xy(lat, lng)
    pts = [to_xy(a, b) for a, b in line]
    best = (float("inf"), 0.0, 1)
    run = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        dx, dy = x2 - x1, y2 - y1
        seg = math.hypot(dx, dy)
        if seg == 0:
            continue
        t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (seg * seg)))
        cx, cy = x1 + t * dx, y1 + t * dy
        d = math.hypot(px - cx, py - cy)
        if d < best[0]:
            cross = dx * (py - y1) - dy * (px - x1)
            best = (d, run + t * seg, 1 if cross >= 0 else -1)
        run += seg
    return best


def buffer_polyline(line, width_m):
    """Build a simple polygon around a polyline (flat caps). Returns [[lat, lng], ...]."""
    pts = [to_xy(a, b) for a, b in line]
    left, right = [], []
    n = len(pts)
    for i in range(n):
        if i == 0:
            dx, dy = pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]
        elif i == n - 1:
            dx, dy = pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1]
        else:
            dx, dy = pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1]
        length = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / length, dx / length
        x, y = pts[i]
        left.append(to_latlng(x + nx * width_m, y + ny * width_m))
        right.append(to_latlng(x - nx * width_m, y - ny * width_m))
    ring = left + right[::-1]
    ring.append(ring[0])
    return [[round(a, 6), round(b, 6)] for a, b in ring]
