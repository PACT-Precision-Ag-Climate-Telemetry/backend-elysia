import { type UnwrapSchema } from "elysia";
import z from "zod";
import {
  TELEMETRY_QUERY_DEFAULT_LIMIT,
  TELEMETRY_QUERY_MAX_LIMIT,
  telemetryReadingSchema,
} from "@/modules/telemetry/model";

export const DEVICE_LIST_MAX_LIMIT = 200;
export const DEVICE_LIST_DEFAULT_LIMIT = 50;

export const DEVICE_ERROR_CODES = [
  "unauthorized",
  "device_not_found",
  "invalid_range",
] as const;

const errorSchema = z.object({
  code: z.enum(DEVICE_ERROR_CODES),
  message: z.string(),
});

/** Why the caller can see this device: they own it, or it stands in their territory. */
const visibilitySchema = z.enum(["owner", "area"]);

const deviceSchema = z.object({
  id: z.string(),
  modelName: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  mcc: z.number().nullable(),
  mnc: z.number().nullable(),
  organizationId: z.string().nullable(),
  farmFieldId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  visibility: visibilitySchema,
});

export const DeviceV1Model = {
  params: z.object({
    deviceId: z.string().min(1),
  }),
  listQuery: z.object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(DEVICE_LIST_MAX_LIMIT)
      .default(DEVICE_LIST_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  telemetryQuery: z.object({
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
  responseList: z.object({
    limit: z.number(),
    offset: z.number(),
    count: z.number(),
    devices: z.array(deviceSchema),
  }),
  responseDevice: deviceSchema.extend({
    /** The organization the visibility came through. */
    visibleThrough: z
      .object({
        organizationId: z.string(),
        orgType: z.string(),
      })
      .nullable(),
  }),
  responseTelemetry: z.object({
    deviceId: z.string(),
    visibility: visibilitySchema,
    limit: z.number(),
    offset: z.number(),
    order: z.enum(["asc", "desc"]),
    count: z.number(),
    readings: z.array(telemetryReadingSchema),
  }),
  responseError: errorSchema,
};

export type DeviceV1Model = {
  [k in keyof typeof DeviceV1Model]: UnwrapSchema<(typeof DeviceV1Model)[k]>;
};
