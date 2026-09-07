import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { device, organization, telemetryV0 } from "@/db/schema";
import { orgHierarchy } from "@/utils/auth/permission";
import db from "@/utils/db";

/** root=0 ... field=4, so a chain can never legitimately exceed five links. */
const MAX_ORG_DEPTH = Object.keys(orgHierarchy).length;

export interface OrganizationNode {
  id: string;
  name: string;
  slug: string;
  orgType: string;
  level: number | null;
  parentOrgId: string | null;
}

function toLevel(orgType: string): number | null {
  return orgType in orgHierarchy
    ? orgHierarchy[orgType as keyof typeof orgHierarchy]
    : null;
}

export type OrganizationRow = Omit<OrganizationNode, "level">;

async function fetchOrganizationRow(
  organizationId: string,
): Promise<OrganizationRow | undefined> {
  const [row] = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      orgType: organization.orgType,
      parentOrgId: organization.parentOrgId,
    })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);

  return row;
}

/**
 * Walks parentOrgId from the given organization up to its root, returning the
 * chain root-first with the given organization last.
 *
 * Bounded by MAX_ORG_DEPTH, and the visited set stops malformed data with a
 * parent cycle from looping forever — the same guard isDescendantOrg uses in
 * @/utils/auth/hierarchy. Takes its lookup as an argument so the traversal can
 * be tested without a database.
 */
export async function buildOrganizationChain(
  organizationId: string,
  fetchOrg: (id: string) => Promise<OrganizationRow | undefined>,
): Promise<OrganizationNode[]> {
  const chain: OrganizationNode[] = [];
  const visited = new Set<string>();
  let currentId: string | null = organizationId;

  while (currentId && !visited.has(currentId) && chain.length < MAX_ORG_DEPTH) {
    visited.add(currentId);

    const row = await fetchOrg(currentId);

    if (!row) {
      break;
    }

    chain.push({ ...row, level: toLevel(row.orgType) });
    currentId = row.parentOrgId;
  }

  return chain.reverse();
}

export async function getOrganizationChain(
  organizationId: string,
): Promise<OrganizationNode[]> {
  return buildOrganizationChain(organizationId, fetchOrganizationRow);
}

export interface TelemetryQueryOptions {
  deviceId: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
  order: "asc" | "desc";
}

export async function getDevice(deviceId: string) {
  const existing = await db
    .select()
    .from(device)
    .where(eq(device.id, deviceId))
    .limit(1);

  return existing[0];
}

export async function getDeviceTelemetry({
  deviceId,
  from,
  to,
  limit,
  offset,
  order,
}: TelemetryQueryOptions) {
  const filters = [
    eq(telemetryV0.deviceId, deviceId),
    ...(from ? [gte(telemetryV0.createdAt, from)] : []),
    ...(to ? [lte(telemetryV0.createdAt, to)] : []),
  ];

  return db
    .select()
    .from(telemetryV0)
    .where(and(...filters))
    // id is the tiebreaker so paging stays stable across readings that share a
    // timestamp (a device uploads a whole batch at once).
    .orderBy(
      ...(order === "asc"
        ? [asc(telemetryV0.createdAt), asc(telemetryV0.id)]
        : [desc(telemetryV0.createdAt), desc(telemetryV0.id)]),
    )
    .limit(limit)
    .offset(offset);
}
