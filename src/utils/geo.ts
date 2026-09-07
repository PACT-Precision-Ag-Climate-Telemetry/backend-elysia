import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { SRID_WGS84, type GeoJsonPolygon } from "@/types/geo";

/**
 * PostGIS stores geometry as EWKB, so a plain `select` of a geometry column
 * returns an opaque hex string and a plain insert of GeoJSON fails. These two
 * helpers are the only supported way in or out.
 */

/** Wraps a GeoJSON polygon for insert/update: `.values({ area: toGeometry(x) })`. */
export function toGeometry(polygon: GeoJsonPolygon): SQL {
  return sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(polygon)}), ${SRID_WGS84})`;
}

/** Selects a geometry column as GeoJSON text: `.select({ area: fromGeometry(farmField.area) })`. */
export function fromGeometry(column: PgColumn): SQL<string> {
  return sql<string>`ST_AsGeoJSON(${column})`;
}

/**
 * Parses what fromGeometry selects. node-postgres hands back the ST_AsGeoJSON
 * text verbatim, so it still needs parsing into an object.
 */
export function parseGeoJsonPolygon(value: string | null): GeoJsonPolygon | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as GeoJsonPolygon;
}

/**
 * A GeoJSON polygon is only valid if every ring is closed — the last position
 * repeats the first — and has at least four positions. PostGIS rejects an
 * unclosed ring with a runtime error, so callers should check first and return
 * a 400 rather than a 500.
 */
export function isValidPolygon(polygon: GeoJsonPolygon): boolean {
  if (polygon.type !== "Polygon" || polygon.coordinates.length === 0) {
    return false;
  }

  return polygon.coordinates.every((ring) => {
    if (ring.length < 4) {
      return false;
    }

    const first = ring[0];
    const last = ring[ring.length - 1];

    return !!first && !!last && first[0] === last[0] && first[1] === last[1];
  });
}
