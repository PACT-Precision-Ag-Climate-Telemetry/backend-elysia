import { Elysia } from "elysia";
import betterAuth from "@/modules/auth";
import {
  createOrganization,
  validateOrganizationSlug,
} from "@/modules/org/service";
import { auth } from "@/utils/auth";
import { z } from "zod";
import { OrgModel } from "@/modules/org/model";
import { orgHierarchy, userRoles } from "@/utils/auth/permission";
import db from "@/utils/db";
import { organization, member } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import generateSlug from "@/utils/slug";
import {
  isAreaSourceAllowed,
  resolveParentOrganization,
  type ParentResolutionRule,
} from "@/modules/org/spatial";
import { isValidArea, toAreaGeometry } from "@/utils/geo";
import type { AreaSource } from "@/types/geo";

const organizationApp = new Elysia({ name: "org", prefix: "/org" })
  .use(betterAuth)
  .post(
    "/create",
    async ({ body, request, status }) => {
      const session = await auth.api.getSession({
        headers: request.headers,
      });

      if (!session) {
        return status(401, { message: "Unauthorized" });
      }

      const userId = session.user.id;

      const { orgName, slug, logo, orgType, parentOrgId, area, areaSource } =
        body;

      const areas = area ? (Array.isArray(area) ? area : [area]) : [];
      // A field draws its own boundary; every higher tier traces fixed
      // administrative GeoJSON.
      const resolvedAreaSource: AreaSource =
        areaSource ?? (orgType === "field" ? "custom" : "reference");

      let resolvedParentOrgId = parentOrgId;
      let parentResolution: ParentResolutionRule | null = null;

      if (areas.length > 0) {
        if (!isAreaSourceAllowed(orgType, resolvedAreaSource)) {
          return status(400, {
            message: "Only a field organization may draw a custom area",
          });
        }

        if (!areas.every(isValidArea)) {
          return status(400, {
            message: "Organization area is not valid GeoJSON",
          });
        }

        // Geography decides parentage, so anything the caller sent is ignored:
        // the parent is the smallest territory containing this area, or on a
        // straddle the one holding the largest share of it.
        const resolution = await resolveParentOrganization(areas, orgType);

        parentResolution = resolution.rule;
        resolvedParentOrgId = resolution.parent?.id;
      }

      if (orgType !== "field") {
        if (!resolvedParentOrgId) {
          return status(400, {
            message:
              areas.length > 0
                ? "Could not resolve a parent organization from the given area"
                : "Parent organization ID is required for non-field organizations",
          });
        }

        const parentOrg = (
          await db
            .select({
              orgType: organization.orgType,
            })
            .from(organization)
            .where(eq(organization.id, resolvedParentOrgId))
            .limit(1)
        )[0];

        if (!parentOrg) {
          return status(400, {
            message: "Parent organization not found",
          });
        }

        const parentOrgType = parentOrg.orgType as keyof typeof orgHierarchy;

        const userRoleInParentOrg = (
          await db
            .select({
              role: member.role,
            })
            .from(member)
            .where(
              and(
                eq(member.userId, userId),
                eq(member.organizationId, resolvedParentOrgId),
              ),
            )
            .limit(1)
        )[0]?.role as (typeof userRoles)[number] | undefined;

        const pendingOrgIndex = orgHierarchy[orgType];
        const parentOrgIndex = orgHierarchy[parentOrgType];

        if (pendingOrgIndex < parentOrgIndex) {
          return status(400, {
            message:
              "Cannot create a child organization under a parent organization of lower hierarchy",
          });
        }

        if (
          userRoleInParentOrg !== "owner" &&
          userRoleInParentOrg !== "admin"
        ) {
          return status(403, {
            message:
              "User does not have permission to create a child organization under the specified parent organization",
          });
        }
      }

      if (orgType !== "field" && slug) {
        const validSlug = await validateOrganizationSlug(slug);

        if (!validSlug) {
          return status(400, {
            message: "Organization slug is already in use",
          });
        }
      }

      let generatedSlug = generateSlug();

      while (true) {
        const validSlug = await validateOrganizationSlug(generatedSlug);
        if (validSlug) {
          break;
        }
        generatedSlug = generateSlug();
      }

      const data = await createOrganization(
        orgName,
        orgType !== "field" ? slug || generatedSlug : generatedSlug,
        logo || null, // TODO: Handle logo upload and get the URL?
        userId,
        orgType || "field",
        resolvedParentOrgId,
      );

      // The boundary is written separately: better-auth passes plain values
      // through, and a geometry column needs ST_GeomFromGeoJSON around it.
      if (areas.length > 0) {
        await db
          .update(organization)
          .set({
            area: toAreaGeometry(areas),
            areaSource: resolvedAreaSource,
          })
          .where(eq(organization.id, data.id));
      }

      const response = {
        id: data.id,
        name: data.name,
        slug: data.slug,
        createdAt: data.createdAt.toISOString(),
        logo: data.logo ?? null,
        metadata: data.metadata ?? {},
        orgType: data.orgType,
        parentOrgId: data.parentOrgId,
        areaSource: areas.length > 0 ? resolvedAreaSource : null,
        parentResolution,
        members: (data.members ?? []).map((member) =>
          member
            ? {
                id: member.id,
                organizationId: member.organizationId,
                userId: member.userId,
                role: member.role,
                createdAt: member.createdAt.toISOString(),
              }
            : undefined,
        ),
      };

      return status(201, response);
    },
    {
      auth: true,
      body: OrgModel.body,
      response: {
        201: OrgModel.responseValid,
        400: OrgModel.responseBadRequest,
        401: OrgModel.responseUnauthorized,
        403: OrgModel.responseForbidden,
      },
    },
  );

export default organizationApp;
