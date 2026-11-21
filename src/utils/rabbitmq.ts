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
const QUOTE_DOUBLE = "\"";
const QUOTE_SINGLE = "'";

const TELEMETRY_STATUS_FLAGS = [
  "battery_read_failed",
  "ultrasonic_read_failed",
  "temperature_read_failed",
  "methane_read_failed",
  "co2_read_failed",
  "moisture_read_failed",
] as const;
const UNKNOWN_STATUS_FLAG_PATTERN = /^unknown_bit_[0-7]$/;
const DEVICE_ID_PATTERN = /^.{3}-.{3}-.{4}$/;

type OptionalBlockField =
  | "latitude"
  | "longitude"
  | "mobile_country_code"
  | "mobile_network_code";

const telemetryStatusFlagSchema = z
  .string()
  .refine(
    (flag) =>
      (TELEMETRY_STATUS_FLAGS as readonly string[]).includes(flag) ||
      UNKNOWN_STATUS_FLAG_PATTERN.test(flag),
    { message: "must be a known status flag or unknown_bit_0-7" },
  );

const telemetryReadingSchema = z
  .object({
    timestamp: z.number().int().min(0),
    timedif: z.number().int().min(0).max(65535),
    temperature: z.number(),
    humidity: z.number().min(0).max(655.35),
    carbon_dioxide: z.number().int().min(0).max(65535),
    methane: z.number().int().min(0).max(65535),
    methane_raw: z.number().min(0).max(655.35).optional(),
    offset: z.number().int().min(0).max(65535),
    depth: z.number().int().min(0).max(65535),
    moisture: z.number().min(0).max(655.35),
    moisture_raw: z.number().int().min(0).max(65535).optional(),
    battery_voltage: z.number().int().min(0).max(65535),
    battery_percentage: z.number().min(0).max(655.35),
    esp_temperature: z.number().min(-327.68).max(327.67),
    status: z.number().int().min(0).max(255),
    status_flags: z
      .array(telemetryStatusFlagSchema)
      .refine((flags) => new Set(flags).size === flags.length, {
        message: "must not contain duplicate flags",
      }),
  })
  .strict();

const telemetryPayloadSchema: z.ZodType<TelemetryPayloadV0> = z
  .object({
    id: z.string().regex(DEVICE_ID_PATTERN),
    version: z.string().regex(/^[0-9]+$/),
    flags: z.number().int().min(0).max(255),
    readings: z.array(telemetryReadingSchema).min(1).max(255),
    has_raw: z.boolean(),
    has_gps: z.boolean(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    has_cell: z.boolean(),
    mobile_country_code: z.number().int().min(0).max(65535).optional(),
    mobile_network_code: z.number().int().min(0).max(65535).optional(),
    signal_strength: z.number().int().min(-128).max(127),
    reset_reason: z.number().int().min(0).max(255),
    reset_reason_name: z.string(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    payload.readings.forEach((reading, index) => {
      for (const field of ["methane_raw", "moisture_raw"] as const) {
        const isSet = reading[field] !== undefined;
        if (payload.has_raw && !isSet) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} is required when has_raw is true`,
            path: ["readings", index, field],
          });
        } else if (!payload.has_raw && isSet) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} must be omitted when has_raw is false`,
            path: ["readings", index, field],
          });
        }
      }
    });

    const requireWhenPresent = (
      isPresent: boolean,
      field: OptionalBlockField,
      guard: "has_gps" | "has_cell",
    ) => {
      const isSet = payload[field] !== undefined;

      if (isPresent && !isSet) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} is required when ${guard} is true`,
          path: [field],
        });
        return;
      }

      if (!isPresent && isSet) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must be omitted when ${guard} is false`,
          path: [field],
        });
      }
    };

    requireWhenPresent(payload.has_gps, "latitude", "has_gps");
    requireWhenPresent(payload.has_gps, "longitude", "has_gps");
    requireWhenPresent(payload.has_cell, "mobile_country_code", "has_cell");
    requireWhenPresent(payload.has_cell, "mobile_network_code", "has_cell");
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
    .map((issue) => {
      const instancePath = issue.path.length ? `/${issue.path.join("/")}` : "/";
      return `${instancePath} ${issue.message || "invalid value"}`;
    })
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
  if (!trimmed) {
    return undefined;
  }

  const hasLeadingQuote =
    trimmed.startsWith(QUOTE_DOUBLE) || trimmed.startsWith(QUOTE_SINGLE);
  const hasTrailingQuote =
    trimmed.endsWith(QUOTE_DOUBLE) || trimmed.endsWith(QUOTE_SINGLE);

  if (hasLeadingQuote && hasTrailingQuote && trimmed.length >= 2) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted ? unquoted : undefined;
  }

  return trimmed;
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
      message: `(rabbitmq.util.ts) Telemetry handler failed while saving payload. Rejecting with requeue=false. ${describeError(error)}`,
    });
    rejectMalformedPayload(channel, message, error);
  }
}

function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      const code = (current as { code?: string }).code;
      parts.push(code ? `${current.message} [code=${code}]` : current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" <- caused by: ");
}

function rejectMalformedPayload(
  channel: Channel,
  message: ConsumeMessage,
  error: unknown,
): void {
  logger.error({
    message: `(rabbitmq.util.ts) Sending basic.reject(requeue=false) for malformed/failed payload. ${describeError(error)}`,
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
    await channel.prefetch(options.prefetch);
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
