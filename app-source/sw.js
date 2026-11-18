// Offline shell: the app works without signal once loaded. App files are
// network-first, so a new version or new closures arrive as soon as there's signal;
// the cache is the fallback when there isn't. The map library is kept cache-first.
// Downloaded map tiles and the saved trip live in their own caches (js/offline.js)
// and survive app updates. Routing to a new destination still needs signal.
const VERSION = "evnav-v21";
const SHELL = ["./", "data/routes.json", "css/app.css", "css/fonts.css", "lib/maplibre-gl.js", "lib/maplibre-gl.css", "legal/legal.css", "legal/privacy.html", "legal/terms.html", "legal/licenses.html", "js/app.js", "js/core.js", "js/services.js", "js/nights.js", "js/offline.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
const DATA = /\/data\/.+\.json$/;
const LIBS = "evnav-libs"; // versioned URLs (maplibre-gl@4.7.1): never stale
const KEEP = [LIBS, "evnav-tiles", "evnav-trip"]; // offline map + saved trip survive app updates

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && !KEEP.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // the map library and fonts: keep a copy so the app also starts with no signal
  if (/^(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) {
    e.respondWith(caches.open(LIBS).then(async (c) => {
      const hit = await caches.match(e.request); // any cache: also the copy kept with a saved trip
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === "opaque") c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  // live route data and closures (GitHub Pages): newest when online, last copy offline
  if (/\.github\.io$/.test(url.hostname) && /\.json$/.test(url.pathname)) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request)));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && !r.redirected) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: DATA.test(url.pathname) })));
});
