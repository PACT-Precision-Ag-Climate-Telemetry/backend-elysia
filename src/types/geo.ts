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
