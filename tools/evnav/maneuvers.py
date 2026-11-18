"""Turn-by-turn maneuvers from route geometry alone (no road network needed).

This is the offline baseline: it finds where the track changes direction and says
which way to turn. It cannot know street names or junction shapes; the Valhalla
map-matching step (valhalla.py) adds those when a routing server is available.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np
from shapely.geometry import LineString, Point

from .geo import Projector, heading, signed_turn

# Tuning knobs, in metres / degrees. Chosen for cycling tracks with GPS noise.
SIMPLIFY_TOL = 6.0      # Douglas-Peucker tolerance for candidate turn points
LOOK = 30.0             # how far before/after a vertex we measure headings
MIN_ANGLE = 25.0        # below this the rider just keeps going
MERGE_DIST = 25.0       # candidates closer than this are one junction
REFINE = 50.0           # search radius for the true corner around a noisy candidate

COMPASS_EN = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
COMPASS_CS = ["sever", "severovýchod", "východ", "jihovýchod", "jih", "jihozápad", "západ", "severozápad"]

TEXT = {
    "en": {
        "slight": "Bear {side}", "turn": "Turn {side}", "sharp": "Turn sharp {side}",
        "turn_back": "Turn sharply back to the {side}", "left": "left", "right": "right",
        "depart": "Head {compass}", "arrive": "You have arrived",
        "gap": "Track gap in route data — check the map",
    },
    "cs": {
        "slight": "Držte se {side}", "turn": "Odbočte {side}", "sharp": "Odbočte ostře {side}",
        "turn_back": "Odbočte prudce zpět {side}", "left": "vlevo", "right": "vpravo",
        "depart": "Vyjeďte směrem na {compass}", "arrive": "Jste v cíli",
        "gap": "Mezera v datech trasy — zkontrolujte mapu",
    },
}


@dataclass
class Maneuver:
    type: str                 # depart | slight | turn | sharp | turn_back | gap | arrive
    side: str | None          # left | right | None
    angle: float              # signed degrees, + = right
    distance_m: float         # chainage from route start
    lon: float
    lat: float
    text: dict = field(default_factory=dict)
    to_next_m: float = 0.0

    def as_dict(self):
        d = asdict(self)
        d["angle"] = round(d["angle"], 1)
        d["distance_m"] = round(d["distance_m"], 1)
        d["to_next_m"] = round(d["to_next_m"], 1)
        d["lon"], d["lat"] = round(self.lon, 6), round(self.lat, 6)
        return d


def classify(angle: float) -> str:
    """Once artefacts are cleaned (clean.py), a reversal of >= 160 degrees on a planned
    EuroVelo track is real: a mountain hairpin, or a junction where the next road
    leaves at an acute angle. Either way the rider turns sharply back."""
    a = abs(angle)
    if a < 45:
        return "slight"
    if a < 120:
        return "turn"
    if a < 160:
        return "sharp"
    return "turn_back"


class Track:
    """A projected polyline with cumulative distances, for fast chainage lookups.

    shapely's interpolate() walks the whole line every call; on a 2,000 km EuroVelo
    route with thousands of corners that is far too slow, so we keep numpy arrays.
    """

    def __init__(self, xy):
        a = np.asarray(xy, dtype=float)
        keep = np.ones(len(a), dtype=bool)
        keep[1:] = np.any(np.diff(a, axis=0) != 0, axis=1)   # drop zero-length steps
        self.x, self.y = a[keep, 0], a[keep, 1]
        self.cum = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(self.x), np.diff(self.y)))])
        self.length = float(self.cum[-1])

    def at(self, c):
        c = np.clip(c, 0.0, self.length)
        return np.interp(c, self.cum, self.x), np.interp(c, self.cum, self.y)

    def kept_indices(self, tol):
        """Indices of vertices surviving Douglas-Peucker simplification."""
        simple = LineString(np.column_stack([self.x, self.y])).simplify(tol, preserve_topology=False)
        out, j = [], 0
        for sx, sy in simple.coords:
            while not (self.x[j] == sx and self.y[j] == sy):
                j += 1
            out.append(j)
        return out


def _fit_heading(tr: Track, c0: float, c1: float, n: int = 11) -> float:
    """Heading of the best-fit line through points sampled between chainages c0..c1.

    Fitting over many samples is much less sensitive to GPS jitter than using two points.
    """
    xs, ys = tr.at(np.linspace(c0, c1, n))
    mx, my = xs.mean(), ys.mean()
    sxx, syy = ((xs - mx) ** 2).sum(), ((ys - my) ** 2).sum()
    sxy = ((xs - mx) * (ys - my)).sum()
    theta = 0.5 * math.atan2(2 * sxy, sxx - syy)          # principal axis
    dx, dy = math.cos(theta), math.sin(theta)
    if dx * (xs[-1] - xs[0]) + dy * (ys[-1] - ys[0]) < 0:
        dx, dy = -dx, -dy                                   # orient along travel
    return math.degrees(math.atan2(dx, dy)) % 360


def _turn_angle(tr: Track, c_from: float, c_to: float, look: float = LOOK) -> float:
    return signed_turn(_fit_heading(tr, c_from - look, c_from),
                       _fit_heading(tr, c_to, c_to + look))


def _text(kind: str, side: str | None, compass_idx: int | None = None) -> dict:
    out = {}
    for lang, t in TEXT.items():
        if kind == "depart":
            comp = (COMPASS_EN if lang == "en" else COMPASS_CS)[compass_idx]
            out[lang] = t["depart"].format(compass=comp)
        elif kind in ("arrive", "gap"):
            out[lang] = t[kind]
        else:
            out[lang] = t[kind].format(side=t[side])
    return out


def build_maneuvers(lonlats: list[tuple[float, float]], proj: Projector | None = None,
                    gap_points: list[tuple[float, float]] | None = None) -> list[Maneuver]:
    proj = proj or Projector.for_points(lonlats)
    tr = Track(proj.to_xy(lonlats))
    total = tr.length

    # 1. Candidate turn points: vertices that survive simplification. Recorded
    #    (noisy) tracks get a looser tolerance than clean planned ones.
    idx = tr.kept_indices(max(SIMPLIFY_TOL, 4 * jitter_m(tr)))
    cands = [float(tr.cum[i]) for i in idx[1:-1]]

    # 2. Data gaps between stages (from stages.chain_stages or gpx_io.find_gaps).
    line = LineString(np.column_stack([tr.x, tr.y])) if gap_points else None
    gaps = [line.project(Point(p)) for p in proj.to_xy(gap_points or [])]

    # 3. Group nearby candidates into junctions, measure the turn across the group.
    groups: list[list[float]] = []
    for c in sorted(cands):
        if groups and c - groups[-1][-1] <= MERGE_DIST:
            groups[-1].append(c)
        else:
            groups.append([c])

    found: list[tuple[float, float]] = []  # (chainage, angle)
    for gi, g in enumerate(groups):
        if len(g) == 1:
            # GPS noise can push the simplified vertex tens of metres off the real
            # corner; slide along the track to the point where the turn is sharpest,
            # without reaching more than halfway to a neighbouring junction.
            lo = max(g[0] - REFINE, (groups[gi - 1][-1] + g[0]) / 2 if gi else 0.0)
            hi = min(g[0] + REFINE, (groups[gi + 1][0] + g[0]) / 2 if gi + 1 < len(groups) else total)
            c, ang = max(((c, _turn_angle(tr, c, c))
                          for c in _frange(lo, hi, 3.0)
                          if 0 < c < total), key=lambda t: abs(t[1]), default=(g[0], 0.0))
            # The max over many noisy estimates overshoots; re-measure the angle at
            # that spot with longer arms (bounded by the neighbouring junctions).
            arm = max(LOOK, min(2 * LOOK, c - lo, hi - c))
            ang = _turn_angle(tr, c, c, look=arm)
        else:
            c, ang = (g[0] + g[-1]) / 2, _turn_angle(tr, g[0], g[-1])
        if abs(ang) >= MIN_ANGLE:
            if found and c - found[-1][0] < MERGE_DIST:   # two groups refined onto one corner
                if abs(ang) > abs(found[-1][1]):
                    found[-1] = (c, ang)
                continue
            found.append((c, ang))

    # 4. Assemble: depart, turns, gaps, arrive.
    out: list[Maneuver] = []
    x0, y0 = tr.at(0.0)
    x1, y1 = tr.at(min(LOOK * 2, total))
    h0 = heading((x0, y0), (x1, y1))
    out.append(_mk(proj, tr, 0.0, "depart", None, 0.0, compass=int(((h0 + 22.5) % 360) // 45)))
    events = [(c, "turn", a) for c, a in found] + [(c, "gap", 0.0) for c in gaps]
    for c, kind, ang in sorted(events):
        if kind == "gap":
            out.append(_mk(proj, tr, c, "gap", None, 0.0))
        else:
            out.append(_mk(proj, tr, c, classify(ang), "right" if ang > 0 else "left", ang))
    out.append(_mk(proj, tr, total, "arrive", None, 0.0))

    for m, nxt in zip(out, out[1:]):
        m.to_next_m = nxt.distance_m - m.distance_m
    return out


def jitter_m(tr: Track) -> float:
    """Rough GPS jitter estimate: median distance of track vertices from a 15 m
    simplification of the track. ~0 for planned GPX, a few metres for recordings."""
    n = len(tr.x)
    if n < 10:
        return 0.0
    kept = np.array(tr.kept_indices(15.0))
    i = np.arange(n)
    seg = np.clip(np.searchsorted(kept, i, side="right") - 1, 0, len(kept) - 2)
    ax, ay = tr.x[kept[seg]], tr.y[kept[seg]]
    bx, by = tr.x[kept[seg + 1]], tr.y[kept[seg + 1]]
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = np.clip(np.where(L2 > 0, ((tr.x - ax) * dx + (tr.y - ay) * dy) / np.where(L2 > 0, L2, 1), 0), 0, 1)
    d = np.hypot(tr.x - (ax + t * dx), tr.y - (ay + t * dy))
    return float(np.median(d))


def _frange(a, b, step):
    x = a
    while x <= b:
        yield x
        x += step


def _mk(proj, tr: Track, c, kind, side, ang, compass=None) -> Maneuver:
    x, y = tr.at(c)
    lon, lat = proj.inv.transform(float(x), float(y))
    return Maneuver(kind, side, ang, c, lon, lat, _text(kind, side, compass))
