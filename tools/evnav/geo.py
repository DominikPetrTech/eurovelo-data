"""Geometry helpers: a local metric projection plus chainage (distance-along-route) tools."""
from __future__ import annotations

import math
from dataclasses import dataclass

from pyproj import CRS, Transformer
from shapely.geometry import LineString, Point


@dataclass
class Projector:
    """Projects WGS84 lon/lat to a local UTM zone so distances are in metres."""

    fwd: Transformer
    inv: Transformer

    @classmethod
    def for_points(cls, lonlats: list[tuple[float, float]]) -> "Projector":
        lon = sum(p[0] for p in lonlats) / len(lonlats)
        lat = sum(p[1] for p in lonlats) / len(lonlats)
        zone = int((lon + 180) // 6) + 1
        epsg = (32600 if lat >= 0 else 32700) + zone
        crs = CRS.from_epsg(epsg)
        return cls(
            Transformer.from_crs("EPSG:4326", crs, always_xy=True),
            Transformer.from_crs(crs, "EPSG:4326", always_xy=True),
        )

    def to_xy(self, lonlats):
        return [self.fwd.transform(lon, lat) for lon, lat in lonlats]

    def to_lonlat(self, xys):
        return [self.inv.transform(x, y) for x, y in xys]


def heading(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Compass heading in degrees (0 = north, clockwise) from a to b in projected xy."""
    return math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360


def signed_turn(h_in: float, h_out: float) -> float:
    """Signed turn angle in degrees: positive = right, negative = left, range (-180, 180]."""
    d = (h_out - h_in + 540) % 360 - 180
    return 180.0 if d == -180 else d


def point_at(line: LineString, dist: float) -> tuple[float, float]:
    p = line.interpolate(max(0.0, min(dist, line.length)))
    return (p.x, p.y)


def chainage(line: LineString, xy: tuple[float, float]) -> float:
    return line.project(Point(xy))
