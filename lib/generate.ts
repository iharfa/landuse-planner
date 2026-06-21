// Automatic town-plan generator (district → block → plot).
//
// Instead of one rigid grid, the boundary is divided into several DISTRICTS,
// each with its own grid ORIENTATION. Whole districts are zoned to the major
// uses (commercial core, industrial estate, parks); civic / utilities /
// reserved are scattered as individual blocks inside residential
// neighbourhoods. Plot widths vary slightly so lots aren't identical. The
// result reads more like a planned town than a stamped grid.
//
// Output is a flat Parcel[] that feeds the existing comparison / metrics /
// export pipeline. Re-running Generate produces a fresh variation.

import * as turf from "@turf/turf";
import type { Feature, Polygon, Position } from "geojson";
import { LandUseKey } from "./landuse";
import { GeneratorOptions, Parcel, PlanningParameters } from "./types";

export const SQFT_TO_SQM = 0.09290304;
export const SQM_TO_SQFT = 1 / SQFT_TO_SQM;
export const FT_TO_M = 0.3048;

const PLOT_ZONES: LandUseKey[] = [
  "residential",
  "commercial",
  "civic",
  "industrial",
  "utilities",
  "reserved",
];
// uses that look right as a whole district
const DISTRICT_USES: LandUseKey[] = ["commercial", "industrial"];
// uses scattered as individual blocks within residential neighbourhoods
const BLOCK_USES: LandUseKey[] = ["civic", "utilities", "reserved"];

const ANGLE_CHOICES_DEG = [-30, -20, -12, 0, 0, 12, 22, 32];

export interface GenerateResult {
  parcels: Parcel[];
  stats: {
    plots: number;
    districts: number;
    roadAreaSqm: number;
    plotAreaSqm: number;
    avgResidentialSqft: number;
    counts: Partial<Record<LandUseKey, number>>;
  };
}

export interface GenerateError {
  error: string;
}

// deterministic-per-call PRNG (varies each Generate)
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeProjection(lat0: number) {
  const mLat = 111320;
  const mLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    toM: ([lng, lat]: Position): [number, number] => [lng * mLng, lat * mLat],
    toLL: ([x, y]: [number, number]): [number, number] => [x / mLng, y / mLat],
  };
}

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1],
      xj = ring[j][0],
      yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
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

interface District {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  cx: number;
  cy: number;
  cos: number;
  sin: number;
  clip: Feature; // boundary ∩ rect
  areaSqm: number;
  use: LandUseKey;
}

export function generatePlan(
  boundary: Feature<Polygon>,
  opt: GeneratorOptions,
  params: PlanningParameters,
  percentages: Record<LandUseKey, number>
): GenerateResult | GenerateError {
  const rng = mulberry32(Math.floor(Math.random() * 2 ** 31) || 1);

  const lat0 = turf.centroid(boundary).geometry.coordinates[1];
  const proj = makeProjection(lat0);
  const ringM = boundary.geometry.coordinates[0].map((p) =>
    proj.toM(p as [number, number])
  );
  const xs = ringM.map((p) => p[0]);
  const ys = ringM.map((p) => p[1]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const boundaryAreaSqm = turf.area(boundary);

  const ratio = Math.max(opt.depthWidthRatio, 0.25);
  const minPlotArea = Math.max(opt.minPlotSqft, 0) * SQFT_TO_SQM;
  const refArea = Math.max(opt.targetPlotSqft, 100) * SQFT_TO_SQM;
  const refW = Math.sqrt(refArea / ratio);
  const refD = ratio * refW;
  const blockW = Math.max(opt.colsPerBlock, 1) * refW;
  const blockD = Math.max(opt.rowsPerBlock, 1) * refD;
  const roadW = Math.max(opt.roadLanes * opt.laneWidthFt * FT_TO_M, 2);
  const arterialW = roadW * 1.8;

  // ---- safety guard ----
  const smallestSqft = opt.perZone
    ? Math.min(
        ...PLOT_ZONES.map((z) => zoneSqft(opt, z)).filter((v) => v > 0),
        opt.targetPlotSqft
      )
    : opt.targetPlotSqft;
  const approxPlots =
    ((maxX - minX) * (maxY - minY)) / (Math.max(smallestSqft, 100) * SQFT_TO_SQM);
  if (approxPlots > 9000) {
    return {
      error: `That would create ~${Math.round(
        approxPlots
      ).toLocaleString()} plots. Increase plot size(s) to keep it under 9,000.`,
    };
  }

  // ---- lay out districts ----
  const span = Math.max(blockW, blockD) * 3;
  let nx = Math.min(5, Math.max(1, Math.round((maxX - minX) / span)));
  let ny = Math.min(5, Math.max(1, Math.round((maxY - minY) / span)));
  while (nx * ny > 12) nx >= ny ? nx-- : ny--;
  const cellW = (maxX - minX) / nx;
  const cellH = (maxY - minY) / ny;

  const districts: District[] = [];
  const arterials: Feature<Polygon>[] = [];

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const dx0 = minX + i * cellW + (i > 0 ? arterialW / 2 : 0);
      const dx1 = minX + (i + 1) * cellW - (i < nx - 1 ? arterialW / 2 : 0);
      const dy0 = minY + j * cellH + (j > 0 ? arterialW / 2 : 0);
      const dy1 = minY + (j + 1) * cellH - (j < ny - 1 ? arterialW / 2 : 0);
      if (dx1 - dx0 < refW || dy1 - dy0 < refD) continue;

      const rectLL: Position[] = [
        [dx0, dy0],
        [dx1, dy0],
        [dx1, dy1],
        [dx0, dy1],
        [dx0, dy0],
      ].map((c) => proj.toLL(c as [number, number]));
      let clip: any = null;
      try {
        clip = turf.intersect(
          turf.featureCollection([turf.polygon([rectLL]), boundary]) as any
        );
      } catch {
        clip = null;
      }
      if (!clip) continue;
      const areaSqm = turf.area(clip);
      if (areaSqm < refArea) continue;

      const deg =
        ANGLE_CHOICES_DEG[Math.floor(rng() * ANGLE_CHOICES_DEG.length)] +
        (rng() - 0.5) * 8;
      const ang = (deg * Math.PI) / 180;
      districts.push({
        x0: dx0,
        x1: dx1,
        y0: dy0,
        y1: dy1,
        cx: (dx0 + dx1) / 2,
        cy: (dy0 + dy1) / 2,
        cos: Math.cos(ang),
        sin: Math.sin(ang),
        clip,
        areaSqm,
        use: "residential",
      });
    }
  }
  if (!districts.length) return { error: "Boundary too small to plan." };

  // arterial corridors between district columns / rows
  for (let i = 1; i < nx; i++) {
    const x = minX + i * cellW;
    arterials.push(
      turf.polygon([
        [
          [x - arterialW / 2, minY],
          [x + arterialW / 2, minY],
          [x + arterialW / 2, maxY],
          [x - arterialW / 2, maxY],
          [x - arterialW / 2, minY],
        ].map((p) => proj.toLL(p as [number, number])),
      ])
    );
  }
  for (let j = 1; j < ny; j++) {
    const y = minY + j * cellH;
    arterials.push(
      turf.polygon([
        [
          [minX, y - arterialW / 2],
          [maxX, y - arterialW / 2],
          [maxX, y + arterialW / 2],
          [minX, y + arterialW / 2],
          [minX, y - arterialW / 2],
        ].map((p) => proj.toLL(p as [number, number])),
      ])
    );
  }

  const totalDistArea = districts.reduce((s, d) => s + d.areaSqm, 0);
  const avgArea = totalDistArea / districts.length;

  // ---- zone districts ----
  let greenTarget: number;
  if (opt.greenFromParams) {
    const resShare = Math.min(
      Math.max((percentages.residential || 35) / 100, 0),
      1
    );
    const estUnits =
      params.avgUnitSizeSqm > 0
        ? (totalDistArea * resShare * params.residentialFAR) /
          params.avgUnitSizeSqm
        : 0;
    greenTarget = Math.min(
      estUnits * params.avgHouseholdSize * params.greenSqmPerPersonTarget,
      totalDistArea * 0.4
    );
  } else {
    greenTarget = (totalDistArea * (percentages.green || 0)) / 100;
  }

  const taken = new Array<boolean>(districts.length).fill(false);

  const greenCount = Math.min(
    districts.length,
    Math.round(greenTarget / (avgArea || 1))
  );
  if (greenCount > 0) {
    const step = Math.max(1, Math.floor(districts.length / greenCount));
    let placed = 0;
    for (let i = 0; i < districts.length && placed < greenCount; i += step) {
      districts[i].use = "green";
      taken[i] = true;
      placed++;
    }
  }

  const byArea = districts
    .map((_, i) => i)
    .sort((a, b) => districts[b].areaSqm - districts[a].areaSqm);
  const districtAssigned: Partial<Record<LandUseKey, number>> = {};
  for (const u of DISTRICT_USES) {
    const target = (totalDistArea * (percentages[u] || 0)) / 100;
    let acc = 0;
    for (const di of byArea) {
      if (acc >= target) break;
      if (taken[di]) continue;
      districts[di].use = u;
      taken[di] = true;
      acc += districts[di].areaSqm;
    }
    districtAssigned[u] = acc;
  }

  const blockRemaining: Partial<Record<LandUseKey, number>> = {};
  BLOCK_USES.forEach((u) => {
    blockRemaining[u] = (totalDistArea * (percentages[u] || 0)) / 100;
  });
  DISTRICT_USES.forEach((u) => {
    const unmet =
      (totalDistArea * (percentages[u] || 0)) / 100 -
      (districtAssigned[u] || 0);
    if (unmet > 0) blockRemaining[u] = unmet;
  });

  // ---- build parcels ----
  const parcels: Parcel[] = [];
  const counts: Partial<Record<LandUseKey, number>> = {};
  let idx = 0;
  let plotCount = 0;
  let resArea = 0;
  let resCount = 0;
  const roadParcelRefs: { areaSqm: number; ref: Parcel }[] = [];

  const push = (u: LandUseKey, geometry: Polygon, areaSqm: number) => {
    counts[u] = (counts[u] || 0) + 1;
    parcels.push({
      id: `gen_${idx++}_${Math.round(rng() * 1e6).toString(36)}`,
      landUse: u,
      notes: PLOT_ZONES.includes(u)
        ? `${Math.round(areaSqm * SQM_TO_SQFT).toLocaleString()} sq ft`
        : "park",
      areaSqm,
      geometry,
      generated: true,
    });
  };

  for (const d of districts) {
    const { cx, cy, cos, sin, x0, x1, y0, y1 } = d;
    const toWorld = (u: number, v: number): [number, number] => [
      cx + u * cos - v * sin,
      cy + u * sin + v * cos,
    ];
    const toLocal = (x: number, y: number): [number, number] => [
      (x - cx) * cos + (y - cy) * sin,
      -(x - cx) * sin + (y - cy) * cos,
    ];
    const inRect = (x: number, y: number) =>
      x >= x0 && x <= x1 && y >= y0 && y <= y1;

    if (d.use === "green") {
      const pieces: { geometry: Polygon; areaSqm: number }[] = [];
      collectPolys(d.clip.geometry, minPlotArea, pieces);
      pieces.forEach((p) => push("green", p.geometry, p.areaSqm));
      continue;
    }

    // local-frame extent of the rect
    const corners = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].map(([x, y]) => toLocal(x, y));
    const us = corners.map((c) => c[0]);
    const vs = corners.map((c) => c[1]);
    const uMin = Math.min(...us),
      uMax = Math.max(...us),
      vMin = Math.min(...vs),
      vMax = Math.max(...vs);

    const stepU = blockW + roadW;
    const stepV = blockD + roadW;

    // blocks
    for (let cu = uMin; cu < uMax; cu += stepU) {
      const bu1 = cu + blockW;
      for (let cv = vMin; cv < vMax; cv += stepV) {
        const bv1 = cv + blockD;
        const bc: [number, number][] = [
          toWorld(cu, cv),
          toWorld(bu1, cv),
          toWorld(bu1, bv1),
          toWorld(cu, bv1),
        ];
        // cheap reject: block centre outside rect∩boundary and no corner in
        const ctr = toWorld((cu + bu1) / 2, (cv + bv1) / 2);
        const anyIn =
          inRect(ctr[0], ctr[1]) && pointInRing(ctr[0], ctr[1], ringM);
        const cornersIn = bc.filter(
          (c) => inRect(c[0], c[1]) && pointInRing(c[0], c[1], ringM)
        ).length;
        if (!anyIn && cornersIn === 0) continue;
        const blockInBoundary =
          bc.every((c) => pointInRing(c[0], c[1], ringM)) &&
          bc.every((c) => inRect(c[0], c[1]));

        // block use
        let bUse: LandUseKey = d.use;
        if (d.use === "residential") {
          const needing = (Object.keys(blockRemaining) as LandUseKey[]).filter(
            (k) => (blockRemaining[k] || 0) > 0
          );
          if (needing.length && rng() < 0.4) {
            needing.sort(
              (a, b) => (blockRemaining[b] || 0) - (blockRemaining[a] || 0)
            );
            bUse = needing[0];
          }
        }

        const zArea = zoneSqft(opt, bUse) * SQFT_TO_SQM;
        const zW = Math.sqrt(zArea / ratio);
        const zD = ratio * zW;

        let used = 0;
        for (let pu = cu; pu < bu1 - 1e-6; ) {
          const w = zW * (0.85 + rng() * 0.3);
          const qu1 = Math.min(pu + w, bu1);
          for (let pv = cv; pv < bv1 - 1e-6; ) {
            const qv1 = Math.min(pv + zD, bv1);
            const pcCtr = toWorld((pu + qu1) / 2, (pv + qv1) / 2);
            if (inRect(pcCtr[0], pcCtr[1])) {
              const pc: [number, number][] = [
                toWorld(pu, pv),
                toWorld(qu1, pv),
                toWorld(qu1, qv1),
                toWorld(pu, qv1),
              ];
              const ringLL: Position[] = [...pc, pc[0]].map((c) => proj.toLL(c));
              if (blockInBoundary) {
                const area = (qu1 - pu) * (qv1 - pv);
                if (area >= minPlotArea) {
                  push(bUse, { type: "Polygon", coordinates: [ringLL] }, area);
                  plotCount++;
                  used += area;
                  if (bUse === "residential") {
                    resArea += area;
                    resCount++;
                  }
                }
              } else if (pointInRing(pcCtr[0], pcCtr[1], ringM)) {
                // coastal: clip to district∩boundary
                let clipped: any = null;
                try {
                  clipped = turf.intersect(
                    turf.featureCollection([
                      turf.polygon([ringLL]),
                      d.clip,
                    ]) as any
                  );
                } catch {
                  clipped = null;
                }
                const pieces: { geometry: Polygon; areaSqm: number }[] = [];
                if (clipped) collectPolys(clipped.geometry, minPlotArea, pieces);
                pieces.forEach((p) => {
                  push(bUse, p.geometry, p.areaSqm);
                  plotCount++;
                  used += p.areaSqm;
                  if (bUse === "residential") {
                    resArea += p.areaSqm;
                    resCount++;
                  }
                });
              }
            }
            pv = qv1;
          }
          pu = qu1;
        }
        if (bUse !== d.use && blockRemaining[bUse] !== undefined) {
          blockRemaining[bUse] = Math.max(0, blockRemaining[bUse]! - used);
        }
      }
    }

    // local roads: full-length strips clipped to district∩boundary
    const pushRoad = (rectLocal: [number, number][]) => {
      const ringLL: Position[] = [...rectLocal, rectLocal[0]].map((c) =>
        proj.toLL(toWorld(c[0], c[1]))
      );
      let clipped: any = null;
      try {
        clipped = turf.intersect(
          turf.featureCollection([turf.polygon([ringLL]), d.clip]) as any
        );
      } catch {
        clipped = null;
      }
      const pieces: { geometry: Polygon; areaSqm: number }[] = [];
      if (clipped) collectPolys(clipped.geometry, 1, pieces);
      pieces.forEach((p) => {
        const parcel: Parcel = {
          id: `road_${idx++}_${Math.round(rng() * 1e6).toString(36)}`,
          landUse: "roads",
          notes: `${opt.roadLanes}-lane`,
          areaSqm: p.areaSqm,
          geometry: p.geometry,
          generated: true,
        };
        parcels.push(parcel);
        counts.roads = (counts.roads || 0) + 1;
        roadParcelRefs.push({ areaSqm: p.areaSqm, ref: parcel });
      });
    };
    for (let cu = uMin; cu < uMax; cu += stepU) {
      const r0 = cu + blockW;
      pushRoad([
        [r0, vMin],
        [r0 + roadW, vMin],
        [r0 + roadW, vMax],
        [r0, vMax],
      ]);
    }
    for (let cv = vMin; cv < vMax; cv += stepV) {
      const r0 = cv + blockD;
      pushRoad([
        [uMin, r0],
        [uMax, r0],
        [uMax, r0 + roadW],
        [uMin, r0 + roadW],
      ]);
    }
  }

  // arterials clipped to boundary
  arterials.forEach((a) => {
    let clipped: any = null;
    try {
      clipped = turf.intersect(turf.featureCollection([a, boundary]) as any);
    } catch {
      clipped = null;
    }
    const pieces: { geometry: Polygon; areaSqm: number }[] = [];
    if (clipped) collectPolys(clipped.geometry, 1, pieces);
    pieces.forEach((p) => {
      const parcel: Parcel = {
        id: `art_${idx++}_${Math.round(rng() * 1e6).toString(36)}`,
        landUse: "roads",
        notes: "arterial",
        areaSqm: p.areaSqm,
        geometry: p.geometry,
        generated: true,
      };
      parcels.push(parcel);
      counts.roads = (counts.roads || 0) + 1;
      roadParcelRefs.push({ areaSqm: p.areaSqm, ref: parcel });
    });
  });

  // Road strips overlap at intersections, so their summed area over-counts.
  // Rescale road parcel areas to the true road area = boundary − everything
  // else, keeping geometry for rendering but accurate areas for the stats.
  const nonRoadArea = parcels
    .filter((p) => p.landUse !== "roads")
    .reduce((s, p) => s + p.areaSqm, 0);
  const trueRoadArea = Math.max(0, boundaryAreaSqm - nonRoadArea);
  const rawRoadArea = roadParcelRefs.reduce((s, r) => s + r.areaSqm, 0);
  if (rawRoadArea > 0) {
    const scale = trueRoadArea / rawRoadArea;
    roadParcelRefs.forEach((r) => (r.ref.areaSqm = r.areaSqm * scale));
  }

  const plotAreaSqm = parcels
    .filter((p) => p.landUse !== "roads")
    .reduce((s, p) => s + p.areaSqm, 0);

  return {
    parcels,
    stats: {
      plots: plotCount,
      districts: districts.length,
      roadAreaSqm: trueRoadArea,
      plotAreaSqm,
      avgResidentialSqft: resCount ? (resArea / resCount) * SQM_TO_SQFT : 0,
      counts,
    },
  };
}
