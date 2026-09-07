import { and, eq, isNull } from "drizzle-orm";
import { member, organization } from "@/db/schema";
import db from "@/utils/db";
import {
  orgHierarchy,
  rolePermissions,
  type Scope,
  type Action,
  type Role,
} from "@/utils/auth/permission";

type OrganizationNode = {
  id: string;
  parentOrgId: string | null;
  orgType: string;
};

function hasActionPermission(
  role: Role,
  scope: Scope,
  action: Action,
): boolean {
  return rolePermissions[role][scope].includes(action);
}

function isKnownRole(role: string): role is Role {
  return role === "owner" || role === "admin" || role === "member";
}

function isKnownOrgType(orgType: string): orgType is keyof typeof orgHierarchy {
  return orgType in orgHierarchy;
}

function hasHierarchyAccess(actorType: string, targetType: string): boolean {
  if (!isKnownOrgType(actorType) || !isKnownOrgType(targetType)) {
    return false;
  }

  return orgHierarchy[actorType] <= orgHierarchy[targetType];
}

function isDescendantOrg(
  sourceOrgId: string,
  targetOrgId: string,
  orgMap: Map<string, OrganizationNode>,
): boolean {
  let current = orgMap.get(targetOrgId);
  const visited = new Set<string>();

  while (current?.parentOrgId) {
    if (visited.has(current.id)) {
      return false;
    }

    visited.add(current.id);

    if (current.parentOrgId === sourceOrgId) {
      return true;
    }

    current = orgMap.get(current.parentOrgId);
  }

  return false;
}

export type HierarchyPermissionInput = {
  userId: string;
  targetOrgId: string;
  action: Action;
  /**
   * Consider a soft-deleted target. Off by default, so a deleted organization
   * cannot be acted on; restoring one is the exception that needs it.
   */
  includeDeleted?: boolean;
};

export type HierarchyPermissionResult = {
  allowed: boolean;
  scope: Scope | null;
  role: Role | null;
  actorOrgId: string | null;
  reason: string;
};

export async function checkOrgHierarchyPermission(
  input: HierarchyPermissionInput,
): Promise<HierarchyPermissionResult> {
  const [targetOrg] = await db
    .select({
      id: organization.id,
      parentOrgId: organization.parentOrgId,
      orgType: organization.orgType,
    })
    .from(organization)
    .where(
      and(
        eq(organization.id, input.targetOrgId),
        ...(input.includeDeleted ? [] : [isNull(organization.deletedAt)]),
      ),
    )
    .limit(1);

  if (!targetOrg) {
    return {
      allowed: false,
      scope: null,
      role: null,
      actorOrgId: null,
      reason: "target organization not found",
    };
  }

  const memberships = await db
    .select({
      organizationId: member.organizationId,
      role: member.role,
    })
    .from(member)
    .where(eq(member.userId, input.userId));

  if (memberships.length === 0) {
    return {
      allowed: false,
      scope: null,
      role: null,
      actorOrgId: null,
      reason: "user has no organization membership",
    };
  }

  const actorOrgs = await db
    .select({
      id: organization.id,
      parentOrgId: organization.parentOrgId,
      orgType: organization.orgType,
    })
    .from(organization)
    .where(isNull(organization.deletedAt));

  const orgMap = new Map(actorOrgs.map((org) => [org.id, org]));

  for (const membership of memberships) {
    if (!isKnownRole(membership.role)) {
      continue;
    }

    const actorOrg = orgMap.get(membership.organizationId);
    if (!actorOrg) {
      continue;
    }

    if (membership.organizationId === input.targetOrgId) {
      if (hasActionPermission(membership.role, "myOrg", input.action)) {
        return {
          allowed: true,
          scope: "myOrg",
          role: membership.role,
          actorOrgId: membership.organizationId,
          reason: "action allowed in same organization",
        };
      }

      continue;
    }

    if (
      isDescendantOrg(membership.organizationId, input.targetOrgId, orgMap) &&
      hasHierarchyAccess(actorOrg.orgType, targetOrg.orgType) &&
      hasActionPermission(membership.role, "subOrg", input.action)
    ) {
      return {
        allowed: true,
        scope: "subOrg",
        role: membership.role,
        actorOrgId: membership.organizationId,
        reason: "action allowed in descendant organization",
      };
    }
  }

  return {
    allowed: false,
    scope: null,
    role: null,
    actorOrgId: null,
    reason: "permission denied by role or hierarchy",
  };
}

export async function requireOrgHierarchyPermission(
  input: HierarchyPermissionInput,
): Promise<Omit<HierarchyPermissionResult, "allowed">> {
  const result = await checkOrgHierarchyPermission(input);

  if (!result.allowed) {
    throw new Error(`Forbidden: ${result.reason}`);
  }

  return {
    scope: result.scope,
    role: result.role,
    actorOrgId: result.actorOrgId,
    reason: result.reason,
  };
}
