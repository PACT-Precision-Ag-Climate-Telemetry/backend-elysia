import { organization } from "@/db/schema";
import { auth } from "@/utils/auth";
import db from "@/utils/db";
import { eq } from "drizzle-orm";

export async function createOrganization(
  orgName: string,
  orgSlug: string,
  orgLogo: string | null,
  userId: string,
  orgType: string | "field",
  parentOrgId?: string,
) {
  const data = await auth.api.createOrganization({
    body: {
      name: orgName,
      slug: orgSlug,
      logo: orgLogo,
      userId: userId,
      keepCurrentActiveOrganization: true,
      orgType: orgType,
      parentOrgId: parentOrgId,
    },
  });

  return data;
}

export async function getOrganizationSlug(slug: string) {
  const data = await db
    .select({
      slug: organization.slug,
    })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);

  return data[0];
}

export async function validateOrganizationSlug(slug: string) {
  const existingSlug = await db
    .select({
      slug: organization.slug,
    })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);

  if (existingSlug.length > 0) {
    return false;
  }

  return true;
}
