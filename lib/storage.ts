import type { FeatureCollection } from "geojson";
import { CATEGORY_MAP } from "./landuse";
import { compareCategories, formatArea } from "./calc";
import { ProjectState } from "./types";

const STORAGE_KEY = "land-use-planner-project-v1";

export function saveToLocalStorage(state: ProjectState): void {
  const payload = { ...state, savedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function loadFromLocalStorage(): ProjectState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProjectState;
  } catch {
    return null;
  }
}

export function hasSavedProject(): boolean {
  return !!localStorage.getItem(STORAGE_KEY);
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportProjectJSON(state: ProjectState): void {
  download(
    `landuse-project-${Date.now()}.json`,
    JSON.stringify(state, null, 2),
    "application/json"
  );
}

export function exportGeoJSON(state: ProjectState): void {
  const features: any[] = [];
  if (state.boundary) {
    features.push({
      ...state.boundary,
      properties: { ...(state.boundary.properties || {}), type: "boundary" },
    });
  }
  state.parcels.forEach((p) => {
    features.push({
      type: "Feature",
      geometry: p.geometry,
      properties: {
        type: "parcel",
        landUse: p.landUse,
        landUseLabel: CATEGORY_MAP[p.landUse]?.label,
        notes: p.notes,
        areaSqm: Math.round(p.areaSqm),
        color: CATEGORY_MAP[p.landUse]?.color,
      },
    });
  });
  const fc: FeatureCollection = { type: "FeatureCollection", features };
  download(
    `landuse-${Date.now()}.geojson`,
    JSON.stringify(fc, null, 2),
    "application/geo+json"
  );
}

export function exportCSVSummary(state: ProjectState): void {
  const rows: string[][] = [];
  rows.push([
    "Land Use",
    "Percentage (%)",
    "Target Area (m2)",
    "Drawn Area (m2)",
    "Surplus/Shortfall (m2)",
    "% Achieved",
  ]);
  const comparisons = compareCategories(
    state.boundaryAreaSqm,
    state.percentages,
    state.parcels
  );
  comparisons.forEach((c) => {
    rows.push([
      CATEGORY_MAP[c.key].label,
      state.percentages[c.key].toFixed(1),
      c.targetSqm.toFixed(0),
      c.drawnSqm.toFixed(0),
      c.diffSqm.toFixed(0),
      c.pctAchieved.toFixed(1),
    ]);
  });
  rows.push([]);
  rows.push(["Island", state.islandName || ""]);
  rows.push(["Boundary Area", formatArea(state.boundaryAreaSqm)]);
  rows.push(["Parcels Drawn", String(state.parcels.length)]);

  const csv = rows
    .map((r) =>
      r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
    )
    .join("\n");
  download(`landuse-summary-${Date.now()}.csv`, csv, "text/csv");
}
