// Land-use category definitions: keys, labels, and map colors.

export type LandUseKey =
  | "residential"
  | "roads"
  | "green"
  | "commercial"
  | "industrial"
  | "civic"
  | "utilities"
  | "reserved";

export interface LandUseCategory {
  key: LandUseKey;
  label: string;
  color: string;
}

export const LAND_USE_CATEGORIES: LandUseCategory[] = [
  { key: "residential", label: "Residential", color: "#f59e0b" },
  { key: "roads", label: "Roads", color: "#6b7280" },
  { key: "green", label: "Green Space", color: "#22c55e" },
  { key: "commercial", label: "Commercial", color: "#3b82f6" },
  { key: "industrial", label: "Industrial", color: "#a855f7" },
  { key: "civic", label: "Civic", color: "#ef4444" },
  { key: "utilities", label: "Utilities", color: "#14b8a6" },
  { key: "reserved", label: "Reserved Land", color: "#92400e" },
];

export const CATEGORY_MAP: Record<LandUseKey, LandUseCategory> =
  LAND_USE_CATEGORIES.reduce((acc, c) => {
    acc[c.key] = c;
    return acc;
  }, {} as Record<LandUseKey, LandUseCategory>);

export const DEFAULT_PERCENTAGES: Record<LandUseKey, number> = {
  residential: 35,
  roads: 15,
  green: 20,
  commercial: 8,
  industrial: 5,
  civic: 7,
  utilities: 5,
  reserved: 5,
};
