import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { device, member, organization } from "@/db/schema";
import { orgHierarchy } from "@/utils/auth/permission";
import db from "@/utils/db";

/**
 * Who can see a device.
 *
 * Tiers at or above AREA_VISIBILITY_MAX_LEVEL see any device standing inside
 * their territory, whether or not they own it — a province sees every device in
 * the province. Below that line, territory grants nothing and only ownership
 * does: the bottom tier must actually own the device to see it.
 *
 * Ownership always wins regardless of tier, so an organization never loses
 * sight of its own device by moving it outside its boundary.
 */

/**
 * The lowest level that still sees by territory: root(0), government(1),
 * province(2) and municipality(3). field(4) is below the line and must own.
 *
 * Raise this to 4 if a sixth tier is added beneath field and that new tier is
 * the one meant to require ownership.
 */
export const AREA_VISIBILITY_MAX_LEVEL = 3;

/** Org types whose territory grants visibility. */
export function areaVisibilityOrgTypes(): string[] {
  return Object.entries(orgHierarchy)
    .filter(([, level]) => level <= AREA_VISIBILITY_MAX_LEVEL)
    .map(([orgType]) => orgType);
}

/** Org types that see only what they own. */
export function ownershipOnlyOrgTypes(): string[] {
  return Object.entries(orgHierarchy)
    .filter(([, level]) => level > AREA_VISIBILITY_MAX_LEVEL)
    .map(([orgType]) => orgType);
}

/** A device's position as a PostGIS point, or NULL when it has no fix. */
const devicePoint = sql`ST_SetSRID(ST_MakePoint(${device.longitude}, ${device.latitude}), ${4326})`;

/**
 * True when the organization's territory covers the device's position.
 *
 * ST_Covers rather than ST_Contains so a device sitting exactly on a boundary
 * is inside it rather than nowhere. A device with no fix is never visible by
 * area — only its owner sees it.
 */
const deviceInOrgArea = sql<boolean>`(
  ${organization.area} IS NOT NULL
  AND ${device.latitude} IS NOT NULL
  AND ${device.longitude} IS NOT NULL
  AND ST_Covers(${organization.area}, ${devicePoint})
)`;

function orgTypeSeesByArea() {
  return sql<boolean>`${organization.orgType} = ANY(${sql.param(areaVisibilityOrgTypes())})`;
}

const deviceOwnedByOrg = sql<boolean>`${device.organizationId} = ${organization.id}`;

export type VisibilityReason = "owner" | "area" | "none";

export interface DeviceVisibility {
  visible: boolean;
  /** Why it is visible: outright ownership, or the device standing inside a territory. */
  reason: VisibilityReason;
  /** The organization the visibility came through. */
  organizationId: string | null;
  orgType: string | null;
}

const DENIED: DeviceVisibility = {
  visible: false,
  reason: "none",
  organizationId: null,
  orgType: null,
};

export interface VisibilityRow {
  organizationId: string;
  orgType: string;
  owns: boolean;
  inArea: boolean;
}

/**
 * Reduces one row per membership to a single answer.
 *
 * Ownership is reported ahead of territory when both apply, so the result names
 * the strongest claim rather than whichever row the planner happened to return
 * first. Kept pure so the precedence is testable without a database.
 */
export function pickVisibility(rows: VisibilityRow[]): DeviceVisibility {
  const owner = rows.find((row) => row.owns);

  if (owner) {
    return {
      visible: true,
      reason: "owner",
      organizationId: owner.organizationId,
      orgType: owner.orgType,
    };
  }

  const byArea = rows.find((row) => row.inArea);

  if (byArea) {
    return {
      visible: true,
      reason: "area",
      organizationId: byArea.organizationId,
      orgType: byArea.orgType,
    };
  }

  return DENIED;
}

/**
 * Whether a user can see a device through any organization they belong to.
 */
export async function canUserViewDevice(
  userId: string,
  deviceId: string,
): Promise<DeviceVisibility> {
  const rows = await db
    .select({
      organizationId: organization.id,
      orgType: organization.orgType,
      owns: deviceOwnedByOrg,
      inArea: sql<boolean>`(${orgTypeSeesByArea()} AND ${deviceInOrgArea})`,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .innerJoin(device, eq(device.id, deviceId))
    .where(and(eq(member.userId, userId), isNull(organization.deletedAt)));

  return pickVisibility(rows);
}

/**
 * Every device a user can see, by either rule. Distinct, because two of the
 * user's organizations can both have a claim on the same device.
 */
export async function listVisibleDeviceIds(userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: device.id })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .innerJoin(
      device,
      or(deviceOwnedByOrg, sql`(${orgTypeSeesByArea()} AND ${deviceInOrgArea})`)!,
    )
    .where(and(eq(member.userId, userId), isNull(organization.deletedAt)));

  return rows.map((row) => row.id);
}

export interface VisibleDevice {
  id: string;
  modelName: string;
  latitude: number | null;
  longitude: number | null;
  mcc: number | null;
  mnc: number | null;
  organizationId: string | null;
  farmFieldId: string | null;
  createdAt: Date;
  updatedAt: Date;
  reason: Exclude<VisibilityReason, "none">;
}

/**
 * A page of the devices a user can see, each carrying why.
 *
 * Grouped by device rather than returning one row per membership, since two of
 * the user's organizations can both have a claim on the same device — a
 * province by territory and a field by ownership. bool_or collapses those into
 * a single answer per device.
 */
export async function listVisibleDevices(
  userId: string,
  options: { limit: number; offset: number },
): Promise<VisibleDevice[]> {
  const owns = sql<boolean>`bool_or(${deviceOwnedByOrg})`;

  const rows = await db
    .select({
      id: device.id,
      modelName: device.modelName,
      latitude: device.latitude,
      longitude: device.longitude,
      mcc: device.mcc,
      mnc: device.mnc,
      organizationId: device.organizationId,
      farmFieldId: device.farmFieldId,
      createdAt: device.createdAt,
      updatedAt: device.updatedAt,
      owns,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .innerJoin(
      device,
      or(deviceOwnedByOrg, sql`(${orgTypeSeesByArea()} AND ${deviceInOrgArea})`)!,
    )
    .where(and(eq(member.userId, userId), isNull(organization.deletedAt)))
    .groupBy(device.id)
    .orderBy(asc(device.id))
    .limit(options.limit)
    .offset(options.offset);

  // The join already required one rule or the other to match, so a device that
  // is not owned is here by territory. Only ownership needs aggregating.
  return rows.map(({ owns: ownsDevice, ...row }) => ({
    ...row,
    reason: ownsDevice ? ("owner" as const) : ("area" as const),
  }));
}

/**
 * The single-organization form of the rule, for a caller that already knows
 * which organization it is acting as.
 */
export async function canOrganizationViewDevice(
  organizationId: string,
  deviceId: string,
): Promise<DeviceVisibility> {
  const [row] = await db
    .select({
      organizationId: organization.id,
      orgType: organization.orgType,
      owns: deviceOwnedByOrg,
      inArea: sql<boolean>`(${orgTypeSeesByArea()} AND ${deviceInOrgArea})`,
    })
    .from(organization)
    .innerJoin(device, eq(device.id, deviceId))
    .where(
      and(eq(organization.id, organizationId), isNull(organization.deletedAt)),
    )
    .limit(1);

  return row ? pickVisibility([row]) : DENIED;
}
