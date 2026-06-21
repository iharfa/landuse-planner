// Automatic plot-subdivision engine.
//
// Given a planning boundary, lay a configurable road grid, subdivide the
// resulting blocks into plots of a target size, size green space from the
// planning parameters, and assign the remaining plots to the other land uses
// per the allocation percentages. Output is a flat Parcel[] that feeds the
// existing comparison / metrics / export pipeline.

import * as turf from "@turf/turf";
import type { Feature, Polygon, Position } from "geojson";
import { LandUseKey } from "./landuse";
import { GeneratorOptions, Parcel, PlanningParameters } from "./types";

export const SQFT_TO_SQM = 0.09290304;
export const SQM_TO_SQFT = 1 / SQFT_TO_SQM;
export const FT_TO_M = 0.3048;

export interface GenerateResult {
  parcels: Parcel[];
  stats: {
    plots: number;
    roadAreaSqm: number;
    plotAreaSqm: number;
    avgPlotSqft: number;
    counts: Partial<Record<LandUseKey, number>>;
  };
}

export interface GenerateError {
  error: string;
}

// ---- simple local equirectangular projection (lng/lat <-> metres) ----
function makeProjection(lat0: number) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    toM: ([lng, lat]: Position): [number, number] => [
      lng * mPerDegLng,
      lat * mPerDegLat,
    ],
    toLL: ([x, y]: [number, number]): [number, number] => [
      x / mPerDegLng,
      y / mPerDegLat,
    ],
  };
}

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

interface Strip {
  a: number;
  b: number;
  road: boolean;
}

// Build 1-D strips: plot, plot, … then a road every `perBlock` plots.
function buildStrips(
  min: number,
  max: number,
  plot: number,
  road: number,
  perBlock: number
): Strip[] {
  const strips: Strip[] = [];
  let pos = min;
  let count = 0;
  let guard = 0;
  while (pos < max && guard++ < 100000) {
    const b = Math.min(pos + plot, max);
    strips.push({ a: pos, b, road: false });
    pos = b;
    count++;
    if (pos >= max) break;
    if (count % perBlock === 0) {
      const rb = Math.min(pos + road, max);
      strips.push({ a: pos, b: rb, road: true });
      pos = rb;
    }
  }
  return strips;
}

function newId(prefix: string, i: number) {
  return `${prefix}_${i}_${Math.random().toString(36).slice(2, 7)}`;
}

// Push every Polygon ring of a (possibly Multi)Polygon geometry as a parcel.
function collectPolys(
  geom: any,
  minAreaSqm: number,
  sink: { geometry: Polygon; areaSqm: number }[]
) {
  if (!geom) return;
  const polys: Position[][][] =
    geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
  polys.forEach((rings) => {
    const g: Polygon = { type: "Polygon", coordinates: rings };
    const area = turf.area(g as any);
    if (area >= minAreaSqm) sink.push({ geometry: g, areaSqm: area });
  });
}

export function generatePlan(
  boundary: Feature<Polygon>,
  opt: GeneratorOptions,
  params: PlanningParameters,
  percentages: Record<LandUseKey, number>
): GenerateResult | GenerateError {
  const lat0 = turf.centroid(boundary).geometry.coordinates[1];
  const proj = makeProjection(lat0);
  const ringLL = boundary.geometry.coordinates[0];
  const ringM = ringLL.map((p) => proj.toM(p as [number, number]));
  const xs = ringM.map((p) => p[0]);
  const ys = ringM.map((p) => p[1]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);

  const plotAreaSqm = Math.max(opt.targetPlotSqft, 100) * SQFT_TO_SQM;
  const ratio = Math.max(opt.depthWidthRatio, 0.25);
  const W = Math.sqrt(plotAreaSqm / ratio); // frontage width (m)
  const D = ratio * W; // depth (m)
  const roadW = Math.max(opt.roadLanes * opt.laneWidthFt * FT_TO_M, 2);

  // safety guard against runaway grids
  const approxPlots =
    (Math.ceil((maxX - minX) / W) || 0) * (Math.ceil((maxY - minY) / D) || 0);
  if (approxPlots > 6000) {
    return {
      error: `That plot size would create ~${approxPlots.toLocaleString()} cells. Increase the target plot size to keep it under 6,000.`,
    };
  }

  const colStrips = buildStrips(minX, maxX, W, roadW, opt.colsPerBlock);
  const rowStrips = buildStrips(minY, maxY, D, roadW, opt.rowsPerBlock);

  const minPlotArea = Math.max(opt.minPlotSqft, 0) * SQFT_TO_SQM;
  const fullPlotArea = W * D;

  const plots: { geometry: Polygon; areaSqm: number }[] = [];

  for (const cs of colStrips) {
    for (const rs of rowStrips) {
      if (cs.road || rs.road) continue; // roads handled as merged strips below
      const corners: [number, number][] = [
        [cs.a, rs.a],
        [cs.b, rs.a],
        [cs.b, rs.b],
        [cs.a, rs.b],
      ];
      const nIn = corners.filter((c) => pointInRing(c[0], c[1], ringM)).length;
      if (nIn === 0) continue;

      if (nIn === 4) {
        const ringPoly: Position[] = [...corners, corners[0]].map((c) =>
          proj.toLL(c)
        );
        plots.push({
          geometry: { type: "Polygon", coordinates: [ringPoly] },
          areaSqm: fullPlotArea,
        });
      } else {
        // edge plot: clip against the boundary
        const rectLL: Position[] = [...corners, corners[0]].map((c) =>
          proj.toLL(c)
        );
        const rect = turf.polygon([rectLL]);
        let clipped: any = null;
        try {
          clipped = turf.intersect(
            turf.featureCollection([rect, boundary]) as any
          );
        } catch {
          clipped = null;
        }
        if (clipped) collectPolys(clipped.geometry, minPlotArea, plots);
      }
    }
  }

  // ---- roads: full-length strips, unioned, clipped to boundary ----
  const roadRects: Feature<Polygon>[] = [];
  colStrips
    .filter((c) => c.road)
    .forEach((c) => {
      const r: [number, number][] = [
        [c.a, minY],
        [c.b, minY],
        [c.b, maxY],
        [c.a, maxY],
        [c.a, minY],
      ];
      roadRects.push(turf.polygon([r.map((p) => proj.toLL(p))]));
    });
  rowStrips
    .filter((r) => r.road)
    .forEach((r) => {
      const rr: [number, number][] = [
        [minX, r.a],
        [maxX, r.a],
        [maxX, r.b],
        [minX, r.b],
        [minX, r.a],
      ];
      roadRects.push(turf.polygon([rr.map((p) => proj.toLL(p))]));
    });

  const roadParcels: { geometry: Polygon; areaSqm: number }[] = [];
  if (roadRects.length) {
    let merged: any = roadRects[0];
    for (let i = 1; i < roadRects.length; i++) {
      try {
        merged = turf.union(
          turf.featureCollection([merged, roadRects[i]]) as any
        );
      } catch {
        /* keep previous */
      }
    }
    let roadClip: any = null;
    try {
      roadClip = turf.intersect(
        turf.featureCollection([merged, boundary]) as any
      );
    } catch {
      roadClip = null;
    }
    if (roadClip) collectPolys(roadClip.geometry, 1, roadParcels);
  }

  const roadAreaSqm = roadParcels.reduce((s, r) => s + r.areaSqm, 0);
  const totalPlotArea = plots.reduce((s, p) => s + p.areaSqm, 0);

  // ---- land-use assignment over the plots ----
  // green: from parameters (per-person target) or from the green slider
  let greenTarget: number;
  if (opt.greenFromParams) {
    // estimate population from the residential SHARE of the plots (not all
    // plots), so green tracks the per-person target sensibly
    const resShare = Math.min(Math.max((percentages.residential || 35) / 100, 0), 1);
    const estResArea = totalPlotArea * resShare;
    const estUnits =
      params.avgUnitSizeSqm > 0
        ? (estResArea * params.residentialFAR) / params.avgUnitSizeSqm
        : 0;
    const estPop = estUnits * params.avgHouseholdSize;
    greenTarget = Math.min(
      estPop * params.greenSqmPerPersonTarget,
      totalPlotArea * 0.4 // safety cap
    );
  } else {
    greenTarget = (totalPlotArea * (percentages.green || 0)) / 100;
  }

  const otherUses: LandUseKey[] = [
    "commercial",
    "civic",
    "industrial",
    "utilities",
    "reserved",
  ];

  const N = plots.length;
  const use = new Array<LandUseKey>(N).fill("residential");
  const taken = new Array<boolean>(N).fill(false);

  // green — scattered evenly across the grid
  const greenCount = Math.min(
    N,
    Math.round(greenTarget / (fullPlotArea || 1))
  );
  if (greenCount > 0) {
    const step = Math.max(1, Math.floor(N / greenCount));
    let placed = 0;
    for (let i = 0; i < N && placed < greenCount; i += step) {
      use[i] = "green";
      taken[i] = true;
      placed++;
    }
  }

  // other uses — contiguous runs from the front of the unused plots
  let cursor = 0;
  const counts: Partial<Record<LandUseKey, number>> = {};
  for (const u of otherUses) {
    const target = (totalPlotArea * (percentages[u] || 0)) / 100;
    let acc = 0;
    while (cursor < N && acc < target) {
      if (!taken[cursor]) {
        use[cursor] = u;
        taken[cursor] = true;
        acc += plots[cursor].areaSqm;
        counts[u] = (counts[u] || 0) + 1;
      }
      cursor++;
    }
  }

  // ---- build parcels ----
  const parcels: Parcel[] = [];
  plots.forEach((p, i) => {
    const u = use[i];
    counts[u] = u === "green" || otherUses.includes(u) ? counts[u] : undefined;
    parcels.push({
      id: newId("gen", i),
      landUse: u,
      notes:
        u === "residential" || u === "green"
          ? `${Math.round(p.areaSqm * SQM_TO_SQFT).toLocaleString()} sq ft`
          : "",
      areaSqm: p.areaSqm,
      geometry: p.geometry,
      generated: true,
    });
  });
  counts.residential = use.filter((u) => u === "residential").length;
  counts.green = use.filter((u) => u === "green").length;

  roadParcels.forEach((r, i) => {
    parcels.push({
      id: newId("road", i),
      landUse: "roads",
      notes: `${opt.roadLanes}-lane`,
      areaSqm: r.areaSqm,
      geometry: r.geometry,
      generated: true,
    });
  });

  return {
    parcels,
    stats: {
      plots: N,
      roadAreaSqm,
      plotAreaSqm: totalPlotArea,
      avgPlotSqft: N ? (totalPlotArea / N) * SQM_TO_SQFT : 0,
      counts,
    },
  };
}
