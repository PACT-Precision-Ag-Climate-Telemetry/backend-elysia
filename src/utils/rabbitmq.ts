import amqplib, { Channel, ConsumeMessage } from "amqplib";
import { z } from "zod";
import {
  type TelemetryPayloadV0,
  type IngestErrorPayloadV0,
} from "@/types/telemetry";
import logger from "@/utils/logger";

export interface RabbitMQConsumerOptions {
  url?: string;
  queueName?: string;
  exchangeName?: string;
  topicBindingKeys?: string[];
  prefetch?: number;
  onTelemetry: (
    payload: TelemetryPayloadV0,
    message: ConsumeMessage,
  ) => Promise<void> | void;
}

const FAILED_MESSAGES_QUEUE = "failed_messages_queue";
const ERROR_HANDLER_QUEUE = "error_handler_queue";
const TELEMETRY_EXCHANGE = "pact.telemetry";
const ROUTING_KEY_INVALID_CHARACTERS = /[^A-Za-z0-9._-]/g;

const telemetryReadingSchema = z
  .object({
    timestamp: z.number().int().min(0),
    timedif: z.number().int().min(0).max(65535),
    temperature: z.number(),
    humidity: z.number(),
    pressure: z.number(),
    carbon_dioxide: z.number().int().min(0).max(65535),
    methane_raw: z.number().int().min(0).max(65535),
    methane: z.number().int().min(0).max(65535),
    offset: z.number().int().min(0).max(65535),
    depth: z.number().int().min(0).max(65535),
    moisture_raw: z.number().int().min(0).max(65535),
    moisture: z.number().min(0),
    battery_voltage: z.number().int().min(0).max(65535),
    battery_percentage: z.number().int().min(0).max(65535),
    status: z.number().int().min(0).max(255),
    error_code: z.number().int().min(0).max(255),
  })
  .strict();

const telemetryPayloadSchema: z.ZodType<TelemetryPayloadV0> = z
  .object({
    id: z.string(),
    version: z.string().regex(/^[0-9]+$/),
    flags: z.number().int().min(0).max(255),
    readings: z.array(telemetryReadingSchema).min(1),
    has_gps: z.boolean(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    has_cell: z.boolean(),
    mobile_country_code: z.number().int().min(0).max(65535).optional(),
    mobile_network_code: z.number().int().min(0).max(65535).optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (
      payload.has_gps &&
      (payload.latitude === undefined || payload.longitude === undefined)
    ) {
      if (payload.latitude === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "latitude is required when has_gps is true",
          path: ["latitude"],
        });
      }

      if (payload.longitude === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "longitude is required when has_gps is true",
          path: ["longitude"],
        });
      }
    }

    if (
      payload.has_cell &&
      (payload.mobile_country_code === undefined ||
        payload.mobile_network_code === undefined)
    ) {
      if (payload.mobile_country_code === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "mobile_country_code is required when has_cell is true",
          path: ["mobile_country_code"],
        });
      }

      if (payload.mobile_network_code === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "mobile_network_code is required when has_cell is true",
          path: ["mobile_network_code"],
        });
      }
    }
  });

const ingestErrorPayloadSchema: z.ZodType<IngestErrorPayloadV0> = z
  .object({
    source: z.string().min(1),
    error: z.string().min(1),
    payload: z.string(),
  })
  .strict();

const validateTelemetryPayload = (payload: unknown) =>
  telemetryPayloadSchema.safeParse(payload);
const validateIngestErrorPayload = (payload: unknown) =>
  ingestErrorPayloadSchema.safeParse(payload);

function formatZodErrors(issues: z.ZodIssue[] | undefined): string {
  if (!issues || issues.length === 0) {
    return "unknown validation error";
  }

  return issues
    .map((issue) => `${issue.path.join(".") || "/"} ${issue.message}`)
    .join("; ");
}

function getMessageBody(message: ConsumeMessage): string {
  return message.content.toString("utf8");
}

function sanitizeRoutingKeySegment(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const sanitized = trimmed.replace(ROUTING_KEY_INVALID_CHARACTERS, "-");
  return sanitized.trim() || fallback;
}

function getVersionMajorSegment(version: string): string {
  const majorVersion = version.trim().split(".")[0] || "";
  return sanitizeRoutingKeySegment(majorVersion, "0");
}

function normalizeEnvValue(
  value: string | undefined | null,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildTelemetryRoutingKey(
  payload: Pick<TelemetryPayloadV0, "id" | "version">,
): string {
  const versionMajor = getVersionMajorSegment(payload.version);
  const deviceId = sanitizeRoutingKeySegment(payload.id, "unknown");
  return `pact.telemetry.${versionMajor}.${deviceId}`;
}

async function processMessage(
  channel: Channel,
  message: ConsumeMessage,
  queueName: string,
  onTelemetry: RabbitMQConsumerOptions["onTelemetry"],
): Promise<void> {
  const rawBody = getMessageBody(message);

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch (error) {
    await publishIngestError(channel, {
      source: "rabbitmq_consumer",
      error: "Invalid JSON payload",
      payload: rawBody,
    });
    rejectMalformedPayload(channel, message, error);
    return;
  }

  const ingestErrorResult = validateIngestErrorPayload(parsedBody);
  if (ingestErrorResult.success) {
    const errorPayload = ingestErrorResult.data;
    logger.warn(
      `(rabbitmq.util.ts) Skip ingestion error payload. source=${errorPayload.source}, error=${errorPayload.error}`,
    );
    channel.ack(message);
    return;
  }

  const telemetryResult = validateTelemetryPayload(parsedBody);
  if (!telemetryResult.success) {
    const schemaError = formatZodErrors(telemetryResult.error.issues);
    await publishIngestError(channel, {
      source: "rabbitmq_consumer",
      error: `Telemetry schema validation failed: ${schemaError}`,
      payload: rawBody,
    });
    logger.warn(
      `(rabbitmq.util.ts) Reject invalid telemetry payload from queue=${queueName}: ${schemaError}`,
    );
    rejectMalformedPayload(channel, message, new Error(schemaError));
    return;
  }

  try {
    await onTelemetry(telemetryResult.data, message);
    channel.ack(message);
  } catch (error) {
    await publishIngestError(channel, {
      source: "rabbitmq_ack",
      error: "Telemetry handler failed",
      payload: rawBody,
    });
    logger.error({
      message: `(rabbitmq.util.ts) Telemetry handler failed while saving payload. Rejecting with requeue=false. ${error}`,
    });
    rejectMalformedPayload(channel, message, error);
  }
}

function rejectMalformedPayload(
  channel: Channel,
  message: ConsumeMessage,
  error: unknown,
): void {
  logger.error({
    message: `(rabbitmq.util.ts) Sending basic.reject(requeue=false) for malformed/failed payload. ${error}`,
  });
  channel.reject(message, false);
}

async function publishIngestError(
  channel: Channel,
  payload: IngestErrorPayloadV0,
): Promise<void> {
  try {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    channel.publish("", ERROR_HANDLER_QUEUE, body, {
      contentType: "application/json",
      deliveryMode: 2,
    });
  } catch (error) {
    logger.error({
      message: "(rabbitmq.util.ts) Failed to publish ingest error payload",
      error,
    });
  }
}

function getTopicBindingKeysFromEnvOrOptions(
  options: RabbitMQConsumerOptions,
): string[] {
  if (options.topicBindingKeys && options.topicBindingKeys.length > 0) {
    return options.topicBindingKeys;
  }

  const envValue = normalizeEnvValue(process.env.INGESTION_ROUTING_KEYS);
  if (!envValue) {
    return ["pact.telemetry.#"];
  }

  return envValue
    .split(",")
    .map((bindingKey) => bindingKey.trim())
    .filter((bindingKey) => bindingKey.length > 0);
}

export async function startIngestionTelemetryConsumer(
  options: RabbitMQConsumerOptions,
): Promise<() => Promise<void>> {
  const queueName =
    options.queueName ||
    normalizeEnvValue(process.env.RABBITMQ_QUEUE) ||
    normalizeEnvValue(process.env.INGESTION_QUEUE) ||
    "ingestion_queue";
  const exchangeName =
    options.exchangeName ||
    normalizeEnvValue(process.env.TELEMETRY_EXCHANGE) ||
    TELEMETRY_EXCHANGE;
  const topicBindingKeys = getTopicBindingKeysFromEnvOrOptions(options);
  const rabbitUrl = options.url || normalizeEnvValue(process.env.RABBITMQ_URL);

  if (!rabbitUrl) {
    throw new Error(
      "RABBITMQ_URL is required to start ingestion telemetry consumer",
    );
  }

  const connection = await amqplib.connect(rabbitUrl);
  const channel = await connection.createChannel();

  await channel.assertQueue(ERROR_HANDLER_QUEUE, { durable: true });
  await channel.assertQueue(FAILED_MESSAGES_QUEUE, { durable: true });

  await channel.assertQueue(queueName, {
    durable: true,
    deadLetterExchange: "",
    deadLetterRoutingKey: FAILED_MESSAGES_QUEUE,
  });

  await channel.assertExchange(exchangeName, "topic", {
    durable: true,
  });

  for (const bindingKey of topicBindingKeys) {
    await channel.bindQueue(queueName, exchangeName, bindingKey);
  }

  if (options.prefetch && options.prefetch > 0) {
    channel.prefetch(options.prefetch);
  }

  await channel.consume(queueName, async (message) => {
    if (!message) {
      return;
    }

    await processMessage(channel, message, queueName, options.onTelemetry);
  });

  logger.info(
    `(rabbitmq.util.ts) Ingestion consumer connected. queue=${queueName} exchange=${exchangeName} bindingKeys=${topicBindingKeys.join(",")}`,
  );

  return async () => {
    await channel.close();
    await connection.close();
    logger.info(
      `(rabbitmq.util.ts) Ingestion consumer disconnected. queue=${queueName}`,
    );
  };
}

export { validateTelemetryPayload, validateIngestErrorPayload };
