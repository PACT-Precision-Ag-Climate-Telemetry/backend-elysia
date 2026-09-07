import { type UnwrapSchema } from "elysia";
import z from "zod";

export const TELEMETRY_QUERY_MAX_LIMIT = 1000;
export const TELEMETRY_QUERY_DEFAULT_LIMIT = 100;

type TelemetryReadingResponse = {
  id: string;
  deviceId: string;
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  methane: number | null;
  methaneRaw: number | null;
  carbonDioxide: number | null;
  waterOffset: number | null;
  waterDepth: number | null;
  soilMoisture: number | null;
  soilMoistureRaw: number | null;
  batteryPercentage: number | null;
  batteryVoltage: number | null;
  status: number | null;
  error: number | null;
  createdAt: string;
};

type OrganizationNodeResponse = {
  id: string;
  name: string;
  slug: string;
  orgType: string;
  level: number | null;
  parentOrgId: string | null;
};

type OrganizationResponse = OrganizationNodeResponse & {
  path: OrganizationNodeResponse[];
};

type DeviceResponse = {
  id: string;
  modelName: string;
  latitude: number | null;
  longitude: number | null;
  mcc: number | null;
  mnc: number | null;
  organizationId: string | null;
  organization: OrganizationResponse | null;
  createdAt: string;
  updatedAt: string;
};

type TelemetryQueryResponse = {
  device: DeviceResponse;
  limit: number;
  offset: number;
  order: "asc" | "desc";
  count: number;
  readings: TelemetryReadingResponse[];
};

const organizationNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  orgType: z.string(),
  // Index into orgHierarchy: root=0, government=1, province=2, municipality=3,
  // field=4. null if the row carries an org_type outside that set.
  level: z.number().nullable(),
  parentOrgId: z.string().nullable(),
}) satisfies z.ZodType<OrganizationNodeResponse>;

const organizationSchema = organizationNodeSchema.extend({
  // Root first, the device's own organization last.
  path: z.array(organizationNodeSchema),
}) satisfies z.ZodType<OrganizationResponse>;

const deviceSchema = z.object({
  id: z.string(),
  modelName: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  mcc: z.number().nullable(),
  mnc: z.number().nullable(),
  organizationId: z.string().nullable(),
  organization: organizationSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}) satisfies z.ZodType<DeviceResponse>;

export const telemetryReadingSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  temperature: z.number().nullable(),
  humidity: z.number().nullable(),
  pressure: z.number().nullable(),
  methane: z.number().nullable(),
  methaneRaw: z.number().nullable(),
  carbonDioxide: z.number().nullable(),
  waterOffset: z.number().nullable(),
  waterDepth: z.number().nullable(),
  soilMoisture: z.number().nullable(),
  soilMoistureRaw: z.number().nullable(),
  batteryPercentage: z.number().nullable(),
  batteryVoltage: z.number().nullable(),
  status: z.number().nullable(),
  error: z.number().nullable(),
  createdAt: z.string().datetime(),
}) satisfies z.ZodType<TelemetryReadingResponse>;

export const TelemetryModel = {
  params: z.object({
    deviceId: z.string().min(1),
  }),
  query: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(TELEMETRY_QUERY_MAX_LIMIT)
      .default(TELEMETRY_QUERY_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
    order: z.enum(["asc", "desc"]).default("desc"),
  }),
  responseValid: z.object({
    device: deviceSchema,
    limit: z.number(),
    offset: z.number(),
    order: z.enum(["asc", "desc"]),
    count: z.number(),
    readings: z.array(telemetryReadingSchema),
  }) satisfies z.ZodType<TelemetryQueryResponse>,
  responseBadRequest: z.object({
    message: z.literal("Query parameter 'from' must be earlier than 'to'"),
  }),
  responseUnauthorized: z.object({
    message: z.literal("Unauthorized"),
  }),
  responseNotFound: z.object({
    message: z.literal("Device not found"),
  }),
  responseUnavailable: z.object({
    message: z.literal("Telemetry API token is not configured"),
  }),
};

export type TelemetryModel = {
  [k in keyof typeof TelemetryModel]: UnwrapSchema<(typeof TelemetryModel)[k]>;
};
