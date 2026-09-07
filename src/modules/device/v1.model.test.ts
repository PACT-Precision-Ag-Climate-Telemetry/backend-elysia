/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  DEVICE_LIST_DEFAULT_LIMIT,
  DEVICE_LIST_MAX_LIMIT,
  DeviceV1Model,
} from "@/modules/device/v1.model";

describe("listQuery", () => {
  it("defaults to a bounded first page", () => {
    expect(DeviceV1Model.listQuery.parse({})).toEqual({
      limit: DEVICE_LIST_DEFAULT_LIMIT,
      offset: 0,
    });
  });

  it("coerces query strings, which arrive as text", () => {
    expect(DeviceV1Model.listQuery.parse({ limit: "10", offset: "20" })).toEqual(
      { limit: 10, offset: 20 },
    );
  });

  it("refuses an unbounded page", () => {
    expect(
      DeviceV1Model.listQuery.safeParse({ limit: DEVICE_LIST_MAX_LIMIT + 1 })
        .success,
    ).toBe(false);
  });

  it("refuses a negative offset", () => {
    expect(DeviceV1Model.listQuery.safeParse({ offset: -1 }).success).toBe(
      false,
    );
  });
});

describe("telemetryQuery", () => {
  it("defaults to the newest readings first", () => {
    const parsed = DeviceV1Model.telemetryQuery.parse({});

    expect(parsed.order).toBe("desc");
    expect(parsed.limit).toBe(100);
    expect(parsed.offset).toBe(0);
  });

  it("accepts an ISO range", () => {
    const result = DeviceV1Model.telemetryQuery.safeParse({
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-07T00:00:00Z",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(
      DeviceV1Model.telemetryQuery.safeParse({ from: "last tuesday" }).success,
    ).toBe(false);
  });

  it("rejects an unknown sort order", () => {
    expect(
      DeviceV1Model.telemetryQuery.safeParse({ order: "sideways" }).success,
    ).toBe(false);
  });
});

describe("visibility in responses", () => {
  const telemetry = {
    deviceId: "ABC-DEF-1234",
    limit: 100,
    offset: 0,
    order: "desc" as const,
    count: 0,
    readings: [],
  };

  it.each(["owner", "area"])("reports %s as a reason", (visibility) => {
    expect(
      DeviceV1Model.responseTelemetry.safeParse({ ...telemetry, visibility })
        .success,
    ).toBe(true);
  });

  it("never reports 'none', which is a 404 rather than a response", () => {
    expect(
      DeviceV1Model.responseTelemetry.safeParse({
        ...telemetry,
        visibility: "none",
      }).success,
    ).toBe(false);
  });
});

describe("device response", () => {
  const base = {
    id: "ABC-DEF-1234",
    modelName: "ABC-DEF",
    latitude: 18.79,
    longitude: 98.98,
    mcc: 520,
    mnc: 3,
    organizationId: "org_1",
    farmFieldId: "ff_1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    visibility: "area" as const,
  };

  it("carries the organization the visibility came through", () => {
    const result = DeviceV1Model.responseDevice.safeParse({
      ...base,
      visibleThrough: { organizationId: "org_1", orgType: "province" },
    });

    expect(result.success).toBe(true);
  });

  it("allows a null position and unclaimed device", () => {
    const result = DeviceV1Model.responseDevice.safeParse({
      ...base,
      latitude: null,
      longitude: null,
      mcc: null,
      mnc: null,
      organizationId: null,
      farmFieldId: null,
      visibleThrough: null,
    });

    expect(result.success).toBe(true);
  });

  it("lists devices with their reason", () => {
    const result = DeviceV1Model.responseList.safeParse({
      limit: 50,
      offset: 0,
      count: 1,
      devices: [base],
    });

    expect(result.success).toBe(true);
  });
});
