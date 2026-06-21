# Island Land-Use Planner

A no-login, no-backend, browser-based land-use planning tool. Everything runs
client-side and persists in `localStorage`.

## Stack

Next.js (App Router) · React · TypeScript · MapLibre GL JS · Terra Draw ·
Turf.js · Tailwind CSS.

## Run

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
```

## Workflow

1. **Select an island** from the left toolbar (data: `public/islands.geojson`).
   The map zooms to it over an Esri World Imagery satellite basemap.
2. **Draw Boundary** — draw a single planning-boundary polygon. Its area is
   computed with Turf.js (m² and ha) and shown in the bottom bar.
3. **Allocation sliders** (right panel) — 8 land-use categories that always sum
   to 100%. Changing one proportionally adjusts the unlocked others; lock a
   slider (🔒) to pin it. Each shows its `target_area = boundary × % / 100`.
4. **Auto-Plan → Generate Plan** — set plot size (sq ft) with a minimum-size
   restriction, road lanes + lane width, and plots-per-block, then click
   ⚡ Generate. The engine lays a road grid, subdivides the boundary into
   plots, sizes green space from the planning parameters (or the Green slider),
   and assigns the remaining plots to the other land uses per the allocation
   sliders. Manual parcel drawing remains available in the toolbar.
5. **Compare** — bottom bar shows drawn vs. target area, surplus/shortfall, and
   % achieved per category.
6. **Parameters** — Residential FAR, avg unit size, household size, road width,
   green m²/person target, industrial buffer distance → derives residential
   floor area, housing units, population, road-area %, green m²/person, and
   industrial-buffer conflict warnings (sensitive parcels inside the buffer).
7. **Save / Load** to `localStorage`, **Export/Import** project JSON, **Export
   GeoJSON** (boundary + colored parcels), **Export CSV** allocation summary.

## Project layout

- `lib/landuse.ts` — categories, colors, defaults
- `lib/calc.ts` — area, slider rebalancing, comparisons, derived metrics, buffer conflicts
- `lib/storage.ts` — localStorage + JSON/GeoJSON/CSV import/export
- `components/MapView.tsx` — MapLibre + Terra Draw integration
- `components/PlannerApp.tsx` — dashboard UI and state
