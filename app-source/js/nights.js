// Multi-day trips: where to sleep.
// 1. splitDays cuts the planned line into days of about `perDay` metres, ending each
//    day in a town on (or near) the route rather than in the middle of nowhere.
// 2. fetchStays asks OpenStreetMap (Overpass) for places to sleep around a night stop,
//    and rankStays picks the best for a given date (campsites only in season).
import { haversine, eleAtD } from "./core.js";

const NEAR_ROUTE = 3000;      // a town counts as "on the route" within 3 km
const WINDOW = [0.7, 1.2];    // a day may run 70–120 % of the chosen distance to end in a town

/** Towns near the line, with their chainage. line: core Line; places: [{name, lonlat}] */
export function townsAlong(line, places, step = 1000) {
  const samples = [];
  for (let d = 0; d <= line.length; d += step) samples.push([line.pointAt(d), d]);
  samples.push([line.pointAt(line.length), line.length]);
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [[x, y]] of samples) { minLon = Math.min(minLon, x); maxLon = Math.max(maxLon, x); minLat = Math.min(minLat, y); maxLat = Math.max(maxLat, y); }
  const out = [];
  for (const p of places) {
    const [x, y] = p.lonlat;
    if (x < minLon - 0.1 || x > maxLon + 0.1 || y < minLat - 0.05 || y > maxLat + 0.05) continue;
    let best = Infinity, bd = 0;
    for (const [[sx, sy], d] of samples) {
      if (Math.abs(sy - y) > 0.05 || Math.abs(sx - x) > 0.08) continue;
      const h = haversine(p.lonlat, [sx, sy]);
      if (h < best) { best = h; bd = d; }
    }
    if (best <= NEAR_ROUTE) {
      const pr = line.project(p.lonlat, Math.max(0, bd - 3000), bd + 3000);
      out.push({ name: p.name, lonlat: p.lonlat, d: pr.d, off: pr.dist });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

/** "Effort distance": every 100 m of climbing counts as 1 km more riding, so hilly
 *  days come out shorter. eff(d) → effort metres; dOf(e) → chainage. */
export const CLIMB_FACTOR = 10;
export function makeEffort(profile, length, step = 250) {
  const n = Math.ceil(length / step) + 1, eff = new Float64Array(n);
  let base = profile?.length ? eleAtD(profile, 0) : null, up = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.min(i * step, length);
    if (base != null) { const e = eleAtD(profile, d); if (e > base + 5) { up += e - base; base = e; } else if (e < base - 5) base = e; }
    eff[i] = d + up * CLIMB_FACTOR;
  }
  const eAt = (d) => { const x = Math.max(0, Math.min(n - 1, d / step)), i = Math.floor(x); return i + 1 < n ? eff[i] + (eff[i + 1] - eff[i]) * (x - i) : eff[i]; };
  const dOf = (e) => {
    if (e <= 0) return 0; if (e >= eff[n - 1]) return length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (eff[m] <= e) lo = m; else hi = m; }
    return Math.min(length, (lo + (e - eff[lo]) / (eff[hi] - eff[lo] || 1)) * step);
  };
  return { eAt, dOf, total: eff[n - 1] };
}
/** Where the next day should end, in chainage: one day's effort on, or half of what's left if that's under two days. */
export function nextTarget(effort, prev, perDay) {
  const e0 = effort.eAt(prev), rem = effort.total - e0;
  return effort.dOf(e0 + (rem < 2 * perDay ? rem / 2 : perDay));
}

/** Night stops: [{n, d, lonlat, name|null}]. Empty when the trip fits in one day. */
export function splitDays(line, towns, perDay, effort = makeEffort(null, line.length)) {
  const total = line.length, nights = [];
  if (effort.total <= perDay * 1.25) return nights;
  let prev = 0;
  while (effort.total - effort.eAt(prev) > perDay * 1.25) {
    const target = nextTarget(effort, prev, perDay);
    let pick = null;
    for (const t of towns) {
      if (t.d < target - perDay * (1 - WINDOW[0]) || t.d > target + perDay * (WINDOW[1] - 1)) continue;
      if (total - t.d < perDay * 0.3) continue; // don't leave a silly 10 km last day
      const cost = Math.abs(t.d - target) + t.off * 2;
      if (!pick || cost < pick.cost) pick = { ...t, cost };
    }
    const d = pick ? pick.d : target;
    nights.push({ n: nights.length + 1, d, lonlat: pick ? pick.lonlat : line.pointAt(d), name: pick ? pick.name : null });
    prev = d;
  }
  return nights;
}

// ---------------------------------------------------------------- places to sleep
export const OVERPASS = "https://overpass-api.de/api/interpreter";
// public mirrors, tried in turn when the main server is busy or refuses us
export const OVERPASS_MIRRORS = [OVERPASS, "https://overpass.private.coffee/api/interpreter"];
const KINDS = "hotel|guest_house|hostel|camp_site|motel|apartment|alpine_hut|chalet|wilderness_hut";

/** Towns/villages and places to sleep around a point, in one Overpass request. */
export async function fetchArea(lonlat, radius, signal, lang = "cs") {
  const [lon, lat] = lonlat, at = `around:${Math.round(radius)},${lat.toFixed(5)},${lon.toFixed(5)}`;
  const q = `[out:json][timeout:25];node(${at})[place~"^(city|town|village)$"][name]->.p;` +
    `nwr(${at})[tourism~"^(${KINDS})$"][name]->.s;.p out tags 80;.s out center tags 150;`;
  let r;
  for (let attempt = 0; attempt < 3; attempt++) { // the public server answers 429/504 when busy: wait and retry
    // a busy server answers 429 without CORS headers, which surfaces as a network error
    try {
      r = await fetch(OVERPASS_MIRRORS[attempt % OVERPASS_MIRRORS.length], { method: "POST", body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal });
    } catch (e) {
      if (signal?.aborted || attempt === 2) throw e;
      r = null;
    }
    if (r && r.status !== 429 && r.status !== 504) break;
    await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
  }
  if (!r.ok) throw new Error(`overpass ${r.status}`);
  const j = await r.json(), places = [], stays = [];
  for (const e of j.elements) {
    const ll = e.type === "node" ? [e.lon, e.lat] : [e.center.lon, e.center.lat], tg = e.tags || {};
    if (tg.place) places.push({ name: localName(tg, lang), kind: tg.place, lonlat: ll });
    else stays.push({ id: `${e.type}/${e.id}`, tags: tg, lonlat: ll });
  }
  return { places, stays };
}

/** Readable name: the user's language if tagged, Latin script over Cyrillic/Greek. */
export function localName(tg, lang) {
  const nonLatin = (x) => /[\u0370-\u03FF\u0400-\u04FF]/.test(x || "");
  return tg[`name:${lang}`] || (nonLatin(tg.name) ? tg["name:en"] || tg.int_name || tg["name:latin"] : null) || tg.name;
}

/** Choose where night ends: a town near the route, close to `target` chainage, with somewhere to sleep. */
export function pickTown(area, line, target, lo, hi) {
  let best = null;
  for (const p of area.places) {
    const pr = line.project(p.lonlat, lo, hi);
    if (pr.dist > 4000) continue;
    const beds = area.stays.filter((s) => haversine(s.lonlat, p.lonlat) < 2500).length;
    const cost = Math.abs(pr.d - target) + pr.dist * 2 + (beds ? -Math.min(beds, 5) * 400 : 40000) + (p.kind === "village" ? 1500 : 0);
    if (!best || cost < best.cost) best = { name: p.name, lonlat: p.lonlat, d: pr.d, beds, cost };
  }
  return best;
}

const TYPE_COST = { guest_house: 0, hostel: 200, hotel: 300, chalet: 400, apartment: 600, motel: 700, camp_site: 300, alpine_hut: 500, wilderness_hut: 1500 };

/** Is a campsite likely open on this date? Uses opening_hours month ranges when tagged. */
export function campOpen(tags, date) {
  if (!date) return true;
  const m = date.getMonth(); // 0 = Jan
  const oh = tags.opening_hours || tags.seasonal || "";
  if (/24\/7|Jan-Dec/i.test(oh)) return true;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ranges = [...oh.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*-\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/g)];
  if (ranges.length) return ranges.some(([, a, b]) => { const x = MON.indexOf(a), y = MON.indexOf(b); return x <= y ? m >= x && m <= y : m >= x || m <= y; });
  return m >= 4 && m <= 8; // untagged: assume May–September
}

/** Best places to sleep near a night stop. line + night.d keep it close to the route. */
export function rankStays(stays, night, line, date) {
  return stays.map((s) => {
    const t = s.tags, pr = line.project(s.lonlat, Math.max(0, night.d - 15000), night.d + 15000);
    let cost = pr.dist + Math.abs(pr.d - night.d) * 0.15 + (TYPE_COST[t.tourism] ?? 800);
    const bike = /yes|designated/.test(t.bicycle || "") || /cykl|bike|bicycle|rad/i.test(`${t.name} ${t.description || ""}`) || t["bicycle:parking"] || t.cyclists === "yes";
    if (bike) cost -= 700;
    if (t.website || t["contact:website"]) cost -= 150;
    if (t.phone || t["contact:phone"]) cost -= 100;
    if (t.tourism === "camp_site" && !campOpen(t, date)) cost += 1e6;
    if (t.disused || t["disused:tourism"]) cost += 1e6;
    return { ...s, kind: t.tourism, off: pr.dist, d: pr.d, bike: !!bike, cost,
      website: t.website || t["contact:website"] || null, phone: t.phone || t["contact:phone"] || null };
  }).filter((s) => s.cost < 1e5).sort((a, b) => a.cost - b.cost);
}

/** Booking.com affiliate (CJ). Filled in once Booking.com approves the partnership:
 *  link = the CJ deep-link base for the Booking.com programme, e.g. "https://www.dpbolvw.net/click-101932011-XXXXXXXX".
 *  Empty = plain Booking.com links (no commission). */
export const BOOKING_AFFILIATE = { link: "", sid: "eurovelo-nav" };

/** Booking.com search for that town and night (date: Date of the night). */
export function bookingUrl(town, date, lang = "cs", sid = "") {
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const out = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  const p = new URLSearchParams({ ss: town, checkin: iso(date), checkout: iso(out), group_adults: "1", no_rooms: "1" });
  const target = `https://www.booking.com/searchresults.${lang === "cs" ? "cs" : "en-gb"}.html?${p}`;
  if (!BOOKING_AFFILIATE.link) return target;
  const q = new URLSearchParams({ url: target, sid: [BOOKING_AFFILIATE.sid, sid].filter(Boolean).join("-") });
  return `${BOOKING_AFFILIATE.link}?${q}`;
}
