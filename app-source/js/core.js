// Navigation core: pure functions, no DOM. Used by the app and by tests (node).
//
// Coordinates are [lon, lat]. Distances are metres. A "chainage" is the distance
// along a line from its start.

const R = 6371008.8;
const RAD = Math.PI / 180;

/** Local equirectangular projection; accurate to well under 0.5% within ~200 km. */
export function makeProj(lat0) { // for small shapes only (buffers)
  const kx = R * RAD * Math.cos(lat0 * RAD), ky = R * RAD;
  return { fwd: ([lon, lat]) => [lon * kx, lat * ky], inv: ([x, y]) => [x / kx, y / ky] };
}

export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearing(a, b) {
  const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
  const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** A polyline with cumulative distances: chainage lookups, snapping, slicing.
 *  Chainage uses great-circle distances, so it stays accurate over a whole
 *  EuroVelo route (a single flat projection would be off by ~1.5% at 1.5° of latitude). */
export class Line {
  constructor(coords) {
    const pts = [];
    for (const c of coords) {
      const p = pts[pts.length - 1];
      if (!p || p[0] !== c[0] || p[1] !== c[1]) pts.push([c[0], c[1]]);
    }
    if (pts.length < 2) pts.push([pts[0][0] + 1e-7, pts[0][1]]);
    this.coords = pts;
    this.cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) this.cum[i] = this.cum[i - 1] + haversine(pts[i - 1], pts[i]);
    this.length = this.cum[pts.length - 1];
  }

  _seg(d) { // index i such that cum[i] <= d <= cum[i+1]
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.cum[mid] <= d) lo = mid; else hi = mid; }
    return lo;
  }

  pointAt(d) {
    d = Math.max(0, Math.min(this.length, d));
    const i = this._seg(d), seg = this.cum[i + 1] - this.cum[i] || 1, t = (d - this.cum[i]) / seg;
    const a = this.coords[i], b = this.coords[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /** Heading of travel at chainage d (degrees, 0 = north). */
  headingAt(d, look = 15) {
    return bearing(this.pointAt(d - look), this.pointAt(d + look));
  }

  /** Nearest point on the line, optionally only between chainages lo..hi.
   *  Returns {d, dist, point}. */
  project(lonlat, lo = 0, hi = Infinity) {
    const kx = R * RAD * Math.cos(lonlat[1] * RAD), ky = R * RAD; // local plane around the query point
    let best = { d: 0, dist: Infinity };
    const i0 = lo > 0 ? this._seg(lo) : 0;
    const i1 = hi < this.length ? Math.min(this._seg(hi) + 1, this.coords.length - 1) : this.coords.length - 1;
    for (let i = i0; i < i1; i++) {
      const a = this.coords[i], b = this.coords[i + 1];
      const ax = (a[0] - lonlat[0]) * kx, ay = (a[1] - lonlat[1]) * ky;
      const bx = (b[0] - lonlat[0]) * kx, by = (b[1] - lonlat[1]) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 ? (-ax * dx - ay * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = this.cum[i] + t * (this.cum[i + 1] - this.cum[i]);
      if (d < lo || d > hi) continue;
      const dist = Math.hypot(ax + dx * t, ay + dy * t);
      if (dist < best.dist) best = { d, dist };
    }
    if (best.dist === Infinity) best = { d: Math.max(0, Math.min(lo, this.length)), dist: Infinity };
    best.point = this.pointAt(best.d);
    return best;
  }

  /** Coordinates from chainage a to b; reversed when b < a. */
  slice(a, b) {
    const rev = b < a, lo = Math.max(0, Math.min(a, b)), hi = Math.min(this.length, Math.max(a, b));
    const out = [this.pointAt(lo)];
    for (let i = 0; i < this.coords.length; i++) if (this.cum[i] > lo && this.cum[i] < hi) out.push(this.coords[i]);
    out.push(this.pointAt(hi));
    return rev ? out.reverse() : out;
  }
}

/**
 * Turn a route bundle into what the planner needs: the EV line, and every turn and
 * closure placed by its coordinates onto that line (chainage `f`, from the start of
 * the line, for both travel directions). Done once at load.
 */
const TURN_KIND = { 1: "slight", 2: "turn", 3: "sharp", 4: "turn_back" };
const TURN_TXT = {
  cs: { slight: "Držte se {s}", turn: "Odbočte {s}", sharp: "Odbočte ostře {s}", turn_back: "Odbočte prudce zpět {s}", l: "vlevo", r: "vpravo" },
  en: { slight: "Bear {s}", turn: "Turn {s}", sharp: "Turn sharp {s}", turn_back: "Turn sharply back to the {s}", l: "left", r: "right" },
};
export function turnText(k, side) {
  const out = {};
  for (const lang of ["cs", "en"]) out[lang] = TURN_TXT[lang][k].replace("{s}", TURN_TXT[lang][side]);
  return out;
}

/**
 * Turn a route bundle (format 2, from `export-app`) into what the planner needs: the
 * EV line, and every turn, stage, closure and gap placed onto it by coordinates
 * (chainage `f` from the start of the line). Done once at load.
 */
export function prepareRoute(route) {
  const coords = typeof route.line === "string" ? decodePolyline(route.line, 1e5) : route.line;
  const ev = new Line(coords);
  const scale = ev.length / route.length_m;
  // Search near where we expect it (routes can pass the same place twice); fall back to everywhere.
  const place = (p, expected, win = 2000) => {
    const near = ev.project(p, Math.max(0, expected - win), expected + win);
    return near.dist < 50 ? near.d : ev.project(p).d;
  };
  // Turns come in order along the line: search forward from the previous one.
  const fwd = [];
  let cursor = 0;
  for (const [lon, lat, kc, a] of route.turns) {
    const p = [lon, lat];
    let pr = ev.project(p, Math.max(0, cursor - 100), cursor + 25000);
    if (pr.dist > 5) { const g = ev.project(p); if (g.dist < pr.dist) pr = g; } // turns sit on the line itself
    cursor = pr.d;
    const k = TURN_KIND[kc], s = a > 0 ? "r" : "l";
    fwd.push({ f: pr.d, k, s, a, t: turnText(k, s), p });
  }
  // Riding the other way, the same corner is the same kind of turn to the other side.
  const rev = fwd.map((m) => { const s = m.s === "l" ? "r" : "l"; return { ...m, s, a: -m.a, t: turnText(m.k, s) }; });
  const closures = (route.closures || []).map((c) => {
    const a = place(c.p0, c.d0 * scale), b = place(c.p1, c.d1 * scale);
    return { ...c, f0: Math.min(a, b), f1: Math.max(a, b) };
  });
  // Stages and gaps also come in order along the line: search forward, not everywhere.
  const ahead = (p, from, span) => {
    const pr = ev.project(p, Math.max(0, from - 1000), from + span);
    return pr.dist < 50 ? pr.d : ev.project(p).d;
  };
  let sc = 0;
  const stages = (route.stages || []).map((st) => { sc = ahead(st.p, sc, 400000); return { ...st, f: sc }; });
  let gc = 0;
  const gaps = (route.gaps || []).map((g) => {
    const a = ahead(g.a, gc, 1500000), b = ahead(g.b, a, 300000);
    gc = Math.max(a, b);
    return { ...g, id: "gap", kind: "gap", f0: Math.min(a, b), f1: Math.max(a, b) };
  });
  const ele = route.ele ? decodeSeries(route.ele.data) : null, step = route.ele?.step || 250;
  const eleAt = ele ? (f) => {
    const x = Math.max(0, Math.min(ele.length - 1, f / step)), i = Math.floor(x), t = x - i;
    return i + 1 < ele.length ? ele[i] * (1 - t) + ele[i + 1] * t : ele[i];
  } : null;
  return { ...route, line: coords, ev, fwd, rev, closures, stages, gaps, eleAt, prepared: true };
}

/** Polyline-style delta series of integers (the bundle's elevation profile). */
export function decodeSeries(str) {
  const out = []; let i = 0, v = 0;
  while (i < str.length) {
    let shift = 0, r = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    v += r & 1 ? ~(r >> 1) : r >> 1;
    out.push(v);
  }
  return out;
}

/** Profile helpers. profile: [[d, ele], ...] sorted by d. */
export function eleAtD(profile, d) {
  if (!profile || !profile.length) return null;
  let lo = 0, hi = profile.length - 1;
  if (d <= profile[0][0]) return profile[0][1];
  if (d >= profile[hi][0]) return profile[hi][1];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (profile[m][0] <= d) lo = m; else hi = m; }
  const [d0, e0] = profile[lo], [d1, e1] = profile[hi];
  return e0 + (e1 - e0) * ((d - d0) / (d1 - d0 || 1));
}
/** Metres climbed between chainages a and b, ignoring wiggles under 5 m (GPX noise). */
export function ascent(profile, a = 0, b = Infinity, step = 100) {
  if (!profile || profile.length < 2) return 0;
  b = Math.min(b, profile.at(-1)[0]);
  let up = 0, base = eleAtD(profile, a);
  for (let d = a + step; d <= b + step - 1; d += step) {
    const e = eleAtD(profile, Math.min(d, b));
    if (e > base + 5) { up += e - base; base = e; } else if (e < base - 5) base = e;
  }
  return up;
}

/** Polygon ring (lon/lat) around a closure geometry, buffered by `m` metres.
 *  Used to tell the router which roads to avoid. */
export function bufferRing(geom, m = 30) {
  const pts = geom.type === "Point" ? [geom.coordinates]
    : geom.type === "LineString" ? geom.coordinates
    : geom.type === "Polygon" ? geom.coordinates[0] : geom.coordinates.flat();
  const proj = makeProj(pts[0][1]);
  const xy = pts.map(proj.fwd);
  // Convex hull of circles around every point: robust, simple, good enough for "avoid here".
  const cloud = [];
  for (const [x, y] of xy) for (let k = 0; k < 12; k++) {
    const a = (k / 12) * 2 * Math.PI; cloud.push([x + m * Math.cos(a), y + m * Math.sin(a)]);
  }
  cloud.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of cloud) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of cloud.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  hull.push(hull[0]);
  return hull.map(proj.inv);
}

const TXT = {
  cs: {
    join: "Napojte se na {n}", leave: "Opusťte {n}", detour: "Objížďka uzavírky",
    detourEnd: "Zpět na {n}", arrive: "Jste v cíli", in: (d) => `Za ${d}`,
  },
  en: {
    join: "Join {n}", leave: "Leave {n}", detour: "Closure detour",
    detourEnd: "Back on {n}", arrive: "You have arrived", in: (d) => `In ${d}`,
  },
};
export const T = TXT;


/** Distance in metres from point p to segment a–b (local plane around p). */
function segDist(p, a, b) {
  const kx = R * RAD * Math.cos(p[1] * RAD), ky = R * RAD;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / L2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}

/**
 * Remove every stretch where a route comes back past a point it already went
 * through (out-and-back spurs, little loops). A sensible bike route never needs
 * one; routers produce them when a start point sits a few metres up the wrong road.
 * Maneuvers inside a removed stretch collapse onto the point where it rejoins
 * (the last one wins: that's the real turn); U-turns are dropped.
 */
/**
 * A routed leg that starts by going the wrong way up a street and turning back (or ends by riding
 * past the target and coming back): cut that out-and-back off. Only true retracing counts, so
 * hairpin bends on a climb are left alone.
 */
export function trimSpurEnds(coords, maneuvers = [], tol = 25, maxSpur = 600) {
  if (coords.length < 4) return { coords, maneuvers };
  const retraced = (L, a, b) => { // does the path between a and b go out and come back the same way?
    let far = a, fd = 0;
    for (let d = a; d <= b; d += 5) { const g = haversine(L.pointAt(a), L.pointAt(d)); if (g > fd) { fd = g; far = d; } }
    if (fd < 15) return false;
    let n = 0, same = 0;
    for (let d = a + 5; d < far; d += 10) { n++; const q = L.pointAt(d); for (let e = far; e <= b; e += 5) if (haversine(q, L.pointAt(e)) < 20) { same++; break; } }
    return n > 0 && same / n > 0.7;
  };
  let L = new Line(coords), cut0 = 0, cut1 = L.length;
  for (let t = Math.min(maxSpur, L.length - 10); t >= 30; t -= 5)
    if (haversine(L.pointAt(0), L.pointAt(t)) < tol && retraced(L, 0, t)) { cut0 = t; break; }
  for (let t = Math.min(maxSpur, L.length - cut0 - 10); t >= 30; t -= 5)
    if (haversine(L.pointAt(L.length), L.pointAt(L.length - t)) < tol && retraced(L, L.length - t, L.length)) { cut1 = L.length - t; break; }
  if (cut0 === 0 && cut1 === L.length) return { coords, maneuvers };
  const i0 = L.cum.findIndex((c) => c > cut0), i1 = L.cum.findIndex((c) => c >= cut1);
  const a = Math.max(1, i0), b = i1 < 0 ? coords.length - 1 : i1;
  const out = [L.pointAt(cut0), ...coords.slice(a, b), L.pointAt(cut1)];
  const mm = maneuvers.filter((m) => m.i >= a && m.i < b).map((m) => ({ ...m, i: m.i - a + 1 }));
  return { coords: out, maneuvers: mm };
}

export function removeLoops(coords, maneuvers = [], tol = 10, maxLoop = 4000) {
  const n = coords.length;
  if (n < 4) return { coords, maneuvers };
  const cum = [0];
  for (let k = 1; k < n; k++) cum.push(cum[k - 1] + haversine(coords[k - 1], coords[k]));
  const keep = [];
  let i = 0;
  while (i < n) {
    keep.push(i);
    let jump = -1;
    for (let j = i + 2; j < n && cum[j] - cum[i] <= maxLoop; j++) {
      if (cum[j - 1] - cum[i] > 3 * tol && segDist(coords[i], coords[j - 1], coords[j]) < tol) jump = j - 1;
    }
    i = jump > 0 ? jump + 1 : i + 1;
  }
  const newIdx = (o) => { let lo = 0, hi = keep.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (keep[m] <= o) lo = m; else hi = m - 1; } return lo; };
  const byIdx = new Map();
  for (const m of maneuvers) {
    if (m.k === "turn_back") continue;
    byIdx.set(newIdx(m.i), { ...m, i: newIdx(m.i) });
  }
  return { coords: keep.map((k) => coords[k]), maneuvers: [...byIdx.values()].sort((a, b) => a.i - b.i) };
}

/**
 * How far a router leg runs along EV9 at its start (or end). Returns the index of
 * the last (first) point of that run and its chainage on EV9, searching only the
 * EV9 stretch between chainages lo..hi.
 */
function evRun(coords, ev, lo, hi, fromEnd, tol = 15) {
  const n = coords.length;
  let best = null;
  for (let s = 0; s < n; s++) {
    const i = fromEnd ? n - 1 - s : s;
    const pr = ev.project(coords[i], lo, hi);
    if (pr.dist > tol) break;
    best = { idx: i, f: pr.d };
  }
  return best;
}

/**
 * Plan a ride: start → nearest EuroVelo point → along EuroVelo → point nearest the
 * destination → destination, routing around closures.
 *
 * route: the bundle from `export-app` (line, fwd, rev, closures...)
 * router(from, to, {avoid}) → Promise<{coords, maneuvers:[{i, k, s, t:{lang:text}}]}>
 *   i = index into coords where the maneuver happens. May throw.
 * Returns a Plan: {coords, maneuvers:[{d,k,s,t}], parts:[{kind,d0,d1}], warnings:[...], evRange}
 */
/** Is a closure in force on this day (ISO yyyy-mm-dd)? Bundles also carry ones starting soon. */
export function closureActive(c, day = localISO(new Date())) {
  return (!c.from || c.from <= day) && (!c.to || c.to >= day);
}
export function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function planRide(route, start, dest, router, opts = {}) {
  const lang = opts.lang || "cs";
  const day = opts.day || localISO(new Date());
  const join = opts.joinThreshold ?? 60;
  if (!route.prepared) route = prepareRoute(route);
  const ev = route.ev;

  // Where to get on and off. Getting on: the EV point nearest to you. Getting off:
  // the EV point nearest the destination.
  const pa = ev.project(start), pb = ev.project(dest);
  const dir = pb.d >= pa.d ? 1 : -1;
  const evA = pa.d, evB = pb.d;

  const parts = []; // {kind, coords, maneuvers:[{i,k,s,t}]} in travel order
  const failed = [];

  async function leg(kind, from, to, avoid) {
    try {
      const raw = await router(from, to, { avoid, lang });
      const l0 = removeLoops(raw.coords, raw.maneuvers || []);
      const r = trimSpurEnds(l0.coords, l0.maneuvers);
      parts.push({ kind, coords: r.coords, maneuvers: r.maneuvers || [] });
    } catch (e) {
      failed.push({ kind, error: String(e && e.message || e) });
      parts.push({ kind, coords: [from, to], maneuvers: [], straight: true });
    }
  }

  if (pa.dist > join) await leg("approach", start, pa.point);

  // EuroVelo stretch, cut around closures that lie on it.
  const lo = Math.min(evA, evB), hi = Math.max(evA, evB);
  const blocks = [
    ...(route.closures || [])
      .filter((c) => c.kind === "closure" && closureActive(c, day) && c.f1 >= lo && c.f0 <= hi)
      .map((c) => ({ ...c, a: Math.max(lo, c.f0 - 120), b: Math.min(hi, c.f1 + 120) })),
    // gaps in the route data (a ferry, a missing bit): let the bike router link the two ends
    ...(route.gaps || [])
      .filter((g) => g.f1 > lo && g.f0 < hi)
      .map((g) => ({ ...g, a: Math.max(lo, g.f0), b: Math.min(hi, g.f1) })),
  ];
  // merge overlapping blocks, order along travel. Closures close to each other
  // (Mikulovice: three within 3 km) become one detour; separate ones would each
  // rejoin the route for a few hundred metres and send the rider back and forth.
  const MERGE_GAP = opts.mergeGap ?? 2500;
  blocks.sort((x, y) => x.a - y.a);
  const merged = [];
  for (const b of blocks) {
    const m = merged[merged.length - 1];
    const bothClosures = m && b.kind === "closure" && m.list.every((x) => x.kind === "closure");
    if (m && (b.a <= m.b || (bothClosures && b.a - m.b <= MERGE_GAP))) { m.b = Math.max(m.b, b.b); m.list.push(b); } else merged.push({ a: b.a, b: b.b, list: [b] });
  }
  if (dir < 0) merged.reverse();

  let cur = evA;
  const evPieces = [];
  for (const blk of merged) {
    const enter = dir > 0 ? blk.a : blk.b, exit = dir > 0 ? blk.b : blk.a;
    if ((enter - cur) * dir > 1) evPieces.push(["ev", cur, enter]);
    evPieces.push(["detour", enter, exit, blk.list]);
    cur = exit;
  }
  if ((evB - cur) * dir > 1 || evPieces.length === 0) evPieces.push(["ev", cur, evB]);

  // `resume` = where on EV9 we are after the previous piece (a detour may rejoin later than planned)
  let resume = evA;
  const ahead = (x, y) => (x - y) * dir; // >0 when x is further along the direction of travel than y

  // The approach may meet EV9 a bit before or after the nearest point and then ride
  // along it; join EV9 where it first touches it instead, so nothing doubles back.
  const app = parts[0] && parts[0].kind === "approach" && !parts[0].straight ? parts[0] : null;
  if (app) {
    const limit = evPieces[0][0] === "detour" ? evPieces[0][1] : evPieces[0][2];
    const lo2 = Math.max(0, Math.min(evA - 1500, limit)), hi2 = Math.min(ev.length, Math.max(evA + 1500, limit));
    const run = evRun(app.coords, ev, Math.min(lo2, hi2), Math.max(lo2, hi2), true);
    if (run && run.idx > 0 && ahead(limit, run.f) > 1) {
      app.coords = app.coords.slice(0, run.idx + 1);
      app.maneuvers = app.maneuvers.filter((m) => m.i <= run.idx);
      resume = run.f;
    }
  }
  for (let k = 0; k < evPieces.length; k++) {
    const p = evPieces[k];
    if (p[0] === "ev") {
      const from = resume; // pick up exactly where the previous piece left EV9
      if (ahead(p[2], from) > 1) parts.push({ kind: "ev", coords: ev.slice(from, p[2]), from, to: p[2] });
      resume = ahead(p[2], from) > 1 ? p[2] : from;
      continue;
    }
    // Detour: leave EV9 a little before the closure and rejoin after it. On rural
    // roads a point 120 m away can sit on the very road segment that gets excluded,
    // and the router finds no path; then step further out and try again.
    const avoid = p[3].filter((c) => c.geom).map((c) => bufferRing(c.geom, 30));
    const prev = parts[parts.length - 1];
    const floor = prev && prev.kind === "ev" ? prev.from : resume;  // can't leave before the previous EV piece starts
    const nextEv = evPieces.slice(k + 1).find((x) => x[0] === "detour");
    const ceil = nextEv ? nextEv[1] : evB;                           // nor rejoin past the next detour / the end
    let done = false, lastErr = null;
    // A signed detour (closure.via, waypoints in route order) is ridden first; only if
    // the router can't follow it does the app look for its own way round.
    const blkList = [...p[3]].sort((x, y) => (x.f0 - y.f0) * dir);
    const via = blkList.flatMap((c) => (c.via ? (dir > 0 ? c.via : [...c.via].reverse()) : []));
    const tries = [...(via.length ? [[0, via], [380, via]] : []), [0, null], [380, null], [1380, null], [2880, null]];
    for (const [margin, vp] of tries) {
      let enter = p[1] - margin * dir, exit = p[2] + margin * dir;
      if (ahead(floor, enter) > 0) enter = floor;
      if (ahead(exit, ceil) > 0) exit = ceil;
      try {
        const raw = await router(ev.pointAt(enter), ev.pointAt(exit), { avoid, via: vp || [], lang });
        let { coords: dc, maneuvers: dm } = (() => { const l0 = removeLoops(raw.coords, raw.maneuvers || []); return trimSpurEnds(l0.coords, l0.maneuvers); })();
        if (vp) { // sanity check on the signed detour: a bad waypoint can send the rider on a 15 km loop
          const len = new Line(dc).length, closed = Math.abs(exit - enter);
          if (len > Math.max(8000, 6 * closed)) throw new Error("signed detour too long");
        }
        // Where does the detour really leave and rejoin EV9? The router often rides a
        // bit along EV9 first (or back along it) before turning off; let EV9 carry
        // the rider to the real turn-off, and pick it up again where the detour returns.
        const cStart = dir > 0 ? Math.min(...p[3].map((c) => c.f0)) : Math.max(...p[3].map((c) => c.f1));
        const cEnd = dir > 0 ? Math.max(...p[3].map((c) => c.f1)) : Math.min(...p[3].map((c) => c.f0));
        const prevFrom = prev && prev.kind === "ev" ? prev.from : resume;
        const sRun = evRun(dc, ev, Math.min(prevFrom, cStart), Math.max(prevFrom, cStart), false);
        const eRun = evRun(dc, ev, Math.min(cEnd, ceil), Math.max(cEnd, ceil), true);
        let i0 = 0, i1 = dc.length - 1, leave = enter, rejoin = exit;
        if (sRun && prev && prev.kind === "ev" && ahead(sRun.f, prev.from) > 1) { i0 = sRun.idx; leave = sRun.f; }
        if (eRun && eRun.idx > i0 + 1) { i1 = eRun.idx; rejoin = eRun.f; }
        dc = dc.slice(i0, i1 + 1);
        dm = dm.filter((m) => m.i >= i0 && m.i <= i1).map((m) => ({ ...m, i: m.i - i0 }));
        if (prev && prev.kind === "ev" && leave !== prev.to) {
          if (ahead(leave, prev.from) > 1) { prev.to = leave; prev.coords = ev.slice(prev.from, leave); } else parts.pop();
        }
        parts.push({ kind: p[3].every((c) => c.kind === "gap") ? "link" : "detour", coords: dc, maneuvers: dm, closures: p[3], signed: !!vp });
        resume = rejoin; done = true;
        break;
      } catch (e) {
        lastErr = e;
        if (!vp && !/no path|400|442/i.test(String(e && e.message))) break; // network trouble: don't hammer the server
      }
    }
    if (!done) {
      failed.push({ kind: "detour", error: String(lastErr && lastErr.message || lastErr) });
      parts.push({ kind: p[3].every((c) => c.kind === "gap") ? "link" : "detour", coords: [ev.pointAt(p[1]), ev.pointAt(p[2])], maneuvers: [], straight: true, closures: p[3] });
      resume = p[2];
    }
  }

  if (pb.dist > join) {
    await leg("exit", pb.point, dest);
    // same idea at the end: leave EV9 where the exit leg really turns off it
    const ex = parts[parts.length - 1], last = parts[parts.length - 2];
    if (!ex.straight && last && last.kind === "ev") {
      const run = evRun(ex.coords, ev, Math.max(0, Math.min(last.from, evB - 1500, evB + 1500)), Math.min(ev.length, Math.max(last.from, evB - 1500, evB + 1500)), false);
      if (run && run.idx > 0 && ahead(run.f, last.from) > 1) {
        last.to = run.f; last.coords = ev.slice(last.from, run.f);
        ex.coords = ex.coords.slice(run.idx);
        ex.maneuvers = ex.maneuvers.filter((m) => m.i >= run.idx).map((m) => ({ ...m, i: m.i - run.idx }));
      }
    }
  }

  // ---- no "ride there and come back" between pieces ----
  // A piece (exit leg, detour, the EuroVelo stretch after an approach…) can start by going back
  // over the end of the previous piece: the rider would be sent past the turn-off and then turned
  // around. Cut both at the point where they really part.
  for (let pi = parts.length - 1; pi >= 0; pi--) // crumbs left between two pieces would hide the overlap
    if (parts.length > 1 && !parts[pi].straight && new Line(parts[pi].coords).length < 5) parts.splice(pi, 1);
  for (let pi = 1; pi < parts.length; pi++) {
    const A = parts[pi - 1], B = parts[pi];
    if (A.straight || B.straight || A.coords.length < 2 || B.coords.length < 2) continue;
    const LA = new Line(A.coords), LB = new Line(B.coords);
    let prevD = LA.length, lastT = 0, lastD = LA.length;
    for (let t = 5; t < Math.min(LB.length, 3000); t += 5) {
      const pr = LA.project(LB.pointAt(t), Math.max(0, LA.length - 3000));
      if (pr.dist > 20 || pr.d > prevD + 3) break;
      prevD = pr.d; lastT = t; lastD = pr.d;
    }
    if (lastT < 25 || LA.length - lastD < 25) {
      // a short spike where the pieces meet (A runs a few metres on to the EuroVelo line, B starts back
      // from there): cut both where they come closest within the last/first 60 m
      let best = null;
      for (let ba = 0; ba <= Math.min(60, LA.length - 1); ba += 5)
        for (let fb = 0; fb <= Math.min(60, LB.length - 1); fb += 5) {
          const g = haversine(LA.pointAt(LA.length - ba), LB.pointAt(fb));
          if (g < 12 && ba + fb > 20 && (!best || ba + fb > best.ba + best.fb)) best = { ba, fb };
        }
      if (!best) continue;
      lastD = LA.length - best.ba; lastT = best.fb;
    }
    lastD = Math.max(1, lastD); lastT = Math.min(LB.length - 1, lastT);
    // trim the end of A
    if (A.kind === "ev") { A.to = A.from + dir * lastD; A.coords = ev.slice(A.from, A.to); }
    else {
      const keep = LA.cum.findIndex((c) => c > lastD); const k = keep < 0 ? A.coords.length - 1 : keep;
      A.coords = [...A.coords.slice(0, k), LA.pointAt(lastD)];
      A.maneuvers = (A.maneuvers || []).filter((m) => m.i < k);
    }
    // trim the start of B
    if (B.kind === "ev") { B.from = B.from + dir * lastT; B.coords = ev.slice(B.from, B.to); }
    else {
      const k = Math.max(1, LB.cum.findIndex((c) => c > lastT));
      B.coords = [LB.pointAt(lastT), ...B.coords.slice(k)];
      B.maneuvers = (B.maneuvers || []).filter((m) => m.i >= k).map((m) => ({ ...m, i: m.i - k + 1 }));
    }
    // A shrank to nothing: drop it and check B against the piece before A too
    if (new Line(A.coords).length < 5 && pi >= 2) { parts.splice(pi - 1, 1); pi -= 2; }
  }

  // ---- assemble one line + one maneuver list with chainage along it ----
  const coords = [], maneuvers = [], spans = [], profile = [];
  let offset = 0;
  const num = opts.routeLong ?? route.long ?? `EuroVelo ${opts.routeNum ?? route.num ?? (String(route.id || "").replace(/\D/g, "") || "9")}`;
  const pushTxt = (key) => ({ cs: TXT.cs[key].replace("{n}", num), en: TXT.en[key].replace("{n}", num) });

  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    const pl = new Line(part.coords);
    const base = offset;
    // transitions
    if (part.kind === "ev" && parts[pi - 1]?.kind !== "link" && (pi > 0 || pa.dist > join)) maneuvers.push({ d: base, k: "join", s: "", t: pushTxt(parts[pi - 1]?.kind === "detour" ? "detourEnd" : "join") });
    if (part.kind === "detour") maneuvers.push({ d: base, k: "detour", s: "", t: pushTxt("detour"), closures: (part.closures || []).filter((c) => c.kind === "closure").map((c) => c.id) });
    if (part.kind === "exit") maneuvers.push({ d: base, k: "leave", s: "", t: pushTxt("leave") });

    if (part.kind === "ev") {
      // our own turn list for this direction of travel (f = chainage on the EV line)
      const list = dir > 0 ? route.fwd : route.rev;
      for (const m of list) {
        const along = (m.f - part.from) * dir;
        if (along > 5 && along < Math.abs(part.to - part.from) - 5) maneuvers.push({ d: base + along, k: m.k, s: m.s, a: m.a, t: m.t });
      }
    } else {
      // router maneuvers: chainage from the vertex index
      for (const m of part.maneuvers) {
        if (["depart", "arrive"].includes(m.k)) continue;
        const i = Math.max(0, Math.min(pl.coords.length - 1, m.i | 0));
        const d = pl.project(part.coords[i]).d;
        maneuvers.push({ d: base + d, k: m.k, s: m.s || "", t: m.t, street: m.street });
      }
    }
    spans.push({ kind: part.kind, d0: base, d1: base + pl.length, straight: !!part.straight });
    // elevation: the bundle's profile on EuroVelo, the router's (3rd coordinate) elsewhere
    if (part.kind === "ev" && route.eleAt) {
      const len = pl.length;
      for (let x = 0; x < len; x += 250) profile.push([base + x, route.eleAt(part.from + dir * x)]);
      profile.push([base + len, route.eleAt(part.to)]);
    } else {
      let run = 0;
      for (let i = 0; i < part.coords.length; i++) {
        if (i) run += haversine(part.coords[i - 1], part.coords[i]);
        if (part.coords[i][2] != null) profile.push([base + run, part.coords[i][2]]);
      }
    }
    for (const c of (coords.length ? pl.coords.slice(1) : pl.coords)) coords.push(c);
    offset += pl.length;
  }
  maneuvers.sort((x, y) => x.d - y.d);
  // drop a router "turn" sitting on top of a transition marker
  const clean = [];
  for (const m of maneuvers) {
    const prev = clean[clean.length - 1];
    if (prev && Math.abs(prev.d - m.d) < 15 && ["join", "leave", "detour"].includes(prev.k) && !["join", "leave", "detour"].includes(m.k)) continue;
    clean.push(m);
  }
  clean.push({ d: offset, k: "arrive", s: "", t: pushTxt("arrive") });

  // warnings: cautions/reports on the EuroVelo stretch actually ridden
  const warnings = [];
  for (const sp of spans.filter((s) => s.kind === "ev")) {
    const part = parts[spans.indexOf(sp)];
    const a = Math.min(part.from, part.to), b = Math.max(part.from, part.to);
    for (const c of route.closures || []) {
      if (c.kind === "closure" || !closureActive(c, day) || c.f1 < a || c.f0 > b) continue;
      const along = dir > 0 ? c.f0 - part.from : part.from - c.f1;
      warnings.push({ d: sp.d0 + Math.max(0, along), id: c.id, kind: c.kind, title: c.title, to: c.to });
    }
  }
  for (const p of parts.filter((p) => p.kind === "detour")) for (const c of (p.closures || []).filter((x) => x.kind === "closure")) {
    const sp = spans[parts.indexOf(p)];
    warnings.push({ d: sp.d0, id: c.id, kind: "closure", title: c.title, to: c.to, detour: c.detour, avoided: true, signed: !!p.signed });
  }
  warnings.sort((x, y) => x.d - y.d);

  const evLen = spans.filter((s) => s.kind === "ev").reduce((s, x) => s + x.d1 - x.d0, 0);
  return {
    coords, maneuvers: clean, spans, warnings, failed, length: offset, evLength: evLen,
    dir, joinAt: pa, leaveAt: pb, start, dest, profile: profile.sort((x, y) => x[0] - y[0]),
  };
}

/**
 * Progress tracker: snap GPS fixes to the plan, find the next maneuver, decide
 * what to announce and when the rider is off route.
 */
export class Navigator {
  constructor(plan, opts = {}) {
    this.plan = plan;
    this.line = new Line(plan.coords);
    this.d = 0;
    this.off = 0;
    this.spoken = new Set();
    this.offRouteM = opts.offRouteM ?? 40;
    this.offRouteFixes = opts.offRouteFixes ?? 3;
    this.announce = opts.announce ?? [250, 60];
    this.warnAhead = opts.warnAhead ?? 800;
  }

  /** Feed a GPS fix ([lon,lat], accuracy m). Returns a state object. */
  update(lonlat, accuracy = 10) {
    // search a window around the last position so loops and parallel streets don't confuse us
    let snap = this.line.project(lonlat, Math.max(0, this.d - 80), this.d + 600);
    if (snap.dist > this.offRouteM * 2) {
      const global = this.line.project(lonlat);
      if (global.dist < snap.dist - 20) snap = global;
    }
    const good = accuracy <= 50;
    if (snap.dist > this.offRouteM && good) this.off++; else if (snap.dist <= this.offRouteM) this.off = 0;
    if (snap.dist <= this.offRouteM * 1.5) this.d = Math.max(this.d - 30, snap.d); // tolerate small backwards jitter

    const ms = this.plan.maneuvers;
    let idx = ms.findIndex((m) => m.d > this.d + 8);
    if (idx < 0) idx = ms.length - 1;
    const next = ms[idx], after = ms[idx + 1];
    const toNext = Math.max(0, next.d - this.d);

    const say = [];
    for (const th of this.announce) {
      const key = `${idx}@${th}`;
      if (toNext <= th && toNext > th * 0.4 && !this.spoken.has(key)) {
        // only the nearest threshold fires; mark the farther ones as done
        this.announce.filter((x) => x >= th).forEach((x) => this.spoken.add(`${idx}@${x}`));
        say.push({ kind: "maneuver", m: next, dist: th === Math.min(...this.announce) ? 0 : roundDist(toNext) });
        break;
      }
    }
    const warn = [];
    for (const w of this.plan.warnings) {
      const ahead = w.d - this.d;
      if (ahead >= -20 && ahead <= this.warnAhead) {
        warn.push({ ...w, ahead });
        if (!this.spoken.has("w:" + w.id)) { this.spoken.add("w:" + w.id); say.push({ kind: "warning", w, dist: roundDist(Math.max(0, ahead)) }); }
      }
    }
    const remaining = Math.max(0, this.plan.length - this.d);
    return {
      d: this.d, snapDist: snap.dist, snapped: this.line.pointAt(this.d), heading: this.line.headingAt(this.d),
      next, after, toNext, idx, remaining, warn, say,
      offRoute: this.off >= this.offRouteFixes, arrived: remaining < 25,
      onEV: this.plan.spans.some((s) => s.kind === "ev" && this.d >= s.d0 && this.d <= s.d1),
    };
  }
}

export function roundDist(m) {
  if (m >= 1000) return Math.round(m / 100) * 100;
  if (m >= 300) return Math.round(m / 50) * 50;
  return Math.max(10, Math.round(m / 10) * 10);
}

export function fmtDist(m, lang = "cs") {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace(".", lang === "cs" ? "," : ".")} km`;
  return `${roundDist(m)} m`;
}

/** Spoken sentence for a maneuver or warning. */
export function phrase(item, lang = "cs") {
  const t = TXT[lang];
  if (item.kind === "warning") {
    const w = item.w, title = w.title?.[lang] || w.title?.cs || "";
    const pre = lang === "cs" ? (w.avoided ? "Objíždíme uzavírku" : "Pozor") : (w.avoided ? "Detouring around a closure" : "Caution");
    return item.dist > 0 ? `${t.in(fmtDist(item.dist, lang))}: ${pre}. ${title}` : `${pre}. ${title}`;
  }
  const text = item.m.t?.[lang] || item.m.t?.cs || item.m.t?.en || "";
  return item.dist > 0 ? `${t.in(fmtDist(item.dist, lang))} ${lowerFirst(text, lang)}` : text;
}

function lowerFirst(s, lang) {
  if (!s) return s;
  return lang === "cs" || lang === "en" ? s[0].toLowerCase() + s.slice(1) : s;
}

/** Valhalla maneuver → our maneuver shape. */
export function fromValhalla(m, lang) {
  const type = m.type;
  // Valhalla types: 1-3 start, 4-6 destination, 8 continue, 9 slight right, 10 right,
  // 11 sharp right, 12/13 u-turn, 14 sharp left, 15 left, 16 slight left, 26/27 roundabout
  const map = { 9: ["slight", "r"], 10: ["turn", "r"], 11: ["sharp", "r"], 12: ["turn_back", "r"], 13: ["turn_back", "l"],
    14: ["sharp", "l"], 15: ["turn", "l"], 16: ["slight", "l"], 26: ["roundabout", ""], 27: ["roundabout_exit", ""],
    17: ["ramp", "s"], 18: ["ramp", "r"], 19: ["ramp", "l"], 20: ["exit", "r"], 21: ["exit", "l"],
    22: ["continue", ""], 23: ["keep", "r"], 24: ["keep", "l"], 8: ["continue", ""], 7: ["continue", ""],
    1: ["depart", ""], 2: ["depart", ""], 3: ["depart", ""], 4: ["arrive", ""], 5: ["arrive", ""], 6: ["arrive", ""] };
  const [k, s] = map[type] || ["continue", ""];
  return { i: m.begin_shape_index, k, s, t: { [lang]: m.instruction }, street: (m.street_names || [])[0] };
}

/** Decode an encoded polyline (Google format) to [lon,lat]. Valhalla uses precision 1e6. */
export function decodePolyline(str, factor = 1e6) {
  const out = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lon += delta;
    }
    out.push([lon / factor, lat / factor]);
  }
  return out;
}
export const decodePolyline6 = (str) => decodePolyline(str, 1e6);

// ---------------------------------------------------------------- several routes

/**
 * Which EuroVelo routes to ride, and where to switch between them.
 *
 * net = {routes: [{id, num, outlineLine}], junctions: [{a, b, pa, pb}]}
 * Uses only the light route outlines (no full downloads): a graph whose nodes are
 * junctions and the points where you'd join/leave each route; edges run along each
 * route between neighbouring nodes, across junctions, and from the start / to the
 * destination. You may get onto any route within `reach` metres of you (plus always
 * the nearest one); road riding to reach it costs `roadCost` × its length, so the
 * plan prefers EuroVelo over plain roads. A route change costs far more than any
 * distance, so the plan stays on one route whenever the trip can be done on it and
 * only switches where it has to (Jeseník – Pula: EV9 only; Jeseník – Kyiv: EV9 → EV4).
 * Returns legs [{id, num, from:[lon,lat], to:[lon,lat]}] in riding order.
 */
export function chooseRoutes(net, start, dest, opts = {}) {
  const reach = opts.reach ?? 25000, roadCost = opts.roadCost ?? 1.5, switchCost = opts.switchCost ?? 1e7; // fewest route changes first, then shortest: never switch just to save km
  const nodes = [], edges = new Map();
  const node = (rid, f, p) => { nodes.push({ rid, f, p }); return nodes.length - 1; };
  const edge = (a, b, w) => {
    if (!edges.has(a)) edges.set(a, []); if (!edges.has(b)) edges.set(b, []);
    edges.get(a).push([b, w]); edges.get(b).push([a, w]);
  };
  const byRoute = new Map(net.routes.map((r) => [r.id, []]));
  const outline = new Map(net.routes.map((r) => [r.id, r.outlineLine]));

  for (const j of net.junctions || []) {
    if (!outline.has(j.a) || !outline.has(j.b)) continue;
    const na = node(j.a, outline.get(j.a).project(j.pa).d, j.pa);
    const nb = node(j.b, outline.get(j.b).project(j.pb).d, j.pb);
    byRoute.get(j.a).push(na); byRoute.get(j.b).push(nb);
    edge(na, nb, switchCost + haversine(j.pa, j.pb));
  }
  const S = node(null, 0, start), D = node(null, 0, dest);
  for (const [end, isStart] of [[start, true], [dest, false]]) {
    const cands = net.routes.map((r) => ({ r, pr: r.outlineLine.project(end) })).sort((x, y) => x.pr.dist - y.pr.dist);
    cands.forEach(({ r, pr }, k) => {
      if (k > 0 && pr.dist > reach) return;
      const n = node(r.id, pr.d, pr.point);
      byRoute.get(r.id).push(n);
      edge(isStart ? S : D, n, pr.dist * roadCost);
    });
  }
  for (const list of byRoute.values()) {
    list.sort((x, y) => nodes[x].f - nodes[y].f);
    for (let k = 1; k < list.length; k++) edge(list[k - 1], list[k], Math.abs(nodes[list[k]].f - nodes[list[k - 1]].f));
  }

  // Dijkstra (small graph: a few dozen nodes)
  const dist = new Array(nodes.length).fill(Infinity), prev = new Array(nodes.length).fill(-1), done = new Set();
  dist[S] = 0;
  while (true) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done.has(i) && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === D) break;
    done.add(u);
    for (const [v, w] of edges.get(u) || []) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
  }
  if (dist[D] === Infinity) return null;
  const path = [];
  for (let u = D; u >= 0; u = prev[u]) path.unshift(u);

  // consecutive nodes on the same route make one leg
  const legs = [];
  for (const u of path.slice(1, -1)) {
    const n = nodes[u], last = legs[legs.length - 1];
    if (last && last.id === n.rid) last.to = n.p;
    else { const m = net.routes.find((r) => r.id === n.rid); legs.push({ id: n.rid, num: m?.num, short: m?.short, long: m?.long, from: n.p, to: n.p }); }
  }
  const real = legs.filter((l) => haversine(l.from, l.to) > 50); // passing straight through a junction isn't a leg
  if (!real.length) return legs.slice(0, 1).map((l) => ({ ...l, from: start, to: dest }));
  real[0].from = start;
  real[real.length - 1].to = dest;
  return real;
}

/**
 * Plan across several routes: `legs` from chooseRoutes, `routes` = {id: prepared route}.
 * Plans each leg with planRide and joins them into one plan the Navigator can follow.
 */
export async function planNetwork(routes, legs, router, opts = {}) {
  const lang = opts.lang || "cs";
  const plans = [];
  for (const l of legs) plans.push(await planRide(routes[l.id], l.from, l.to, router, { ...opts, routeNum: l.num, routeLong: l.long }));
  if (plans.length === 1) return Object.assign(plans[0], { legs: [{ id: legs[0].id, num: legs[0].num, short: legs[0].short, long: legs[0].long, d0: 0, d1: plans[0].length }] });

  const out = { coords: [], maneuvers: [], spans: [], warnings: [], failed: [], length: 0, evLength: 0, legs: [], profile: [],
    start: plans[0].start, dest: plans.at(-1).dest, dir: plans[0].dir, joinAt: plans[0].joinAt, leaveAt: plans.at(-1).leaveAt };
  plans.forEach((p, k) => {
    const off = out.length, last = k === plans.length - 1;
    const pts = out.coords.length && p.coords.length && haversine(out.coords.at(-1), p.coords[0]) < 1 ? p.coords.slice(1) : p.coords;
    out.coords.push(...pts);
    if (k > 0) {
      const n = legs[k].long ?? `EuroVelo ${legs[k].num ?? legs[k].id}`;
      out.maneuvers.push({ d: off, k: "join", s: "", t: { cs: `Pokračujte po ${n}`, en: `Continue on ${n}` } });
    }
    for (const m of p.maneuvers) {
      if (m.k === "arrive" && !last) continue;
      if (k > 0 && m.k === "join" && m.d < 200) continue; // already announced the switch
      if (!last && m.k === "leave" && p.length - m.d < 200) continue;
      out.maneuvers.push({ ...m, d: m.d + off });
    }
    for (const s of p.spans) out.spans.push({ ...s, d0: s.d0 + off, d1: s.d1 + off, route: legs[k].id });
    for (const w of p.warnings) out.warnings.push({ ...w, d: w.d + off });
    for (const [d, e] of p.profile || []) out.profile.push([d + off, e]);
    out.failed.push(...p.failed);
    out.legs.push({ id: legs[k].id, num: legs[k].num, short: legs[k].short, long: legs[k].long, d0: off, d1: off + p.length });
    out.length += p.length;
    out.evLength += p.evLength;
  });
  out.maneuvers.sort((a, b) => a.d - b.d);
  return out;
}
