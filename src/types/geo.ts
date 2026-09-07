/** WGS 84 — the SRID GPS coordinates and GeoJSON are expressed in. */
export const SRID_WGS84 = 4326;

/** A `[longitude, latitude]` pair, in GeoJSON's x/y order. */
export type GeoJsonPosition = [number, number];

/**
 * A GeoJSON Polygon (RFC 7946). The first ring is the outer boundary, any
 * further rings are holes, and each ring must be closed — its last position
 * repeats its first.
 */
export interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: GeoJsonPosition[][];
}

/**
 * A GeoJSON MultiPolygon: several polygons treated as one area. This is what an
 * organization boundary is stored as, because joining adjacent administrative
 * areas can leave disjoint parts (an enclave, an island, a district split by a
 * river).
 */
export interface GeoJsonMultiPolygon {
  type: "MultiPolygon";
  coordinates: GeoJsonPosition[][][];
}

/** Either shape callers may supply for an area. */
export type GeoJsonArea = GeoJsonPolygon | GeoJsonMultiPolygon;

/**
 * Where an organization's boundary came from.
 *
 * - `reference`: traced from fixed administrative GeoJSON, optionally several
 *   features joined into one.
 * - `custom`: drawn by hand. Only a `field` organization may use this.
 */
export const AREA_SOURCES = ["reference", "custom"] as const;

export type AreaSource = (typeof AREA_SOURCES)[number];
