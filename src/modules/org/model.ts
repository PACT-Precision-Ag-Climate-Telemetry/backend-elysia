import { type UnwrapSchema } from "elysia";
import z from "zod";

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
    parentOrgId: z.string().optional(),
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
