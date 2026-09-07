import { Elysia } from "elysia";
import bearerAuth from "@/modules/telemetry/bearer";
import { TelemetryModel } from "@/modules/telemetry/model";
import { deviceExists, getDeviceTelemetry } from "@/modules/telemetry/service";

/**
 * TEMPORARY read-only telemetry API.
 *
 * Guarded by a single static token in `TELEMETRY_API_TOKEN` (see ./bearer.ts),
 * not by a session, so it performs no organization scoping — any holder of the
 * token can read any device. Remove it, or move it behind better-auth with the
 * org hierarchy checks used in @/modules/org, once the dashboard can query
 * telemetry through an authenticated session.
 */
const telemetryApp = new Elysia({ name: "telemetry", prefix: "/telemetry" })
  .use(bearerAuth)
  .get(
    "/devices/:deviceId",
    async ({ params, query, status }) => {
      const { deviceId } = params;
      const { limit, offset, order } = query;

      const from = query.from ? new Date(query.from) : undefined;
      const to = query.to ? new Date(query.to) : undefined;

      if (from && to && from > to) {
        return status(400, {
          message: "Query parameter 'from' must be earlier than 'to'",
        } as const);
      }

      if (!(await deviceExists(deviceId))) {
        return status(404, { message: "Device not found" } as const);
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
      bearer: true,
      params: TelemetryModel.params,
      query: TelemetryModel.query,
      response: {
        200: TelemetryModel.responseValid,
        400: TelemetryModel.responseBadRequest,
        401: TelemetryModel.responseUnauthorized,
        404: TelemetryModel.responseNotFound,
        503: TelemetryModel.responseUnavailable,
      },
      detail: {
        summary: "Query telemetry for a device (temporary)",
        description:
          "Temporary endpoint. Requires `Authorization: Bearer <TELEMETRY_API_TOKEN>`.",
        tags: ["Telemetry"],
      },
    },
  );

export default telemetryApp;
