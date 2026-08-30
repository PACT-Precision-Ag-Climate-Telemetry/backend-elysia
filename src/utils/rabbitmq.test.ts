/// <reference types="bun-types" />
import { describe, expect, it, beforeEach, mock } from "bun:test";

const calls: any[] = [];
let consumeHandler: (msg: any) => any;

const channel = {
  assertQueue: mock(async (q: string, o: any) => { calls.push(["assertQueue", q, o]); return {}; }),
  assertExchange: mock(async (x: string, t: string, o: any) => { calls.push(["assertExchange", x, t, o]); return {}; }),
  bindQueue: mock(async (q: string, x: string, k: string) => { calls.push(["bindQueue", q, x, k]); return {}; }),
  prefetch: mock(async (n: number) => { calls.push(["prefetch", n]); return {}; }),
  consume: mock(async (q: string, fn: any) => { calls.push(["consume", q]); consumeHandler = fn; return { consumerTag: "t" }; }),
  publish: mock((x: string, rk: string, body: Buffer, o: any) => { calls.push(["publish", x, rk, JSON.parse(body.toString("utf8")), o]); return true; }),
  ack: mock((m: any) => { calls.push(["ack"]); }),
  reject: mock((m: any, requeue: boolean) => { calls.push(["reject", requeue]); }),
  close: mock(async () => { calls.push(["channel.close"]); }),
};
const connection = {
  createChannel: mock(async () => channel),
  close: mock(async () => { calls.push(["connection.close"]); }),
};
const connect = mock(async (url: string) => { calls.push(["connect", url]); return connection; });

mock.module("amqplib", () => ({ default: { connect }, connect }));

const { startIngestionTelemetryConsumer, buildTelemetryRoutingKey, validateTelemetryPayload } = await import("@/utils/rabbitmq");

const reading = {
  timestamp: 1756512000, timedif: 300, temperature: 23.100000381469727, humidity: 61.5,
  pressure: 1008.25, carbon_dioxide: 412, methane_raw: 1350, methane: 8, offset: 120,
  depth: 940, moisture_raw: 2100, moisture: 34.5, battery_voltage: 3980,
  battery_percentage: 87.25, status: 0, status_flags: [], error_code: 0,
};
const validPayload = {
  id: "ABC-DEF-1234", version: "0", flags: 128, readings: [reading],
  has_gps: true, latitude: 13.7563, longitude: 100.5018, has_cell: false,
};
const msg = (body: string) => ({ content: Buffer.from(body, "utf8"), fields: {}, properties: {} });

async function start(onTelemetry: any = async () => {}) {
  calls.length = 0;
  return startIngestionTelemetryConsumer({
    url: "amqp://x", queueName: "ingestion_queue", prefetch: 10, onTelemetry,
  });
}
const kinds = () => calls.map((c) => c[0]);
const published = () => calls.filter((c) => c[0] === "publish");

describe("acceptance", () => {
  beforeEach(() => {
    delete process.env.RABBITMQ_URL;
    delete process.env.RABBITMQ_QUEUE;
    delete process.env.INGESTION_QUEUE;
    delete process.env.TELEMETRY_EXCHANGE;
    delete process.env.INGESTION_ROUTING_KEYS;
  });

  it("1. throws without RABBITMQ_URL", async () => {
    await expect(startIngestionTelemetryConsumer({ onTelemetry: async () => {} }))
      .rejects.toThrow("RABBITMQ_URL is required to start ingestion telemetry consumer");
  });

  it("2. declares topology durable, in order", async () => {
    await start();
    expect(calls.slice(1, 7)).toEqual([
      ["assertQueue", "error_handler_queue", { durable: true }],
      ["assertQueue", "failed_messages_queue", { durable: true }],
      ["assertQueue", "ingestion_queue", { durable: true, deadLetterExchange: "", deadLetterRoutingKey: "failed_messages_queue" }],
      ["assertExchange", "pact.telemetry", "topic", { durable: true }],
      ["bindQueue", "ingestion_queue", "pact.telemetry", "pact.telemetry.#"],
      ["prefetch", 10],
    ]);
    expect(calls[7][0]).toBe("consume");
  });

  it("3. invalid JSON -> error record + reject(false)", async () => {
    await start();
    calls.length = 0;
    await consumeHandler(msg("{not json"));
    expect(published()[0].slice(1, 3)).toEqual(["", "error_handler_queue"]);
    expect(published()[0][3]).toMatchObject({ source: "rabbitmq_consumer", error: "Invalid JSON payload", payload: "{not json" });
    expect(published()[0][4]).toMatchObject({ contentType: "application/json", deliveryMode: 2 });
    expect(calls).toContainEqual(["reject", false]);
    expect(kinds()).not.toContain("ack");
  });

  it("4. missing reading field -> rejected, path named", async () => {
    await start();
    calls.length = 0;
    const { timestamp, ...rest } = reading;
    await consumeHandler(msg(JSON.stringify({ ...validPayload, readings: [rest] })));
    expect(published()[0][3].error).toContain("/readings/0/timestamp");
    expect(calls).toContainEqual(["reject", false]);
  });

  it("5. has_gps true without latitude -> rejected", async () => {
    await start();
    calls.length = 0;
    const { latitude, ...noLat } = validPayload;
    await consumeHandler(msg(JSON.stringify(noLat)));
    expect(published()[0][3].error).toContain("latitude");
    expect(calls).toContainEqual(["reject", false]);
  });

  it("6. unknown extra property -> rejected", async () => {
    await start();
    calls.length = 0;
    await consumeHandler(msg(JSON.stringify({ ...validPayload, bogus: 1 })));
    expect(published()[0][3].error).toContain("Telemetry schema validation failed");
    expect(calls).toContainEqual(["reject", false]);
  });

  it("7. ingest-error-shaped -> acked, not dead-lettered, no new error", async () => {
    await start();
    calls.length = 0;
    await consumeHandler(msg(JSON.stringify({ source: "rabbitmq_consumer", error: "boom", payload: "{}" })));
    expect(kinds()).toEqual(["ack"]);
  });

  it("8. handler throws -> rabbitmq_ack error record + dead-letter", async () => {
    await start(async () => { throw new Error("db down"); });
    calls.length = 0;
    await consumeHandler(msg(JSON.stringify(validPayload)));
    expect(published()[0][3]).toMatchObject({ source: "rabbitmq_ack", error: "Telemetry handler failed" });
    expect(calls).toContainEqual(["reject", false]);
  });

  it("9. valid payload -> handler once, ack, no error records", async () => {
    let seen = 0;
    await start(async (p: any) => { seen++; expect(p.id).toBe("ABC-DEF-1234"); });
    calls.length = 0;
    await consumeHandler(msg(JSON.stringify(validPayload)));
    expect(seen).toBe(1);
    expect(kinds()).toEqual(["ack"]);
  });

  it("9b. null delivery is ignored", async () => {
    await start();
    calls.length = 0;
    await consumeHandler(null);
    expect(calls).toEqual([]);
  });

  it("10. stop closes channel then connection", async () => {
    const stop = await start();
    calls.length = 0;
    await stop();
    expect(kinds()).toEqual(["channel.close", "connection.close"]);
  });

  it("11. routing key builder", () => {
    expect(buildTelemetryRoutingKey({ id: "AB C/1", version: "2.4.1" })).toBe("pact.telemetry.2.AB-C-1");
    expect(buildTelemetryRoutingKey({ id: "ABC-DEF-1234", version: "0" })).toBe("pact.telemetry.0.ABC-DEF-1234");
    expect(buildTelemetryRoutingKey({ id: "  ", version: "  " })).toBe("pact.telemetry.0.unknown");
  });
});

describe("config resolution", () => {
  beforeEach(() => {
    delete process.env.RABBITMQ_URL;
    delete process.env.RABBITMQ_QUEUE;
    delete process.env.INGESTION_QUEUE;
    delete process.env.TELEMETRY_EXCHANGE;
    delete process.env.INGESTION_ROUTING_KEYS;
  });

  it("strips quotes around env values", async () => {
    process.env.RABBITMQ_URL = '  "amqp://quoted"  ';
    process.env.RABBITMQ_QUEUE = "'pact_backend'";
    process.env.INGESTION_ROUTING_KEYS = '"pact.telemetry.#, pact.telemetry.2.*"';
    calls.length = 0;
    await startIngestionTelemetryConsumer({ onTelemetry: async () => {} });
    expect(calls[0]).toEqual(["connect", "amqp://quoted"]);
    expect(calls.filter((c) => c[0] === "bindQueue")).toEqual([
      ["bindQueue", "pact_backend", "pact.telemetry", "pact.telemetry.#"],
      ["bindQueue", "pact_backend", "pact.telemetry", "pact.telemetry.2.*"],
    ]);
  });

  it("falls back INGESTION_QUEUE then default, options win", async () => {
    process.env.RABBITMQ_URL = "amqp://x";
    process.env.INGESTION_QUEUE = "legacy_queue";
    calls.length = 0;
    await startIngestionTelemetryConsumer({ onTelemetry: async () => {} });
    expect(calls[3][1]).toBe("legacy_queue");

    process.env.RABBITMQ_QUEUE = "   ";
    calls.length = 0;
    await startIngestionTelemetryConsumer({ onTelemetry: async () => {} });
    expect(calls[3][1]).toBe("legacy_queue");

    delete process.env.INGESTION_QUEUE;
    calls.length = 0;
    await startIngestionTelemetryConsumer({ onTelemetry: async () => {} });
    expect(calls[3][1]).toBe("ingestion_queue");
  });

  it("skips prefetch when absent or not positive", async () => {
    process.env.RABBITMQ_URL = "amqp://x";
    calls.length = 0;
    await startIngestionTelemetryConsumer({ prefetch: 0, onTelemetry: async () => {} });
    expect(kinds()).not.toContain("prefetch");
  });
});

describe("telemetry schema v0", () => {
  const ok = (p: any) => validateTelemetryPayload(p).success;
  const errs = (p: any) => {
    const r = validateTelemetryPayload(p);
    return r.success ? "" : JSON.stringify(r.error.issues);
  };
  const withReading = (patch: any) => ({
    ...validPayload,
    readings: [{ ...reading, ...patch }],
  });

  it("accepts the schema's own example payload", () => {
    expect(ok({
      id: "ABC-DEF-1234", version: "0", flags: 128,
      readings: [
        { ...reading },
        { timestamp: 1756512300, timedif: 300, temperature: 23.5, humidity: 60.75,
          pressure: 1008.1, carbon_dioxide: 418, methane_raw: 1361, methane: 9, offset: 120,
          depth: 938, moisture_raw: 2094, moisture: 34.2, battery_voltage: 3975,
          battery_percentage: 87.1, status: 2, status_flags: ["ultrasonic_read_failed"],
          error_code: 0 },
      ],
      has_gps: true, latitude: 13.7563, longitude: 100.5018, has_cell: false,
    })).toBe(true);
  });

  it("requires status_flags on every reading", () => {
    const { status_flags, ...noFlags } = reading;
    expect(errs({ ...validPayload, readings: [noFlags] })).toContain("status_flags");
  });

  it("accepts known flags and unknown_bit_N, rejects anything else", () => {
    expect(ok(withReading({ status: 255, status_flags: [
      "battery_read_failed", "ultrasonic_read_failed", "temperature_read_failed",
      "methane_read_failed", "co2_read_failed", "unknown_bit_0", "unknown_bit_7",
    ] }))).toBe(true);
    expect(ok(withReading({ status_flags: ["unknown_bit_8"] }))).toBe(false);
    expect(ok(withReading({ status_flags: ["gps_read_failed"] }))).toBe(false);
  });

  it("rejects duplicate status_flags", () => {
    expect(errs(withReading({ status: 2, status_flags: ["ultrasonic_read_failed", "ultrasonic_read_failed"] })))
      .toContain("duplicate");
  });

  it("rejects gps/cell fields when the block is absent", () => {
    const { latitude, longitude, ...base } = validPayload;
    expect(ok({ ...base, has_gps: false })).toBe(true);
    expect(errs({ ...base, has_gps: false, latitude: 13.7 })).toContain("omitted");
    expect(errs({ ...base, has_gps: false, longitude: 100.5 })).toContain("omitted");
    expect(errs({ ...validPayload, mobile_country_code: 520 })).toContain("omitted");
    expect(ok({ ...validPayload, has_cell: true, mobile_country_code: 520, mobile_network_code: 0 })).toBe(true);
  });

  it("enforces the device id pattern", () => {
    expect(ok({ ...validPayload, id: "AB-DEF-1234" })).toBe(false);
    expect(ok({ ...validPayload, id: "ABC-DEF-12345" })).toBe(false);
    expect(ok({ ...validPayload, id: "XYZ-123-ABCD" })).toBe(true);
  });

  it("bounds readings, coordinates and codes", () => {
    expect(ok({ ...validPayload, readings: Array(255).fill(reading) })).toBe(true);
    expect(ok({ ...validPayload, readings: Array(256).fill(reading) })).toBe(false);
    expect(ok({ ...validPayload, latitude: 91 })).toBe(false);
    expect(ok({ ...validPayload, longitude: -181 })).toBe(false);
    expect(ok(withReading({ moisture: 655.36 }))).toBe(false);
    expect(ok(withReading({ battery_percentage: 655.35 }))).toBe(true);
  });
});
