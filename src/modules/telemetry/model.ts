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

type TelemetryQueryResponse = {
  deviceId: string;
  limit: number;
  offset: number;
  order: "asc" | "desc";
  count: number;
  readings: TelemetryReadingResponse[];
};

const readingSchema = z.object({
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
    deviceId: z.string(),
    limit: z.number(),
    offset: z.number(),
    order: z.enum(["asc", "desc"]),
    count: z.number(),
    readings: z.array(readingSchema),
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
