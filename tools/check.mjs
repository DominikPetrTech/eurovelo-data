// Weekly sanity check of routes, closures and detours, using the app's own planner and the
// public Valhalla router. Writes closures/checks.md (+ checks.json) for the weekly review.
//   node tools/check.mjs            all routes
//   node tools/check.mjs ev9 ev6    some routes
import { readFileSync, writeFileSync } from "node:fs";
import { prepareRoute, planRide, haversine, closureActive, Line } from "../app-source/js/core.js";
import { valhallaRoute } from "../app-source/js/services.js";

const ROOT = new URL("..", import.meta.url).pathname;
const today = new Date().toISOString().slice(0, 10);
const net = JSON.parse(readFileSync(ROOT + "data/routes.json"));
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const issues = [], rows = [];
let known = []; try { known = JSON.parse(readFileSync(ROOT + "closures/known-gaps.json")).items; } catch {}
const isKnownGap = (rid, g) => known.some((k) => k.route === rid && (haversine(k.near, g.a) < 3000 || haversine(k.near, g.b) < 3000));
const flag = (sev, route, what, detail) => issues.push({ sev, route, what, detail });

// Valhalla's public server asks for moderate use: one request at a time, a pause between.
let last = 0;
const router = async (from, to, opts) => { const w = 1100 - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now(); return valhallaRoute(from, to, opts); };

for (const meta of net.routes) {
  if (only.length && !only.includes(meta.id)) continue;
  const b = JSON.parse(readFileSync(ROOT + "data/" + meta.file));
  let live = null; try { live = JSON.parse(readFileSync(ROOT + `closures/${meta.id}.json`)); } catch {}
  if (live) b.closures = live.closures;
  const r = prepareRoute(b);
  const km = r.ev.length / 1000;

  // ---- the route itself
  const realGaps = (r.gaps || []).filter((g) => !isKnownGap(meta.id, g));
  const gapKm = realGaps.reduce((s, g) => s + Math.max(0, g.f1 - g.f0), 0) / 1000;
  if (gapKm > km * 0.05) flag("high", meta.id, "route gaps", `${gapKm.toFixed(1)} km of ${km.toFixed(0)} km has no route data`);
  for (const g of realGaps) if (g.f1 - g.f0 > 10000) flag("medium", meta.id, "long gap", `${((g.f1 - g.f0) / 1000).toFixed(1)} km at ${g.a.map((v) => v.toFixed(4)).join(",")}`);
  const perKm = (b.turns || []).length / km;
  if (perKm > 4) flag("medium", meta.id, "too many turns", `${perKm.toFixed(1)} per km (zigzag data?)`);
  // a line that runs back over itself (lost GPX order, duplicated stage)
  let back = 0;
  for (let d = 0; d + 2000 < r.ev.length; d += 1000) {
    const a = r.ev.pointAt(d), c = r.ev.pointAt(d + 2000);
    if (haversine(a, c) < 150) back++;
  }
  if (back > 3) flag("medium", meta.id, "doubling back", `${back} places where the line returns to itself within 2 km`);

  // ---- closures
  const seen = new Map();
  for (const c of r.closures) {
    const len = c.f1 - c.f0;
    if (c.to && c.to < today) flag("low", meta.id, "expired item", `${c.id} ended ${c.to}`);
    if (c.from && c.to && c.from > c.to) flag("high", meta.id, "dates reversed", c.id);
    if (len > 15000) flag("medium", meta.id, "very long closure", `${c.id}: ${(len / 1000).toFixed(1)} km`);
    if (c.kind === "closure" && !c.source) flag("medium", meta.id, "closure without source", c.id);
    for (const [id, o] of seen) if (c.kind === "closure" && o.kind === "closure" && c.f0 < o.f1 && o.f0 < c.f1 && Math.min(c.f1, o.f1) - Math.max(c.f0, o.f0) > 0.8 * Math.min(len, o.f1 - o.f0))
      flag("low", meta.id, "duplicate?", `${c.id} overlaps ${id}`);
    seen.set(c.id, c);
  }

  // ---- detours: ride each active closure from 3 km before to 3 km after with the real router
  for (const c of r.closures.filter((x) => x.kind === "closure" && closureActive(x, today))) {
    const a = r.ev.pointAt(Math.max(0, c.f0 - 3000)), z = r.ev.pointAt(Math.min(r.ev.length, c.f1 + 3000));
    const straight = (c.f1 + 3000) - Math.max(0, c.f0 - 3000);
    let p;
    try { p = await planRide(r, a, z, router, { day: today }); } catch (e) { flag("high", meta.id, "planner crashed", `${c.id}: ${e.message}`); continue; }
    const det = p.spans.filter((s) => s.kind === "detour");
    const detLen = det.reduce((s, x) => s + x.d1 - x.d0, 0), closed = c.f1 - c.f0;
    const row = { route: meta.id, id: c.id, closed: Math.round(closed), detour: Math.round(detLen), plan: Math.round(p.length), ratio: +(p.length / straight).toFixed(2),
      signed: p.warnings.some((w) => w.id === c.id && w.signed), failed: p.failed.length, straightLine: det.some((s) => s.straight) };
    rows.push(row);
    if (row.failed || row.straightLine) flag("high", meta.id, "no detour found", `${c.id}: the router found no way round (straight line shown)`);
    else if (!det.length) flag("high", meta.id, "closure not avoided", `${c.id}: plan doesn't detour`);
    else if (row.ratio > 3 && p.length - straight > 8000) flag("medium", meta.id, "long detour", `${c.id}: ${(p.length / 1000).toFixed(1)} km instead of ${(straight / 1000).toFixed(1)} km`);
    // does the detour run into another active closure?
    for (const o of r.closures.filter((x) => x.kind === "closure" && x.id !== c.id && closureActive(x, today) && x.geom && (x.f1 < c.f0 || x.f0 > c.f1)))
      for (const s of det) {
        const hits = p.coords.filter((q, i) => i % 3 === 0).filter((q) => (o.geom.type === "Point" ? [o.geom.coordinates] : (o.geom.type === "LineString" ? o.geom.coordinates : o.geom.coordinates.flat())).some((g) => haversine(q, g) < 15)).length;
        if (hits > 3) { flag("medium", meta.id, "detour through closure", `${c.id} detour passes ${o.id}`); break; }
      }
  }
}

// ---------------------------------------------------------------- random trips
// Like a rider would: start somewhere near the route (in a village off the line, at a junction…),
// go to another point 5–60 km away, in both directions, and look for nonsense in the plan:
//  - "ride there and come back": the plan goes out and returns along the same streets
//  - a detour or link that runs along a closed stretch
//  - no route found / straight-line fallback
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rand = rng(Number(today.replace(/-/g, "")) + (process.env.CHECK_SEED ? Number(process.env.CHECK_SEED) : 0));
const TRIPS = Number(process.env.CHECK_TRIPS || 8);   // per route and direction
const trips = [];

function resample(coords, step = 10) {
  const L = new Line(coords), out = [];
  for (let d = 0; d <= L.length; d += step) out.push({ p: L.pointAt(d), d });
  return out;
}
/** Out-and-back stretches: the path leaves a point and comes back to it along the same way. */
function spurs(coords) {
  const pts = resample(coords), found = [];
  for (let i = 0; i < pts.length; i++) {
    let far = i;
    for (let j = i + 15; j < pts.length && pts[j].d - pts[i].d < 3000; j++) {
      const dj = haversine(pts[i].p, pts[j].p);
      if (dj > haversine(pts[i].p, pts[far].p)) far = j;
      if (dj < 25 && pts[j].d - pts[i].d > 150 && far > i && far < j) {
        // out-and-back if the way out and the way back run on top of each other
        let same = 0, n = 0;
        for (let k = i + 1; k < far; k += 2) { n++; for (let m = far; m < j; m++) if (haversine(pts[k].p, pts[m].p) < 20) { same++; break; } }
        if (n && same / n > 0.7) { found.push({ at: pts[far].p, d: pts[i].d, len: Math.round((pts[j].d - pts[i].d) / 2) }); i = j; break; }
      }
    }
  }
  return found;
}
/** Places where the path turns right round (>150° within 40 m either side). */
function reversals(coords) {
  const L = new Line(coords), out = [];
  const bear = (a, c) => Math.atan2((c[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), c[1] - a[1]) * 180 / Math.PI;
  for (let d = 40; d < L.length - 40; d += 10) {
    const x = bear(L.pointAt(d - 40), L.pointAt(d)), y = bear(L.pointAt(d), L.pointAt(d + 40));
    if (Math.abs(((y - x + 540) % 360) - 180) > 150 && (!out.length || d - out[out.length - 1].d > 100)) out.push({ d, at: L.pointAt(d), len: 0 });
  }
  return out;
}
function closurePts(c) {
  const g = c.geom; if (!g) return [];
  const lines = g.type === "Point" ? [[g.coordinates]] : g.type === "LineString" ? [g.coordinates] : g.coordinates;
  return lines.flatMap((ln) => ln.length > 1 ? resample(ln, 8).map((x) => x.p) : ln);
}
function offRoute(p, ev, d, off) { // a point `off` metres to the side of the route
  const a = ev.pointAt(Math.max(0, d - 30)), b = ev.pointAt(Math.min(ev.length, d + 30));
  const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ky = 110540;
  const vx = (b[0] - a[0]) * kx, vy = (b[1] - a[1]) * ky, n = Math.hypot(vx, vy) || 1;
  return [p[0] - (vy / n) * off / kx, p[1] + (vx / n) * off / ky];
}

for (const meta of net.routes) {
  if (only.length && !only.includes(meta.id)) continue;
  const b = JSON.parse(readFileSync(ROOT + "data/" + meta.file));
  try { b.closures = JSON.parse(readFileSync(ROOT + `closures/${meta.id}.json`)).closures; } catch {}
  const r = prepareRoute(b), L = r.ev.length;
  const active = r.closures.filter((c) => c.kind === "closure" && closureActive(c, today));
  const cpts = active.map((c) => ({ c, pts: closurePts(c) }));
  // half the trips around active closures (where things go wrong), half anywhere
  const centres = [...active.map((c) => (c.f0 + c.f1) / 2)];
  for (let t = 0; t < TRIPS; t++) {
    const around = centres.length && t % 2 === 0 ? centres[Math.floor(rand() * centres.length)] : null;
    const span = 5000 + rand() * 55000;
    const mid = around ?? (span / 2 + rand() * Math.max(1, L - span));
    for (const dir of [1, -1]) {
      const da = Math.max(0, Math.min(L, mid - dir * span / 2 + (rand() - 0.5) * 2000));
      const db = Math.max(0, Math.min(L, mid + dir * span / 2 + (rand() - 0.5) * 2000));
      if (Math.abs(db - da) < 3000) continue;
      const offA = rand() < 0.5 ? 0 : 100 + rand() * 900, offB = rand() < 0.5 ? 0 : 100 + rand() * 900;
      const A = offRoute(r.ev.pointAt(da), r.ev, da, offA * (rand() < 0.5 ? 1 : -1)), B = offRoute(r.ev.pointAt(db), r.ev, db, offB * (rand() < 0.5 ? 1 : -1));
      const where = `${A.map((v) => v.toFixed(5)).join(",")} → ${B.map((v) => v.toFixed(5)).join(",")}`;
      // every third trip on foot (walking mode uses the pedestrian router)
      const travel = t % 3 === 2 ? "walk" : "bike";
      const rt = (f, z, o) => router(f, z, { ...o, travel });
      let p;
      try { p = await planRide(r, A, B, rt, { day: today }); } catch (e) { flag("high", meta.id, "trip: planner crashed", `${where} (${travel}): ${e.message}`); continue; }
      const row = { route: meta.id, travel, from: A, to: B, km: +(p.length / 1000).toFixed(1), spurs: 0, overlap: 0, failed: p.failed.length };
      if (p.failed.length || p.spans.some((s) => s.straight)) flag("high", meta.id, "trip: no way found", `${where} (straight line in the plan)`);
      // which span does a distance fall in
      const kindAt = (d) => (p.spans.find((s) => d >= s.d0 && d <= s.d1) || {}).kind || "?";
      const seenAt = [];
      for (const s of [...spurs(p.coords), ...reversals(p.coords)]) {
        if (seenAt.some((x) => Math.abs(x - s.d) < 150)) continue;
        seenAt.push(s.d); row.spurs++;
        const k = kindAt(s.d);
        // on the EuroVelo line itself it's the route data (low); anywhere else the planner sent the rider back
        flag(k === "ev" ? "low" : "high", meta.id, `trip: there and back (${k})`,
          `${s.len ? s.len + " m out and back" : "turns back"} at ${s.at.map((v) => v.toFixed(5)).join(",")} on trip ${where} (${travel})`);
      }
      // detours/links that run along a closed stretch
      const L2 = new Line(p.coords);
      for (const sp of p.spans.filter((s) => s.kind !== "ev")) {
        for (const { c, pts } of cpts) {
          let run = 0;
          for (let d = sp.d0; d <= sp.d1; d += 10) { const q = L2.pointAt(d); if (pts.some((g) => haversine(q, g) < 12)) run += 10; }
          if (run > 40) { row.overlap += run; flag("high", meta.id, `trip: ${sp.kind} over closure`, `${run} m of the ${sp.kind} runs on ${c.id} (trip ${where})`); }
        }
      }
      trips.push(row);
    }
  }
}

const order = { high: 0, medium: 1, low: 2 };
issues.sort((x, y) => order[x.sev] - order[y.sev] || x.route.localeCompare(y.route));
const md = [`# Sanity check ${today}`, "", `${issues.length} findings (${issues.filter((i) => i.sev === "high").length} high).`, "",
  "| severity | route | what | detail |", "|---|---|---|---|", ...issues.map((i) => `| ${i.sev} | ${i.route} | ${i.what} | ${i.detail.replace(/\|/g, "/")} |`),
  "", "## Detours ridden", "", "| route | closure | closed m | detour m | trip m | ×straight | signed |", "|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.route} | ${r.id} | ${r.closed} | ${r.detour} | ${r.plan} | ${r.ratio} | ${r.signed ? "yes" : ""} |`),
  "", `## Random trips (${trips.length})`, "", "| route | mode | from | to | km | there-and-back | m over closure | failed |", "|---|---|---|---|---|---|---|---|",
  ...trips.map((t) => `| ${t.route} | ${t.travel} | ${t.from.map((v) => v.toFixed(4)).join(",")} | ${t.to.map((v) => v.toFixed(4)).join(",")} | ${t.km} | ${t.spurs} | ${t.overlap} | ${t.failed} |`)].join("\n");
writeFileSync(ROOT + "closures/checks.md", md + "\n");
writeFileSync(ROOT + "closures/checks.json", JSON.stringify({ date: today, issues, detours: rows, trips }, null, 1));
console.log(md.split("\n").slice(0, 40).join("\n"));
