"""Build app bundles for routes listed in routes.yml from OpenStreetMap route relations,
then rewrite data/routes.json (outlines, places, countries, junctions) for all routes.

A routes.yml entry:
    - id: ev8
      kind: ev                      # ev = EuroVelo, cz = Czech national cycle route
      num: 8
      name: "EuroVelo 8 · Mediterranean Route"
      short: EV8                    # badge/legs label (default EV<num>)
      long: EuroVelo 8              # used in spoken instructions
      osm: 'relation[route=bicycle][network=icn][ref="EV8"]'   # Overpass selector of the top relation(s)
      status: build                 # build = (re)build now; live = built, leave alone; planned = later
Bundles that came from official GPX files (source: gpx) are never rebuilt here.
"""
import heapq
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import requests
import yaml
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).parent))
from routes_geo import decode, encode, hav, RouteLine  # noqa: E402
from evnav.clean import clean_track  # noqa: E402
from evnav.geo import Projector  # noqa: E402
from evnav.maneuvers import build_maneuvers  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
UA = {"User-Agent": "EuroVeloNav-by-NEXIS-Rail/1.0 (route build; d.petr@nexisrail.cz)"}
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
KIND_CODE = {"slight": 1, "turn": 2, "sharp": 3, "turn_back": 4}
GAP_LINK_M = 30000      # join pieces of a relation that don't touch, up to this far apart
GAP_PENALTY = 3.0


def overpass(q, timeout=900):
    last = None
    for attempt in range(6):
        url = OVERPASS[attempt % len(OVERPASS)]
        try:
            r = requests.post(url, data={"data": q}, headers=UA, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            last = f"{url} {r.status_code}"
            log(f"overpass {last}")
        except Exception as e:  # noqa: BLE001
            last = f"{url} {e}"
            log(f"overpass {type(e).__name__}")
        time.sleep(30 * (attempt + 1))
    raise RuntimeError(f"overpass failed: {last}")


def fetch_relation(selector):
    """All ways of the relation(s) and their sub-relations, with geometry and the sub-relation they belong to."""
    q = f"""[out:json][timeout:900];{selector}->.top;
    (.top; rel(r.top); rel(r); rel(r);)->.rels;
    .rels out tags;
    foreach.rels -> .r (way(r.r)[highway!=proposed]; out geom tags qt; .r out ids;);"""
    j = overpass(q)
    rels, ways, cur = {}, {}, []
    for e in j["elements"]:
        if e["type"] == "relation" and "tags" in e:
            rels[e["id"]] = e["tags"]
        elif e["type"] == "way":
            cur.append(e)
        elif e["type"] == "relation":  # the ".r out ids" marker after each relation's ways
            for w in cur:
                ways.setdefault(w["id"], {"geom": [(p["lon"], p["lat"]) for p in w["geometry"]], "rels": set()})["rels"].add(e["id"])
            cur = []
    return rels, ways


def key(p):
    return (round(p[0], 6), round(p[1], 6))


def build_graph(ways):
    adj, edge_rel = {}, {}
    for wid, w in ways.items():
        g = [key(p) for p in w["geom"]]
        for a, b in zip(g, g[1:]):
            if a == b:
                continue
            d = hav(a, b)
            adj.setdefault(a, {})[b] = (d, d)
            adj.setdefault(b, {})[a] = (d, d)
            edge_rel[(a, b)] = edge_rel[(b, a)] = min(w["rels"])
    return adj, edge_rel


def components(adj):
    comp, cid = {}, 0
    for s in adj:
        if s in comp:
            continue
        stack = [s]; comp[s] = cid
        while stack:
            u = stack.pop()
            for v in adj[u]:
                if v not in comp:
                    comp[v] = cid; stack.append(v)
        cid += 1
    return comp, cid


def link_pieces(adj, gaps):
    """Pieces of the relation that don't touch get joined by 'gap' edges between their loose ends."""
    comp, n = components(adj)
    log(f"graph: {len(adj)} nodes in {n} pieces")
    if n == 1:
        return
    ends = [u for u in adj if len(adj[u]) == 1] or list(adj)
    pts = np.array([[u[0] * math.cos(math.radians(u[1])) * 111.32, u[1] * 110.54] for u in ends])  # km
    tree = cKDTree(pts)
    k = min(16, len(ends))
    dists, idxs = tree.query(pts, k=k, distance_upper_bound=GAP_LINK_M / 1000)
    best = {}
    for i in range(len(ends)):
        for dd, j in zip(np.atleast_1d(dists[i]), np.atleast_1d(idxs[i])):
            if not np.isfinite(dd) or j >= len(ends) or j == i:
                continue
            a, b = ends[i], ends[j]
            ca, cb = comp[a], comp[b]
            if ca == cb:
                continue
            key_ = (min(ca, cb), max(ca, cb))
            d = hav(a, b)
            if key_ not in best or d < best[key_][0]:
                best[key_] = (d, a, b)
    for d, a, b in best.values():
        adj[a][b] = (d * GAP_PENALTY, d)
        adj[b][a] = (d * GAP_PENALTY, d)
        gaps.add((a, b)); gaps.add((b, a))


def dijkstra(adj, src):
    dist, prev = {src: 0.0}, {}
    pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        for v, (cost, _) in adj[u].items():
            nd = d + cost
            if nd < dist.get(v, math.inf):
                dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
    return dist, prev


def main_path(adj, start=None, end=None):
    if start and end:
        nodes = list(adj)
        arr = np.array(nodes)
        tree = cKDTree(arr)
        a = nodes[tree.query(start)[1]]; b = nodes[tree.query(end)[1]]
    else:  # longest of the shortest paths: the route from one end to the other
        any_node = next(iter(adj))
        d0, _ = dijkstra(adj, any_node)
        a = max(d0, key=d0.get)
        d1, _ = dijkstra(adj, a)
        b = max(d1, key=d1.get)
    _, prev = dijkstra(adj, a)
    path = [b]
    while path[-1] != a:
        path.append(prev[path[-1]])
    return path[::-1]


def turns_by_window(line, gaps, win=80000, overlap=1000):
    """Turn detection per ~80 km window with a local projection (angles stay true on long routes)."""
    cum = [0.0]
    for p, q in zip(line, line[1:]):
        cum.append(cum[-1] + hav(p, q))
    out, start = [], 0.0
    while start < cum[-1]:
        lo, hi = start - overlap, start + win + overlap
        idx = [i for i, c in enumerate(cum) if lo <= c <= hi]
        if len(idx) >= 3:
            seg = [line[i] for i in idx]
            proj = Projector.for_points(seg)
            for m in build_maneuvers(seg, proj=proj, gap_points=[g for g in gaps if lo <= g[1] <= hi and False] or None):
                c = cum[idx[0]] + m.distance_m
                if m.type in KIND_CODE and start <= c < start + win:
                    out.append([round(m.lon, 5), round(m.lat, 5), KIND_CODE[m.type], round(m.angle)])
        start += win
    return out


def elevation(line, length, step=250):
    """Elevation every `step` m from OpenTopoData (EU-DEM 25 m, SRTM outside); None when unavailable."""
    rl_pts, cum = line, [0.0]
    for p, q in zip(line, line[1:]):
        cum.append(cum[-1] + hav(p, q))
    import bisect
    samples = []
    d = 0.0
    while d <= cum[-1]:
        i = max(0, min(len(cum) - 2, bisect.bisect_right(cum, d) - 1))
        t = 0 if cum[i + 1] == cum[i] else (d - cum[i]) / (cum[i + 1] - cum[i])
        a, b = rl_pts[i], rl_pts[i + 1]
        samples.append((a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t))
        d += step * cum[-1] / length
    vals = []
    for k in range(0, len(samples), 100):
        chunk = samples[k:k + 100]
        locs = "|".join(f"{la:.5f},{lo:.5f}" for la, lo in chunk)
        for attempt in range(4):
            try:
                r = requests.post("https://api.opentopodata.org/v1/eudem25m,srtm30m", data={"locations": locs}, headers=UA, timeout=60)
                if r.status_code == 200:
                    vals += [x.get("elevation") for x in r.json()["results"]]
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(5 * (attempt + 1))
        else:
            return None
        time.sleep(1.1)   # public instance: 1 request per second
    prev, out, last = 0, [], 0
    for v in vals:
        v = round(v) if v is not None else last
        last = v
        dv = v - prev; prev = v
        dv = ~(dv << 1) if dv < 0 else dv << 1
        s = ""
        while dv >= 0x20:
            s += chr((0x20 | (dv & 0x1f)) + 63); dv >>= 5
        out.append(s + chr(dv + 63))
    return {"step": float(step), "data": "".join(out)}


T0 = time.time()


def log(msg):
    print(f"[{time.time() - T0:7.1f}s] {msg}", flush=True)


def build(entry):
    log("overpass: fetching relation")
    rels, ways = fetch_relation(entry["osm"])
    log(f"  {len(rels)} relations, {len(ways)} ways")
    if not ways:
        raise RuntimeError("relation has no ways")
    adj, edge_rel = build_graph(ways)
    gap_edges = set()
    link_pieces(adj, gap_edges)
    # the biggest connected piece after linking
    comp, n = components(adj)
    if n > 1:
        sizes = {}
        for u, c in comp.items():
            sizes[c] = sizes.get(c, 0) + 1
        big = max(sizes, key=sizes.get)
        adj = {u: {v: w for v, w in nb.items() if comp[v] == big} for u, nb in adj.items() if comp[u] == big}
    log(f"graph: {len(adj)} nodes, {len(gap_edges) // 2} gap links")
    path = main_path(adj, entry.get("start"), entry.get("end"))
    log(f"main path: {len(path)} nodes")
    # gaps along the path and the sub-relation (stage) of each step
    gaps_out, stages = [], []
    run = 0.0
    for a, b in zip(path, path[1:]):
        if (a, b) in gap_edges:
            gaps_out.append({"a": [round(a[0], 5), round(a[1], 5)], "b": [round(b[0], 5), round(b[1], 5)], "m": round(hav(a, b))})
        else:
            rid = edge_rel.get((a, b))
            if not stages or stages[-1]["rel"] != rid:
                stages.append({"rel": rid, "m0": run, "p": a})
        run += hav(a, b)
    line, _ = clean_track([tuple(p) for p in path])
    line = [list(p) for p in line]
    # simplify for size (~5 m tolerance in degrees)
    from shapely.geometry import LineString
    line = [list(p) for p in LineString(line).simplify(0.00005, preserve_topology=False).coords]
    length = sum(hav(p, q) for p, q in zip(line, line[1:]))
    # merge tiny stages, name them after their relation
    merged = []
    for s in stages:
        if merged and s["m0"] - merged[-1]["m0"] < 3000:
            continue
        merged.append(s)
    st_out = []
    for k, s in enumerate(merged):
        tg = rels.get(s["rel"], {})
        st_out.append({"num": k + 1, "name": tg.get("name") or tg.get("ref") or entry["name"], "status": tg.get("state", ""),
                       "m": round(s["m0"] * length / max(run, 1)), "p": [round(s["p"][0], 5), round(s["p"][1], 5)]})
    gaps_pts = []
    log(f"line {len(line)} pts, {length / 1000:.0f} km; turns…")
    turns = turns_by_window(line, gaps_pts)
    log(f"{len(turns)} turns; elevation…")
    xs, ys = [p[0] for p in line], [p[1] for p in line]
    bundle = {
        "format": 2, "id": entry["id"], "name": entry["name"], "generated": time.strftime("%Y-%m-%d"),
        "length_m": round(length, 1),
        "attribution": f"Route from OpenStreetMap relations (© OpenStreetMap contributors, ODbL), downloaded {time.strftime('%Y-%m-%d')}.",
        "bbox": [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)],
        "line": encode(line), "turns": turns, "stages": st_out, "gaps": gaps_out, "closures": [],
        "source": "osm", "osm": entry["osm"],
    }
    ele = elevation(line, length)
    if ele:
        bundle["ele"] = ele
    return bundle


# ------------------------------------------------------------------ routes.json
def places_along(bundle, old):
    """Towns and cities within 3 km of the route, in route order (one Overpass request over the route's bbox)."""
    if old and old.get("places"):
        return old["places"]
    rl = RouteLine(bundle["id"], bundle)
    x0, y0, x1, y1 = bundle["bbox"]
    j = overpass(f'[out:json][timeout:300];node[place~"^(city|town)$"][name]({y0 - 0.05:.4f},{x0 - 0.05:.4f},{y1 + 0.05:.4f},{x1 + 0.05:.4f});out;', timeout=400)
    out, seen = [], set()
    for e in j["elements"]:
        p = [e["lon"], e["lat"]]
        n = rl.nearest(p, 3000)
        nm = e["tags"].get("name")
        if n and nm not in seen:
            seen.add(nm); out.append((n[1], [nm, round(p[0], 5), round(p[1], 5)]))
    return [x for _, x in sorted(out)]


def countries_along(bundle, old):
    if old and old.get("countries"):
        return old["countries"]
    rl = RouteLine(bundle["id"], bundle)
    out = []
    for d in np.linspace(0, rl.length, max(2, int(rl.length / 40000))):
        lon, lat = rl.point_at(d)
        try:
            j = requests.get("https://photon.komoot.io/reverse", params={"lon": lon, "lat": lat}, headers=UA, timeout=30).json()
            cc = (j["features"][0]["properties"].get("countrycode") or "").upper()
        except Exception:  # noqa: BLE001
            cc = ""
        if cc and (not out or out[-1] != cc):
            out.append(cc)
        time.sleep(0.5)
    return out


def junctions(lines, step=60, near_m=30, every=30000):
    """Where two routes meet: the start and end of every stretch they share (within 30 m),
    plus a point every 30 km along long shared stretches, so the planner can switch anywhere sensible."""
    out = []
    ids = list(lines)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            la, lb = lines[a], lines[b]
            xa = [p[0] for p in la.pts]; ya = [p[1] for p in la.pts]
            xb = [p[0] for p in lb.pts]; yb = [p[1] for p in lb.pts]
            if max(xb) < min(xa) or min(xb) > max(xa) or max(yb) < min(ya) or min(yb) > max(ya):
                continue
            runs, cur = [], None
            for d in np.arange(0, la.length, step):
                n = lb.nearest(la.point_at(d), near_m)
                if n:
                    if cur and d - cur[1] <= 3 * step:
                        cur[1] = d
                    else:
                        cur = [d, d]; runs.append(cur)
            for d0, d1 in runs:
                marks = [d0] + list(np.arange(d0 + every, d1 - every / 2, every)) + ([d1] if d1 - d0 > 1000 else [])
                for d in marks:
                    p = la.point_at(d)
                    n = lb.nearest(p, near_m + 20)
                    if n:
                        out.append({"a": a, "b": b, "pa": p, "pb": lb.point_at(n[1])})
    return out


def write_routes_json(cfg):
    path = ROOT / "data" / "routes.json"
    old = {r["id"]: r for r in json.loads(path.read_text())["routes"]} if path.exists() else {}
    routes, lines = [], {}
    order = [e["id"] for e in cfg]
    order += [i for i in old if i not in order]
    for rid in order:
        f = ROOT / "data" / f"{rid}.json"
        if not f.exists():
            continue
        b = json.loads(f.read_text())
        e = next((x for x in cfg if x["id"] == rid), {})
        o = old.get(rid, {})
        line = decode(b["line"])
        from shapely.geometry import LineString
        outline = [list(p) for p in LineString(line).simplify(0.01).coords]
        meta = {**o, "id": rid, "num": e.get("num", o.get("num")), "name": e.get("name", b.get("name")), "file": f"{rid}.json",
                "length_km": round(b["length_m"] / 1000), "bbox": b["bbox"], "outline": encode(outline)}
        for k in ("kind", "short", "long", "badge"):
            if e.get(k) is not None:
                meta[k] = e[k]
        log(f"routes.json: {rid} countries/places")
        try:
            meta["countries"] = countries_along(b, o)
        except Exception as ex:  # noqa: BLE001
            log(f"  countries skipped: {ex}"); meta.setdefault("countries", [])
        try:
            meta["places"] = places_along(b, o)
        except Exception as ex:  # noqa: BLE001 - towns for search are nice to have; retried next run
            log(f"  places skipped: {ex}"); meta.setdefault("places", [])
        routes.append(meta)
        lines[rid] = RouteLine(rid, b)
    log("junctions…")
    path.write_text(json.dumps({"routes": routes, "junctions": junctions(lines)}, ensure_ascii=False, separators=(",", ":")))
    print(f"routes.json: {len(routes)} routes")


def main():
    cfg = yaml.safe_load((ROOT / "routes.yml").read_text())["routes"]
    changed = False
    for e in cfg:
        if e.get("status") != "build" or e.get("source") == "gpx":
            continue
        print(f"building {e['id']} from {e['osm']}")
        try:
            b = build(e)
        except Exception as ex:  # noqa: BLE001
            log(f"  FAILED: {ex}")
            e["status"] = "failed"; e["error"] = str(ex)[:300]
            changed = True
            continue
        (ROOT / "data" / f"{e['id']}.json").write_text(json.dumps(b, ensure_ascii=False, separators=(",", ":")))
        e["status"] = "live"
        e["built"] = {"date": time.strftime("%Y-%m-%d"), "km": round(b["length_m"] / 1000), "gaps": len(b["gaps"]),
                      "gap_km": round(sum(g["m"] for g in b["gaps"]) / 1000, 1), "turns": len(b["turns"]), "stages": len(b["stages"])}
        print(f"  {e['built']}")
        changed = True
    if changed or "--routes-json" in sys.argv:
        write_routes_json(cfg)
        doc = yaml.safe_load((ROOT / "routes.yml").read_text())
        doc["routes"] = cfg
        (ROOT / "routes.yml").write_text(yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, width=200))


if __name__ == "__main__":
    main()
