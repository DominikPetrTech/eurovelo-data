"""Route lines from the app bundles, with a fast "where on which route is this point" lookup."""
import json
import math
from pathlib import Path

R = 6371008.8


def decode(s, f=1e5):
    """Google polyline → [[lon, lat], ...]"""
    out, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for k in (0, 1):
            sh = r = 0
            while True:
                b = ord(s[i]) - 63; i += 1
                r |= (b & 31) << sh; sh += 5
                if b < 32:
                    break
            d = ~(r >> 1) if r & 1 else r >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        out.append([lon / f, lat / f])
    return out


def encode(coords, f=1e5):
    out, plat, plon = [], 0, 0
    for lon, lat in coords:
        ilat, ilon = round(lat * f), round(lon * f)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63)); v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def hav(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(math.radians(b[0] - a[0]) / 2) ** 2
    return 2 * R * math.asin(min(1, math.sqrt(h)))


CELL = 0.01  # degrees


class RouteLine:
    def __init__(self, rid, bundle):
        self.id = rid
        self.pts = decode(bundle["line"])
        cum = [0.0]
        for p, q in zip(self.pts, self.pts[1:]):
            cum.append(cum[-1] + hav(p, q))
        # chainage in the bundle's own units (prepareRoute rescales by length_m)
        k = bundle["length_m"] / cum[-1] if cum[-1] else 1
        self.cum = [c * k for c in cum]
        self.length = self.cum[-1]
        self.grid = {}
        for i, (p, q) in enumerate(zip(self.pts, self.pts[1:])):
            x0, x1 = sorted((p[0], q[0])); y0, y1 = sorted((p[1], q[1]))
            for gx in range(math.floor(x0 / CELL), math.floor(x1 / CELL) + 1):
                for gy in range(math.floor(y0 / CELL), math.floor(y1 / CELL) + 1):
                    self.grid.setdefault((gx, gy), []).append(i)

    def nearest(self, p, max_m=100):
        """(distance m, chainage) of the closest point on the route, or None beyond ~max_m."""
        gx, gy = math.floor(p[0] / CELL), math.floor(p[1] / CELL)
        kx = 111320 * math.cos(math.radians(p[1])); ky = 110540
        best = None
        seen = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in self.grid.get((gx + dx, gy + dy), ()):
                    if i in seen:
                        continue
                    seen.add(i)
                    a, b = self.pts[i], self.pts[i + 1]
                    ax, ay = (a[0] - p[0]) * kx, (a[1] - p[1]) * ky
                    bx, by = (b[0] - p[0]) * kx, (b[1] - p[1]) * ky
                    vx, vy = bx - ax, by - ay
                    L2 = vx * vx + vy * vy
                    t = 0 if L2 == 0 else max(0, min(1, -(ax * vx + ay * vy) / L2))
                    cx, cy = ax + t * vx, ay + t * vy
                    d = math.hypot(cx, cy)
                    if best is None or d < best[0]:
                        best = (d, self.cum[i] + t * (self.cum[i + 1] - self.cum[i]))
        return best if best and best[0] <= max_m else None

    def point_at(self, d):
        import bisect
        i = max(0, min(len(self.cum) - 2, bisect.bisect_right(self.cum, d) - 1))
        seg = self.cum[i + 1] - self.cum[i]
        t = 0 if seg == 0 else (d - self.cum[i]) / seg
        a, b = self.pts[i], self.pts[i + 1]
        return [round(a[0] + (b[0] - a[0]) * t, 5), round(a[1] + (b[1] - a[1]) * t, 5)]


def load_routes(root):
    root = Path(root)
    net = json.loads((root / "data" / "routes.json").read_text())
    return {r["id"]: RouteLine(r["id"], json.loads((root / "data" / r["file"]).read_text())) for r in net["routes"]}


def samples(geom, step=10):
    """Points every ~step m along a (Multi)LineString / Point geometry."""
    t = geom["type"]
    if t == "Point":
        return [geom["coordinates"]]
    lines = geom["coordinates"] if t == "MultiLineString" else [geom["coordinates"]]
    out = []
    for ln in lines:
        for p, q in zip(ln, ln[1:]):
            n = max(1, round(hav(p, q) / step))
            out += [[p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n] for k in range(n)]
        if ln:
            out.append(ln[-1])
    return out


def geom_length(geom):
    t = geom["type"]
    if t == "Point":
        return 0.0
    lines = geom["coordinates"] if t == "MultiLineString" else [geom["coordinates"]]
    return sum(hav(p, q) for ln in lines for p, q in zip(ln, ln[1:]))


LINE_BUFFER, POINT_BUFFER = 25, 60


def match(routes, geom, only=None):
    """Where a closure lies on the routes. A line counts when the route runs along it
    for at least min(150 m, 60 % of its length) — a road the route only crosses doesn't."""
    out = []
    pts = samples(geom)
    length = geom_length(geom)
    for rid, rl in routes.items():
        if only and rid not in only:
            continue
        if geom["type"] == "Point":
            n = rl.nearest(pts[0], POINT_BUFFER)
            if n:
                d = n[1]
                out.append((rid, max(0, d - 30), min(rl.length, d + 30)))
            continue
        hits = [n[1] for p in pts if (n := rl.nearest(p, LINE_BUFFER))]
        if not hits:
            continue
        hits.sort()
        clusters, cur = [], [hits[0]]
        for h in hits[1:]:
            if h - cur[-1] > 500:
                clusters.append(cur); cur = [h]
            else:
                cur.append(h)
        clusters.append(cur)
        per = length / max(1, len(pts))
        for c in clusters:
            along = len(c) * per
            if along >= min(150, 0.6 * length) and c[-1] - c[0] >= min(100, 0.5 * length):
                out.append((rid, c[0], c[-1]))
    return out
