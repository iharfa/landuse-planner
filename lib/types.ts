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
  targetPlotSqft: number; // desired residential plot size
  minPlotSqft: number; // plots smaller than this (edge offcuts) are dropped
  depthWidthRatio: number; // plot depth / frontage width
  roadLanes: number; // lanes per road
  laneWidthFt: number; // width of a single lane
  colsPerBlock: number; // plots between vertical (cross) roads
  rowsPerBlock: number; // plot rows between horizontal (access) roads
  greenFromParams: boolean; // size green space from green m²/person target
}

export const DEFAULT_GENERATOR: GeneratorOptions = {
  targetPlotSqft: 2500,
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
