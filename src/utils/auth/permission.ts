import { createAccessControl } from "better-auth/plugins/access";

export const statement = {
  device: ["read", "write", "delete", "share"],
  myOrg: ["read", "write", "delete", "create", "edit"],
  subOrg: ["read", "write", "delete", "create", "edit"],
} as const;

export type Scope = "myOrg" | "subOrg";
export type Action = (typeof statement.myOrg)[number];
export type Role = "owner" | "admin" | "member";

export const rolePermissions: Record<
  Role,
  Record<"device" | Scope, readonly string[]>
> = {
  owner: {
    device: ["read", "write", "delete", "share"],
    myOrg: ["read", "write", "delete", "create", "edit"],
    subOrg: ["read", "write", "delete", "create", "edit"],
  },
  admin: {
    device: ["read", "write", "delete", "share"],
    myOrg: ["read", "write", "edit"],
    subOrg: ["read", "write", "delete", "create", "edit"],
  },
  member: {
    device: ["read"],
    myOrg: ["read"],
    subOrg: ["read"],
  },
};

export const ac = createAccessControl(statement);

export const ownerRole = ac.newRole({
  device: rolePermissions.owner.device as ["read", "write", "delete", "share"],
  myOrg: rolePermissions.owner.myOrg as [
    "read",
    "write",
    "delete",
    "create",
    "edit",
  ],
  subOrg: rolePermissions.owner.subOrg as [
    "read",
    "write",
    "delete",
    "create",
    "edit",
  ],
});

export const adminRole = ac.newRole({
  device: rolePermissions.admin.device as ["read", "write", "delete", "share"],
  myOrg: rolePermissions.admin.myOrg as ["read", "write", "edit"],
  subOrg: rolePermissions.admin.subOrg as [
    "read",
    "write",
    "delete",
    "create",
    "edit",
  ],
});

export const memberRole = ac.newRole({
  device: rolePermissions.member.device as ["read"],
  myOrg: rolePermissions.member.myOrg as ["read"],
  subOrg: rolePermissions.member.subOrg as ["read"],
});

export const orgHierarchy = {
  root: 0,
  government: 1,
  province: 2,
  municipality: 3,
  field: 4,
} as const;

export const userRoles = ["owner", "admin", "member"] as const;
