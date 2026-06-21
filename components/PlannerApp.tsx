"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import MapView, { MapViewHandle } from "./MapView";
import Tutorial, { hasSeenTutorial } from "./Tutorial";
import {
  CATEGORY_MAP,
  DEFAULT_PERCENTAGES,
  LAND_USE_CATEGORIES,
  LandUseKey,
} from "@/lib/landuse";
import {
  DEFAULT_PARAMETERS,
  Parcel,
  PlanningParameters,
  ProjectState,
} from "@/lib/types";
import {
  compareCategories,
  deriveMetrics,
  formatArea,
  industrialBufferConflicts,
  polygonAreaSqm,
  rebalancePercentages,
} from "@/lib/calc";
import {
  exportCSVSummary,
  exportGeoJSON,
  exportProjectJSON,
  loadFromLocalStorage,
  saveToLocalStorage,
} from "@/lib/storage";

type Mode = "idle" | "boundary" | "parcel";

function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default function PlannerApp() {
  const mapRef = useRef<MapViewHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [islands, setIslands] = useState<FeatureCollection | null>(null);
  const [selectedIslandId, setSelectedIslandId] = useState<string | null>(null);
  const [islandName, setIslandName] = useState<string | null>(null);

  const [boundary, setBoundary] = useState<Feature<Polygon> | null>(null);
  const [boundaryAreaSqm, setBoundaryAreaSqm] = useState(0);

  const [percentages, setPercentages] =
    useState<Record<LandUseKey, number>>(DEFAULT_PERCENTAGES);
  const [locked, setLocked] = useState<Record<LandUseKey, boolean>>(
    () =>
      LAND_USE_CATEGORIES.reduce(
        (a, c) => ((a[c.key] = false), a),
        {} as Record<LandUseKey, boolean>
      )
  );

  const [parcels, setParcels] = useState<Parcel[]>([]);
  const [parameters, setParameters] =
    useState<PlanningParameters>(DEFAULT_PARAMETERS);

  const [mode, setMode] = useState<Mode>("idle");
  const [pendingUse, setPendingUse] = useState<LandUseKey>("residential");
  const [selectedParcelId, setSelectedParcelId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showTutorial, setShowTutorial] = useState(false);

  // show the tutorial automatically on first visit
  useEffect(() => {
    if (!hasSeenTutorial()) setShowTutorial(true);
  }, []);

  // refs so the map's stable callback reads current values
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const pendingUseRef = useRef(pendingUse);
  pendingUseRef.current = pendingUse;

  // load islands geojson
  useEffect(() => {
    fetch("/islands.geojson")
      .then((r) => r.json())
      .then((fc: FeatureCollection) => setIslands(fc))
      .catch(() => flash("Failed to load islands.geojson"));
  }, []);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  function handleSelectIsland(id: string) {
    setSelectedIslandId(id);
    const f = islands?.features.find((x) => x.properties?.id === id) as
      | Feature<Polygon>
      | undefined;
    if (f) {
      setIslandName((f.properties?.name as string) ?? id);
      mapRef.current?.zoomToIsland(f);
    }
  }

  function handlePolygonDrawn(geom: Polygon) {
    if (modeRef.current === "boundary") {
      const feat: Feature<Polygon> = {
        type: "Feature",
        geometry: geom,
        properties: { type: "boundary" },
      };
      setBoundary(feat);
      setBoundaryAreaSqm(polygonAreaSqm(geom));
      setMode("idle");
      mapRef.current?.stopDraw();
      flash("Boundary set. Adjust sliders or draw parcels.");
    } else if (modeRef.current === "parcel") {
      const use = pendingUseRef.current;
      const parcel: Parcel = {
        id: newId("parcel"),
        landUse: use,
        notes: "",
        areaSqm: polygonAreaSqm(geom),
        geometry: geom,
      };
      setParcels((prev) => [...prev, parcel]);
      setSelectedParcelId(parcel.id);
      // stay in parcel mode for rapid drawing
      mapRef.current?.startDraw();
    }
  }

  function startBoundary() {
    setMode("boundary");
    mapRef.current?.startDraw();
    flash("Click to draw boundary; double-click / close to finish.");
  }
  function startParcel() {
    if (!boundary) return flash("Draw a planning boundary first.");
    setMode("parcel");
    mapRef.current?.startDraw();
    flash(`Drawing ${CATEGORY_MAP[pendingUse].label} parcels.`);
  }
  function stopDrawing() {
    setMode("idle");
    mapRef.current?.stopDraw();
  }

  function changePercentage(key: LandUseKey, value: number) {
    setPercentages((prev) => rebalancePercentages(prev, locked, key, value));
  }
  function toggleLock(key: LandUseKey) {
    setLocked((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function updateParcel(id: string, patch: Partial<Parcel>) {
    setParcels((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...patch } : p))
    );
  }
  function deleteParcel(id: string) {
    setParcels((prev) => prev.filter((p) => p.id !== id));
    if (selectedParcelId === id) setSelectedParcelId(null);
  }

  // ---- derived ----
  const comparisons = useMemo(
    () => compareCategories(boundaryAreaSqm, percentages, parcels),
    [boundaryAreaSqm, percentages, parcels]
  );
  const metrics = useMemo(
    () => deriveMetrics(boundaryAreaSqm, parcels, parameters),
    [boundaryAreaSqm, parcels, parameters]
  );
  const conflicts = useMemo(
    () => industrialBufferConflicts(parcels, parameters),
    [parcels, parameters]
  );
  const totalPct = useMemo(
    () =>
      Object.values(percentages).reduce((s, v) => s + v, 0),
    [percentages]
  );

  // ---- project persistence ----
  function buildState(): ProjectState {
    return {
      version: 1,
      islandId: selectedIslandId,
      islandName,
      boundary,
      boundaryAreaSqm,
      percentages,
      locked,
      parcels,
      parameters,
    };
  }
  function applyState(s: ProjectState) {
    setSelectedIslandId(s.islandId);
    setIslandName(s.islandName);
    setBoundary(s.boundary);
    setBoundaryAreaSqm(s.boundaryAreaSqm);
    setPercentages(s.percentages);
    setLocked(s.locked);
    setParcels(s.parcels);
    setParameters(s.parameters);
    if (s.boundary) mapRef.current?.zoomToIsland(s.boundary);
  }

  function doSave() {
    saveToLocalStorage(buildState());
    flash("Saved to browser storage.");
  }
  function doLoad() {
    const s = loadFromLocalStorage();
    if (s) {
      applyState(s);
      flash("Loaded from browser storage.");
    } else flash("No saved project found.");
  }
  function doImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyState(JSON.parse(String(reader.result)) as ProjectState);
        flash("Project imported.");
      } catch {
        flash("Invalid project file.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  const conflictParcelIds = new Set(
    conflicts.flatMap((c) => [c.industrialId, c.conflictingId])
  );

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-900">
      <MapView
        ref={mapRef}
        islands={islands}
        boundary={boundary}
        parcels={parcels}
        selectedIslandId={selectedIslandId}
        onPolygonDrawn={handlePolygonDrawn}
      />

      {/* ===== Left toolbar ===== */}
      <div className="absolute left-3 top-3 z-10 flex w-64 flex-col gap-3 rounded-xl bg-slate-900/90 p-3 text-sm shadow-xl ring-1 ring-white/10 backdrop-blur">
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold text-sky-300">
            🏝️ Land-Use Planner
          </div>
          <button
            onClick={() => setShowTutorial(true)}
            title="Show tutorial"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-800 text-xs ring-1 ring-white/10 hover:bg-slate-700"
          >
            ?
          </button>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-slate-400">Island</span>
          <select
            value={selectedIslandId ?? ""}
            onChange={(e) => handleSelectIsland(e.target.value)}
            className="w-full rounded bg-slate-800 px-2 py-1.5 ring-1 ring-white/10"
          >
            <option value="" disabled>
              Select an island…
            </option>
            {islands?.features.map((f) => (
              <option key={f.properties?.id} value={f.properties?.id}>
                {f.properties?.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-2">
          <button
            onClick={startBoundary}
            className={`rounded px-3 py-2 text-left font-medium ring-1 ring-white/10 ${
              mode === "boundary"
                ? "bg-yellow-500 text-slate-900"
                : "bg-slate-800 hover:bg-slate-700"
            }`}
          >
            ✏️ Draw Boundary
          </button>

          <div className="rounded bg-slate-800 p-2 ring-1 ring-white/10">
            <span className="mb-1 block text-xs text-slate-400">
              Parcel land-use
            </span>
            <select
              value={pendingUse}
              onChange={(e) => setPendingUse(e.target.value as LandUseKey)}
              className="mb-2 w-full rounded bg-slate-900 px-2 py-1.5 ring-1 ring-white/10"
            >
              {LAND_USE_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <button
              onClick={startParcel}
              className={`w-full rounded px-3 py-2 font-medium ring-1 ring-white/10 ${
                mode === "parcel"
                  ? "bg-sky-500 text-slate-900"
                  : "bg-slate-900 hover:bg-slate-700"
              }`}
            >
              ➕ Draw Parcels
            </button>
          </div>

          {mode !== "idle" && (
            <button
              onClick={stopDrawing}
              className="rounded bg-rose-600 px-3 py-2 font-medium hover:bg-rose-500"
            >
              ■ Stop Drawing
            </button>
          )}
        </div>

        <div className="border-t border-white/10 pt-2">
          <span className="mb-1 block text-xs text-slate-400">Project</span>
          <div className="grid grid-cols-2 gap-1.5 text-xs">
            <button onClick={doSave} className="rounded bg-slate-800 px-2 py-1.5 hover:bg-slate-700">💾 Save</button>
            <button onClick={doLoad} className="rounded bg-slate-800 px-2 py-1.5 hover:bg-slate-700">📂 Load</button>
            <button onClick={() => exportProjectJSON(buildState())} className="rounded bg-slate-800 px-2 py-1.5 hover:bg-slate-700">⬇ JSON</button>
            <button onClick={() => fileInputRef.current?.click()} className="rounded bg-slate-800 px-2 py-1.5 hover:bg-slate-700">⬆ JSON</button>
            <button onClick={() => exportGeoJSON(buildState())} className="rounded bg-slate-800 px-2 py-1.5 hover:bg-slate-700">⬇ GeoJSON</button>
            <button onClick={() => exportCSVSummary(buildState())} className="rounded bg-slate-800 px-2 py-1.5 hover:bg-slate-700">⬇ CSV</button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={doImport}
          />
        </div>

        {/* legend */}
        <div className="border-t border-white/10 pt-2">
          <span className="mb-1 block text-xs text-slate-400">Legend</span>
          <div className="grid grid-cols-2 gap-1 text-xs">
            {LAND_USE_CATEGORIES.map((c) => (
              <div key={c.key} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={{ background: c.color }}
                />
                <span className="truncate">{c.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ===== Right control panel ===== */}
      <div className="absolute right-3 top-3 z-10 flex max-h-[calc(100vh-7rem)] w-80 flex-col gap-3 overflow-y-auto rounded-xl bg-slate-900/90 p-3 text-sm shadow-xl ring-1 ring-white/10 backdrop-blur">
        {/* Allocation sliders */}
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-semibold text-sky-300">Land-Use Allocation</h2>
            <span
              className={`text-xs ${
                Math.round(totalPct) === 100 ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {totalPct.toFixed(1)}%
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {LAND_USE_CATEGORIES.map((c) => {
              const cmp = comparisons.find((x) => x.key === c.key)!;
              return (
                <div key={c.key} className="rounded bg-slate-800/60 p-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 shrink-0 rounded-sm"
                      style={{ background: c.color }}
                    />
                    <span className="flex-1 truncate">{c.label}</span>
                    <span className="w-12 text-right tabular-nums">
                      {percentages[c.key].toFixed(1)}%
                    </span>
                    <button
                      onClick={() => toggleLock(c.key)}
                      title="Lock / unlock"
                      className={`rounded px-1 ${
                        locked[c.key] ? "text-amber-400" : "text-slate-500"
                      }`}
                    >
                      {locked[c.key] ? "🔒" : "🔓"}
                    </button>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={0.5}
                    disabled={locked[c.key]}
                    value={percentages[c.key]}
                    onChange={(e) =>
                      changePercentage(c.key, parseFloat(e.target.value))
                    }
                    className="mt-1.5 w-full"
                  />
                  <div className="mt-1 flex justify-between text-[11px] text-slate-400">
                    <span>target {formatArea(cmp.targetSqm)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Parameters */}
        <section className="border-t border-white/10 pt-2">
          <h2 className="mb-2 font-semibold text-sky-300">Parameters</h2>
          <div className="flex flex-col gap-2 text-xs">
            <ParamRow label="Residential FAR" value={parameters.residentialFAR} step={0.1} onChange={(v) => setParameters((p) => ({ ...p, residentialFAR: v }))} />
            <ParamRow label="Avg unit size (m²)" value={parameters.avgUnitSizeSqm} step={5} onChange={(v) => setParameters((p) => ({ ...p, avgUnitSizeSqm: v }))} />
            <ParamRow label="Avg household size" value={parameters.avgHouseholdSize} step={0.1} onChange={(v) => setParameters((p) => ({ ...p, avgHouseholdSize: v }))} />
            <ParamRow label="Road width (m)" value={parameters.roadWidthM} step={0.5} onChange={(v) => setParameters((p) => ({ ...p, roadWidthM: v }))} />
            <ParamRow label="Green m²/person target" value={parameters.greenSqmPerPersonTarget} step={0.5} onChange={(v) => setParameters((p) => ({ ...p, greenSqmPerPersonTarget: v }))} />
            <ParamRow label="Industrial buffer (m)" value={parameters.industrialBufferM} step={5} onChange={(v) => setParameters((p) => ({ ...p, industrialBufferM: v }))} />
          </div>
        </section>

        {/* Derived metrics */}
        <section className="border-t border-white/10 pt-2">
          <h2 className="mb-2 font-semibold text-sky-300">Derived Metrics</h2>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
            <Metric label="Residential floor area" value={`${Math.round(metrics.residentialFloorAreaSqm).toLocaleString()} m²`} />
            <Metric label="Housing units" value={metrics.estimatedUnits.toLocaleString()} />
            <Metric label="Population" value={metrics.estimatedPopulation.toLocaleString()} />
            <Metric label="Road area" value={`${metrics.roadAreaPct.toFixed(1)} %`} />
            <Metric label="Green m²/person" value={metrics.greenSqmPerPerson.toFixed(1)} warn={!metrics.greenMeetsTarget} />
            <Metric label="Parcels" value={String(parcels.length)} />
          </dl>
          {!metrics.greenMeetsTarget && metrics.estimatedPopulation > 0 && (
            <p className="mt-1 text-[11px] text-amber-400">
              ⚠ Green space below {parameters.greenSqmPerPersonTarget} m²/person target.
            </p>
          )}
          {conflicts.length > 0 && (
            <div className="mt-2 rounded bg-rose-950/60 p-2 text-[11px] text-rose-300 ring-1 ring-rose-500/30">
              ⚠ {conflicts.length} industrial buffer conflict
              {conflicts.length > 1 ? "s" : ""} ({parameters.industrialBufferM} m):
              sensitive parcels too close to industrial land.
            </div>
          )}
        </section>

        {/* Parcels */}
        <section className="border-t border-white/10 pt-2">
          <h2 className="mb-2 font-semibold text-sky-300">
            Parcels ({parcels.length})
          </h2>
          <div className="flex flex-col gap-2">
            {parcels.length === 0 && (
              <p className="text-xs text-slate-400">
                No parcels yet. Pick a land-use and draw inside the boundary.
              </p>
            )}
            {parcels.map((p) => (
              <div
                key={p.id}
                className={`rounded bg-slate-800/60 p-2 ring-1 ${
                  conflictParcelIds.has(p.id)
                    ? "ring-rose-500/50"
                    : "ring-white/5"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 rounded-sm"
                    style={{ background: CATEGORY_MAP[p.landUse].color }}
                  />
                  <select
                    value={p.landUse}
                    onChange={(e) =>
                      updateParcel(p.id, {
                        landUse: e.target.value as LandUseKey,
                      })
                    }
                    className="flex-1 rounded bg-slate-900 px-1.5 py-1 text-xs ring-1 ring-white/10"
                  >
                    {LAND_USE_CATEGORIES.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => deleteParcel(p.id)}
                    className="text-rose-400 hover:text-rose-300"
                    title="Delete parcel"
                  >
                    🗑
                  </button>
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  {formatArea(p.areaSqm)}
                </div>
                <input
                  value={p.notes}
                  placeholder="notes…"
                  onChange={(e) => updateParcel(p.id, { notes: e.target.value })}
                  className="mt-1 w-full rounded bg-slate-900 px-1.5 py-1 text-xs ring-1 ring-white/10"
                />
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ===== Bottom summary bar ===== */}
      <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center gap-4 overflow-x-auto border-t border-white/10 bg-slate-900/95 px-4 py-2 text-xs backdrop-blur">
        <div className="shrink-0">
          <span className="text-slate-400">Island: </span>
          <span className="font-medium">{islandName ?? "—"}</span>
        </div>
        <div className="shrink-0">
          <span className="text-slate-400">Boundary: </span>
          <span className="font-medium">
            {boundary ? formatArea(boundaryAreaSqm) : "not drawn"}
          </span>
        </div>
        <div className="h-5 w-px shrink-0 bg-white/10" />
        {comparisons.map((c) => {
          const cat = CATEGORY_MAP[c.key];
          const ok = c.pctAchieved >= 95 && c.pctAchieved <= 105;
          return (
            <div key={c.key} className="flex shrink-0 items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: cat.color }}
              />
              <span className="text-slate-300">{cat.label}:</span>
              <span
                className={
                  c.drawnSqm === 0
                    ? "text-slate-500"
                    : ok
                    ? "text-emerald-400"
                    : c.diffSqm < 0
                    ? "text-amber-400"
                    : "text-sky-400"
                }
                title={`target ${Math.round(c.targetSqm).toLocaleString()} m² · drawn ${Math.round(
                  c.drawnSqm
                ).toLocaleString()} m²`}
              >
                {Math.round(c.drawnSqm).toLocaleString()}/
                {Math.round(c.targetSqm).toLocaleString()} m²
                {" "}
                ({c.pctAchieved.toFixed(0)}%
                {c.diffSqm < 0
                  ? `, ${Math.round(c.diffSqm).toLocaleString()}`
                  : c.diffSqm > 0
                  ? `, +${Math.round(c.diffSqm).toLocaleString()}`
                  : ""}
                )
              </span>
            </div>
          );
        })}
      </div>

      {toast && (
        <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-slate-800 px-4 py-1.5 text-xs shadow-lg ring-1 ring-white/10">
          {toast}
        </div>
      )}

      {showTutorial && <Tutorial onClose={() => setShowTutorial(false)} />}
    </div>
  );
}

function ParamRow({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-slate-300">{label}</span>
      <input
        type="number"
        step={step}
        min={0}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-20 rounded bg-slate-800 px-2 py-1 text-right ring-1 ring-white/10"
      />
    </label>
  );
}

function Metric({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex flex-col rounded bg-slate-800/60 px-2 py-1">
      <dt className="text-[10px] text-slate-400">{label}</dt>
      <dd className={`font-medium ${warn ? "text-amber-400" : ""}`}>{value}</dd>
    </div>
  );
}
