import { createHash, timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import logger from "@/utils/logger";

const BEARER_PREFIX = "bearer ";

/**
 * TEMPORARY: static shared-secret bearer auth for the telemetry query endpoint.
 * Replace with a real credential (better-auth API keys / bearer plugin) before
 * this leaves internal use. See src/modules/telemetry/index.ts.
 */
function readConfiguredToken(): string | null {
  const raw = process.env.TELEMETRY_API_TOKEN?.trim();

  return raw ? raw : null;
}

function tokensMatch(provided: string, expected: string): boolean {
  // Hash both sides first so the comparison is constant time regardless of the
  // supplied token's length.
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}

const bearerAuth = new Elysia({ name: "telemetry-bearer-auth" }).macro({
  bearer: {
    resolve({ status, request: { headers } }) {
      const expected = readConfiguredToken();

      if (!expected) {
        logger.error(
          "(telemetry) TELEMETRY_API_TOKEN is not configured, rejecting request",
        );

        return status(503, {
          message: "Telemetry API token is not configured",
        });
      }

      const authorization = headers.get("authorization") ?? "";

      if (!authorization.toLowerCase().startsWith(BEARER_PREFIX)) {
        return status(401, { message: "Unauthorized" });
      }

      const provided = authorization.slice(BEARER_PREFIX.length).trim();

      if (!provided || !tokensMatch(provided, expected)) {
        return status(401, { message: "Unauthorized" });
      }

      return {};
    },
  },
});

export default bearerAuth;
