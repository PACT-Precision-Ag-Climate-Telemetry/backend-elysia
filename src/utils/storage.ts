import { S3Client } from "bun";
import logger from "@/utils/logger";

/**
 * Object storage, against Garage or any other S3-compatible service.
 *
 * Uses Bun's built-in S3 client, so there is no AWS SDK in the dependency tree.
 */

export interface StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Base URL the bucket is publicly served from, if it is. */
  publicBaseUrl: string | null;
}

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();

  return value ? value : null;
}

export function readStorageConfig(): StorageConfig | null {
  const endpoint = readEnv("S3_ENDPOINT");
  const bucket = readEnv("S3_BUCKET");
  const accessKeyId = readEnv("S3_ACCESS_KEY_ID");
  const secretAccessKey = readEnv("S3_SECRET_ACCESS_KEY");

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    // Garage ignores the region, but the SigV4 signer still needs one.
    region: readEnv("S3_REGION") ?? "garage",
    publicBaseUrl: readEnv("S3_PUBLIC_BASE_URL")?.replace(/\/+$/, "") ?? null,
  };
}

export function isStorageConfigured(): boolean {
  return readStorageConfig() !== null;
}

let cached: { config: StorageConfig; client: S3Client } | null = null;

function getClient(): S3Client | null {
  const config = readStorageConfig();

  if (!config) {
    return null;
  }

  if (cached && cached.config.endpoint === config.endpoint) {
    return cached.client;
  }

  const client = new S3Client({
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    // Path-style addressing. Virtual-hosted style needs wildcard DNS, which a
    // self-hosted Garage usually is not set up for.
    virtualHostedStyle: false,
  });

  cached = { config, client };

  return client;
}

export class StorageNotConfiguredError extends Error {}

function requireClient(): S3Client {
  const client = getClient();

  if (!client) {
    throw new StorageNotConfiguredError(
      "S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must all be set",
    );
  }

  return client;
}

export async function putObject(
  key: string,
  data: Uint8Array,
  contentType: string,
): Promise<void> {
  await requireClient().write(key, data, { type: contentType });
}

/**
 * Deletes an object, treating failure as non-fatal.
 *
 * Used to clean up a logo that has been replaced. A leftover object wastes a
 * few kilobytes; a thrown error here would fail a request whose actual work has
 * already succeeded.
 */
export async function deleteObjectQuietly(key: string): Promise<boolean> {
  try {
    await requireClient().delete(key);

    return true;
  } catch (error) {
    logger.warn({
      message: "(storage.util.ts) Failed to delete object",
      key,
      error,
    });

    return false;
  }
}

/** True when the stored value is an absolute URL rather than a key of ours. */
export function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Turns a stored `organization.logo` into something a browser can fetch.
 *
 * The column holds a storage key for anything uploaded through the API, but it
 * may still hold an absolute URL from before uploads existed, so both are
 * handled. Keys are resolved against S3_PUBLIC_BASE_URL at read time, which is
 * why the column stores the key: moving the public domain then costs nothing.
 */
export function resolveStoredUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  if (isAbsoluteUrl(value)) {
    return value;
  }

  const config = readStorageConfig();

  if (!config?.publicBaseUrl) {
    return null;
  }

  return `${config.publicBaseUrl}/${value}`;
}
