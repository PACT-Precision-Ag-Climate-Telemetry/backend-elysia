import { type UnwrapSchema } from "elysia";
import z from "zod";
import { orgNameSchema } from "@/configs/org";
import { areaInputSchema } from "@/modules/org/area.model";
import { AREA_SOURCES } from "@/types/geo";

export const ORG_TYPES = [
  "root",
  "government",
  "province",
  "municipality",
  "field",
] as const;

/**
 * Machine-readable failure codes, so a client can branch without matching on
 * message text. v1 pairs every error with one of these.
 */
export const ORG_ERROR_CODES = [
  "slug_required",
  "slug_taken",
  "slug_generation_failed",
  "parent_required",
  "parent_not_found",
  "parent_unresolvable",
  "hierarchy_violation",
  "root_not_allowed",
  "invalid_area",
  "custom_area_not_allowed",
  "insufficient_permission",
  "unauthorized",
  "org_not_found",
  "slug_not_editable",
  "no_changes",
  "org_not_deleted",
] as const;

export type OrgErrorCode = (typeof ORG_ERROR_CODES)[number];

/** Matches what generateSlug emits: lowercase words joined by single hyphens. */
const slugSchema = z
  .string()
  .min(3, { message: "Slug must be at least 3 characters long" })
  .max(64, { message: "Slug must be at most 64 characters long" })
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      "Slug must be lowercase letters, digits and single hyphens between them",
  });

const errorSchema = z.object({
  code: z.enum(ORG_ERROR_CODES),
  message: z.string(),
});

const reparentedSchema = z.object({
  id: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  rule: z.enum(["contained", "majority", "none", "promoted"]),
});

export const OrgV1Model = {
  body: z.object({
    orgName: orgNameSchema,
    orgType: z.enum(ORG_TYPES).default("field"),
    /** Required for every tier above field; ignored for a field, which is always assigned a random one. */
    slug: slugSchema.optional(),
    logo: z.string().optional(),
    /** Ignored when `area` is supplied — geography decides parentage then. */
    parentOrgId: z.string().optional(),
    area: areaInputSchema.optional(),
    areaSource: z.enum(AREA_SOURCES).optional(),
  }),
  responseCreated: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    /** Whether the slug was assigned at random or taken from the request. */
    slugSource: z.enum(["generated", "provided"]),
    createdAt: z.string().datetime(),
    logo: z.string().nullable(),
    orgType: z.string(),
    parentOrgId: z.string().nullable(),
    parentResolution: z
      .enum(["contained", "majority", "none"])
      .nullable(),
    areaSource: z.string().nullable(),
    members: z.array(
      z.object({
        id: z.string(),
        organizationId: z.string(),
        userId: z.string(),
        role: z.string(),
        createdAt: z.string().datetime(),
      }),
    ),
  }),
  params: z.object({
    orgId: z.string().min(1),
  }),
  /**
   * Every field optional — send only what changes. A field organization's slug
   * is system-assigned, so editing it is refused rather than ignored.
   */
  updateBody: z
    .object({
      orgName: orgNameSchema.optional(),
      slug: slugSchema.optional(),
      logo: z.string().nullable().optional(),
      area: areaInputSchema.optional(),
      areaSource: z.enum(AREA_SOURCES).optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), {
      message: "At least one field must be provided",
    }),
  responseUpdated: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    logo: z.string().nullable(),
    orgType: z.string(),
    parentOrgId: z.string().nullable(),
    /** Re-resolved when the area changed, otherwise null. */
    parentResolution: z.enum(["contained", "majority", "none"]).nullable(),
    areaSource: z.string().nullable(),
    updatedFields: z.array(z.string()),
  }),
  responseDeleted: z.object({
    id: z.string(),
    /** Soft delete: the row stays, and this is when it was retired. */
    deletedAt: z.string().datetime(),
    /** How the caller was entitled to delete it. */
    scope: z.enum(["myOrg", "subOrg"]),
    /** The parent its children were promoted to; null if it had none. */
    promotedTo: z.string().nullable(),
    /** Children moved up a rung so the subtree is never orphaned. */
    reparented: z.array(reparentedSchema),
  }),
  responseRestored: z.object({
    id: z.string(),
    /** The parent it resolved to on return, recomputed from its area. */
    parentOrgId: z.string().nullable(),
    /** Organizations whose parentage geography reassigned on the way back. */
    reparented: z.array(reparentedSchema),
  }),
  responseError: errorSchema,
};

export type OrgV1Model = {
  [k in keyof typeof OrgV1Model]: UnwrapSchema<(typeof OrgV1Model)[k]>;
};
