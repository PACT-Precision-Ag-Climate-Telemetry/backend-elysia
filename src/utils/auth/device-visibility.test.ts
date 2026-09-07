/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  AREA_VISIBILITY_MAX_LEVEL,
  areaVisibilityOrgTypes,
  ownershipOnlyOrgTypes,
  pickVisibility,
  type VisibilityRow,
} from "@/utils/auth/device-visibility";
import { orgHierarchy } from "@/utils/auth/permission";

const row = (
  organizationId: string,
  orgType: string,
  owns: boolean,
  inArea: boolean,
): VisibilityRow => ({ organizationId, orgType, owns, inArea });

describe("tier split", () => {
  it("lets levels 0-3 see by territory", () => {
    expect(areaVisibilityOrgTypes()).toEqual([
      "root",
      "government",
      "province",
      "municipality",
    ]);
  });

  it("requires level 4 to own the device", () => {
    expect(ownershipOnlyOrgTypes()).toEqual(["field"]);
  });

  it("splits exactly at the configured level", () => {
    for (const [orgType, level] of Object.entries(orgHierarchy)) {
      const seesByArea = areaVisibilityOrgTypes().includes(orgType);

      expect(seesByArea).toBe(level <= AREA_VISIBILITY_MAX_LEVEL);
    }
  });

  it("puts every org type on exactly one side of the line", () => {
    const all = [...areaVisibilityOrgTypes(), ...ownershipOnlyOrgTypes()];

    expect(all.sort()).toEqual(Object.keys(orgHierarchy).sort());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("pickVisibility", () => {
  it("denies when no organization has a claim", () => {
    expect(pickVisibility([row("o1", "province", false, false)])).toEqual({
      visible: false,
      reason: "none",
      organizationId: null,
      orgType: null,
    });
  });

  it("denies when the user has no memberships at all", () => {
    expect(pickVisibility([]).visible).toBe(false);
  });

  it("grants a province the device standing in its territory", () => {
    const result = pickVisibility([row("o1", "province", false, true)]);

    expect(result).toMatchObject({
      visible: true,
      reason: "area",
      organizationId: "o1",
    });
  });

  it("grants an owner its own device", () => {
    const result = pickVisibility([row("o9", "field", true, false)]);

    expect(result).toMatchObject({
      visible: true,
      reason: "owner",
      organizationId: "o9",
    });
  });

  it("reports ownership ahead of territory when both apply", () => {
    const result = pickVisibility([
      row("o1", "province", false, true),
      row("o9", "field", true, true),
    ]);

    expect(result.reason).toBe("owner");
    expect(result.organizationId).toBe("o9");
  });

  it("reports ownership even when the owning row comes last", () => {
    const result = pickVisibility([
      row("o1", "root", false, true),
      row("o2", "municipality", false, true),
      row("o9", "field", true, false),
    ]);

    expect(result.organizationId).toBe("o9");
  });

  it("uses the first territory that covers the device", () => {
    const result = pickVisibility([
      row("o1", "province", false, false),
      row("o2", "municipality", false, true),
    ]);

    expect(result.organizationId).toBe("o2");
    expect(result.reason).toBe("area");
  });
});
