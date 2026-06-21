// Automatic plot-subdivision engine (block-then-subdivide model).
//
// 1. A configurable road grid carves the boundary into rectangular blocks.
// 2. Each block is zoned to a land use (green sized from parameters or the
//    Green slider; the rest split among the other uses per the allocation
//    sliders; remainder residential).
// 3. Each block is subdivided into plots at THAT zone's plot size — so plot
//    sizes can vary per zone. Green blocks are kept whole (parks).
//
// Output is a flat Parcel[] that feeds the existing comparison / metrics /
// export pipeline.

import * as turf from "@turf/turf";
import type { Feature, Polygon, Position } from "geojson";
import { LandUseKey } from "./landuse";
import { GeneratorOptions, Parcel, PlanningParameters } from "./types";

export const SQFT_TO_SQM = 0.09290304;
export const SQM_TO_SQFT = 1 / SQFT_TO_SQM;
export const FT_TO_M = 0.3048;

// land uses that get subdivided into plots (green = whole-block parks)
const PLOT_ZONES: LandUseKey[] = [
  "residential",
  "commercial",
  "civic",
  "industrial",
  "utilities",
  "reserved",
];
// order non-residential zones are filled in
const OTHER_ZONES: LandUseKey[] = [
  "commercial",
  "civic",
  "industrial",
  "utilities",
  "reserved",
];

export interface GenerateResult {
  parcels: Parcel[];
  stats: {
    plots: number;
    blocks: number;
    roadAreaSqm: number;
    plotAreaSqm: number;
    avgResidentialSqft: number;
    counts: Partial<Record<LandUseKey, number>>;
  };
}

export interface GenerateError {
  error: string;
}

// ---- local equirectangular projection (lng/lat <-> metres) ----
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
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

interface Strip {
  a: number;
  b: number;
  road: boolean;
}

// Tile [min,max] with cells of `size`, inserting a road of `road` after each.
function buildStrips(
  min: number,
  max: number,
  size: number,
  road: number
): Strip[] {
  const strips: Strip[] = [];
  let pos = min;
  let guard = 0;
  while (pos < max && guard++ < 100000) {
    const b = Math.min(pos + size, max);
    strips.push({ a: pos, b, road: false });
    pos = b;
    if (pos >= max) break;
    const rb = Math.min(pos + road, max);
    strips.push({ a: pos, b: rb, road: true });
    pos = rb;
  }
  return strips;
}

function newId(prefix: string, i: number) {
  return `${prefix}_${i}_${Math.random().toString(36).slice(2, 7)}`;
}

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

function zoneSqft(opt: GeneratorOptions, use: LandUseKey): number {
  if (opt.perZone) {
    const v = opt.zonePlotSqft?.[use];
    if (v && v > 0) return v;
  }
  return opt.targetPlotSqft;
}

interface Block {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  coastal: boolean;
  areaSqm: number;
  geoms: Polygon[]; // boundary-clipped pieces (coastal only)
}

export function generatePlan(
  boundary: Feature<Polygon>,
  opt: GeneratorOptions,
  params: PlanningParameters,
  percentages: Record<LandUseKey, number>
): GenerateResult | GenerateError {
  const lat0 = turf.centroid(boundary).geometry.coordinates[1];
  const proj = makeProjection(lat0);
  const ringM = boundary.geometry.coordinates[0].map((p) =>
    proj.toM(p as [number, number])
  );
  const xs = ringM.map((p) => p[0]);
  const ys = ringM.map((p) => p[1]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);

  const ratio = Math.max(opt.depthWidthRatio, 0.25);
  const minPlotArea = Math.max(opt.minPlotSqft, 0) * SQFT_TO_SQM;

  // block footprint, sized from the reference (uniform / residential) plot
  const refArea = Math.max(opt.targetPlotSqft, 100) * SQFT_TO_SQM;
  const refW = Math.sqrt(refArea / ratio);
  const refD = ratio * refW;
  const blockW = Math.max(opt.colsPerBlock, 1) * refW;
  const blockD = Math.max(opt.rowsPerBlock, 1) * refD;
  const roadW = Math.max(opt.roadLanes * opt.laneWidthFt * FT_TO_M, 2);

  // safety guard — estimate plots using the smallest active plot size
  const smallestSqft = opt.perZone
    ? Math.min(
        ...PLOT_ZONES.map((z) => zoneSqft(opt, z)).filter((v) => v > 0),
        opt.targetPlotSqft
      )
    : opt.targetPlotSqft;
  const bboxAreaSqm = (maxX - minX) * (maxY - minY);
  const approxPlots = bboxAreaSqm / (Math.max(smallestSqft, 100) * SQFT_TO_SQM);
  if (approxPlots > 8000) {
    return {
      error: `That would create ~${Math.round(
        approxPlots
      ).toLocaleString()} plots. Increase plot size(s) to keep it under 8,000.`,
    };
  }

  const colStrips = buildStrips(minX, maxX, blockW, roadW);
  const rowStrips = buildStrips(minY, maxY, blockD, roadW);

  // ---- build blocks (non-road cells) ----
  const blocks: Block[] = [];
  for (const cs of colStrips) {
    if (cs.road) continue;
    for (const rs of rowStrips) {
      if (rs.road) continue;
      const corners: [number, number][] = [
        [cs.a, rs.a],
        [cs.b, rs.a],
        [cs.b, rs.b],
        [cs.a, rs.b],
      ];
      const nIn = corners.filter((c) => pointInRing(c[0], c[1], ringM)).length;
      if (nIn === 0) continue;
      if (nIn === 4) {
        blocks.push({
          x0: cs.a,
          x1: cs.b,
          y0: rs.a,
          y1: rs.b,
          coastal: false,
          areaSqm: (cs.b - cs.a) * (rs.b - rs.a),
          geoms: [],
        });
      } else {
        const rectLL: Position[] = [...corners, corners[0]].map((c) =>
          proj.toLL(c)
        );
        let clipped: any = null;
        try {
          clipped = turf.intersect(
            turf.featureCollection([turf.polygon([rectLL]), boundary]) as any
          );
        } catch {
          clipped = null;
        }
        const pieces: { geometry: Polygon; areaSqm: number }[] = [];
        if (clipped) collectPolys(clipped.geometry, minPlotArea, pieces);
        if (!pieces.length) continue;
        blocks.push({
          x0: cs.a,
          x1: cs.b,
          y0: rs.a,
          y1: rs.b,
          coastal: true,
          areaSqm: pieces.reduce((s, p) => s + p.areaSqm, 0),
          geoms: pieces.map((p) => p.geometry),
        });
      }
    }
  }

  const totalBlockArea = blocks.reduce((s, b) => s + b.areaSqm, 0);
  const B = blocks.length;

  // ---- zone each block ----
  let greenTarget: number;
  if (opt.greenFromParams) {
    const resShare = Math.min(
      Math.max((percentages.residential || 35) / 100, 0),
      1
    );
    const estResArea = totalBlockArea * resShare;
    const estUnits =
      params.avgUnitSizeSqm > 0
        ? (estResArea * params.residentialFAR) / params.avgUnitSizeSqm
        : 0;
    const estPop = estUnits * params.avgHouseholdSize;
    greenTarget = Math.min(
      estPop * params.greenSqmPerPersonTarget,
      totalBlockArea * 0.4
    );
  } else {
    greenTarget = (totalBlockArea * (percentages.green || 0)) / 100;
  }

  const use = new Array<LandUseKey>(B).fill("residential");
  const taken = new Array<boolean>(B).fill(false);
  const avgBlockArea = B ? totalBlockArea / B : 1;

  // green — scattered evenly
  const greenCount = Math.min(B, Math.round(greenTarget / (avgBlockArea || 1)));
  if (greenCount > 0) {
    const step = Math.max(1, Math.floor(B / greenCount));
    let placed = 0;
    for (let i = 0; i < B && placed < greenCount; i += step) {
      use[i] = "green";
      taken[i] = true;
      placed++;
    }
  }

  // other zones — contiguous runs from the front of the unused blocks
  let cursor = 0;
  for (const u of OTHER_ZONES) {
    const target = (totalBlockArea * (percentages[u] || 0)) / 100;
    let acc = 0;
    while (cursor < B && acc < target) {
      if (!taken[cursor]) {
        use[cursor] = u;
        taken[cursor] = true;
        acc += blocks[cursor].areaSqm;
      }
      cursor++;
    }
  }

  // ---- subdivide blocks into plots ----
  const parcels: Parcel[] = [];
  const counts: Partial<Record<LandUseKey, number>> = {};
  let plotCount = 0;
  let residentialAreaTotal = 0;
  let residentialPlotCount = 0;
  let idx = 0;

  const pushParcel = (u: LandUseKey, geometry: Polygon, areaSqm: number) => {
    counts[u] = (counts[u] || 0) + 1;
    parcels.push({
      id: newId("gen", idx++),
      landUse: u,
      notes: PLOT_ZONES.includes(u)
        ? `${Math.round(areaSqm * SQM_TO_SQFT).toLocaleString()} sq ft`
        : "park",
      areaSqm,
      geometry,
      generated: true,
    });
  };

  blocks.forEach((blk, bi) => {
    const u = use[bi];

    if (u === "green") {
      // whole-block park
      if (blk.coastal) {
        blk.geoms.forEach((g) => pushParcel("green", g, turf.area(g as any)));
      } else {
        const ring: Position[] = [
          [blk.x0, blk.y0],
          [blk.x1, blk.y0],
          [blk.x1, blk.y1],
          [blk.x0, blk.y1],
          [blk.x0, blk.y0],
        ].map((c) => proj.toLL(c as [number, number]));
        pushParcel("green", { type: "Polygon", coordinates: [ring] }, blk.areaSqm);
      }
      return;
    }

    // subdivide at this zone's plot size
    const zArea = zoneSqft(opt, u) * SQFT_TO_SQM;
    const zW = Math.sqrt(zArea / ratio);
    const zD = ratio * zW;

    for (let px = blk.x0; px < blk.x1 - 1e-6; px += zW) {
      const qx1 = Math.min(px + zW, blk.x1);
      for (let py = blk.y0; py < blk.y1 - 1e-6; py += zD) {
        const qy1 = Math.min(py + zD, blk.y1);
        const corners: [number, number][] = [
          [px, py],
          [qx1, py],
          [qx1, qy1],
          [px, qy1],
        ];
        if (!blk.coastal) {
          const area = (qx1 - px) * (qy1 - py);
          if (area < minPlotArea) continue;
          const ring: Position[] = [...corners, corners[0]].map((c) =>
            proj.toLL(c)
          );
          pushParcel(u, { type: "Polygon", coordinates: [ring] }, area);
          plotCount++;
          if (u === "residential") {
            residentialAreaTotal += area;
            residentialPlotCount++;
          }
        } else {
          // clip sub-plot to boundary
          const rectLL: Position[] = [...corners, corners[0]].map((c) =>
            proj.toLL(c)
          );
          let clipped: any = null;
          try {
            clipped = turf.intersect(
              turf.featureCollection([
                turf.polygon([rectLL]),
                boundary,
              ]) as any
            );
          } catch {
            clipped = null;
          }
          const pieces: { geometry: Polygon; areaSqm: number }[] = [];
          if (clipped) collectPolys(clipped.geometry, minPlotArea, pieces);
          pieces.forEach((p) => {
            pushParcel(u, p.geometry, p.areaSqm);
            plotCount++;
            if (u === "residential") {
              residentialAreaTotal += p.areaSqm;
              residentialPlotCount++;
            }
          });
        }
      }
    }
  });

  // ---- roads: corridors between blocks, unioned & clipped ----
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
  roadParcels.forEach((r, i) => {
    counts.roads = (counts.roads || 0) + 1;
    parcels.push({
      id: newId("road", i),
      landUse: "roads",
      notes: `${opt.roadLanes}-lane`,
      areaSqm: r.areaSqm,
      geometry: r.geometry,
      generated: true,
    });
  });

  const roadAreaSqm = roadParcels.reduce((s, r) => s + r.areaSqm, 0);
  const plotAreaSqm = parcels
    .filter((p) => p.landUse !== "roads")
    .reduce((s, p) => s + p.areaSqm, 0);

  return {
    parcels,
    stats: {
      plots: plotCount,
      blocks: B,
      roadAreaSqm,
      plotAreaSqm,
      avgResidentialSqft: residentialPlotCount
        ? (residentialAreaTotal / residentialPlotCount) * SQM_TO_SQFT
        : 0,
      counts,
    },
  };
}
