import type { Feature, Polygon } from "geojson";
import type { LandUseKey } from "./landuse";

export interface Parcel {
  id: string;
  landUse: LandUseKey;
  notes: string;
  areaSqm: number;
  geometry: Polygon;
  generated?: boolean; // true when produced by the auto-plan generator
}

export interface GeneratorOptions {
  perZone: boolean; // false = one plot size for all zones; true = per-zone sizes
  targetPlotSqft: number; // uniform plot size & block-sizing reference
  zonePlotSqft: Record<LandUseKey, number>; // per-zone plot sizes (sq ft)
  minPlotSqft: number; // plots smaller than this (edge offcuts) are dropped
  depthWidthRatio: number; // plot depth / frontage width
  roadLanes: number; // lanes per road
  laneWidthFt: number; // width of a single lane
  colsPerBlock: number; // reference plots across a block (block width)
  rowsPerBlock: number; // reference plots deep in a block (block depth)
  greenFromParams: boolean; // size green space from green m²/person target
}

// sensible starting sizes by land use (sq ft)
export const DEFAULT_ZONE_PLOT_SQFT: Record<LandUseKey, number> = {
  residential: 2500,
  commercial: 6000,
  industrial: 12000,
  civic: 8000,
  utilities: 5000,
  reserved: 4000,
  roads: 0,
  green: 0,
};

export const DEFAULT_GENERATOR: GeneratorOptions = {
  perZone: false,
  targetPlotSqft: 2500,
  zonePlotSqft: { ...DEFAULT_ZONE_PLOT_SQFT },
  minPlotSqft: 1200,
  depthWidthRatio: 1.4,
  roadLanes: 2,
  laneWidthFt: 11,
  colsPerBlock: 8,
  rowsPerBlock: 2,
  greenFromParams: true,
};

export interface PlanningParameters {
  residentialFAR: number; // floor area ratio
  avgUnitSizeSqm: number; // average dwelling unit size
  avgHouseholdSize: number; // persons per household
  roadWidthM: number; // average road width (informational)
  greenSqmPerPersonTarget: number; // target green space per person
  industrialBufferM: number; // required buffer around industrial parcels
}

export const DEFAULT_PARAMETERS: PlanningParameters = {
  residentialFAR: 1.5,
  avgUnitSizeSqm: 90,
  avgHouseholdSize: 4.5,
  roadWidthM: 8,
  greenSqmPerPersonTarget: 9,
  industrialBufferM: 50,
};

export interface ProjectState {
  version: 1;
  islandId: string | null;
  islandName: string | null;
  boundary: Feature<Polygon> | null;
  boundaryAreaSqm: number;
  percentages: Record<LandUseKey, number>;
  locked: Record<LandUseKey, boolean>;
  parcels: Parcel[];
  parameters: PlanningParameters;
  generator?: GeneratorOptions;
  savedAt?: string;
}
