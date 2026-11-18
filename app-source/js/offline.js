// Offline map for a planned trip.
// Every map request (style, tiles, fonts, icons) goes through the "evc://" protocol,
// so it can be answered from our own cache when there is no signal. Downloading a
// trip puts the tiles along it (a corridor around the line) into that cache; the
// trip itself is saved too, so navigation survives the browser being closed.
const CACHE = "evnav-tiles";
const TRIP_CACHE = "evnav-trip";
const TRIP_URL = "/__evnav/trip.json";
export const PREFIX = "evc://";

// ---------------------------------------------------------------- protocol
async function cached(url) {
  try { const c = await caches.open(CACHE); return await c.match(url); } catch { return null; }
}
async function store(url, res) {
  try { const c = await caches.open(CACHE); await c.put(url, res); } catch {}
}
/** Small things the map always needs (style, fonts, icons) are kept whenever they load. */
const ALWAYS_KEEP = /\/(styles|fonts|sprites)\/|\/planet\/?$/;

export function registerProtocol(maplibregl) {
  maplibregl.addProtocol("evc", async (params, abort) => {
    const url = params.url.slice(PREFIX.length);
    // cache first: tile URLs carry the map version, so a cached tile never goes stale
    let res = await cached(url);
    if (!res) {
      try {
        res = await fetch(url, { signal: abort.signal });
        if (res.ok && ALWAYS_KEEP.test(url)) store(url, res.clone());
      } catch (e) {
        res = await cached(url);
        if (!res) throw e;
      }
    }
    if (!res.ok) {
      if (res.status === 404 || res.status === 204) return { data: params.type === "json" ? {} : new ArrayBuffer(0) }; // empty sea tile
      throw new Error(`HTTP ${res.status}`);
    }
    if (params.type === "json") return { data: await res.json() };
    if (params.type === "string") return { data: await res.text() };
    return { data: await res.arrayBuffer() };
  });
}

/** Style JSON: from the network (and keep a copy), else the copy. TileJSON sources are
 *  inlined and every URL is routed through evc://. */
export async function loadStyle(url, timeoutMs = 8000) {
  let style = null;
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
    if (!r.ok) throw new Error(String(r.status));
    store(url, r.clone());
    style = await r.json();
  } catch {
    const r = await cached(url);
    if (!r) return null;
    style = await r.json();
  }
  for (const src of Object.values(style.sources || {})) {
    if (src.url && /^https?:/.test(src.url) && (src.type === "vector" || src.type === "raster")) {
      try {
        let r;
        try { const ctl = new AbortController(); setTimeout(() => ctl.abort(), timeoutMs); r = await fetch(src.url, { signal: ctl.signal }); if (r.ok) store(src.url, r.clone()); else throw 0; }
        catch { r = await cached(src.url); }
        if (r) {
          const tj = await r.json();
          if (Array.isArray(tj.tiles) && tj.tiles.length) {
            src.tiles = tj.tiles;
            for (const k of ["minzoom", "maxzoom", "bounds", "attribution", "scheme", "tileSize", "encoding"]) if (tj[k] != null) src[k] = tj[k];
            delete src.url;
          }
        }
      } catch {}
    }
    if (src.tiles) src.tiles = src.tiles.map((u) => (/^https?:/.test(u) ? PREFIX + u : u));
  }
  if (style.glyphs && /^https?:/.test(style.glyphs)) style.glyphs = PREFIX + style.glyphs;
  if (typeof style.sprite === "string" && /^https?:/.test(style.sprite)) style.sprite = PREFIX + style.sprite;
  return style;
}

// ---------------------------------------------------------------- which tiles
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };

/** Tiles along a line: a corridor of `buffer` metres at the detailed zooms. */
export function tilesAlong(line, { maxzoom = 14, minzoom = 0, buffer = 400, step = 150 } = {}) {
  const keys = new Set();
  const dlat = buffer / 111320;
  for (let d = 0; d <= line.length + step; d += step) {
    const [lon, lat] = line.pointAt(Math.min(d, line.length));
    const dlon = dlat / Math.cos((lat * Math.PI) / 180);
    for (let z = minzoom; z <= maxzoom; z++) {
      if (z >= 12) {
        for (const [ox, oy] of [[0, 0], [dlon, 0], [-dlon, 0], [0, dlat], [0, -dlat]]) keys.add(`${z}/${lon2x(lon + ox, z)}/${lat2y(lat + oy, z)}`);
      } else keys.add(`${z}/${lon2x(lon, z)}/${lat2y(lat, z)}`);
    }
  }
  return [...keys].map((k) => k.split("/").map(Number));
}

/** Everything to download for a trip, given the (rewritten) style. */
export function tripUrls(style, line) {
  const urls = new Set();
  for (const src of Object.values(style.sources || {})) {
    if (!src.tiles) continue;
    const tmpl = src.tiles[0].replace(PREFIX, "");
    const maxz = Math.min(src.maxzoom ?? 14, 14), minz = src.minzoom ?? 0;
    for (const [z, x, y] of tilesAlong(line, { maxzoom: maxz, minzoom: minz })) urls.add(tmpl.replace("{z}", z).replace("{x}", x).replace("{y}", y));
  }
  // fonts: Latin, Latin Extended (Czech, Polish…), Greek, Cyrillic, punctuation
  if (style.glyphs) {
    const stacks = new Set();
    for (const l of style.layers || []) { const f = l.layout?.["text-font"]; if (Array.isArray(f) && f.every((x) => typeof x === "string")) stacks.add(f.join(",")); }
    for (const st of stacks) for (const r of ["0-255", "256-511", "512-767", "768-1023", "1024-1279", "8192-8447"])
      urls.add(style.glyphs.replace(PREFIX, "").replace("{fontstack}", encodeURIComponent(st)).replace("{range}", r));
  }
  if (typeof style.sprite === "string") {
    const s = style.sprite.replace(PREFIX, "");
    for (const suf of [".json", ".png", "@2x.json", "@2x.png"]) urls.add(s + suf);
  }
  return [...urls];
}

/** Download what isn't cached yet. onProgress(done, total, bytes). Resolves {ok, failed, bytes}. */
export async function download(urls, { onProgress, signal, concurrency = 6 } = {}) {
  const c = await caches.open(CACHE);
  let done = 0, failed = 0, bytes = 0, i = 0, quota = false;
  const total = urls.length;
  async function worker() {
    while (i < total) {
      if (signal?.aborted) return;
      const url = urls[i++];
      try {
        if (!(await c.match(url))) {
          const r = await fetch(url, { signal });
          if (r.ok || r.status === 404 || r.status === 204) {
            const buf = await r.arrayBuffer(); bytes += buf.byteLength;
            await c.put(url, new Response(buf, { status: r.status === 200 ? 200 : 204, headers: { "Content-Type": r.headers.get("Content-Type") || "application/octet-stream" } }));
          } else failed++;
        }
      } catch (e) {
        if (signal?.aborted || quota) return;
        if (e?.name === "QuotaExceededError") { quota = true; return; } // phone is full: stop, keep what we have
        failed++;
      }
      done++;
      onProgress?.(done, total, bytes);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { ok: done - failed, failed, bytes, quota, aborted: !!signal?.aborted };
}

/** How many of these are already cached (for "already downloaded" state). */
export async function countCached(urls) {
  try {
    const c = await caches.open(CACHE);
    let n = 0;
    for (const u of urls) if (await c.match(u)) n++;
    return n;
  } catch { return 0; }
}

/** Delete all downloaded map data (keeps style/fonts/icons so the app still starts). */
export async function clearTiles() {
  const c = await caches.open(CACHE);
  for (const req of await c.keys()) if (!ALWAYS_KEEP.test(req.url)) await c.delete(req);
  await caches.delete(TRIP_CACHE);
}

export async function storageEstimate() {
  try { const e = await navigator.storage.estimate(); return e; } catch { return null; }
}

// ---------------------------------------------------------------- saved trip
export async function saveTrip(trip) {
  try {
    const c = await caches.open(TRIP_CACHE);
    await c.put(TRIP_URL, new Response(JSON.stringify(trip), { headers: { "Content-Type": "application/json" } }));
    navigator.storage?.persist?.().catch(() => {});
  } catch {}
}
/** Keep a copy of the app itself (pages, scripts, route data, map library) with the
 *  trip, so it starts with no signal even if the browser hadn't cached it yet. */
export async function keepAppFiles(urls) {
  try {
    const c = await caches.open(TRIP_CACHE);
    await Promise.all(urls.map(async (u) => {
      const abs = new URL(u, location.href).href;
      try { const r = await fetch(abs, { cache: "no-cache" }); if (r.ok) await c.put(abs, r); } catch {}
    }));
  } catch {}
}
export async function loadTrip() {
  try { const r = await (await caches.open(TRIP_CACHE)).match(TRIP_URL); return r ? await r.json() : null; } catch { return null; }
}
export async function dropTrip() { try { await caches.delete(TRIP_CACHE); } catch {} }
