import { eq } from "drizzle-orm";
import { device, telemetryV0 } from "@/db/schema";
import type { TelemetryPayloadV0 } from "@/types/telemetry";
import db from "@/utils/db";

function sanitizeIdentifier(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type TelemetryTransaction = Pick<typeof db, "select" | "update" | "insert">;

async function ensureDevice(
  tx: TelemetryTransaction,
  payload: TelemetryPayloadV0,
): Promise<void> {
  const existing = await tx
    .select({ id: device.id })
    .from(device)
    .where(eq(device.id, payload.id))
    .limit(1);

  const modelName =
    sanitizeIdentifier(payload.id).split("-").slice(0, 2).join("-") ||
    payload.id;

  if (!existing[0]) {
    await tx.insert(device).values({
      id: payload.id,
      modelName,
      latitude: payload.has_gps ? (payload.latitude ?? null) : null,
      longitude: payload.has_gps ? (payload.longitude ?? null) : null,
      mcc: payload.has_cell ? (payload.mobile_country_code ?? null) : null,
      mnc: payload.has_cell ? (payload.mobile_network_code ?? null) : null,
      organizationId: null,
      createdAt: new Date(),
    });

    return;
  }

  await tx
    .update(device)
    .set({
      modelName,
      updatedAt: new Date(),
      ...(payload.has_gps && payload.latitude !== undefined
        ? { latitude: payload.latitude }
        : {}),
      ...(payload.has_gps && payload.longitude !== undefined
        ? { longitude: payload.longitude }
        : {}),
      ...(payload.has_cell && payload.mobile_country_code !== undefined
        ? { mcc: payload.mobile_country_code }
        : {}),
      ...(payload.has_cell && payload.mobile_network_code !== undefined
        ? { mnc: payload.mobile_network_code }
        : {}),
    })
    .where(eq(device.id, payload.id));
}

export async function ingestTelemetry(
  payload: TelemetryPayloadV0,
): Promise<void> {
  await db.transaction(async (tx) => {
    await ensureDevice(tx, payload);

    for (const reading of payload.readings) {
      const readingTimestamp = new Date(reading.timestamp * 1000);

      await tx.insert(telemetryV0).values({
        deviceId: payload.id,
        temperature: reading.temperature,
        humidity: reading.humidity,
        pressure: reading.pressure,
        methane: reading.methane,
        methaneRaw: reading.methane_raw,
        carbonDioxide: reading.carbon_dioxide,
        waterOffset: reading.offset,
        waterDepth: reading.depth,
        soilMoisture: reading.moisture,
        soilMoistureRaw: reading.moisture_raw,
        batteryPercentage: reading.battery_percentage,
        batteryVoltage: reading.battery_voltage,
        status: reading.status,
        error: reading.error_code,
        createdAt: Number.isNaN(readingTimestamp.getTime())
          ? new Date()
          : readingTimestamp,
      });
    }
  });
}
