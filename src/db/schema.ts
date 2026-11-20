import {
  pgTable,
  text,
  timestamp,
  boolean,
  index,
  real,
  integer,
  inet,
  customType,
} from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";
import { jsonb } from "drizzle-orm/cockroach-core";
import {
  SRID_WGS84,
  type GeoJsonMultiPolygon,
  type GeoJsonPolygon,
} from "@/types/geo";

/**
 * PostGIS geometry columns.
 *
 * Drizzle's built-in `geometry` helper hardcodes `geometry(point)`, so a custom
 * type is what gives us polygons. PostGIS speaks WKB/EWKB on the wire, not
 * GeoJSON, so reads and writes must go through ST_AsGeoJSON / ST_GeomFromGeoJSON
 * — see @/utils/geo, and never select these columns bare.
 */
function geometryColumn<TGeometry>(geometryType: string) {
  return customType<{ data: TGeometry; driverData: string }>({
    dataType() {
      return `geometry(${geometryType},${SRID_WGS84})`;
    },
  });
}

/** One contiguous parcel — a farm field boundary. */
const polygon = geometryColumn<GeoJsonPolygon>("Polygon");

/** Possibly disjoint parts — an organization's territory. */
const multiPolygon = geometryColumn<GeoJsonMultiPolygon>("MultiPolygon");

export const user = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
});

export const session = pgTable(
  "session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = pgTable(
  "organization",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: timestamp("created_at").notNull(),
    metadata: text("metadata"),
    orgType: text("org_type").notNull(),
    parentOrgId: text("parent_org_id"),
    // The organization's territory. Null until a boundary is assigned, which is
    // why containment queries must filter it out rather than assume it exists.
    area: multiPolygon("area"),
    // "reference" (fixed administrative GeoJSON, possibly several joined) or
    // "custom" (hand drawn). Only a field organization may be "custom".
    areaSource: text("area_source"),
    // Soft delete: null means live. A hard delete would cascade through device
    // into telemetry_v0 and destroy the org's entire reading history, so
    // deleting an organization only ever sets this.
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("organization_parentOrgId_idx").on(table.parentOrgId),
    index("organization_deletedAt_idx").on(table.deletedAt),
    // Makes ST_Intersects / ST_CoveredBy against every organization cheap, which
    // is what resolving a parent by containment leans on.
    index("organization_area_idx").using("gist", table.area),
  ],
);

export const member = pgTable(
  "member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

export const farmField = pgTable(
  "farm_field",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    // The field's owner. Cascades so deleting an organization takes its fields
    // with it, matching device.organization_id.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    area: polygon("area").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    // Soft delete: null means live. Every read must filter on this.
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("farm_field_organizationId_idx").on(table.organizationId),
    index("farm_field_deletedAt_idx").on(table.deletedAt),
    // GiST is what makes ST_Contains / ST_Intersects on the boundary fast.
    index("farm_field_area_idx").using("gist", table.area),
  ],
);

export const device = pgTable(
  "device",
  {
    id: text("id").primaryKey(),
    modelName: text("model_name").notNull(),
    latitude: real("latitude"),
    longitude: real("longitude"),
    mcc: integer("mcc"),
    mnc: integer("mnc"),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" }),
    // The field this device sits in. Null while unassigned; set null rather
    // than cascade on delete, so retiring a field never destroys telemetry
    // history hanging off its devices.
    farmFieldId: text("farm_field_id").references(() => farmField.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("device_farmFieldId_idx").on(table.farmFieldId)],
);

export const telemetryV0 = pgTable(
  "telemetry_v0",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    deviceId: text("device_id")
      .notNull()
      .references(() => device.id, { onDelete: "cascade" }),
    temperature: real("temperature"),
    humidity: real("humidity"),
    methane: integer("methane"),
    carbonDioxide: integer("carbon_dioxide"),
    waterOffset: integer("water_offset"),
    waterDepth: integer("water_depth"),
    soilMoisture: real("soil_moisture"),
    batteryPercentage: real("battery_percentage"),
    batteryVoltage: integer("battery_voltage"),
    methaneRaw: real("methane_raw"),
    soilMoistureRaw: integer("soil_moisture_raw"),
    espTemperature: real("esp_temperature"),
    status: integer("status"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("telemetry_v0_deviceId_idx").on(table.deviceId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    sessionId: text("session_id"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    result: text("result").notNull(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    requestPath: text("request_path"),
    requestMethod: text("request_method"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_log_userId_idx").on(table.userId),
    index("audit_log_action_idx").on(table.action),
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
    index("audit_log_request_idx").on(table.requestPath, table.requestMethod),
  ],
);

export const sessionAudit = pgTable(
  "session_audit",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    sessionId: text("session_id").notNull(),
    event: text("event").notNull(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    requestPath: text("request_path"),
    requestMethod: text("request_method"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("session_audit_userId_idx").on(table.userId),
    index("session_audit_sessionId_idx").on(table.sessionId),
    index("session_audit_event_idx").on(table.event),
  ],
);
