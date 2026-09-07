import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { device, telemetryV0 } from "@/db/schema";
import db from "@/utils/db";

export interface TelemetryQueryOptions {
  deviceId: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
  order: "asc" | "desc";
}

export async function deviceExists(deviceId: string): Promise<boolean> {
  const existing = await db
    .select({ id: device.id })
    .from(device)
    .where(eq(device.id, deviceId))
    .limit(1);

  return Boolean(existing[0]);
}

export async function getDeviceTelemetry({
  deviceId,
  from,
  to,
  limit,
  offset,
  order,
}: TelemetryQueryOptions) {
  const filters = [
    eq(telemetryV0.deviceId, deviceId),
    ...(from ? [gte(telemetryV0.createdAt, from)] : []),
    ...(to ? [lte(telemetryV0.createdAt, to)] : []),
  ];

  return db
    .select()
    .from(telemetryV0)
    .where(and(...filters))
    // id is the tiebreaker so paging stays stable across readings that share a
    // timestamp (a device uploads a whole batch at once).
    .orderBy(
      ...(order === "asc"
        ? [asc(telemetryV0.createdAt), asc(telemetryV0.id)]
        : [desc(telemetryV0.createdAt), desc(telemetryV0.id)]),
    )
    .limit(limit)
    .offset(offset);
}
