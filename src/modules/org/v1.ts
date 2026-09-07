import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { member, organization } from "@/db/schema";
import betterAuth from "@/modules/auth";
import {
  createOrganization,
  generateUniqueSlug,
  validateOrganizationSlug,
} from "@/modules/org/service";
import {
  findOrganizationsWithinArea,
  isAreaSourceAllowed,
  promoteChildrenToGrandparent,
  recomputeParentOrganizations,
  resolveParentOrganization,
  tiersBelow,
  type ParentResolutionRule,
} from "@/modules/org/spatial";
import { OrgV1Model } from "@/modules/org/v1.model";
import type { AreaSource, GeoJsonArea } from "@/types/geo";
import { auth } from "@/utils/auth";
import { checkOrgHierarchyPermission } from "@/utils/auth/hierarchy";
import { orgHierarchy, userRoles } from "@/utils/auth/permission";
import db from "@/utils/db";
import { isValidArea, toAreaGeometry } from "@/utils/geo";

/**
 * v1 organization creation.
 *
 * Slug rule, by tier: a field (level 4) is always assigned a random slug and any
 * slug in the request is ignored, because a farmer naming their own plot has no
 * reason to pick a public identifier. Every tier above it (levels 0-3) names an
 * administrative body, so the slug is theirs to choose and required.
 *
 * Parentage follows the hierarchy: an organization hangs off a tier above it,
 * resolved from `area` when one is supplied and taken from `parentOrgId`
 * otherwise. A field needs no parent at all, which is what lets a brand new user
 * with no memberships create one.
 */
const organizationV1App = new Elysia({ name: "org-v1", prefix: "/v1/org" })
  .use(betterAuth)
  .post(
    "/",
    async ({ body, request, status }) => {
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session) {
        return status(401, {
          code: "unauthorized" as const,
          message: "Authentication is required to create an organization",
        });
      }

      const userId = session.user.id;
      const { orgName, orgType, slug, logo, parentOrgId, area, areaSource } =
        body;

      // A root has no tier above it, so it cannot be created through an
      // endpoint whose whole authorization model is "prove yourself in the
      // parent". Seed it out of band.
      if (orgType === "root") {
        return status(403, {
          code: "root_not_allowed" as const,
          message: "Root organizations cannot be created through this endpoint",
        });
      }

      const usesGeneratedSlug = orgType === "field";
      const areas = area ? (Array.isArray(area) ? area : [area]) : [];
      const resolvedAreaSource: AreaSource =
        areaSource ?? (usesGeneratedSlug ? "custom" : "reference");

      let resolvedParentOrgId = parentOrgId;
      let parentResolution: ParentResolutionRule | null = null;

      if (areas.length > 0) {
        if (!isAreaSourceAllowed(orgType, resolvedAreaSource)) {
          return status(400, {
            code: "custom_area_not_allowed" as const,
            message: "Only a field organization may draw a custom area",
          });
        }

        if (!areas.every(isValidArea)) {
          return status(400, {
            code: "invalid_area" as const,
            message:
              "Area must be a GeoJSON polygon whose rings are closed and have at least four positions",
          });
        }

        const resolution = await resolveParentOrganization(areas, orgType);

        parentResolution = resolution.rule;
        resolvedParentOrgId = resolution.parent?.id;
      }

      if (orgType !== "field") {
        if (!resolvedParentOrgId) {
          return status(400, {
            code:
              areas.length > 0
                ? ("parent_unresolvable" as const)
                : ("parent_required" as const),
            message:
              areas.length > 0
                ? "No organization above this tier contains the given area"
                : "parentOrgId is required for this organization type",
          });
        }

        const [parentOrg] = await db
          .select({ orgType: organization.orgType })
          .from(organization)
          .where(eq(organization.id, resolvedParentOrgId))
          .limit(1);

        if (!parentOrg) {
          return status(400, {
            code: "parent_not_found" as const,
            message: "Parent organization not found",
          });
        }

        const parentOrgType = parentOrg.orgType as keyof typeof orgHierarchy;

        if (orgHierarchy[orgType] <= orgHierarchy[parentOrgType]) {
          return status(400, {
            code: "hierarchy_violation" as const,
            message:
              "An organization must sit below its parent in the hierarchy",
          });
        }

        const [membership] = await db
          .select({ role: member.role })
          .from(member)
          .where(
            and(
              eq(member.userId, userId),
              eq(member.organizationId, resolvedParentOrgId),
            ),
          )
          .limit(1);

        const role = membership?.role as (typeof userRoles)[number] | undefined;

        if (role !== "owner" && role !== "admin") {
          return status(403, {
            code: "insufficient_permission" as const,
            message:
              "You must be an owner or admin of the parent organization to create an organization under it",
          });
        }
      }

      let finalSlug: string;

      if (usesGeneratedSlug) {
        const generated = await generateUniqueSlug();

        if (!generated) {
          return status(500, {
            code: "slug_generation_failed" as const,
            message: "Could not generate an unused organization slug",
          });
        }

        finalSlug = generated;
      } else {
        if (!slug) {
          return status(400, {
            code: "slug_required" as const,
            message: "slug is required for this organization type",
          });
        }

        if (!(await validateOrganizationSlug(slug))) {
          return status(400, {
            code: "slug_taken" as const,
            message: "Organization slug is already in use",
          });
        }

        finalSlug = slug;
      }

      const data = await createOrganization(
        orgName,
        finalSlug,
        logo || null,
        userId,
        orgType,
        resolvedParentOrgId,
      );

      // Written separately: better-auth passes plain values through, and a
      // geometry column needs ST_GeomFromGeoJSON around it.
      if (areas.length > 0) {
        await db
          .update(organization)
          .set({
            area: toAreaGeometry(areas),
            areaSource: resolvedAreaSource,
          })
          .where(eq(organization.id, data.id));
      }

      return status(201, {
        id: data.id,
        name: data.name,
        slug: data.slug,
        slugSource: usesGeneratedSlug
          ? ("generated" as const)
          : ("provided" as const),
        createdAt: data.createdAt.toISOString(),
        logo: data.logo ?? null,
        orgType: data.orgType,
        parentOrgId: data.parentOrgId ?? null,
        parentResolution,
        areaSource: areas.length > 0 ? resolvedAreaSource : null,
        // better-auth types this array as possibly holding gaps; v1 promises a
        // clean list, so drop them rather than emitting nulls.
        members: (data.members ?? [])
          .filter((orgMember) => Boolean(orgMember))
          .map((orgMember) => ({
            id: orgMember!.id,
            organizationId: orgMember!.organizationId,
            userId: orgMember!.userId,
            role: orgMember!.role,
            createdAt: orgMember!.createdAt.toISOString(),
          })),
      });
    },
    {
      auth: true,
      body: OrgV1Model.body,
      response: {
        201: OrgV1Model.responseCreated,
        400: OrgV1Model.responseError,
        401: OrgV1Model.responseError,
        403: OrgV1Model.responseError,
        500: OrgV1Model.responseError,
      },
      detail: {
        summary: "Create an organization",
        description:
          "A field organization is assigned a random slug; every higher tier must supply its own. Supplying an area resolves the parent by geography.",
        tags: ["Organization"],
      },
    },
  )
  .patch(
    "/:orgId",
    async ({ params, body, request, status }) => {
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session) {
        return status(401, {
          code: "unauthorized" as const,
          message: "Authentication is required to edit an organization",
        });
      }

      const { orgId } = params;
      const { orgName, slug, logo, area, areaSource } = body;

      const [target] = await db
        .select({
          id: organization.id,
          orgType: organization.orgType,
          areaSource: organization.areaSource,
        })
        .from(organization)
        .where(and(eq(organization.id, orgId), isNull(organization.deletedAt)))
        .limit(1);

      if (!target) {
        return status(404, {
          code: "org_not_found" as const,
          message: "Organization not found",
        });
      }

      // "edit" resolves against myOrg for your own organization and subOrg for
      // one below you, which is what decides whether an admin qualifies.
      const permission = await checkOrgHierarchyPermission({
        userId: session.user.id,
        targetOrgId: orgId,
        action: "edit",
      });

      if (!permission.allowed) {
        return status(403, {
          code: "insufficient_permission" as const,
          message: `Not allowed to edit this organization: ${permission.reason}`,
        });
      }

      const updates: Record<string, unknown> = {};
      const updatedFields: string[] = [];

      if (orgName !== undefined) {
        updates.name = orgName;
        updatedFields.push("orgName");
      }

      if (logo !== undefined) {
        updates.logo = logo;
        updatedFields.push("logo");
      }

      if (slug !== undefined) {
        // A field slug is assigned at random on creation, so it is not the
        // caller's to change — refuse rather than silently ignore.
        if (target.orgType === "field") {
          return status(400, {
            code: "slug_not_editable" as const,
            message:
              "A field organization is assigned its slug automatically and cannot change it",
          });
        }

        const [clash] = await db
          .select({ id: organization.id })
          .from(organization)
          .where(and(eq(organization.slug, slug), ne(organization.id, orgId)))
          .limit(1);

        if (clash) {
          return status(400, {
            code: "slug_taken" as const,
            message: "Organization slug is already in use",
          });
        }

        updates.slug = slug;
        updatedFields.push("slug");
      }

      let parentResolution: ParentResolutionRule | null = null;

      if (area !== undefined) {
        const areas = Array.isArray(area) ? area : [area];
        const nextAreaSource: AreaSource =
          areaSource ??
          (target.areaSource as AreaSource | null) ??
          (target.orgType === "field" ? "custom" : "reference");

        if (!isAreaSourceAllowed(target.orgType, nextAreaSource)) {
          return status(400, {
            code: "custom_area_not_allowed" as const,
            message: "Only a field organization may draw a custom area",
          });
        }

        if (!areas.every(isValidArea)) {
          return status(400, {
            code: "invalid_area" as const,
            message:
              "Area must be a GeoJSON polygon whose rings are closed and have at least four positions",
          });
        }

        // Moving a boundary can move the organization into a different
        // territory, so parentage is re-resolved rather than left stale.
        // excludeOrgId keeps it from resolving to itself.
        const resolution = await resolveParentOrganization(
          areas,
          target.orgType,
          { excludeOrgId: orgId },
        );

        parentResolution = resolution.rule;

        if (target.orgType !== "field" && !resolution.parent) {
          return status(400, {
            code: "parent_unresolvable" as const,
            message: "No organization above this tier contains the given area",
          });
        }

        updates.area = toAreaGeometry(areas);
        updates.areaSource = nextAreaSource;
        updates.parentOrgId = resolution.parent?.id ?? null;
        updatedFields.push("area", "areaSource", "parentOrgId");
      } else if (areaSource !== undefined) {
        if (!isAreaSourceAllowed(target.orgType, areaSource)) {
          return status(400, {
            code: "custom_area_not_allowed" as const,
            message: "Only a field organization may draw a custom area",
          });
        }

        updates.areaSource = areaSource;
        updatedFields.push("areaSource");
      }

      const [updated] = await db
        .update(organization)
        .set(updates)
        .where(eq(organization.id, orgId))
        .returning({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          logo: organization.logo,
          orgType: organization.orgType,
          parentOrgId: organization.parentOrgId,
          areaSource: organization.areaSource,
        });

      if (!updated) {
        return status(404, {
          code: "org_not_found" as const,
          message: "Organization not found",
        });
      }

      return status(200, {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        orgType: updated.orgType,
        logo: updated.logo ?? null,
        parentOrgId: updated.parentOrgId ?? null,
        areaSource: updated.areaSource ?? null,
        parentResolution,
        updatedFields,
      });
    },
    {
      auth: true,
      params: OrgV1Model.params,
      body: OrgV1Model.updateBody,
      response: {
        200: OrgV1Model.responseUpdated,
        400: OrgV1Model.responseError,
        401: OrgV1Model.responseError,
        403: OrgV1Model.responseError,
        404: OrgV1Model.responseError,
      },
      detail: {
        summary: "Edit an organization",
        description:
          "Requires the edit permission on the target organization. Changing the area re-resolves the parent.",
        tags: ["Organization"],
      },
    },
  )
  .delete(
    "/:orgId",
    async ({ params, request, status }) => {
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session) {
        return status(401, {
          code: "unauthorized" as const,
          message: "Authentication is required to delete an organization",
        });
      }

      const { orgId } = params;

      const [target] = await db
        .select({ id: organization.id, parentOrgId: organization.parentOrgId })
        .from(organization)
        .where(and(eq(organization.id, orgId), isNull(organization.deletedAt)))
        .limit(1);

      if (!target) {
        return status(404, {
          code: "org_not_found" as const,
          message: "Organization not found",
        });
      }

      // Note the role matrix: an admin may delete an organization below it but
      // not its own, while an owner may do both.
      const permission = await checkOrgHierarchyPermission({
        userId: session.user.id,
        targetOrgId: orgId,
        action: "delete",
      });

      if (!permission.allowed || !permission.scope) {
        return status(403, {
          code: "insufficient_permission" as const,
          message: `Not allowed to delete this organization: ${permission.reason}`,
        });
      }

      // Retiring a middle organization promotes its children a rung rather than
      // orphaning them: they take on its parent. Restoring it puts them back,
      // because geography resolves them under it again.
      const reparented = await promoteChildrenToGrandparent(
        orgId,
        target.parentOrgId ?? null,
      );

      const deletedAt = new Date();

      // Soft delete only: the cascade from organization runs through device
      // into telemetry_v0, so a hard delete would destroy the reading history.
      await db
        .update(organization)
        .set({ deletedAt })
        .where(eq(organization.id, orgId));

      return status(200, {
        id: orgId,
        deletedAt: deletedAt.toISOString(),
        scope: permission.scope,
        promotedTo: target.parentOrgId ?? null,
        reparented,
      });
    },
    {
      auth: true,
      params: OrgV1Model.params,
      response: {
        200: OrgV1Model.responseDeleted,
        401: OrgV1Model.responseError,
        403: OrgV1Model.responseError,
        404: OrgV1Model.responseError,
      },
      detail: {
        summary: "Delete an organization",
        description:
          "Requires the delete permission. Soft delete: children are promoted to the parent, and the row is retained and excluded from every query.",
        tags: ["Organization"],
      },
    },
  )
  .post(
    "/:orgId/restore",
    async ({ params, request, status }) => {
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session) {
        return status(401, {
          code: "unauthorized" as const,
          message: "Authentication is required to restore an organization",
        });
      }

      const { orgId } = params;

      const [target] = await db
        .select({
          id: organization.id,
          orgType: organization.orgType,
          deletedAt: organization.deletedAt,
          area: sql<string | null>`ST_AsGeoJSON(${organization.area})`,
        })
        .from(organization)
        .where(eq(organization.id, orgId))
        .limit(1);

      if (!target) {
        return status(404, {
          code: "org_not_found" as const,
          message: "Organization not found",
        });
      }

      if (!target.deletedAt) {
        return status(400, {
          code: "org_not_deleted" as const,
          message: "Organization is not deleted",
        });
      }

      // The target is deleted, so the permission check has to be told to look
      // at it at all. Restoring is gated on delete, the permission that retired
      // it in the first place.
      const permission = await checkOrgHierarchyPermission({
        userId: session.user.id,
        targetOrgId: orgId,
        action: "delete",
        includeDeleted: true,
      });

      if (!permission.allowed) {
        return status(403, {
          code: "insufficient_permission" as const,
          message: `Not allowed to restore this organization: ${permission.reason}`,
        });
      }

      await db
        .update(organization)
        .set({ deletedAt: null })
        .where(eq(organization.id, orgId));

      // With the organization live again, recompute parentage from geography:
      // its own, then everything sitting inside its territory. Children that
      // were promoted away on delete fall back under it, because it is once
      // more the smallest territory containing them.
      const reparented = await recomputeParentOrganizations([orgId]);

      if (target.area) {
        const within = await findOrganizationsWithinArea(
          JSON.parse(target.area) as GeoJsonArea,
          { orgTypes: tiersBelow(target.orgType), excludeOrgId: orgId },
        );

        reparented.push(
          ...(await recomputeParentOrganizations(within.map((org) => org.id))),
        );
      }

      const [restored] = await db
        .select({ parentOrgId: organization.parentOrgId })
        .from(organization)
        .where(eq(organization.id, orgId))
        .limit(1);

      return status(200, {
        id: orgId,
        parentOrgId: restored?.parentOrgId ?? null,
        reparented,
      });
    },
    {
      auth: true,
      params: OrgV1Model.params,
      response: {
        200: OrgV1Model.responseRestored,
        400: OrgV1Model.responseError,
        401: OrgV1Model.responseError,
        403: OrgV1Model.responseError,
        404: OrgV1Model.responseError,
      },
      detail: {
        summary: "Restore a deleted organization",
        description:
          "Requires the delete permission. Clears the soft delete and recomputes parentage from geography, pulling back children that were promoted away.",
        tags: ["Organization"],
      },
    },
  );

export default organizationV1App;
