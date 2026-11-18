"""Weekly closures update for every route in data/routes.json.

Sources
  1. closures/manual.json       hand-checked items (official notices abroad, mapy.com, rider reports)
  2. Czech JSDI feed            api.dopravniinfo.cz, all 14 regions (closures, roadworks)
  3. OpenStreetMap (Overpass)   ways under construction / closed at night along each route

Writes closures/<route>.json (what the app loads) and closures/report.md.

    python tools/update_closures.py              # everything
    python tools/update_closures.py --no-osm     # skip the slow OSM scan, keep last week's OSM items
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from routes_geo import load_routes, match, geom_length  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
UA = {"User-Agent": "EuroVeloNav-by-NEXIS-Rail/1.0 (closures update; d.petr@nexisrail.cz)"}
AHEAD_DAYS = 90          # include closures that start within this many days
TODAY = dt.date.today()


def iso(d):
    return d.isoformat() if d else None


def active_soon(frm, to):
    f = dt.date.fromisoformat(frm) if frm else None
    t = dt.date.fromisoformat(to) if to else None
    if t and t < TODAY:
        return False
    if f and f > TODAY + dt.timedelta(days=AHEAD_DAYS):
        return False
    return True


# ------------------------------------------------------------------ JSDI (Czechia)
JSDI_CFG = "https://api-mov.dopravniinfo.cz/config/web"
JSDI_REGION = "https://api.dopravniinfo.cz/RegionData.ashx?region={}"
KEEP_ICONS = {"U2U", "U4N"}   # closures and restrictions, roadworks (p_ = planned)
FULL = re.compile(r"úpln\w* uzavírk|\buzavřen[aoáý]?\b|uzavírka pro (všechn|cykli)|neprůjezdn|zákaz vjezdu (všech|cyklist)", re.I)
# rules for lorries, weight/height limits, transit bans: nothing to do with bikes
NOT_BIKES = re.compile(r"nákladní|nad \\d+[,.]?\\d* ?t\\b|\\d+ ?tun|hmotnost|výšk|šířk|délk|tranzit|autobus|kamion|motorov|osobní(ch)? (auto|vozid)", re.I)
PARTIAL = re.compile(r"částečn|jízdní\w* pruh|zúžen|kyvadlov|semafor|světeln|mimo cyklist|cyklist\w* (povolen|umožněn)|vyjma cyklist|kromě cyklist|1 pruh", re.I)


def jtsk_to_wgs():
    from pyproj import Transformer
    return Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True)


def decode_int(s):
    out, i, a, b = [], 0, 0, 0
    while i < len(s):
        v = []
        for _ in (0, 1):
            sh = r = 0
            while True:
                c = ord(s[i]) - 63; i += 1
                r |= (c & 31) << sh; sh += 5
                if c < 32:
                    break
            v.append(~(r >> 1) if r & 1 else r >> 1)
        a += v[0]; b += v[1]
        out.append((a, b))
    return out


def zigzags(s):
    out, i = [], 0
    while i < len(s):
        sh = r = 0
        while True:
            c = ord(s[i]) - 63; i += 1
            r |= (c & 31) << sh; sh += 5
            if c < 32:
                break
        out.append(~(r >> 1) if r & 1 else r >> 1)
    return out


def jsdi_geom(ev, tr):
    """JSDI 'Geo': '<point counts per part> <one polyline of all parts>', S-JTSK (EPSG:5514) metres."""
    g = ev.get("Geo") or ""
    parts = []
    if " " in g:
        pre, body = g.split(" ", 1)
        try:
            counts, xy = zigzags(pre), decode_int(body)
        except Exception:  # noqa: BLE001
            counts, xy = [], []
        if sum(counts) != len(xy):
            counts = [len(xy)]
        k = 0
        for n in counts:
            pts = [[round(v, 6) for v in tr.transform(x, y)] for x, y in xy[k:k + n]]
            k += n
            if len(pts) >= 2:
                parts.append(pts)
    if not parts and ev.get("X") and ev.get("Y"):
        lon, lat = tr.transform(ev["X"], ev["Y"])
        return {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]}
    if not parts:
        return None
    return {"type": "LineString", "coordinates": parts[0]} if len(parts) == 1 else {"type": "MultiLineString", "coordinates": parts}


def jsdi_date(s):
    if not s:
        return None
    t = dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone(dt.timedelta(hours=1)))
    return t.date()


def short(desc, n=140):
    d = re.sub(r"\s+", " ", desc or "").strip()
    d = re.sub(r",?\s*Vydal:.*$", "", d)
    return d if len(d) <= n else d[: n - 1].rsplit(" ", 1)[0] + "…"


# VARS keys of the 14 regions (from api-mov.dopravniinfo.cz/config/web, which isn't always reachable)
REGIONS = {"Hlavní město Praha": "19", "Jihočeský kraj": "35", "Jihomoravský kraj": "116", "Karlovarský kraj": "51",
           "Kraj Vysočina": "108", "Královéhradecký kraj": "86", "Liberecký kraj": "78", "Moravskoslezský kraj": "132",
           "Olomoucký kraj": "124", "Pardubický kraj": "94", "Plzeňský kraj": "43", "Středočeský kraj": "27",
           "Ústecký kraj": "60", "Zlínský kraj": "141"}
# The feed may refuse foreign IPs (GitHub runners); JSDI_PROXY points at a small relay on a Czech host.
JSDI_PROXY = os.environ.get("JSDI_PROXY", "")


def fetch_jsdi(log):
    tr = jtsk_to_wgs()
    events = {}
    for name, key in REGIONS.items():
        reg = {"name": name, "VARS_key": key}
        for attempt in range(3):
            try:
                url = (JSDI_PROXY + "?region=" + reg["VARS_key"]) if JSDI_PROXY else JSDI_REGION.format(reg["VARS_key"])
                j = requests.get(url, headers=UA, timeout=120).json()
                break
            except Exception as e:  # noqa: BLE001
                log.append(f"JSDI {reg['name']}: {e}"); time.sleep(10)
        else:
            continue
        for ev in j.get("Information", []):
            icon = ev.get("Icon", "")
            if icon.replace("p_", "") not in KEEP_ICONS:
                continue
            events[ev["Id"]] = (ev, icon)
        time.sleep(1)
    out = []
    for eid, (ev, icon) in events.items():
        frm, to = jsdi_date(ev.get("ValidFrom")), jsdi_date(ev.get("ValidTo"))
        if not active_soon(iso(frm), iso(to)):
            continue
        geom = jsdi_geom(ev, tr)
        if not geom:
            continue
        desc = ev.get("Description") or ""
        if NOT_BIKES.search(desc) and not re.search(r"úpln\\w* uzavírk|všech vozidel", desc, re.I):
            continue
        long_term = frm and to and (to - frm).days > 730   # standing regulation rather than works
        full = not long_term and icon.endswith("U2U") and FULL.search(desc) and not PARTIAL.search(desc)
        loc = re.sub(r",?\s*okr\.\s*[^,]+$", "", ev.get("Locality") or "").strip()
        out.append({
            "id": f"jsdi-{eid}", "kind": "closure" if full else "caution",
            "title": {"cs": f"{loc}: {short(desc, 110) or ev.get('Title')}",
                      "en": f"{loc}: {'road closed' if full else 'roadworks / restriction'} (Czech traffic info)"},
            "from": iso(frm), "to": iso(to), "source": f"https://dopravniinfo.cz/?id={eid}",
            "geom": geom, "src": "JSDI – ŘSD ČR (dopravniinfo.cz)",
        })
    return out


# ------------------------------------------------------------------ OpenStreetMap
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
OSM_Q = ('[out:json][timeout:120][bbox:{bb}];(way[highway=construction];way[highway]["bicycle:conditional"~"^no ?@ ?\\\\(?sunset-sunrise"];'
         'way[highway]["access:conditional"~"^no ?@ ?\\\\(?sunset-sunrise"];);out geom tags;')


def overpass(q, log):
    for attempt in range(6):
        url = OVERPASS[attempt % len(OVERPASS)]
        try:
            r = requests.post(url, data={"data": q}, headers=UA, timeout=180)
            if r.status_code == 200:
                j = r.json()
                if not re.search(r"runtime error|timed out|out of memory", j.get("remark", "") or "", re.I):
                    return j
            log.append(f"overpass {url.split('/')[2]} {r.status_code}")
        except Exception as e:  # noqa: BLE001
            log.append(f"overpass {url.split('/')[2]} {type(e).__name__}")
        time.sleep(15 * (attempt + 1))
    return None


def boxes(rl, step=60000, pad=0.003):
    out, d = [], 0
    while d < rl.length:
        i0 = next(i for i, c in enumerate(rl.cum) if c >= d) if d else 0
        i1 = next((i for i, c in enumerate(rl.cum) if c >= d + step), len(rl.pts) - 1)
        seg = rl.pts[max(0, i0 - 1): i1 + 1]
        xs, ys = [p[0] for p in seg], [p[1] for p in seg]
        out.append((min(ys) - pad, min(xs) - pad, max(ys) + pad, max(xs) + pad))
        d += step
    return out


def scan_osm(routes, log):
    found = {}
    for rid, rl in routes.items():
        for bb in boxes(rl):
            j = overpass(OSM_Q.format(bb=",".join(f"{v:.4f}" for v in bb)), log)
            time.sleep(2)
            if not j:
                log.append(f"OSM box skipped on {rid}: {bb}")
                continue
            for w in j.get("elements", []):
                if w.get("type") != "way" or not w.get("geometry"):
                    continue
                tags = w.get("tags", {})
                night = tags.get("highway") != "construction"
                if not night and "minor" in tags.get("construction", ""):
                    continue
                od = tags.get("opening_date")
                if od and od[:10] < TODAY.isoformat()[: len(od[:10])]:
                    continue
                geom = {"type": "LineString", "coordinates": [[round(p["lon"], 6), round(p["lat"], 6)] for p in w["geometry"]]}
                found[w["id"]] = (geom, tags, night)
    out = []
    for wid, (geom, tags, night) in found.items():
        L = round(geom_length(geom) / 10) * 10
        if L < 100:
            continue
        nm = f"{tags['name']}: " if tags.get("name") else ""
        it = {"id": f"osm-{'night' if night else 'constr'}-{wid}", "kind": "caution", "from": None,
              "to": (tags.get("opening_date") + ("-28" if len(tags.get("opening_date", "")) == 7 else ""))[:10] if tags.get("opening_date") and not night else None,
              "source": f"https://www.openstreetmap.org/way/{wid}", "geom": geom, "src": "OpenStreetMap"}
        if night:
            it["title"] = {"cs": f"{nm}stezka v noci uzavřena (od soumraku do svítání)", "en": f"{nm}path closed at night (sunset to sunrise)"}
        else:
            od = tags.get("opening_date")
            it["title"] = {"cs": f"{nm}v OpenStreetMap vedeno jako stavba – úsek může být neprůjezdný",
                           "en": f"{nm}mapped as under construction in OpenStreetMap – may be impassable"}
            it["detour"] = {"cs": f"Otevření plánováno {od}." if od else "Termín otevření neuveden; ověřte na místě.",
                            "en": f"Opening planned {od}." if od else "No opening date given; check on site."}
        out.append(it)
    return out


# ------------------------------------------------------------------ assemble
def slice_geom(routes, it):
    """Items given as two end points on one route ({"routes": ["ev6"], "slice": {"a": [lon, lat], "b": [lon, lat]}})
    get the route line between the nearest points as their geometry."""
    rid = (it.get("routes") or [None])[0]
    rl = routes.get(rid)
    if not rl:
        return None
    a, b = rl.nearest(it["slice"]["a"], 3000), rl.nearest(it["slice"]["b"], 3000)
    if not a or not b:
        return None
    d0, d1 = sorted((a[1], b[1]))
    n = max(2, int((d1 - d0) / 20) + 1)
    return {"type": "LineString", "coordinates": [rl.point_at(d0 + (d1 - d0) * k / (n - 1)) for k in range(n)]}


def place(routes, items, report):
    per = {rid: [] for rid in routes}
    for it in items:
        if not it.get("geom") and it.get("slice"):
            it["geom"] = slice_geom(routes, it)
        if not it.get("geom"):
            report.setdefault("not placed", [0, 0]); report["not placed"][0] += 1
            continue
        if not active_soon(it.get("from"), it.get("to")):
            continue
        hits = match(routes, it["geom"], it.get("routes"))
        for rid, d0, d1 in hits:
            rl = routes[rid]
            per[rid].append({
                "id": it["id"], "kind": it["kind"], "d0": round(d0, 1), "d1": round(d1, 1),
                "p0": rl.point_at(d0), "p1": rl.point_at(d1), "title": it["title"],
                "from": it.get("from"), "to": it.get("to"), "detour": it.get("detour"),
                "approx": bool(it.get("approx")), "source": it.get("source"), "geom": it["geom"],
                **({"via": it["via"]} if it.get("via") else {}),
            })
        report.setdefault(it.get("src", "manual"), [0, 0])
        report[it.get("src", "manual")][0] += 1
        report[it.get("src", "manual")][1] += bool(hits)
    for rid in per:
        per[rid].sort(key=lambda c: c["d0"])
    return per


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-osm", action="store_true")
    ap.add_argument("--no-jsdi", action="store_true")
    a = ap.parse_args()
    log, report = [], {}
    routes = load_routes(ROOT)
    manual = json.loads((ROOT / "closures/manual.json").read_text())["items"]
    for it in manual:
        it.setdefault("src", "manual")
    jsdi = []
    if not a.no_jsdi:
        try:
            jsdi = fetch_jsdi(log)
            over = json.loads((ROOT / "closures/jsdi-overrides.json").read_text())["items"]
            for it in jsdi:
                it.update(over.get(it["id"][5:], {}))
            # "skip": true in an override drops a JSDI event that doesn't affect cyclists on the route
            jsdi = [it for it in jsdi if not it.get("skip")]
        except Exception as e:  # noqa: BLE001
            log.append(f"JSDI failed: {e}")
    prev = {}
    for rid in routes:
        p = ROOT / "closures" / f"{rid}.json"
        if p.exists():
            prev[rid] = json.loads(p.read_text())
    if a.no_osm or a.no_jsdi:  # keep last week's items from the source we skipped
        keep = ("osm-",) if a.no_osm else ()
        keep += ("jsdi-",) if a.no_jsdi else ()
        carried = {}
        for doc in prev.values():
            for c in doc.get("closures", []):
                if c["id"].startswith(keep):
                    carried[c["id"]] = {**c, "src": "previous run"}
        osm = list(carried.values())
    else:
        osm = []
    if not a.no_osm:
        osm = scan_osm(routes, log)
    per = place(routes, manual + jsdi + osm, report)
    lines = [f"# Closures update {TODAY.isoformat()}", "", "| source | items | on a route |", "|---|---|---|"]
    lines += [f"| {k} | {v[0]} | {v[1]} |" for k, v in report.items()]
    lines += ["", "| route | closures | cautions | new | gone |", "|---|---|---|---|---|"]
    for rid, items in per.items():
        old = {c["id"] for c in prev.get(rid, {}).get("closures", [])}
        new = {c["id"] for c in items}
        lines.append(f"| {rid} | {sum(c['kind'] == 'closure' for c in items)} | {sum(c['kind'] != 'closure' for c in items)} | {len(new - old)} | {len(old - new)} |")
        (ROOT / "closures" / f"{rid}.json").write_text(json.dumps(
            {"route": rid, "checked": TODAY.isoformat(), "closures": items}, ensure_ascii=False, separators=(",", ":")))
    if log:
        lines += ["", "## Problems", ""] + [f"- {x}" for x in log[:80]]
    (ROOT / "closures/report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
