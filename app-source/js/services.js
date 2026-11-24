// External services. All free public instances, fine for a pilot; for real users
// run your own (Valhalla + Photon are both open source, Docker images exist).
import { decodePolyline6, fromValhalla, haversine } from "./core.js";

export const CONFIG = {
  valhalla: "https://valhalla1.openstreetmap.de",
  photon: "https://photon.komoot.io",
  style: "https://tiles.openfreemap.org/styles/liberty",
  // Route bundles and closures, refreshed every week by the eurovelo-data repo (GitHub Pages).
  // Empty = use only the copy shipped with the app in data/.
  dataBase: "https://dominikpetrtech.github.io/eurovelo-data/",
};

/** JSON from the live data repo, falling back to the copy shipped in data/ (old phone, no signal, repo down). */
export async function fetchData(path, { timeout = 6000 } = {}) {
  if (CONFIG.dataBase) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(CONFIG.dataBase + path, { signal: ctl.signal });
      if (r.ok) return await r.json();
    } catch {} finally { clearTimeout(timer); }
  }
  if (path.startsWith("closures/")) return null; // closures only exist live; the bundle carries a snapshot
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/** Route from → to by bike (default) or on foot (travel: "walk"), avoiding polygons. Returns {coords, maneuvers}. */
export async function valhallaRoute(from, to, { avoid = [], via = [], lang = "cs", travel = "bike" } = {}) {
  const walk = travel === "walk";
  const body = {
    // via: points of a signed detour; "through" makes the route pass them without a stop or a U-turn
    locations: [{ lon: from[0], lat: from[1] }, ...via.map(([lon, lat]) => ({ lon, lat, type: "through" })), { lon: to[0], lat: to[1] }],
    costing: walk ? "pedestrian" : "bicycle",
    costing_options: walk ? { pedestrian: { walking_speed: 4.5, use_tracks: 0.6, walkway_factor: 0.9 } }
      : { bicycle: { bicycle_type: "Hybrid", use_roads: 0.3, use_hills: 0.4 } },
    directions_options: { units: "kilometers", language: lang === "cs" ? "cs-CZ" : "en-US" },
    elevation_interval: 50,
  };
  if (avoid.length) body.exclude_polygons = avoid;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${CONFIG.valhalla}/route`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`router ${r.status}`);
    const j = await r.json();
    const legs = j.trip.legs;
    const coords = [], maneuvers = [];
    for (const leg of legs) {
      const shape = decodePolyline6(leg.shape), base = coords.length ? coords.length - 1 : 0;
      // elevation every N m along the leg → a 3rd coordinate on each shape point
      if (Array.isArray(leg.elevation) && leg.elevation.length) {
        const step = leg.elevation_interval || 50;
        let run = 0;
        for (let i = 0; i < shape.length; i++) {
          if (i) run += haversine(shape[i - 1], shape[i]);
          const x = Math.min(leg.elevation.length - 1, run / step), k = Math.floor(x), t = x - k;
          const e = k + 1 < leg.elevation.length ? leg.elevation[k] * (1 - t) + leg.elevation[k + 1] * t : leg.elevation[k];
          if (Number.isFinite(e)) shape[i] = [shape[i][0], shape[i][1], Math.round(e)];
        }
      }
      coords.push(...(coords.length ? shape.slice(1) : shape));
      for (const m of leg.maneuvers) { const x = fromValhalla(m, lang); x.i += base; maneuvers.push(x); }
    }
    return { coords, maneuvers };
  } finally { clearTimeout(timer); }
}

/** Place search near a point. Returns [{name, label, lonlat}]. */
export async function searchPlaces(q, near, lang = "cs", signal) {
  const p = new URLSearchParams({ q, limit: "6" });
  if (near) { p.set("lon", near[0].toFixed(4)); p.set("lat", near[1].toFixed(4)); }
  // Photon has no Czech UI language; "default" keeps local names (Brno, not "Brünn").
  p.set("lang", lang === "cs" ? "default" : "en");
  // Public Photon is often slow (10–20 s); only give up after 45 s.
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort("timeout"), 45000);
  const onAbort = () => ctl.abort("cancel");
  signal?.addEventListener("abort", onAbort);
  let r;
  try { r = await fetch(`${CONFIG.photon}/api/?${p}`, { signal: ctl.signal }); }
  catch (e) { throw new Error(ctl.signal.reason === "timeout" ? "timeout" : "cancel"); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
  if (!r.ok) throw new Error(`search ${r.status}`);
  const j = await r.json();
  return j.features.map((f) => {
    const pr = f.properties;
    const place = [pr.city || pr.town || pr.village || pr.county, pr.country].filter(Boolean);
    return { name: pr.name || place[0] || q, label: [pr.street && `${pr.street} ${pr.housenumber || ""}`.trim(), ...place].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(", "), lonlat: f.geometry.coordinates };
  });
}
