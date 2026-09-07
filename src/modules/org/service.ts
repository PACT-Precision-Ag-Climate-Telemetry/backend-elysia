import { organization } from "@/db/schema";
import { auth } from "@/utils/auth";
import db from "@/utils/db";
import { eq } from "drizzle-orm";
import generateSlug from "@/utils/slug";

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

/** How many random slugs to try before giving up rather than looping forever. */
export const SLUG_GENERATION_ATTEMPTS = 10;

/**
 * A random slug that is not yet taken, or null if every attempt collided.
 *
 * Bounded on purpose: the generator draws from a finite dictionary, so an
 * unbounded retry loop would spin forever once the space fills up.
 */
export async function generateUniqueSlug(
  attempts = SLUG_GENERATION_ATTEMPTS,
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = generateSlug();

    if (await validateOrganizationSlug(candidate)) {
      return candidate;
    }
  }

  return null;
}
