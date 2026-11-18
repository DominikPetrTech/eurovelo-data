"""Clean up artefacts in planned EuroVelo tracks before deriving maneuvers.

Found in the official EV9 file:
  * tiny loops: the track goes round a block and comes back to the identical point
  * overlapping stage joins: the next stage restarts a few points behind where the
    previous one ended, so the line doubles back on itself
  * spikes: a single vertex sticking out tens of metres and straight back
Each would otherwise produce bogus "make a U-turn" instructions.
"""
from __future__ import annotations

import numpy as np

from .geo import Projector

LOOP_RETURN_M = 5.0     # the track counts as "back where it was" within this distance
LOOP_MAX_M = 400.0      # only cut loops shorter than this (longer ones are real routes)
SPIKE_MAX_M = 60.0      # spike arm length limit
SPIKE_ANGLE = 160.0     # reversal angle that marks a spike


def clean_track(lonlats, proj: Projector | None = None):
    """Return (clean_lonlats, report). report counts what was removed."""
    proj = proj or Projector.for_points(lonlats)
    xy = np.asarray(proj.to_xy(lonlats), dtype=float)
    keep = np.ones(len(xy), dtype=bool)
    keep[1:] = np.any(np.diff(xy, axis=0) != 0, axis=1)
    xy = xy[keep]
    report = {"loops_cut": 0, "loop_m_removed": 0.0, "spikes_removed": 0}

    # 1. Loops / overlaps: if a point comes back within LOOP_RETURN_M of an earlier
    #    point after travelling less than LOOP_MAX_M, drop everything in between.
    seg = np.hypot(*np.diff(xy, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    out_idx = []
    i, n = 0, len(xy)
    while i < n:
        out_idx.append(i)
        hi = np.searchsorted(cum, cum[i] + LOOP_MAX_M, side="right")
        j_range = np.arange(i + 2, min(hi, n))
        if len(j_range):
            d = np.hypot(xy[j_range, 0] - xy[i, 0], xy[j_range, 1] - xy[i, 1])
            # the path must actually leave (not just a dense run of points)
            hits = j_range[(d <= LOOP_RETURN_M) & (cum[j_range] - cum[i] > 3 * LOOP_RETURN_M)]
            if len(hits):
                j = int(hits[-1])
                report["loops_cut"] += 1
                report["loop_m_removed"] += float(cum[j] - cum[i])
                i = j + 1      # continue after the return point (i itself is kept)
                continue
        i += 1
    xy = xy[out_idx]

    # 2. Spikes: a vertex whose in- and out-segments are nearly opposite and short.
    changed = True
    while changed and len(xy) > 2:
        changed = False
        a, b, c = xy[:-2], xy[1:-1], xy[2:]
        v1, v2 = b - a, c - b
        l1, l2 = np.hypot(*v1.T), np.hypot(*v2.T)
        cosang = np.einsum("ij,ij->i", v1, v2) / np.maximum(l1 * l2, 1e-9)
        ang = np.degrees(np.arccos(np.clip(cosang, -1, 1)))
        spike = (ang >= SPIKE_ANGLE) & (np.minimum(l1, l2) <= SPIKE_MAX_M)
        if spike.any():
            # remove non-adjacent spikes in one pass
            idx = np.flatnonzero(spike) + 1
            idx = idx[np.concatenate([[True], np.diff(idx) > 1])]
            mask = np.ones(len(xy), dtype=bool)
            mask[idx] = False
            xy = xy[mask]
            report["spikes_removed"] += len(idx)
            changed = True

    report["loop_m_removed"] = round(report["loop_m_removed"], 1)
    return proj.to_lonlat([tuple(p) for p in xy]), report
