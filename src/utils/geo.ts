import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  SRID_WGS84,
  type GeoJsonArea,
  type GeoJsonMultiPolygon,
  type GeoJsonPolygon,
} from "@/types/geo";

/**
 * PostGIS stores geometry as EWKB, so a plain `select` of a geometry column
 * returns an opaque hex string and a plain insert of GeoJSON fails. These
 * helpers are the only supported way in or out.
 */

/** Wraps a GeoJSON polygon for insert/update: `.values({ area: toGeometry(x) })`. */
export function toGeometry(polygon: GeoJsonPolygon): SQL {
  return sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(polygon)}), ${SRID_WGS84})`;
}

/**
 * Wraps one or more GeoJSON areas as a single MultiPolygon, for an organization
 * boundary.
 *
 * Passing several joins them: ST_Union dissolves the shared borders of adjacent
 * administrative areas into one outline, and ST_Multi normalizes the result so
 * the column type holds whether the pieces touch or not. That is what lets a
 * province be "these four districts" and still be one area to test against.
 */
export function toAreaGeometry(areas: GeoJsonArea | GeoJsonArea[]): SQL {
  const list = Array.isArray(areas) ? areas : [areas];

  if (list.length === 0) {
    throw new Error("toAreaGeometry requires at least one area");
  }

  const geometries = list.map(
    (area) =>
      sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(area)}), ${SRID_WGS84})`,
  );

  if (geometries.length === 1) {
    return sql`ST_Multi(${geometries[0]!})`;
  }

  return sql`ST_Multi(ST_UnaryUnion(ST_Collect(ARRAY[${sql.join(geometries, sql`, `)}])))`;
}

/** Selects a geometry column as GeoJSON text: `.select({ area: fromGeometry(farmField.area) })`. */
export function fromGeometry(column: PgColumn): SQL<string> {
  return sql<string>`ST_AsGeoJSON(${column})`;
}

/**
 * Parses what fromGeometry selects. node-postgres hands back the ST_AsGeoJSON
 * text verbatim, so it still needs parsing into an object.
 */
export function parseGeoJsonPolygon(
  value: string | null,
): GeoJsonPolygon | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as GeoJsonPolygon;
}

/** Parses an organization boundary selected with fromGeometry. */
export function parseGeoJsonArea(value: string | null): GeoJsonArea | null {
  if (!value) {
    return null;
  }

  return JSON.parse(value) as GeoJsonArea;
}

function isClosedRing(ring: unknown): boolean {
  if (!Array.isArray(ring) || ring.length < 4) {
    return false;
  }

  const first = ring[0];
  const last = ring[ring.length - 1];

  return (
    Array.isArray(first) &&
    Array.isArray(last) &&
    first[0] === last[0] &&
    first[1] === last[1]
  );
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

  return polygon.coordinates.every(isClosedRing);
}

function isValidMultiPolygon(multi: GeoJsonMultiPolygon): boolean {
  if (multi.type !== "MultiPolygon" || multi.coordinates.length === 0) {
    return false;
  }

  return multi.coordinates.every(
    (rings) => rings.length > 0 && rings.every(isClosedRing),
  );
}

/** isValidPolygon, widened to either area shape. */
export function isValidArea(area: GeoJsonArea): boolean {
  return area.type === "MultiPolygon"
    ? isValidMultiPolygon(area)
    : isValidPolygon(area);
}
