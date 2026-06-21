import type { Feature, Polygon } from "geojson";
import type { LandUseKey } from "./landuse";

export interface Parcel {
  id: string;
  landUse: LandUseKey;
  notes: string;
  areaSqm: number;
  geometry: Polygon;
}

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
  savedAt?: string;
}
