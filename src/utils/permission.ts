import { createAccessControl } from "better-auth/plugins/access";

const statement = {
  device: ["read", "write", "delete", "share"],
  field: ["read", "write", "delete", "create", "edit"],
  municipality: ["read", "write", "delete", "create", "edit"],
  province: ["read", "write", "delete", "create", "edit"],
  government: ["read", "write", "delete", "create", "edit"],
} as const;

const ac = createAccessControl(statement);

const fieldRole = ac.newRole({
  device: ["read", "write", "delete", "share"],
  field: ["read", "write", "delete", "create", "edit"],
});

const municipalityRole = ac.newRole({
  device: ["read"],
  field: ["read"],
  municipality: ["read", "write"],
});

const provinceRole = ac.newRole({
  device: ["read"],
  field: ["read"],
  municipality: ["read", "write", "delete", "create", "edit"],
  province: ["read", "write"],
});

const governmentRole = ac.newRole({
  device: ["read"],
  field: ["read"],
  municipality: ["read", "write", "delete", "create", "edit"],
  province: ["read", "write", "delete", "create", "edit"],
  government: ["read", "write"],
});

export { ac, fieldRole, municipalityRole, provinceRole, governmentRole };
