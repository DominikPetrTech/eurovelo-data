// Weekly sanity check of routes, closures and detours, using the app's own planner and the
// public Valhalla router. Writes closures/checks.md (+ checks.json) for the weekly review.
//   node tools/check.mjs            all routes
//   node tools/check.mjs ev9 ev6    some routes
import { readFileSync, writeFileSync } from "node:fs";
import { prepareRoute, planRide, haversine, closureActive } from "../app-source/js/core.js";
import { valhallaRoute } from "../app-source/js/services.js";

const ROOT = new URL("..", import.meta.url).pathname;
const today = new Date().toISOString().slice(0, 10);
const net = JSON.parse(readFileSync(ROOT + "data/routes.json"));
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const issues = [], rows = [];
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
  const gapKm = (r.gaps || []).reduce((s, g) => s + Math.max(0, g.f1 - g.f0), 0) / 1000;
  if (gapKm > km * 0.05) flag("high", meta.id, "route gaps", `${gapKm.toFixed(1)} km of ${km.toFixed(0)} km has no route data`);
  for (const g of r.gaps || []) if (g.f1 - g.f0 > 10000) flag("medium", meta.id, "long gap", `${((g.f1 - g.f0) / 1000).toFixed(1)} km at ${g.a.map((v) => v.toFixed(4)).join(",")}`);
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

const order = { high: 0, medium: 1, low: 2 };
issues.sort((x, y) => order[x.sev] - order[y.sev] || x.route.localeCompare(y.route));
const md = [`# Sanity check ${today}`, "", `${issues.length} findings (${issues.filter((i) => i.sev === "high").length} high).`, "",
  "| severity | route | what | detail |", "|---|---|---|---|", ...issues.map((i) => `| ${i.sev} | ${i.route} | ${i.what} | ${i.detail.replace(/\|/g, "/")} |`),
  "", "## Detours ridden", "", "| route | closure | closed m | detour m | trip m | ×straight | signed |", "|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.route} | ${r.id} | ${r.closed} | ${r.detour} | ${r.plan} | ${r.ratio} | ${r.signed ? "yes" : ""} |`)].join("\n");
writeFileSync(ROOT + "closures/checks.md", md + "\n");
writeFileSync(ROOT + "closures/checks.json", JSON.stringify({ date: today, issues, detours: rows }, null, 1));
console.log(md.split("\n").slice(0, 40).join("\n"));
