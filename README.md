# EuroVelo Nav by NEXIS Rail – data

Route bundles and closures for the EuroVelo Nav app (nexisrail.cz/eurovelo).
GitHub Pages serves this repo; the app loads `data/routes.json`, `data/<route>.json`
and `closures/<route>.json` from here and falls back to the copy it ships with.

## What updates itself

| what | how | when |
|---|---|---|
| Czech closures | `tools/update_closures.py` reads the official JSDI feed (dopravniinfo.cz, all 14 regions) | every Monday, GitHub Actions |
| OSM construction / night closures | same script, Overpass scan along every route (max 105 min per run; resumes next week where it stopped, see `closures/osm-scan.json`) | every Monday |
| hand-checked closures (abroad, mapy.com, riders) | `closures/manual.json`, edited by the weekly Claude task | weekly |
| new routes | `routes.yml` queue → `tools/build_routes.py` builds from OpenStreetMap relations | one per week |

A push that changes `closures/manual.json`, `closures/jsdi-overrides.json`, `routes.yml` or `data/`
re-runs the update straight away (without the slow OSM scan).
`closures/report.md` is the latest run's summary.

## Closure rules
- A line closure counts for a route only when the route runs along it for at least
  min(150 m, 60 % of its length); a road it merely crosses doesn't count.
- JSDI: full closures (`úplná uzavírka`, `uzavřeno`, …) become *closures* (the app detours);
  partial ones, roadworks and anything lasting over 2 years become *cautions*; lorry/weight/height
  rules are skipped. `closures/jsdi-overrides.json` gives better wording and signed-detour waypoints by JSDI id.
- OSM items are always *cautions* (tags can be stale).
- `via` = waypoints of a signed detour, in route order; the app rides them first.

Data: © OpenStreetMap contributors (ODbL); EuroVelo GPX © ECF/EuroVelo (ODbL); JSDI © ŘSD ČR.

## Weekly sanity check
`tools/check.mjs` (runs in the workflow after the closures update) loads every route with the app's own
planner (`app-source/`, a copy of the app as deployed) and the public Valhalla router, and writes
`closures/checks.md` / `checks.json`: route gaps, zigzags, a line that doubles back, expired or reversed dates,
duplicate closures, and for every active closure whether the detour was found, how long it is, and whether it
runs through another closure. The weekly Claude task reads it and fixes what it can.

`app-source/` is the app's source (what is uploaded to nexisrail.cz/eurovelo) kept here as a backup and for the checks.
