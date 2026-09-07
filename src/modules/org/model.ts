import { type UnwrapSchema } from "elysia";
import z from "zod";
import { AREA_SOURCES } from "@/types/geo";

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

const geoJsonAreaSchema = z.union([
  geoJsonPolygonSchema,
  geoJsonMultiPolygonSchema,
]);

/**
 * One area, or several to be joined into one territory — a province given as
 * its constituent districts. Ring closure is not checked here; isValidArea does
 * that, because it is a geometry rule rather than a shape rule.
 */
const areaInputSchema = z.union([
  geoJsonAreaSchema,
  z.array(geoJsonAreaSchema).min(1),
]);

type OrganizationMemberResponse = {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: string;
};

type OrganizationResponse = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  logo?: string | null;
  metadata: unknown;
  orgType: string;
  parentOrgId?: string;
  areaSource?: string | null;
  /** How parentOrgId was decided when an area was supplied. */
  parentResolution?: "contained" | "majority" | "none" | null;
  members: Array<OrganizationMemberResponse | undefined>;
};

export const OrgModel = {
  body: z.object({
    orgName: z.string().min(5, {
      message: "Organization name must be at least 5 characters long",
    }),
    slug: z.string().optional(),
    logo: z.string().optional(),
    orgType: z
      .enum(["root", "government", "province", "municipality", "field"])
      .default("field"),
    // Ignored when `area` is supplied — geography decides parentage then.
    parentOrgId: z.string().optional(),
    area: areaInputSchema.optional(),
    areaSource: z.enum(AREA_SOURCES).optional(),
  }),
  responseValid: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    createdAt: z.string().datetime(),
    logo: z.string().nullable().optional(),
    metadata: z.unknown(),
    orgType: z.string(),
    parentOrgId: z.string().optional(),
    areaSource: z.string().nullable().optional(),
    parentResolution: z
      .enum(["contained", "majority", "none"])
      .nullable()
      .optional(),
    members: z.array(
      z
        .object({
          id: z.string(),
          organizationId: z.string(),
          userId: z.string(),
          role: z.string(),
          createdAt: z.string().datetime(),
        })
        .optional(),
    ),
  }) satisfies z.ZodType<OrganizationResponse>,
  responseUnauthorized: z.object({
    message: z.literal("Unauthorized"),
  }),
  responseBadRequest: z.object({
    message: z.xor([
      z.literal(
        "Parent organization ID is required for non-field organizations",
      ),
      z.literal("Parent organization not found"),
      z.literal(
        "Cannot create a child organization under a parent organization of lower hierarchy",
      ),
      z.literal("Organization slug is already in use"),
      z.literal("Only a field organization may draw a custom area"),
      z.literal("Organization area is not valid GeoJSON"),
      z.literal(
        "Could not resolve a parent organization from the given area",
      ),
    ]),
  }),
  responseForbidden: z.object({
    message: z.literal(
      "User does not have permission to create a child organization under the specified parent organization",
    ),
  }),
};

export type OrgModel = {
  [k in keyof typeof OrgModel]: UnwrapSchema<(typeof OrgModel)[k]>;
};
