import { Line, prepareRoute, chooseRoutes, planNetwork, Navigator, phrase, fmtDist, haversine, decodePolyline, ascent, eleAtD, closureActive } from "./core.js";
import { CONFIG, valhallaRoute, searchPlaces, fetchData } from "./services.js";
import { registerProtocol, loadStyle, tripUrls, download, countCached, clearTiles, saveTrip, loadTrip, keepAppFiles } from "./offline.js";
import { townsAlong, splitDays, fetchArea, pickTown, rankStays, bookingUrl, makeEffort, nextTarget } from "./nights.js";

const ROUTES_URL = "data/routes.json";
const DEFAULT_SPEED = 16 / 3.6; // m/s, touring bike

const I18N = {
  cs: {
    installTitle: "Nainstalujte si EuroVelo Nav", privacy: "Ochrana soukromí", terms: "Podmínky užití", licenses: "Zdroje dat", install: "Instalovat",
    installAndroid: "Funguje jako aplikace, i bez signálu.",
    installIos: "Klepněte na {share} Sdílet a pak na „Přidat na plochu“.",
    where: "Kam jedeme?", change: "Změnit", go: "Jet", simulate: "Simulace", stop: "Konec",
    left: "zbývá", eta: "příjezd", onEv: "po {n}", total: "celkem", time: "čas",
    planning: "Plánuji trasu…", replanning: "Mimo trasu, přepočítávám…", noGps: "Polohu nezjistím. Ťukněte do mapy, odkud jedete.",
    startSet: "Start nastaven. Teď vyberte cíl.", tapStart: "Ťukněte do mapy pro start",
    hint: "Vyhledejte místo, nebo podržte prst na mapě. Navigace vás dovede na nejbližší EuroVelo a po něm do cíle.",
    avoided: "Objíždíme uzavírku", avoidedSigned: "Objížďka po značené trase", caution: "Pozor", report: "Hlášení cyklistů (neověřeno)", until: "do",
    routerFail: "Část trasy nešla naplánovat, vede přímou čarou", arrived: "Jste v cíli",
    search_err: "Hledání nefunguje, zkuste to znovu.", noResults: "Nic nenalezeno.", searching: "Hledám…", searching_slow: "Vyhledávání trvá déle, server je vytížený. Pořád hledám…", search_slow: "Vyhledávací server neodpovídá. Zkuste to znovu nebo vyberte město z trasy.", destPin: "Bod na mapě",
    simulating: "Simulace jízdy", approach: "na EV", exit: "z EV", closureAhead: "Uzavírka před vámi",
    detourVia: "Objížďka", offline: "Mapa se nenačetla (offline?)", data: "Uzavírky ověřeny",
    switched: "Trasa přepnuta na", loadingRoute: "Načítám trasu…",
    offDl: "Stáhnout mapu offline", offSize: "≈ {mb} MB", offProgress: "Stahuji mapu… {p} %", offDone: "Mapa trasy je offline", offPart: "Staženo {p} %, zkuste znovu",
    offCancel: "Zrušit", offDelete: "Smazat", offNoNet: "Bez signálu. Jeďte po vyznačené trase, přepočítám, až bude signál.",
    savedTrip: "Uložená trasa", resume: "Pokračovat", offStorage: "V telefonu není místo",
    climb: "stoupání", sleep: "Přespání", perDay: "km/den", depart: "Odjezd", night: "Noc", day: "den",
    tripHint: "Zadejte datum odjezdu: doplním dny, odkazy na rezervaci na konkrétní noc a vyřadím zavřené kempy.",
    tripHintDate: "Doporučení podle polohy u trasy a sezóny. Volná místa neověřujeme, rezervujte předem.",
    nearTown: "u trasy", stayLoading: "Hledám ubytování…", stayNone: "Ubytování v okolí nenalezeno", stayErr: "Ubytování se nepodařilo načíst",
    more: "další možnosti", web: "web", booking: "Booking", call: "volat", bikeOk: "pro cyklisty", fromRoute: "od trasy",
    kind_hotel: "hotel", kind_guest_house: "penzion", kind_hostel: "hostel", kind_camp_site: "kemp", kind_motel: "motel",
    kind_apartment: "apartmán", kind_alpine_hut: "chata", kind_chalet: "chata", kind_wilderness_hut: "útulna",
  },
  en: {
    installTitle: "Install EuroVelo Nav", privacy: "Privacy", terms: "Terms of use", licenses: "Data sources", install: "Install",
    installAndroid: "Works like an app, even with no signal.",
    installIos: "Tap {share} Share, then “Add to Home Screen”.",
    where: "Where to?", change: "Change", go: "Go", simulate: "Simulate", stop: "End",
    left: "left", eta: "arrive", onEv: "on {n}", total: "total", time: "time",
    planning: "Planning route…", replanning: "Off route, recalculating…", noGps: "Can't get your location. Tap the map where you're starting.",
    startSet: "Start set. Now choose a destination.", tapStart: "Tap the map to set start",
    hint: "Search for a place, or long-press the map. Navigation takes you to the nearest EuroVelo route and along it to your destination.",
    avoided: "Detouring around a closure", avoidedSigned: "Following the signed detour", caution: "Caution", report: "Rider report (unverified)", until: "until",
    routerFail: "Part of the route couldn't be planned and runs as a straight line", arrived: "You have arrived",
    search_err: "Search isn't working, try again.", noResults: "Nothing found.", searching: "Searching…", searching_slow: "This is taking longer, the server is busy. Still searching…", search_slow: "The search server isn't answering. Try again or pick a town on the route.", destPin: "Point on map",
    simulating: "Simulated ride", approach: "to EV", exit: "from EV", closureAhead: "Closure ahead",
    detourVia: "Detour", offline: "Map didn't load (offline?)", data: "Closures checked",
    switched: "Switched route to", loadingRoute: "Loading route…",
    offDl: "Download map for offline", offSize: "≈ {mb} MB", offProgress: "Downloading map… {p} %", offDone: "Route map is offline", offPart: "{p} % downloaded, try again",
    offCancel: "Cancel", offDelete: "Delete", offNoNet: "No signal. Follow the marked route; I'll recalculate when there's signal.",
    savedTrip: "Saved route", resume: "Continue", offStorage: "Not enough space on the phone",
    climb: "climbing", sleep: "Overnight stops", perDay: "km/day", depart: "Start date", night: "Night", day: "day",
    tripHint: "Enter a start date to see the days, booking links for each night, and skip closed campsites.",
    tripHintDate: "Picked by distance from the route and season. Availability isn't checked, so book ahead.",
    nearTown: "on route", stayLoading: "Finding a place to stay…", stayNone: "Nothing to stay at found nearby", stayErr: "Couldn't load places to stay",
    more: "more options", web: "website", booking: "Booking", call: "call", bikeOk: "bike friendly", fromRoute: "from route",
    kind_hotel: "hotel", kind_guest_house: "guesthouse", kind_hostel: "hostel", kind_camp_site: "campsite", kind_motel: "motel",
    kind_apartment: "apartment", kind_alpine_hut: "hut", kind_chalet: "chalet", kind_wilderness_hut: "shelter",
  },
};

const S = {
  lang: load("lang", "cs"), voice: load("voice", "1") === "1", pace: Number(load("pace", "80")) || 80, tripDate: null,
  route: null, start: null, startIsGps: false, dest: null, destName: "", destSub: "",
  plan: null, nav: null, mode: "search", watch: null, sim: null, follow: true,
  lastFix: null, lastReplan: 0, speeds: [], wake: null, setStartByTap: false,
};
const shortOf = (r) => r?.short || `EV${r?.num ?? ""}`, longOf = (r) => r?.long || `EuroVelo ${r?.num ?? ""}`;
const t = (k) => String(I18N[S.lang][k] ?? k).replace("{n}", S.plan?.legs?.length > 1 ? S.plan.legs.map((l) => shortOf(l)).join("+") : shortOf(S.route));
const $ = (id) => document.getElementById(id);

function load(k, d) { try { return localStorage.getItem("evnav-" + k) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem("evnav-" + k, v); } catch {} }

// ---------------------------------------------------------------- map
const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#eef1f5" } }] };
let map;

async function initMap() {
  registerProtocol(maplibregl);
  let style = await loadStyle(CONFIG.style);
  if (!style) { style = FALLBACK_STYLE; toast(t("offline"), 4000); }
  S.style = style;

  map = new maplibregl.Map({
    container: "map", style, center: [16.95, 49.6], zoom: 7, attributionControl: false,
    pitchWithRotate: false, dragRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "EuroVelo GPX (ODbL) · JSDI/ŘSD" }));
  await new Promise((res) => map.on("load", res));

  // the other EuroVelo routes, faint; tap one to switch to it
  map.addSource("others", { type: "geojson", data: othersFC() });
  map.addLayer({ id: "others", type: "line", source: "others", paint: { "line-color": "#0f4c9c", "line-opacity": 0.35,
    "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.2, 12, 3], "line-dasharray": [2, 1.5] } });
  map.addLayer({ id: "others-hit", type: "line", source: "others", paint: { "line-color": "#000", "line-opacity": 0, "line-width": 18 } });
  map.on("click", "others-hit", async (e) => {
    if (S.mode === "ride") return;
    const id = e.features[0].properties.id, meta = S.routes.find((r) => r.id === id);
    await loadRoute(id); renderChips(); toast(`${t("switched")} ${meta.name}`);
  });
  map.addSource("ev", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: S.route.line } } });
  map.addLayer({ id: "ev-casing", type: "line", source: "ev", paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 3, 14, 9] }, layout: { "line-cap": "round", "line-join": "round" } });
  map.addLayer({ id: "ev", type: "line", source: "ev", paint: { "line-color": "#0f4c9c", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.6, 14, 5] }, layout: { "line-cap": "round", "line-join": "round" } });

  map.addSource("plan", { type: "geojson", data: emptyFC() });
  map.addLayer({ id: "plan-casing", type: "line", source: "plan", paint: { "line-color": "#13213a", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 5, 16, 13] }, layout: { "line-cap": "round", "line-join": "round" } });
  map.addLayer({ id: "plan", type: "line", source: "plan", filter: ["!=", ["get", "straight"], true], paint: {
    "line-color": ["match", ["get", "kind"], "detour", "#ff8a3d", "ev", "#f2c200", "#ffe680"],
    "line-width": ["interpolate", ["linear"], ["zoom"], 7, 3, 16, 9] }, layout: { "line-cap": "round", "line-join": "round" } });
  // legs the router couldn't plan: drawn dashed so they read as "straight line, not a road"
  map.addLayer({ id: "plan-straight", type: "line", source: "plan", filter: ["==", ["get", "straight"], true], paint: {
    "line-color": "#ffe680", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 3, 16, 9], "line-dasharray": [1, 1.5] } });

  map.addSource("closures", { type: "geojson", data: closureFC() });
  map.addLayer({ id: "closure-line", type: "line", source: "closures", filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": ["match", ["get", "kind"], "closure", "#c4361c", "#b26a00"], "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 16, 10], "line-dasharray": [1.2, 0.8] } });
  map.addLayer({ id: "closure-pt", type: "circle", source: "closures", filter: ["==", ["geometry-type"], "Point"],
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 16, 9], "circle-color": ["match", ["get", "kind"], "closure", "#c4361c", "report", "#56647c", "#b26a00"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  for (const id of ["closure-line", "closure-pt"]) map.on("click", id, (e) => {
    const c = S.route.closures.find((x) => x.id === e.features[0].properties.id);
    if (c) new maplibregl.Popup({ closeButton: true, maxWidth: "280px" }).setLngLat(e.lngLat).setHTML(closureHTML(c)).addTo(map);
  });

  fitRoute();

  map.on("dragstart", () => { if (S.mode === "ride") S.follow = false; });
  map.on("contextmenu", (e) => { if (S.mode !== "ride") setDest([e.lngLat.lng, e.lngLat.lat], t("destPin"), fmtLL(e.lngLat)); });
  map.on("click", (e) => {
    if (S.setStartByTap && S.mode === "search") {
      S.start = [e.lngLat.lng, e.lngLat.lat]; S.startIsGps = false; S.setStartByTap = false;
      placePuck(S.start); toast(t("startSet"));
      if (S.dest) doPlan();
    }
  });
}

function closureHTML(c) {
  const k = c.kind === "closure" ? t("avoided") : c.kind === "report" ? t("report") : t("caution");
  const until = c.to ? ` · ${t("until")} ${fmtDate(c.to)}` : "";
  const det = c.detour ? `<br><small>${t("detourVia")}: ${esc(c.detour[S.lang] || c.detour.cs)}</small>` : "";
  return `<b>${esc(c.title?.[S.lang] || c.title?.cs || "")}</b><br><small>${k}${until}</small>${det}`;
}

function emptyFC() { return { type: "FeatureCollection", features: [] }; }
function pad() {
  const sh = $("sheet").getBoundingClientRect().height, wide = innerWidth >= 900;
  return wide ? { top: 40, bottom: 40, left: 440, right: 80 } : { top: 60, bottom: sh + 30, left: 30, right: 70 };
}

let puck, destMarker;
function placePuck(ll, heading) {
  if (!puck) {
    const el = document.createElement("div"); el.className = "puck"; el.innerHTML = '<div class="cone"></div>';
    puck = new maplibregl.Marker({ element: el, rotationAlignment: "map" }).setLngLat(ll).addTo(map);
  }
  puck.setLngLat(ll);
  const cone = puck.getElement().querySelector(".cone");
  cone.style.display = heading == null ? "none" : "block";
  if (heading != null) puck.setRotation(heading);
}
function placeDest(ll) {
  if (!destMarker) { const el = document.createElement("div"); el.className = "dest-pin"; destMarker = new maplibregl.Marker({ element: el, anchor: "bottom" }); }
  destMarker.setLngLat(ll).addTo(map);
}

// ---------------------------------------------------------------- location
function getPosition(timeout = 10000) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("no geolocation"));
    navigator.geolocation.getCurrentPosition((p) => res(p), rej, { enableHighAccuracy: true, timeout, maximumAge: 15000 });
  });
}
async function locate() {
  try {
    const p = await getPosition();
    S.start = [p.coords.longitude, p.coords.latitude]; S.startIsGps = true; S.setStartByTap = false;
    placePuck(S.start);
    return true;
  } catch {
    S.setStartByTap = true;
    toast(t("noGps"), 5000);
    return false;
  }
}

// ---------------------------------------------------------------- search & destination
// Search: towns on the EuroVelo routes answer instantly from the bundled list;
// the online geocoder fills in everything else underneath when it replies.
const fold = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/ł/g, "l").replace(/đ/g, "d").replace(/ß/g, "ss");
let placeIndex = null;
function localPlaces(q) {
  if (!placeIndex) {
    const seen = new Map();
    for (const r of S.routes) for (const [name, lon, lat] of r.places || []) {
      const n = placeName(name), k = fold(n);
      if (!seen.has(k)) seen.set(k, { name: n, key: k, label: longOf(r), nums: [shortOf(r)], lonlat: [lon, lat] });
      else { const p = seen.get(k); if (!p.nums.includes(shortOf(r))) { p.nums.push(shortOf(r)); p.label = p.nums.join(" · "); } }
    }
    placeIndex = [...seen.values()];
  }
  const f = fold(q), words = f.split(/\s+/);
  return placeIndex
    .map((p) => ({ p, score: p.key.startsWith(f) ? 0 : p.key.split(/[\s-]+/).some((w) => w.startsWith(f)) ? 1 : words.every((w) => p.key.includes(w)) ? 2 : 9 }))
    .filter((x) => x.score < 9).sort((a, b) => a.score - b.score || a.p.name.length - b.p.name.length)
    .slice(0, 4).map((x) => x.p);
}

let searchTimer, slowTimer, searchCtl, searchSeq = 0;
const searchCache = new Map();
function renderResults(local, remote, state) {
  const ul = $("results"); ul.innerHTML = "";
  const seen = new Set(), add = (r, ev) => {
    const k = fold(r.name) + Math.round(r.lonlat[0] * 50) + "," + Math.round(r.lonlat[1] * 50);
    if (seen.has(k)) return; seen.add(k);
    const li = document.createElement("li"), b = document.createElement("button");
    b.type = "button"; b.innerHTML = `<b>${ev ? '<i class="ev-dot"></i>' : ""}${esc(r.name)}</b><span>${esc(r.label)}</span>`;
    b.onclick = () => { searchCtl?.abort(); $("results").hidden = true; $("q").blur(); setDest(r.lonlat, r.name, r.label); };
    li.appendChild(b); ul.appendChild(li);
  };
  local.forEach((r) => add(r, true));
  (remote || []).forEach((r) => add(r, false));
  const msg = (cls, text) => { const li = document.createElement("li"); li.className = cls; li.innerHTML = `<span>${text}</span>`; ul.appendChild(li); };
  if (state === "loading" || state === "slow") msg("status loading", `<i class="spin"></i>${t(state === "slow" ? "searching_slow" : "searching")}`);
  else if (state === "timeout") msg("status", t("search_slow"));
  else if (state === "error") msg("status", t("search_err"));
  else if (!ul.children.length) msg("status", t("noResults"));
  ul.hidden = false;
}
function onSearchInput() {
  clearTimeout(searchTimer); clearTimeout(slowTimer); searchCtl?.abort();
  const seq = ++searchSeq, q = $("q").value.trim();
  $("q").classList.remove("busy");
  if (q.length < 2) { $("results").hidden = true; return; }
  const local = localPlaces(q), key = `${S.lang}|${fold(q)}`;
  if (searchCache.has(key)) return renderResults(local, searchCache.get(key));
  if (q.length < 3) return local.length ? renderResults(local, []) : ($("results").hidden = true);
  renderResults(local, null, "loading");
  slowTimer = setTimeout(() => { if (seq === searchSeq) renderResults(local, null, "slow"); }, 8000);
  $("q").classList.add("busy");
  searchTimer = setTimeout(async () => {
    const ctl = (searchCtl = new AbortController());
    try {
      const near = S.start || map.getCenter().toArray();
      const res = await searchPlaces(q, near, S.lang, ctl.signal);
      searchCache.set(key, res);
      if (seq === searchSeq) renderResults(local, res);
    } catch (e) {
      if (seq === searchSeq && e.message !== "cancel") renderResults(local, [], e.message === "timeout" ? "timeout" : "error");
    } finally { if (seq === searchSeq) { clearTimeout(slowTimer); $("q").classList.remove("busy"); } }
  }, 250);
}

// EuroVelo GPX stage names often drop diacritics; show places as locals write them.
const PLACE = {
  Jesenik: "Jeseník", "Novy Dvur": "Nový Dvůr", Breclav: "Břeclav", Hanusovice: "Hanušovice",
  Gdansk: "Gdańsk", Grudziadz: "Grudziądz", Poznan: "Poznań", Swiecie: "Świecie", "Welcz Maly": "Wełcz Mały",
  Swidnica: "Świdnica", Kromeriz: "Kroměříž", "L'viv": "Lviv",
  "Клецішча": "Kletsishcha", "Пытань": "Pytan", "Ляды": "Lyady", Constanta: "Constanța",
};
const placeName = (n) => { n = n.replace(/,\s*(Czechia|Poland|Italy|Austria|Slovenia|Croatia)$/, "").trim(); return PLACE[n] || n; };

/** Stage towns as quick destinations: the ones nearest to you (or to the map centre). */
function renderChips() {
  const ev = S.route.ev, seen = new Set(), places = [];
  const add = (name, f) => { const n = placeName(name); if (!seen.has(n)) { seen.add(n); places.push({ n, ll: ev.pointAt(f) }); } };
  S.route.stages.forEach((s) => add(s.name.split(" – ")[0], s.f));
  add(S.route.stages.at(-1).name.split(" – ").at(-1), ev.length);
  const ref = S.start || (map ? map.getCenter().toArray() : null);
  if (ref) places.sort((x, y) => haversine(ref, x.ll) - haversine(ref, y.ll));
  const box = $("chips"); box.innerHTML = "";
  for (const c of places.slice(0, 10)) {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip";
    const km = S.start ? ` <small>${fmtDist(haversine(S.start, c.ll), S.lang)}</small>` : "";
    b.innerHTML = esc(c.n) + km;
    b.onclick = () => setDest(c.ll, c.n, S.route.name);
    box.appendChild(b);
  }
}

// ---------------------------------------------------------------- routes
const routeCache = new Map();

async function getRoute(id) {
  const meta = S.routes.find((r) => r.id === id);
  if (!routeCache.has(id)) {
    const [bundle, live] = await Promise.all([fetchData(`data/${meta.file}`), fetchData(`closures/${id}.json`)]);
    if (live && Array.isArray(live.closures)) { bundle.closures = live.closures; bundle.closuresChecked = live.checked; }
    const route = prepareRoute(bundle);
    route.num = meta.num; route.short = meta.short; route.long = meta.long; route.kind = meta.kind;
    routeCache.set(id, route);
  }
  return routeCache.get(id);
}

async function loadRoute(id) {
  const meta = S.routes.find((r) => r.id === id) || S.routes[0];
  if (S.route && S.route.id === meta.id) return;
  if (!routeCache.has(meta.id)) { toast(t("loadingRoute"), 8000); await getRoute(meta.id); hideToast(); }
  S.route = routeCache.get(meta.id);
  const badge = document.querySelector(".ev-badge");
  badge.querySelector("span").textContent = meta.badge ?? meta.num;
  badge.classList.toggle("cz", meta.kind === "cz");
  if (map && map.getSource("ev")) {
    map.getSource("ev").setData({ type: "Feature", geometry: { type: "LineString", coordinates: S.route.line } });
    map.getSource("closures").setData(closureFC());
    map.getSource("others").setData(othersFC());
  }
}

/** Which route runs closest to a point? Uses the light outlines, no downloads. */
function nearestRoute(ll) {
  let best = null;
  for (const r of S.routes) {
    const d = r.outlineLine.project(ll).dist;
    if (!best || d < best.dist) best = { meta: r, dist: d };
  }
  return best;
}

function othersFC() {
  return { type: "FeatureCollection", features: S.routes.filter((r) => r.id !== S.route?.id).map((r) => ({
    type: "Feature", properties: { id: r.id }, geometry: { type: "LineString", coordinates: r.outlineLine.coords } })) };
}

function closureFC() {
  return { type: "FeatureCollection", features: S.route.closures.filter((c) => c.geom && closureActive(c)).map((c) => ({ type: "Feature", properties: { kind: c.kind, id: c.id }, geometry: c.geom })) };
}

function showRoutePicker() {
  const ul = $("results"); ul.innerHTML = "";
  for (const r of S.routes) {
    const li = document.createElement("li"), b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<b>${r.id === S.route.id ? "● " : ""}${esc(r.name)}</b><span>${r.length_km} km · ${esc((r.countries || []).join(", "))}</span>`;
    b.onclick = async () => {
      ul.hidden = true;
      if (r.id === S.route.id) return;
      await loadRoute(r.id); save("route", r.id); fitRoute(); renderChips();
    };
    li.appendChild(b); ul.appendChild(li);
  }
  ul.hidden = !ul.hidden;
}

function fitRoute() {
  const b = new maplibregl.LngLatBounds(); S.route.line.forEach((c) => b.extend(c));
  map.fitBounds(b, { padding: pad(), duration: 0 });
}

async function setDest(ll, name, sub) {
  clearTrip();
  S.dest = ll; S.destName = name; S.destSub = sub || "";
  placeDest(ll);
  if (!S.start) { const ok = await locate(); if (!ok) { showPanel("search"); return; } }
  doPlan();
}

// ---------------------------------------------------------------- planning
async function doPlan(fromFix) {
  const start = fromFix || S.start;
  toast(fromFix ? t("replanning") : t("planning"), 20000);
  try {
    // which EuroVelo routes to ride (switching where they meet), then plan each part
    const legs = chooseRoutes({ routes: S.routes, junctions: S.junctions }, start, S.dest)
      || [{ id: S.route.id, num: S.route.num, short: S.route.short, long: S.route.long, from: start, to: S.dest }];
    const routes = {};
    for (const l of legs) routes[l.id] = await getRoute(l.id);
    const plan = await planNetwork(routes, legs, valhallaRoute, { lang: S.lang });
    if (!fromFix && legs[0].id !== S.route.id) { await loadRoute(legs[0].id); renderChips(); }
    S.plan = plan;
    drawPlan(plan);
    hideToast();
    if (!fromFix) { showPreview(); fitPlan(); }
    return plan;
  } catch (e) {
    toast(String(e.message || e), 5000);
    return null;
  }
}

function drawPlan(plan) {
  const line = new Line(plan.coords);
  const feats = plan.spans.map((s) => ({ type: "Feature", properties: { kind: s.kind, straight: s.straight },
    geometry: { type: "LineString", coordinates: line.slice(s.d0, s.d1) } }));
  map.getSource("plan").setData({ type: "FeatureCollection", features: feats });
}
function fitPlan() {
  const b = new maplibregl.LngLatBounds(); S.plan.coords.forEach((c) => b.extend(c));
  map.fitBounds(b, { padding: pad(), duration: 600 });
}

function showPreview() {
  const p = S.plan;
  computeNights();
  $("dest-name").textContent = S.destName;
  $("dest-sub").textContent = S.destSub;
  const secs = p.length / DEFAULT_SPEED;
  $("stats").innerHTML =
    `<div><b>${fmtDist(p.length, S.lang)}</b><span>${t("total")}</span></div>` +
    `<div><b>${fmtDist(p.evLength, S.lang)}</b><span>${t("onEv")}</span></div>` +
    `<div><b>${fmtDuration(secs)}</b><span>${t("time")}</span></div>` +
    (p.climb >= 20 ? `<div><b>↑ ${p.climb.toLocaleString(S.lang === "cs" ? "cs-CZ" : "en-GB")} m</b><span>${t("climb")}</span></div>` : "");
  const notes = $("notes"); notes.innerHTML = "";
  if (p.legs && p.legs.length > 1) {
    const li = document.createElement("li"); li.className = "legs";
    li.innerHTML = p.legs.map((l) => `<b>${esc(shortOf(l))}</b> ${fmtDist(l.d1 - l.d0, S.lang)}`).join(" → ");
    notes.appendChild(li);
  }
  for (const w of p.warnings) {
    const li = document.createElement("li");
    li.className = w.avoided ? "" : w.kind;
    const head = w.avoided ? t(w.signed ? "avoidedSigned" : "avoided") : w.kind === "report" ? t("report") : t("caution");
    const det = w.avoided && w.detour ? `<small>${t("detourVia")}: ${esc(w.detour[S.lang] || w.detour.cs)}</small>` : "";
    li.innerHTML = `<b>${head}</b> · ${esc(w.title?.[S.lang] || w.title?.cs || "")} <small>${fmtDist(w.d, S.lang)}${w.to ? ` · ${t("until")} ${fmtDate(w.to)}` : ""}</small>${det}`;
    notes.appendChild(li);
  }
  if (p.failed.length) { const li = document.createElement("li"); li.className = "fail"; li.textContent = t("routerFail"); notes.appendChild(li); }
  renderTrip();
  drawProfile();
  renderOffline();
  showPanel("preview");
}

// ---------------------------------------------------------------- offline map
const TILE_KB = 45; // average vector tile along a route, for the size estimate
let offCtl = null;
const tf = (k, v) => t(k).replace(/\{(\w+)\}/g, (_, x) => v[x]);
function offUrls() {
  const p = S.plan;
  if (!S.style?.sources || S.style === FALLBACK_STYLE) return [];
  return (p.offUrls ??= tripUrls(S.style, (p.line ??= new Line(p.coords))));
}
async function renderOffline(state) {
  const urls = offUrls(), label = $("off-label"), bar = $("off-bar"), x = $("btn-offline-x"), btn = $("btn-offline");
  $("offline").hidden = !urls.length;
  if (!urls.length) return;
  bar.hidden = true; x.hidden = true; btn.disabled = false; btn.classList.remove("done");
  if (state?.progress != null) {
    bar.hidden = false; bar.firstElementChild.style.width = `${state.progress}%`;
    label.textContent = tf("offProgress", { p: Math.floor(state.progress) });
    x.hidden = false; x.textContent = t("offCancel"); x.onclick = () => offCtl?.abort();
    btn.disabled = true;
    return;
  }
  const tileUrls = urls.filter((u) => !/\/(fonts|sprites)\//.test(u)); // fonts/icons get cached just by using the map
  const have = await countCached(tileUrls);
  if (S.plan.offUrls !== urls) return; // plan changed meanwhile
  if (have >= tileUrls.length * 0.98) {
    btn.classList.add("done"); label.textContent = t("offDone"); btn.disabled = true;
    x.hidden = false; x.textContent = t("offDelete");
    x.onclick = async () => { await clearTiles(); renderOffline(); };
  } else if (have > 0) {
    label.textContent = tf("offPart", { p: Math.floor((have / tileUrls.length) * 100) });
  } else {
    label.textContent = `${t("offDl")} · ${tf("offSize", { mb: Math.max(1, Math.round((urls.length * TILE_KB) / 1024)) })}`;
  }
  btn.onclick = downloadTrip;
}
async function downloadTrip() {
  const urls = offUrls(), plan = S.plan;
  offCtl = new AbortController();
  plan.saved = true; saveTrip(tripSnapshot());
  const libs = ["lib/maplibre-gl.js", "lib/maplibre-gl.css", "css/fonts.css",
    ...["atkinson-hyperlegible-latin-400", "atkinson-hyperlegible-latin-ext-400", "atkinson-hyperlegible-latin-700", "atkinson-hyperlegible-latin-ext-700",
      "barlow-condensed-latin-600", "barlow-condensed-latin-ext-600", "barlow-condensed-latin-700", "barlow-condensed-latin-ext-700"].map((f) => `fonts/${f}-normal.woff2`)];
  keepAppFiles(["./", "index.html", "css/app.css", "js/app.js", "js/core.js", "js/services.js", "js/nights.js", "js/offline.js",
    "manifest.webmanifest", "icons/icon-192.png", ROUTES_URL, ...new Set((plan.legs || [{ id: S.route.id }]).flatMap((l) => [`data/${l.id}.json`,
      ...(CONFIG.dataBase ? [`${CONFIG.dataBase}data/${l.id}.json`, `${CONFIG.dataBase}closures/${l.id}.json`] : [])])),
    ...(CONFIG.dataBase ? [CONFIG.dataBase + ROUTES_URL] : []), ...libs]);
  renderOffline({ progress: 0 });
  const res = await download(urls, { signal: offCtl.signal, onProgress: (d, n) => { if (S.plan === plan) renderOffline({ progress: (d / n) * 100 }); } });
  offCtl = null;
  if (res.quota) toast(t("offStorage"), 5000);
  if (S.plan === plan) renderOffline();
}
function tripSnapshot() {
  const p = S.plan;
  const plan = { coords: p.coords, maneuvers: p.maneuvers, spans: p.spans, warnings: p.warnings, failed: p.failed, length: p.length,
    evLength: p.evLength, legs: p.legs, profile: p.profile, dir: p.dir, start: p.start, dest: p.dest, climb: p.climb,
    nights: (p.nights || []).map(({ loading, ...n }) => n) };
  return { v: 1, saved: Date.now(), plan, routeId: S.route.id, dest: S.dest, destName: S.destName, destSub: S.destSub, pace: S.pace,
    tripDate: S.tripDate ? S.tripDate.getTime() : null };
}
async function offerSavedTrip() {
  const trip = await loadTrip(), b = $("saved-trip");
  if (!trip?.plan) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `<span><small>${t("savedTrip")}</small><b>${esc(trip.destName)}</b> · ${fmtDist(trip.plan.length, S.lang)}</span><span class="go">${t("resume")} ›</span>`;
  b.onclick = async () => {
    if (trip.routeId && trip.routeId !== S.route.id) { try { await loadRoute(trip.routeId); } catch {} }
    Object.assign(S, { dest: trip.dest, destName: trip.destName, destSub: trip.destSub, pace: trip.pace || S.pace, tripDate: trip.tripDate ? new Date(trip.tripDate) : null });
    if (S.tripDate) $("trip-date").value = `${S.tripDate.getFullYear()}-${String(S.tripDate.getMonth() + 1).padStart(2, "0")}-${String(S.tripDate.getDate()).padStart(2, "0")}`;
    S.plan = { ...trip.plan, restored: true, saved: true };
    placeDest(S.dest); drawPlan(S.plan); showPreview(); fitPlan();
  };
}

// ---------------------------------------------------------------- elevation profile
let pfMarker = null;
function drawProfile() {
  const p = S.plan, box = $("profile"), pr = p?.profile;
  if (!pr || pr.length < 2 || !p.climb) { box.hidden = true; return; }
  box.hidden = false;
  const L = p.length, N = 300, es = [];
  for (let i = 0; i <= N; i++) es.push(eleAtD(pr, (L * i) / N));
  let lo = Math.min(...es), hi = Math.max(...es);
  if (hi - lo < 100) { const m = (hi + lo) / 2; lo = m - 50; hi = m + 50; }
  const y = (e) => 96 - ((e - lo) / (hi - lo)) * 88;
  const pts = es.map((e, i) => `${((i / N) * 1000).toFixed(1)},${y(e).toFixed(1)}`);
  box.querySelector(".ln").setAttribute("d", "M" + pts.join("L"));
  box.querySelector(".area").setAttribute("d", "M0,100L" + pts.join("L") + "L1000,100Z");
  const nights = p.nights || [];
  box.querySelector(".nl").innerHTML = nights.map((n) => `<line x1="${(n.d / L) * 1000}" x2="${(n.d / L) * 1000}" y1="0" y2="100"/>`).join("");
  const fmt = (e) => `${Math.round(e)} m`;
  box.querySelector(".pf-labels").innerHTML = `<span class="hi">${fmt(Math.max(...es))}</span><span class="lo">${fmt(Math.min(...es))}</span>` +
    nights.map((n) => `<span class="nn" style="left:${(n.d / L) * 100}%">${n.n}</span>`).join("");
  const read = box.querySelector(".pf-read"), cur = box.querySelector(".cur");
  const show = (ev) => {
    const r = box.getBoundingClientRect(), f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), d = f * L;
    cur.hidden = false; cur.setAttribute("x1", f * 1000); cur.setAttribute("x2", f * 1000);
    read.hidden = false; read.textContent = `km ${Math.round(d / 1000)} · ${Math.round(eleAtD(pr, d))} m`;
    read.style.left = `${Math.min(80, Math.max(0, f * 100 - 10))}%`;
    const ll = (p.line ??= new Line(p.coords)).pointAt(d);
    if (!pfMarker) { const el = document.createElement("div"); el.className = "pf-dot"; pfMarker = new maplibregl.Marker({ element: el }); }
    pfMarker.setLngLat(ll).addTo(map);
  };
  const hide = () => { cur.hidden = true; read.hidden = true; pfMarker?.remove(); };
  box.onpointerdown = (e) => { box.setPointerCapture(e.pointerId); show(e); };
  box.onpointermove = (e) => { if (e.pointerType === "mouse" || box.hasPointerCapture(e.pointerId)) show(e); };
  box.onpointerup = box.onpointercancel = (e) => { if (e.pointerType !== "mouse") hide(); };
  box.onpointerleave = (e) => { if (e.pointerType === "mouse") hide(); };
}

// ---------------------------------------------------------------- overnight stops
// Instant first guess from the stage towns; then each night is refined in order
// from OpenStreetMap: the town nearest the day's distance that has beds, and the
// best place to sleep there.
let allPlaces = null, nightMarkers = [], stayMarkers = [], tripCtl = null;
const areaCache = new Map();
function computeNights() {
  const p = S.plan;
  if (!allPlaces) { localPlaces("a"); allPlaces = placeIndex; }
  p.line ??= new Line(p.coords);
  p.towns ??= townsAlong(p.line, allPlaces);
  p.effort ??= makeEffort(p.profile, p.line.length);
  p.climb ??= Math.round(ascent(p.profile));
  if (p.restored && p.nights && !p.repaced) return; // saved trip: keep its nights and places to stay (they may be offline)
  p.nights = splitDays(p.line, p.towns, S.pace * 1000, p.effort);
}
const climbTxt = (a, b) => { const up = Math.round(ascent(S.plan.profile, a, b) / 10) * 10; return up >= 20 ? ` · ↑ ${up.toLocaleString(S.lang === "cs" ? "cs-CZ" : "en-GB")} m` : ""; };
const nightDate = (n) => S.tripDate && new Date(S.tripDate.getFullYear(), S.tripDate.getMonth(), S.tripDate.getDate() + n - 1);
const fmtDay = (d) => d.toLocaleDateString(S.lang === "cs" ? "cs-CZ" : "en-GB", { weekday: "short", day: "numeric", month: "numeric" });
function clearTrip() {
  tripCtl?.abort();
  nightMarkers.forEach((m) => m.remove()); stayMarkers.forEach((m) => m.remove());
  nightMarkers = []; stayMarkers = [];
}
function renderTrip() {
  clearTrip();
  const p = S.plan, nights = p?.nights || [];
  $("trip").hidden = !nights.length;
  if (!nights.length) return;
  document.querySelectorAll("#pace button").forEach((b) => b.setAttribute("aria-pressed", Number(b.dataset.v) === S.pace));
  $("trip-date-clear").hidden = !S.tripDate;
  $("trip-hint").textContent = t(S.tripDate ? "tripHintDate" : "tripHint");
  drawNights();
  if (!(p.restored && !p.repaced)) refineNights();
}
function drawNights() {
  const p = S.plan, nights = p.nights;
  nightMarkers.forEach((m) => m.remove()); stayMarkers.forEach((m) => m.remove());
  nightMarkers = []; stayMarkers = [];
  const ol = $("nights"), open = new Set([...ol.querySelectorAll("details[open]")].map((d) => d.dataset.n));
  ol.innerHTML = "";
  let prev = 0;
  for (const n of nights) {
    const li = document.createElement("li"); li.id = `night-${n.n}`;
    const date = nightDate(n.n), where = n.name || `km ${Math.round(n.d / 1000)}`;
    li.innerHTML = `<button type="button" class="night-head"><span class="night-n">${n.n}</span><span><b>${esc(where)}</b>` +
      `<small>${date ? fmtDay(date) + " · " : ""}${t("day")} ${n.n}: ${fmtDist(n.d - prev, S.lang)}${climbTxt(prev, n.d)} · km ${Math.round(n.d / 1000)}</small></span></button>` +
      `<div class="stays">${staysHTML(n, open.has(String(n.n)))}</div>`;
    li.querySelector(".night-head").onclick = () => map.flyTo({ center: n.stay?.lonlat || n.lonlat, zoom: 13, duration: 700 });
    ol.appendChild(li);
    prev = n.d;
    const el = document.createElement("div"); el.className = "night-pin"; el.textContent = n.n; el.title = `${t("night")} ${n.n}: ${where}`;
    el.onclick = () => li.scrollIntoView({ behavior: "smooth", block: "nearest" });
    nightMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(n.lonlat).addTo(map));
    if (n.stay) {
      const sp = document.createElement("div"); sp.className = "stay-pin"; sp.title = n.stay.tags.name;
      sp.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="11" r="2" fill="#fff"/></svg>';
      sp.onclick = () => li.scrollIntoView({ behavior: "smooth", block: "nearest" });
      stayMarkers.push(new maplibregl.Marker({ element: sp }).setLngLat(n.stay.lonlat).addTo(map));
    }
  }
  const last = document.createElement("li"); last.className = "night-last";
  last.innerHTML = `<span class="night-n">◎</span><span><b>${esc(S.destName)}</b><small>${S.tripDate ? fmtDay(nightDate(nights.length + 1)) + " · " : ""}${t("day")} ${nights.length + 1}: ${fmtDist(p.length - prev, S.lang)}${climbTxt(prev, p.length)}</small></span>`;
  ol.appendChild(last);
  drawProfile();
  $("stats").querySelector(":scope > div:nth-child(3) b").textContent = fmtDuration(p.length / DEFAULT_SPEED);
}
async function refineNights() {
  const ctl = (tripCtl = new AbortController()), p = S.plan, line = p.line, per = S.pace * 1000;
  const radius = Math.min(20000, Math.max(6000, per * 0.25));
  let prev = 0;
  for (let k = 0; k < p.nights.length; k++) {
    const target = nextTarget(p.effort, prev, per); // hills count extra; never a stub last day
    if (p.effort.total - p.effort.eAt(prev) <= per * 1.25) { p.nights.length = k; drawNights(); return; } // the rest fits in the last day
    let n = p.nights[k];
    if (Math.abs(n.d - target) > per * 0.2) { n = p.nights[k] = { n: k + 1, d: target, lonlat: line.pointAt(target), name: null }; }
    n.loading = true; drawNights();
    const center = line.pointAt(target), key = `${center.map((x) => x.toFixed(2))}|${radius}|${S.lang}`;
    try {
      if (!areaCache.has(key)) areaCache.set(key, await fetchArea(center, radius, ctl.signal, S.lang));
      if (ctl.signal.aborted) return;
      const area = areaCache.get(key);
      const span = target - prev;
      const town = pickTown(area, line, target, prev + span * 0.75, Math.min(line.length - per * 0.3, prev + span * 1.25));
      if (town) Object.assign(n, { d: town.d, lonlat: town.lonlat, name: placeName(town.name) });
      n.stays = rankStays(area.stays, n, line, nightDate(n.n)).filter((s) => haversine(s.lonlat, n.lonlat) < 6000);
      n.stay = n.stays[0] || null;
    } catch {
      if (ctl.signal.aborted) return;
      n.failed = true;
    }
    n.loading = false; drawNights();
    prev = n.d;
    // a night that moved shifts the rest; add one if the trip now needs it
    if (k === p.nights.length - 1 && p.effort.total - p.effort.eAt(prev) > per * 1.25) { const d = nextTarget(p.effort, prev, per); p.nights.push({ n: k + 2, d, lonlat: line.pointAt(d), name: null }); }
  }
  if (p.saved && S.plan === p) saveTrip(tripSnapshot()); // the offline copy gets the places to stay too
}
function stayHTML(s, n, top) {
  const date = nightDate(n.n), tg = s.tags;
  const links = [
    s.website && `<a href="${esc(s.website.startsWith("http") ? s.website : "https://" + s.website)}" target="_blank" rel="noopener">${t("web")}</a>`,
    s.phone && `<a href="tel:${esc(s.phone.split(/[;,]/)[0].replace(/\s/g, ""))}">${t("call")}</a>`,
    date && `<a href="${esc(bookingUrl(n.name || tg["addr:city"] || tg.name, date, S.lang, S.route?.id))}" target="_blank" rel="noopener">${t("booking")}</a>`,
  ].filter(Boolean).join(" · ");
  return `<div class="stay${top ? " top" : ""}"><b>${esc(tg.name)}</b><small>${t("kind_" + s.kind)} · ${fmtDist(s.off, S.lang)} ${t("fromRoute")}${s.bike ? ` · <span class="bike">${t("bikeOk")}</span>` : ""}</small>${links ? `<div class="stay-links">${links}</div>` : ""}</div>`;
}
function staysHTML(n, open) {
  if (n.loading) return `<div class="stay-status"><i class="spin"></i>${t("stayLoading")}</div>`;
  if (n.failed) return `<div class="stay-status">${t("stayErr")}</div>`;
  if (!n.stays) return "";
  if (!n.stays.length) return `<div class="stay-status">${t("stayNone")}</div>`;
  const [top, ...rest] = n.stays;
  return stayHTML(top, n, true) + (rest.length ? `<details data-n="${n.n}"${open ? " open" : ""}><summary>${t("more")} (${Math.min(rest.length, 4)})</summary>${rest.slice(0, 4).map((x) => stayHTML(x, n, false)).join("")}</details>` : "");
}

// ---------------------------------------------------------------- riding
async function startRide(simulate) {
  if (!S.plan) return;
  S.nav = new Navigator(S.plan);
  S.mode = "ride"; S.follow = true; S.speeds = [];
  showPanel("ride");
  $("turn").hidden = false;
  try { S.wake = await navigator.wakeLock?.request("screen"); } catch {}
  speak(phrase({ kind: "maneuver", m: S.plan.maneuvers[0], dist: Math.round(S.plan.maneuvers[0].d) }, S.lang));
  if (simulate) startSim(); else {
    S.watch = navigator.geolocation?.watchPosition(
      (p) => onFix([p.coords.longitude, p.coords.latitude], p.coords.accuracy, p.coords.speed),
      () => toast(t("noGps"), 4000),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
}

function startSim() {
  const line = new Line(S.plan.coords);
  let d = 0, last = performance.now();
  const speed = 25 / 3.6 * 4; // 4× real time at 25 km/h
  toast(t("simulating"), 2500);
  S.sim = setInterval(() => {
    const now = performance.now(); d += speed * (now - last) / 1000; last = now;
    const p = line.pointAt(d);
    onFix([p[0] + (Math.random() - .5) * 0.00004, p[1] + (Math.random() - .5) * 0.00003], 6, 25 / 3.6);
    if (d >= line.length + 30) { clearInterval(S.sim); S.sim = null; }
  }, 400);
}

async function onFix(ll, acc, speed) {
  if (S.mode !== "ride") return;
  S.lastFix = ll;
  if (speed > 1.5) { S.speeds.push(speed); if (S.speeds.length > 30) S.speeds.shift(); }
  const st = S.nav.update(ll, acc);
  const show = st.snapDist < 30 ? st.snapped : ll;
  placePuck(show, st.heading);
  if (S.follow) map.easeTo({ center: show, zoom: Math.max(map.getZoom(), 16), duration: 600 });

  renderTurn(st);
  renderWarn(st);
  renderRideStats(st);
  for (const s of st.say) speak(phrase(s, S.lang));

  if (st.arrived) { speak(t("arrived")); stopRide(true); return; }
  if (st.offRoute && Date.now() - S.lastReplan > 20000) {
    S.lastReplan = Date.now();
    if (!navigator.onLine) { toast(t("offNoNet"), 5000); return; }
    const plan = await doPlan(ll);
    if (plan) { S.nav = new Navigator(plan); }
  }
}

function renderTurn(st) {
  const m = st.next;
  $("turn").classList.toggle("detour", m.k === "detour");
  $("turn-glyph").innerHTML = glyph(m);
  $("turn-dist").textContent = fmtDist(st.toNext, S.lang);
  $("turn-what").textContent = m.t?.[S.lang] || m.t?.cs || m.t?.en || "";
  const a = st.after;
  if (a && a.d - m.d < 150 && a.k !== "arrive") {
    $("turn-then").hidden = false;
    $("turn-then").innerHTML = `${S.lang === "cs" ? "Pak" : "Then"} ${glyph(a, true)} ${esc(a.t?.[S.lang] || a.t?.cs || "")}`;
  } else $("turn-then").hidden = true;
  document.documentElement.style.setProperty("--turn-h", $("turn").getBoundingClientRect().height + "px");
}
function renderWarn(st) {
  const w = st.warn[0], box = $("warn");
  if (!w) { box.hidden = true; return; }
  box.hidden = false;
  box.className = "warn" + (w.avoided ? "" : " caution");
  const head = w.avoided ? t(w.signed ? "avoidedSigned" : "avoided") : w.kind === "report" ? t("report") : t("caution");
  box.innerHTML = `<b>${head} · ${fmtDist(Math.max(0, w.ahead), S.lang)}</b>${esc(w.title?.[S.lang] || w.title?.cs || "")}`;
}
function renderRideStats(st) {
  const v = S.speeds.length ? S.speeds.reduce((a, b) => a + b) / S.speeds.length : DEFAULT_SPEED;
  const eta = new Date(Date.now() + st.remaining / v * 1000);
  $("ride-left").textContent = fmtDist(st.remaining, S.lang);
  $("ride-eta").textContent = eta.toLocaleTimeString(S.lang === "cs" ? "cs-CZ" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  const evLeft = S.plan.spans.filter((s) => s.kind === "ev").reduce((sum, s) => sum + Math.max(0, s.d1 - Math.max(s.d0, st.d)), 0);
  $("ride-on").textContent = fmtDist(evLeft, S.lang);
  $("ride-on-l").textContent = t("onEv");
}

function stopRide(arrived) {
  if (S.watch != null) navigator.geolocation.clearWatch(S.watch);
  if (S.sim) clearInterval(S.sim);
  S.watch = S.sim = null;
  try { S.wake?.release(); } catch {}
  S.mode = arrived ? "search" : "preview";
  $("turn").hidden = true; $("warn").hidden = true;
  if (arrived) { toast(t("arrived"), 5000); showPanel("search"); } else showPreview();
}

// ---------------------------------------------------------------- voice
function speak(text) {
  if (!S.voice || !text || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = S.lang === "cs" ? "cs-CZ" : "en-GB";
  const v = speechSynthesis.getVoices().find((x) => x.lang?.toLowerCase().startsWith(S.lang === "cs" ? "cs" : "en"));
  if (v) u.voice = v;
  u.rate = 1.02;
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------- glyphs
function glyph(m, small = false) {
  const sw = small ? 5 : 5.5, col = "#13213a";
  if (m.k === "arrive") return svg(`<path d="M15 42V8" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/><path d="M15 9h20l-5 7 5 7H15z" fill="${col}"/>`);
  if (m.k === "detour") return svg(`<path d="M24 6 44 40H4z" fill="#c4361c"/><path d="M24 18v11" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cx="24" cy="35" r="3" fill="#fff"/>`);
  if (m.k === "join" || m.k === "leave") {
    const ring = Array.from({ length: 12 }, (_, i) => { const a = i / 12 * Math.PI * 2; return `<circle cx="${24 + 15 * Math.sin(a)}" cy="${24 - 15 * Math.cos(a)}" r="2" fill="${col}"/>`; }).join("");
    return svg(`${ring}<text x="24" y="31" text-anchor="middle" font-family="Barlow Condensed, sans-serif" font-weight="700" font-size="21" fill="${col}">9</text>`);
  }
  if (m.k === "roundabout" || m.k === "roundabout_exit") return svg(`<circle cx="24" cy="20" r="9" fill="none" stroke="${col}" stroke-width="${sw}"/><path d="M24 44V29" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`);
  const ang = { slight: 40, turn: 90, sharp: 135, turn_back: 170, keep: 25, exit: 40, ramp: 30 }[m.k] ?? 0;
  const a = (m.s === "l" ? -ang : ang) * Math.PI / 180;
  const ex = 24 + 16 * Math.sin(a), ey = 24 - 16 * Math.cos(a);
  const hx = (dx, dy) => [ex + dx * Math.cos(a) - dy * Math.sin(a), ey + dx * Math.sin(a) + dy * Math.cos(a)];
  const h1 = hx(-8, 9), h2 = hx(8, 9), tip = hx(0, -3);
  return svg(`<path d="M24 44V24L${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M${tip[0].toFixed(1)} ${tip[1].toFixed(1)}L${h1[0].toFixed(1)} ${h1[1].toFixed(1)}L${h2[0].toFixed(1)} ${h2[1].toFixed(1)}z" fill="${col}"/>`);
}
const svg = (inner) => `<svg viewBox="0 0 48 48" aria-hidden="true">${inner}</svg>`;

// ---------------------------------------------------------------- ui helpers
function showPanel(name) {
  S.mode = name === "ride" ? "ride" : name;
  for (const p of ["search", "preview", "ride"]) $("panel-" + p).hidden = p !== name;
  requestAnimationFrame(() => document.documentElement.style.setProperty("--sheet-h", $("sheet").getBoundingClientRect().height + "px"));
}
let toastTimer;
function toast(msg, ms = 2500) { const el = $("toast"); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms); }
function hideToast() { $("toast").hidden = true; }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function fmtLL(ll) { return `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`; }
function fmtDate(iso) {
  const d = new Date(iso), opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric"; // "do 1. 10. 2028", not a misleading "do 1. 10."
  return d.toLocaleDateString(S.lang === "cs" ? "cs-CZ" : "en-GB", opts);
}
function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h >= 10) { // a multi-day trip: days at ~80 km/day are more useful than hours
    const days = S.plan?.nights ? S.plan.nights.length + 1 : Math.max(1, Math.round((s * DEFAULT_SPEED) / (S.pace * 1000)));
    return S.lang === "cs" ? `≈ ${days} ${days === 1 ? "den" : days < 5 ? "dny" : "dní"}` : `≈ ${days} day${days === 1 ? "" : "s"}`;
  }
  return h ? `${h} h ${m} min` : `${m} min`;
}

function applyLang() {
  document.documentElement.lang = S.lang;
  $("btn-lang").textContent = S.lang === "cs" ? "CZ" : "EN";
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  window.__installRender?.();
  $("hint").textContent = `${t("hint")} ${t("data")}: ${fmtDate(S.route?.closuresChecked || S.route?.generated || Date.now())}`;
  $("btn-voice").innerHTML = S.voice
    ? svg('<path d="M8 18h8l10-8v28l-10-8H8z" fill="#13213a"/><path d="M32 16c4 5 4 11 0 16M36 11c7 8 7 18 0 26" stroke="#13213a" stroke-width="3.5" fill="none" stroke-linecap="round"/>')
    : svg('<path d="M8 18h8l10-8v28l-10-8H8z" fill="#56647c"/><path d="M33 18l10 12M43 18 33 30" stroke="#56647c" stroke-width="3.5" stroke-linecap="round"/>');
  $("btn-voice").setAttribute("aria-pressed", S.voice);
  $("btn-locate").innerHTML = svg('<circle cx="24" cy="24" r="8" fill="#0f4c9c"/><circle cx="24" cy="24" r="15" fill="none" stroke="#13213a" stroke-width="3.5"/><path d="M24 3v7M24 38v7M3 24h7M38 24h7" stroke="#13213a" stroke-width="3.5" stroke-linecap="round"/>');
}

// ---------------------------------------------------------------- boot
async function boot() {
  const net = await fetchData(ROUTES_URL);
  S.routes = net.routes; S.junctions = net.junctions || [];
  for (const r of S.routes) r.outlineLine = new Line(decodePolyline(r.outline, 1e5));
  const saved = load("route", null);
  await loadRoute(saved || "ev9");
  applyLang();
  showPanel("search");
  await initMap();
  renderChips();
  offerSavedTrip();

  $("q").addEventListener("input", onSearchInput);
  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("results").querySelector("button")?.click(); } });
  document.querySelectorAll("#pace button").forEach((b) => (b.onclick = () => {
    S.pace = Number(b.dataset.v); save("pace", S.pace); if (S.plan) S.plan.repaced = true; showPreview();
  }));
  // the date only changes labels, Booking links and which campsites are open: re-rank, no new requests
  const redate = () => {
    $("trip-date-clear").hidden = !S.tripDate; $("trip-hint").textContent = t(S.tripDate ? "tripHintDate" : "tripHint");
    for (const n of S.plan?.nights || []) if (n.stays) {
      const key = [...areaCache.values()].find((a) => a.stays.some((x) => x.id === n.stays[0]?.id));
      if (key) { n.stays = rankStays(key.stays, n, S.plan.line, nightDate(n.n)).filter((x) => haversine(x.lonlat, n.lonlat) < 6000); n.stay = n.stays[0] || null; }
    }
    drawNights();
    if (S.plan?.saved) saveTrip(tripSnapshot());
  };
  $("trip-date").onchange = (e) => {
    const v = e.target.value; S.tripDate = v ? new Date(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) : null; redate();
  };
  $("trip-date-clear").onclick = () => { $("trip-date").value = ""; S.tripDate = null; redate(); };
  $("btn-change").onclick = () => { clearTrip(); S.plan = null; map.getSource("plan").setData(emptyFC()); showPanel("search"); $("q").focus(); };
  $("btn-go").onclick = () => startRide(false);
  $("btn-sim").onclick = () => startRide(true);
  $("btn-stop").onclick = () => stopRide(false);
  $("btn-lang").onclick = () => { S.lang = S.lang === "cs" ? "en" : "cs"; save("lang", S.lang); applyLang(); renderChips(); if (S.mode === "preview" && S.dest) doPlan(); };
  $("btn-voice").onclick = () => { S.voice = !S.voice; save("voice", S.voice ? "1" : "0"); applyLang(); if (!S.voice) speechSynthesis?.cancel(); };
  $("btn-locate").onclick = async () => {
    if (S.mode === "ride") { S.follow = true; if (S.lastFix) map.easeTo({ center: S.lastFix, zoom: 16.5 }); return; }
    if (await locate()) { map.easeTo({ center: S.start, zoom: 13 }); renderChips(); }
  };
  document.querySelector(".ev-badge").addEventListener("click", showRoutePicker);
  if ("speechSynthesis" in window) speechSynthesis.getVoices();
  setupInstall();
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) navigator.serviceWorker.register("sw.js").catch(() => {});
  // ask for location quietly; the app works without it (tap the map to set start)
  locate().then(async (ok) => {
    if (!ok) return;
    if (!saved) { const n = nearestRoute(S.start); if (n.dist < 50000) await loadRoute(n.meta.id); }
    renderChips();
    // near the route? show your surroundings; far away? keep the whole route in view
    if (S.route.ev.project(S.start).dist < 30000) map.easeTo({ center: S.start, zoom: 11, duration: 800 });
  });
}

// ---------------------------------------------------------------- install offer
// Android/Chrome: the browser's own install prompt behind our button. iPhone/iPad
// Safari has no prompt, so we say where the button is. Hidden once installed or dismissed.
function setupInstall() {
  const box = $("install"), how = $("install-how"), go = $("install-go");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  let dismissed = false; try { dismissed = localStorage.getItem("evnav.installX") === "1"; } catch {}
  if (standalone || dismissed || !mobile) return;
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || /Macintosh/.test(navigator.userAgent);
  const share = '<svg class="ios-share" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M12 3 8 7m4-4 4 4M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const render = () => { how.innerHTML = ios && !deferred ? esc(t("installIos")).replace("{share}", share) : esc(t("installAndroid")); go.hidden = !deferred; };
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; render(); box.hidden = false; });
  window.addEventListener("appinstalled", () => { box.hidden = true; });
  go.onclick = async () => { if (!deferred) return; deferred.prompt(); const r = await deferred.userChoice.catch(() => null); deferred = null; if (r?.outcome === "accepted") box.hidden = true; else render(); };
  $("install-x").onclick = () => { box.hidden = true; try { localStorage.setItem("evnav.installX", "1"); } catch {} };
  window.__installRender = render;
  if (ios) { render(); box.hidden = false; } // Android shows it once Chrome says it's installable
}

boot().catch((e) => { console.error(e); toast(String(e.message || e), 8000); });

// exposed for automated tests
window.__evnav = { S, onFix, startRide, setDest, doPlan, renderTrip, offerSavedTrip };
