import { Elysia } from "elysia";
import { cors } from "@elysia/cors";
import { corsOptions } from "@/configs/cors";
import openapiApp from "@/modules/openapi";
import betterAuth from "@/modules/auth";
import hierarchyExampleApp from "@/modules/auth/hierarchy-example";
import httpLogger from "@/modules/http";
import organizationApp from "@/modules/org";
import type { TelemetryPayloadV0 } from "@/types/telemetry";
import { ingestTelemetry } from "@/utils/ingestion";
import logger from "@/utils/logger";
import { startIngestionTelemetryConsumer } from "@/utils/rabbitmq";

let stopIngestionConsumer: (() => Promise<void>) | null = null;
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const app = new Elysia({
  serve: {
    development: false,
    fetch: undefined,
  },
})
  .use(cors(corsOptions))
  .use(openapiApp)
  .use(betterAuth)
  .use(hierarchyExampleApp)
  .use(organizationApp)
  .use(httpLogger())
  .get("/", () => "Hello Elysia")
  .get("/health", () => "OK")
  .get("/user", ({ user }) => "Auth", {
    auth: true,
  });

async function bootstrap() {
  stopIngestionConsumer = await startIngestionTelemetryConsumer({
    prefetch: 10,
    onTelemetry: async (payload: TelemetryPayloadV0) => {
      await ingestTelemetry(payload);
      logger.debug(
        `(app.ts) Telemetry consumed id=${payload.id} readings=${payload.readings.length}`,
      );
    },
  });

  app.listen(port);
  logger.info(`Server running at port ${port} 🚀`);
}

async function shutdown(signal: string) {
  logger.info(`(app.ts) Received ${signal}, shutting down...`);

  if (stopIngestionConsumer) {
    try {
      await stopIngestionConsumer();
    } catch (error) {
      logger.error({
        message: "(app.ts) Failed to stop ingestion consumer cleanly",
        error,
      });
    }
  }

  try {
    await app.stop();
  } catch (error) {
    logger.error({
      message: "(app.ts) Failed to stop Elysia app cleanly",
      error,
    });
  }

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void bootstrap().catch((error) => {
  logger.error({
    message: "(app.ts) Application bootstrap failed",
    error,
  });
  process.exit(1);
});
