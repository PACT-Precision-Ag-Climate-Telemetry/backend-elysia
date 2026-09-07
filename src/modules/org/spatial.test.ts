/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isAreaSourceAllowed, tiersAbove } from "@/modules/org/spatial";

describe("tiersAbove", () => {
  it("lists every tier above a field", () => {
    expect(tiersAbove("field")).toEqual([
      "root",
      "government",
      "province",
      "municipality",
    ]);
  });

  it("lists only the tiers above a province", () => {
    expect(tiersAbove("province")).toEqual(["root", "government"]);
  });

  it("returns nothing for root, which can have no parent", () => {
    expect(tiersAbove("root")).toEqual([]);
  });

  it("returns nothing for an org type outside the hierarchy", () => {
    expect(tiersAbove("not-a-tier")).toEqual([]);
  });
});

describe("isAreaSourceAllowed", () => {
  it("lets a field draw a custom boundary", () => {
    expect(isAreaSourceAllowed("field", "custom")).toBe(true);
  });

  it("refuses a custom boundary at every higher tier", () => {
    for (const orgType of ["root", "government", "province", "municipality"]) {
      expect(isAreaSourceAllowed(orgType, "custom")).toBe(false);
    }
  });

  it("allows reference boundaries at every tier, field included", () => {
    for (const orgType of [
      "root",
      "government",
      "province",
      "municipality",
      "field",
    ]) {
      expect(isAreaSourceAllowed(orgType, "reference")).toBe(true);
    }
  });
});
