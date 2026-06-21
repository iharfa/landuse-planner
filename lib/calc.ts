import * as turf from "@turf/turf";
import type { Feature, Polygon } from "geojson";
import { LAND_USE_CATEGORIES, LandUseKey } from "./landuse";
import { Parcel, PlanningParameters } from "./types";

export function polygonAreaSqm(geom: Feature<Polygon> | Polygon): number {
  try {
    return turf.area(geom as any);
  } catch {
    return 0;
  }
}

export function formatArea(sqm: number): string {
  const ha = sqm / 10000;
  return `${sqm.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  })} m² · ${ha.toLocaleString(undefined, { maximumFractionDigits: 2 })} ha`;
}

/**
 * Rebalance percentages so they always sum to 100.
 * The changed key takes `newValue`; remaining UNLOCKED keys absorb the
 * difference proportionally to their current values. Locked keys are fixed.
 */
export function rebalancePercentages(
  current: Record<LandUseKey, number>,
  locked: Record<LandUseKey, boolean>,
  changedKey: LandUseKey,
  newValue: number
): Record<LandUseKey, number> {
  const keys = LAND_USE_CATEGORIES.map((c) => c.key);
  const lockedSum = keys
    .filter((k) => locked[k] && k !== changedKey)
    .reduce((s, k) => s + current[k], 0);

  // The changed slider can't exceed what's available outside locked sliders.
  const maxForChanged = Math.max(0, 100 - lockedSum);
  const clamped = Math.min(Math.max(newValue, 0), maxForChanged);

  const others = keys.filter(
    (k) => k !== changedKey && !locked[k]
  );
  const remaining = 100 - lockedSum - clamped; // to distribute among `others`

  const result = { ...current };
  result[changedKey] = clamped;

  const othersCurrentSum = others.reduce((s, k) => s + current[k], 0);

  if (others.length === 0) {
    // nothing to absorb the change; just set it
    return result;
  }

  if (othersCurrentSum <= 0) {
    // distribute evenly
    const each = remaining / others.length;
    others.forEach((k) => (result[k] = each));
  } else {
    others.forEach((k) => {
      result[k] = (current[k] / othersCurrentSum) * remaining;
    });
  }

  // round to 1 decimal, fix drift on the largest unlocked "other"
  others.forEach((k) => (result[k] = Math.round(result[k] * 10) / 10));
  result[changedKey] = Math.round(result[changedKey] * 10) / 10;

  const total = keys.reduce((s, k) => s + result[k], 0);
  const drift = Math.round((100 - total) * 10) / 10;
  if (drift !== 0 && others.length > 0) {
    const target = others.reduce((a, b) => (result[a] >= result[b] ? a : b));
    result[target] = Math.round((result[target] + drift) * 10) / 10;
  }

  return result;
}

export function targetAreas(
  boundaryAreaSqm: number,
  percentages: Record<LandUseKey, number>
): Record<LandUseKey, number> {
  const out = {} as Record<LandUseKey, number>;
  LAND_USE_CATEGORIES.forEach((c) => {
    out[c.key] = (boundaryAreaSqm * percentages[c.key]) / 100;
  });
  return out;
}

export function drawnAreasByCategory(
  parcels: Parcel[]
): Record<LandUseKey, number> {
  const out = {} as Record<LandUseKey, number>;
  LAND_USE_CATEGORIES.forEach((c) => (out[c.key] = 0));
  parcels.forEach((p) => {
    out[p.landUse] = (out[p.landUse] || 0) + p.areaSqm;
  });
  return out;
}

export interface CategoryComparison {
  key: LandUseKey;
  targetSqm: number;
  drawnSqm: number;
  diffSqm: number; // drawn - target (positive = surplus)
  pctAchieved: number; // drawn / target * 100
}

export function compareCategories(
  boundaryAreaSqm: number,
  percentages: Record<LandUseKey, number>,
  parcels: Parcel[]
): CategoryComparison[] {
  const targets = targetAreas(boundaryAreaSqm, percentages);
  const drawn = drawnAreasByCategory(parcels);
  return LAND_USE_CATEGORIES.map((c) => {
    const targetSqm = targets[c.key];
    const drawnSqm = drawn[c.key];
    return {
      key: c.key,
      targetSqm,
      drawnSqm,
      diffSqm: drawnSqm - targetSqm,
      pctAchieved: targetSqm > 0 ? (drawnSqm / targetSqm) * 100 : 0,
    };
  });
}

export interface DerivedMetrics {
  residentialAreaSqm: number;
  residentialFloorAreaSqm: number;
  estimatedUnits: number;
  estimatedPopulation: number;
  roadAreaSqm: number;
  roadAreaPct: number;
  greenAreaSqm: number;
  greenSqmPerPerson: number;
  greenMeetsTarget: boolean;
}

export function deriveMetrics(
  boundaryAreaSqm: number,
  parcels: Parcel[],
  params: PlanningParameters
): DerivedMetrics {
  const drawn = drawnAreasByCategory(parcels);
  const residentialAreaSqm = drawn.residential;
  const residentialFloorAreaSqm = residentialAreaSqm * params.residentialFAR;
  const estimatedUnits =
    params.avgUnitSizeSqm > 0
      ? Math.floor(residentialFloorAreaSqm / params.avgUnitSizeSqm)
      : 0;
  const estimatedPopulation = Math.round(
    estimatedUnits * params.avgHouseholdSize
  );
  const roadAreaSqm = drawn.roads;
  const roadAreaPct =
    boundaryAreaSqm > 0 ? (roadAreaSqm / boundaryAreaSqm) * 100 : 0;
  const greenAreaSqm = drawn.green;
  const greenSqmPerPerson =
    estimatedPopulation > 0 ? greenAreaSqm / estimatedPopulation : 0;

  return {
    residentialAreaSqm,
    residentialFloorAreaSqm,
    estimatedUnits,
    estimatedPopulation,
    roadAreaSqm,
    roadAreaPct,
    greenAreaSqm,
    greenSqmPerPerson,
    greenMeetsTarget:
      estimatedPopulation === 0 ||
      greenSqmPerPerson >= params.greenSqmPerPersonTarget,
  };
}

export interface BufferConflict {
  industrialId: string;
  conflictingId: string;
  conflictingUse: LandUseKey;
}

const SENSITIVE_USES: LandUseKey[] = ["residential", "civic", "green"];

/**
 * Buffer each industrial parcel by params.industrialBufferM and flag any
 * sensitive parcel (residential/civic/green) that intersects the buffer.
 */
export function industrialBufferConflicts(
  parcels: Parcel[],
  params: PlanningParameters
): BufferConflict[] {
  const conflicts: BufferConflict[] = [];
  const industrial = parcels.filter((p) => p.landUse === "industrial");
  const sensitive = parcels.filter((p) => SENSITIVE_USES.includes(p.landUse));

  industrial.forEach((ind) => {
    let buffered;
    try {
      buffered = turf.buffer(turf.feature(ind.geometry), params.industrialBufferM, {
        units: "meters",
      });
    } catch {
      return;
    }
    if (!buffered) return;
    sensitive.forEach((s) => {
      try {
        if (turf.booleanIntersects(buffered as any, turf.feature(s.geometry))) {
          conflicts.push({
            industrialId: ind.id,
            conflictingId: s.id,
            conflictingUse: s.landUse,
          });
        }
      } catch {
        /* ignore */
      }
    });
  });

  return conflicts;
}
