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

      const { orgName, slug, logo, orgType, parentOrgId } = body;

      if (orgType !== "field") {
        if (!parentOrgId) {
          return status(400, {
            message:
              "Parent organization ID is required for non-field organizations",
          });
        }

        const parentOrgType = (
          await db
            .select({
              orgType: organization.orgType,
            })
            .from(organization)
            .where(eq(organization.id, parentOrgId))
            .limit(1)
        )[0].orgType as keyof typeof orgHierarchy;

        if (!parentOrgType) {
          return status(400, {
            message: "Parent organization not found",
          });
        }

        const userRoleInParentOrg = (
          await db
            .select({
              role: member.role,
            })
            .from(member)
            .where(
              and(
                eq(member.userId, userId),
                eq(member.organizationId, parentOrgId),
              ),
            )
            .limit(1)
        )[0].role as (typeof userRoles)[number];

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
        parentOrgId,
      );

      const response = {
        id: data.id,
        name: data.name,
        slug: data.slug,
        createdAt: data.createdAt.toISOString(),
        logo: data.logo ?? null,
        metadata: data.metadata ?? {},
        orgType: data.orgType,
        parentOrgId: data.parentOrgId,
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
