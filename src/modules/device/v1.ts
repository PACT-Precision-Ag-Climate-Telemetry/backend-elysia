import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { device } from "@/db/schema";
import betterAuth from "@/modules/auth";
import { DeviceV1Model } from "@/modules/device/v1.model";
import { getDeviceTelemetry } from "@/modules/telemetry/service";
import { auth } from "@/utils/auth";
import {
  canUserViewDevice,
  listVisibleDevices,
  type VisibleDevice,
} from "@/utils/auth/device-visibility";
import db from "@/utils/db";

/**
 * v1 device and telemetry queries for a signed-in user.
 *
 * Every route is scoped by the organization rules rather than by a shared
 * secret: levels 0-3 see any device standing in their territory, level 4 sees
 * only what it owns. See @/utils/auth/device-visibility.
 *
 * A device the caller cannot see is reported as 404 rather than 403. Answering
 * "it exists but is not yours" would leak the presence and id of devices in
 * territories the caller has no claim on.
 */

function serializeDevice(row: VisibleDevice) {
  return {
    id: row.id,
    modelName: row.modelName,
    latitude: row.latitude,
    longitude: row.longitude,
    mcc: row.mcc,
    mnc: row.mnc,
    organizationId: row.organizationId,
    farmFieldId: row.farmFieldId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    visibility: row.reason,
  };
}

const deviceV1App = new Elysia({ name: "device-v1", prefix: "/v1/device" })
  .use(betterAuth)
  .get(
    "/",
    async ({ query, request, status }) => {
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session) {
        return status(401, {
          code: "unauthorized" as const,
          message: "Authentication is required to list devices",
        });
      }

      const { limit, offset } = query;

      const devices = await listVisibleDevices(session.user.id, {
        limit,
        offset,
      });

      return status(200, {
        limit,
        offset,
        count: devices.length,
        devices: devices.map(serializeDevice),
      });
    },
    {
      auth: true,
      query: DeviceV1Model.listQuery,
      response: {
        200: DeviceV1Model.responseList,
        401: DeviceV1Model.responseError,
      },
      detail: {
        summary: "List devices visible to the caller",
        description:
          "Scoped by the organization rules: territory for levels 0-3, ownership for level 4.",
        tags: ["Device"],
      },
    },
  )
  .get(
    "/:deviceId",
    async ({ params, request, status }) => {
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session) {
        return status(401, {
          code: "unauthorized" as const,
          message: "Authentication is required to read a device",
        });
      }

      const { deviceId } = params;

      const visibility = await canUserViewDevice(session.user.id, deviceId);

      if (!visibility.visible || visibility.reason === "none") {
        return status(404, {
          code: "device_not_found" as const,
          message: "Device not found",
        });
      }

      const [row] = await db
        .select()
        .from(device)
        .where(eq(device.id, deviceId))
        .limit(1);

      if (!row) {
        return status(404, {
          code: "device_not_found" as const,
          message: "Device not found",
        });
      }

      return status(200, {
        ...serializeDevice({ ...row, reason: visibility.reason }),
        visibleThrough:
          visibility.organizationId && visibility.orgType
            ? {
                organizationId: visibility.organizationId,
                orgType: visibility.orgType,
              }
            : null,
      });
    },
    {
      auth: true,
      params: DeviceV1Model.params,
      response: {
        200: DeviceV1Model.responseDevice,
        401: DeviceV1Model.responseError,
        404: DeviceV1Model.responseError,
      },
      detail: {
        summary: "Read one device",
        tags: ["Device"],
      },
    },
  )
  .get(
    "/:deviceId/telemetry",
    async ({ params, query, request, status }) => {
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session) {
        return status(401, {
          code: "unauthorized" as const,
          message: "Authentication is required to read telemetry",
        });
      }

      const { deviceId } = params;
      const { limit, offset, order } = query;

      const from = query.from ? new Date(query.from) : undefined;
      const to = query.to ? new Date(query.to) : undefined;

      if (from && to && from > to) {
        return status(400, {
          code: "invalid_range" as const,
          message: "Query parameter 'from' must be earlier than 'to'",
        });
      }

      // Visibility is checked before the device is even confirmed to exist, so
      // both cases answer the same way and neither reveals the other.
      const visibility = await canUserViewDevice(session.user.id, deviceId);

      if (!visibility.visible || visibility.reason === "none") {
        return status(404, {
          code: "device_not_found" as const,
          message: "Device not found",
        });
      }

      const rows = await getDeviceTelemetry({
        deviceId,
        from,
        to,
        limit,
        offset,
        order,
      });

      return status(200, {
        deviceId,
        visibility: visibility.reason,
        limit,
        offset,
        order,
        count: rows.length,
        readings: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    },
    {
      auth: true,
      params: DeviceV1Model.params,
      query: DeviceV1Model.telemetryQuery,
      response: {
        200: DeviceV1Model.responseTelemetry,
        400: DeviceV1Model.responseError,
        401: DeviceV1Model.responseError,
        404: DeviceV1Model.responseError,
      },
      detail: {
        summary: "Query a device's telemetry",
        description:
          "Same range, paging and ordering as the temporary bearer endpoint, but scoped to the caller's organizations.",
        tags: ["Device", "Telemetry"],
      },
    },
  );

export default deviceV1App;
