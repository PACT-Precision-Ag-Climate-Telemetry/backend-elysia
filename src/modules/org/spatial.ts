import { and, asc, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { organization } from "@/db/schema";
import type { AreaSource, GeoJsonArea } from "@/types/geo";
import { orgHierarchy } from "@/utils/auth/permission";
import db from "@/utils/db";
import { toAreaGeometry } from "@/utils/geo";

/**
 * Parentage by geography.
 *
 * A lower organization is not under a higher one merely because it sits at a
 * lower tier — it is under it when its territory falls inside that territory.
 * PostGIS answers that with ST_CoveredBy against the GiST index on
 * organization.area, and the coverage ratio below reports partial overlap so a
 * boundary that straddles two parents is visible rather than silently resolved.
 */

/** Coverage at or above this counts as contained, allowing for rounding noise. */
export const FULL_COVERAGE = 0.999999;

export interface ContainingOrganization {
  id: string;
  name: string;
  slug: string;
  orgType: string;
  level: number | null;
  parentOrgId: string | null;
  /** Fraction of the candidate's area that lies inside this organization, 0-1. */
  coverage: number;
  /** The candidate organization's own size, in square meters. */
  areaSqMeters: number;
}

export interface ContainmentOptions {
  /** Minimum coverage to report. Defaults to full containment. */
  minCoverage?: number;
  /** Restrict to these org types. Defaults to every tier above `belowOrgType`. */
  orgTypes?: string[];
  /** Report only tiers strictly above this one. */
  belowOrgType?: string;
  /** Exclude an organization — itself, when re-resolving an existing one. */
  excludeOrgId?: string;
}

function toLevel(orgType: string): number | null {
  return orgType in orgHierarchy
    ? orgHierarchy[orgType as keyof typeof orgHierarchy]
    : null;
}

/** Tiers strictly above the given one: for `province`, root and government. */
export function tiersAbove(orgType: string): string[] {
  const level = toLevel(orgType);

  if (level === null) {
    return [];
  }

  return Object.entries(orgHierarchy)
    .filter(([, candidateLevel]) => candidateLevel < level)
    .map(([type]) => type);
}

/**
 * Every organization whose territory covers the given area, most tightly
 * fitting first.
 *
 * Ordered by coverage descending then area ascending, so the immediate parent —
 * the smallest territory that still contains the area — comes first, and a
 * grandparent that also contains it sorts after.
 */
export async function findContainingOrganizations(
  area: GeoJsonArea | GeoJsonArea[],
  options: ContainmentOptions = {},
): Promise<ContainingOrganization[]> {
  const {
    minCoverage = FULL_COVERAGE,
    belowOrgType,
    excludeOrgId,
    orgTypes = belowOrgType ? tiersAbove(belowOrgType) : undefined,
  } = options;

  // An org type with no tier above it (root) can have no parent at all.
  if (orgTypes && orgTypes.length === 0) {
    return [];
  }

  const geometry = toAreaGeometry(area);

  // Geography casts so the ratio is of true surface areas rather than of
  // degrees, which distort badly away from the equator.
  const coverage = sql<number>`
    ST_Area(ST_Intersection(${geometry}, ${organization.area})::geography)
      / NULLIF(ST_Area(${geometry}::geography), 0)
  `;
  const areaSqMeters = sql<number>`ST_Area(${organization.area}::geography)`;

  const filters = [
    isNotNull(organization.area),
    // Index-backed prefilter: only intersecting rows reach the exact test.
    sql`ST_Intersects(${geometry}, ${organization.area})`,
    // Full containment is a topological test, so ask PostGIS that question
    // directly rather than comparing computed areas — ST_CoveredBy is exact and
    // skips building an intersection geometry. Only a partial-overlap threshold
    // needs the ratio.
    minCoverage >= FULL_COVERAGE
      ? sql`ST_CoveredBy(${geometry}, ${organization.area})`
      : sql`${coverage} >= ${minCoverage}`,
    ...(orgTypes
      ? [sql`${organization.orgType} = ANY(${sql.param(orgTypes)})`]
      : []),
    ...(excludeOrgId ? [ne(organization.id, excludeOrgId)] : []),
  ];

  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      orgType: organization.orgType,
      parentOrgId: organization.parentOrgId,
      coverage,
      areaSqMeters,
    })
    .from(organization)
    .where(and(...filters))
    .orderBy(desc(coverage), asc(areaSqMeters));

  return rows.map((row) => ({
    ...row,
    level: toLevel(row.orgType),
    coverage: Number(row.coverage),
    areaSqMeters: Number(row.areaSqMeters),
  }));
}

/** A boundary at least this far inside a territory is claimed by it. */
export const MAJORITY_COVERAGE = 0.6;

export type ParentResolutionRule = "contained" | "majority" | "none";

export interface ParentResolution {
  parent: ContainingOrganization | null;
  /**
   * How the parent was chosen: `contained` if the area sits wholly inside it,
   * `majority` if it only straddles and this territory holds the largest share,
   * `none` if nothing qualified.
   */
  rule: ParentResolutionRule;
  /** Everything that qualified, so a caller can report an ambiguous boundary. */
  candidates: ContainingOrganization[];
}

/**
 * The organization an area should hang off.
 *
 * Prefers the smallest territory that wholly contains the area. Failing that, a
 * straddling boundary goes to whichever territory holds the largest share of
 * it, provided that share clears MAJORITY_COVERAGE. Neither returns a parent
 * for an area out in the open, which is a valid answer rather than an error.
 */
export async function resolveParentOrganization(
  area: GeoJsonArea | GeoJsonArea[],
  orgType: string,
  options: Omit<ContainmentOptions, "belowOrgType" | "orgTypes"> & {
    majorityCoverage?: number;
  } = {},
): Promise<ParentResolution> {
  const { majorityCoverage = MAJORITY_COVERAGE, ...containment } = options;

  const contained = await findContainingOrganizations(area, {
    ...containment,
    belowOrgType: orgType,
  });

  if (contained[0]) {
    return { parent: contained[0], rule: "contained", candidates: contained };
  }

  // Ordered by coverage first, so the largest share wins the straddle.
  const overlapping = await findContainingOrganizations(area, {
    ...containment,
    belowOrgType: orgType,
    minCoverage: majorityCoverage,
  });

  if (overlapping[0]) {
    return { parent: overlapping[0], rule: "majority", candidates: overlapping };
  }

  return { parent: null, rule: "none", candidates: [] };
}

export interface ContainmentCheck {
  contained: boolean;
  coverage: number;
  reason: string;
}

/**
 * Whether a proposed parent's territory actually contains the child's, and by
 * how much. Coverage is reported even when the check fails, so a caller can
 * tell "just outside" from "nowhere near".
 */
export async function checkParentContainsArea(
  parentOrgId: string,
  area: GeoJsonArea | GeoJsonArea[],
  minCoverage = FULL_COVERAGE,
): Promise<ContainmentCheck> {
  const geometry = toAreaGeometry(area);

  const [row] = await db
    .select({
      hasArea: sql<boolean>`${organization.area} IS NOT NULL`,
      coverage: sql<number | null>`
        ST_Area(ST_Intersection(${geometry}, ${organization.area})::geography)
          / NULLIF(ST_Area(${geometry}::geography), 0)
      `,
    })
    .from(organization)
    .where(eq(organization.id, parentOrgId))
    .limit(1);

  if (!row) {
    return { contained: false, coverage: 0, reason: "parent organization not found" };
  }

  if (!row.hasArea) {
    return {
      contained: false,
      coverage: 0,
      reason: "parent organization has no boundary assigned",
    };
  }

  const coverage = Number(row.coverage ?? 0);

  if (coverage >= minCoverage) {
    return { contained: true, coverage, reason: "area falls inside parent" };
  }

  return {
    contained: false,
    coverage,
    reason:
      coverage > 0
        ? "area only partly overlaps parent"
        : "area falls outside parent",
  };
}

/**
 * Only a field organization may draw its own boundary; every higher tier traces
 * fixed administrative GeoJSON, joined if it spans several features.
 */
export function isAreaSourceAllowed(
  orgType: string,
  source: AreaSource,
): boolean {
  return source === "custom" ? orgType === "field" : true;
}
