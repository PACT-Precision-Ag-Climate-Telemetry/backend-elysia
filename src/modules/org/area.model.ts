import z from "zod";

/**
 * Request schemas for an organization boundary.
 *
 * Kept apart from any one API version so a later version can reuse them without
 * importing from its predecessor.
 */

const geoJsonPositionSchema = z.tuple([z.number(), z.number()]);
const linearRingSchema = z.array(geoJsonPositionSchema);

const geoJsonPolygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(linearRingSchema),
});

const geoJsonMultiPolygonSchema = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(linearRingSchema)),
});

export const geoJsonAreaSchema = z.union([
  geoJsonPolygonSchema,
  geoJsonMultiPolygonSchema,
]);

/**
 * One area, or several to be joined into one territory — a province given as
 * its constituent districts. Ring closure is not checked here; isValidArea does
 * that, because it is a geometry rule rather than a shape rule.
 */
export const areaInputSchema = z.union([
  geoJsonAreaSchema,
  z.array(geoJsonAreaSchema).min(1),
]);
