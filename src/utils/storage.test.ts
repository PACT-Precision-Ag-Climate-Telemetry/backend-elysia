/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  isAbsoluteUrl,
  isStorageConfigured,
  readStorageConfig,
  resolveStoredUrl,
} from "@/utils/storage";

const KEYS = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_REGION",
  "S3_PUBLIC_BASE_URL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

function configure(extra: Record<string, string> = {}) {
  process.env.S3_ENDPOINT = "http://garage.local:3900";
  process.env.S3_BUCKET = "pact";
  process.env.S3_ACCESS_KEY_ID = "key";
  process.env.S3_SECRET_ACCESS_KEY = "secret";

  for (const [key, value] of Object.entries(extra)) {
    process.env[key] = value;
  }
}

describe("readStorageConfig", () => {
  it("is null until every required variable is set", () => {
    expect(readStorageConfig()).toBeNull();
    expect(isStorageConfigured()).toBe(false);
  });

  it("is still null when one is missing", () => {
    configure();
    delete process.env.S3_SECRET_ACCESS_KEY;

    expect(readStorageConfig()).toBeNull();
  });

  it("treats a blank value as missing", () => {
    configure({ S3_BUCKET: "   " });

    expect(readStorageConfig()).toBeNull();
  });

  it("defaults the region, which Garage ignores but the signer needs", () => {
    configure();

    expect(readStorageConfig()?.region).toBe("garage");
  });

  it("trims a trailing slash off the public base URL", () => {
    configure({ S3_PUBLIC_BASE_URL: "https://cdn.example.org/" });

    expect(readStorageConfig()?.publicBaseUrl).toBe("https://cdn.example.org");
  });
});

describe("isAbsoluteUrl", () => {
  it.each([
    ["https://cdn.example.org/logo.webp", true],
    ["http://cdn.example.org/logo.webp", true],
    ["org/abc/logo/deadbeef.webp", false],
    ["/org/abc/logo.webp", false],
  ])("%s -> %s", (value, expected) => {
    expect(isAbsoluteUrl(value)).toBe(expected as boolean);
  });
});

describe("resolveStoredUrl", () => {
  it("returns null for no logo", () => {
    expect(resolveStoredUrl(null)).toBeNull();
  });

  it("passes an absolute URL through, for values predating uploads", () => {
    configure({ S3_PUBLIC_BASE_URL: "https://cdn.example.org" });

    expect(resolveStoredUrl("https://elsewhere.example/logo.png")).toBe(
      "https://elsewhere.example/logo.png",
    );
  });

  it("composes a key against the public base URL", () => {
    configure({ S3_PUBLIC_BASE_URL: "https://cdn.example.org" });

    expect(resolveStoredUrl("org/o1/logo/abc.webp")).toBe(
      "https://cdn.example.org/org/o1/logo/abc.webp",
    );
  });

  it("returns null for a key when the bucket is not publicly served", () => {
    configure();

    expect(resolveStoredUrl("org/o1/logo/abc.webp")).toBeNull();
  });
});
