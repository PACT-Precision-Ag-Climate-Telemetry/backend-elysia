/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { OrgV1Model } from "@/modules/org/v1.model";
import generateSlug from "@/utils/slug";

const validName = "Mae On Rice Field";

describe("orgType", () => {
  it("defaults to field, so a new user creating a plot needs no tier", () => {
    const parsed = OrgV1Model.body.parse({ orgName: validName });

    expect(parsed.orgType).toBe("field");
  });

  it("rejects a tier outside the hierarchy", () => {
    const result = OrgV1Model.body.safeParse({
      orgName: validName,
      orgType: "district",
    });

    expect(result.success).toBe(false);
  });
});

describe("slug", () => {
  it("is optional, because a field is assigned one", () => {
    expect(
      OrgV1Model.body.safeParse({ orgName: validName, orgType: "field" })
        .success,
    ).toBe(true);
  });

  it("accepts a lowercase hyphenated slug", () => {
    const result = OrgV1Model.body.safeParse({
      orgName: validName,
      orgType: "province",
      slug: "chiang-mai",
    });

    expect(result.success).toBe(true);
  });

  it.each([
    ["uppercase", "Chiang-Mai"],
    ["underscore", "chiang_mai"],
    ["double hyphen", "chiang--mai"],
    ["leading hyphen", "-chiang"],
    ["trailing hyphen", "chiang-"],
    ["space", "chiang mai"],
    ["too short", "cm"],
  ])("rejects a slug with %s", (_label, slug) => {
    const result = OrgV1Model.body.safeParse({
      orgName: validName,
      orgType: "province",
      slug,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a slug longer than 64 characters", () => {
    const result = OrgV1Model.body.safeParse({
      orgName: validName,
      orgType: "province",
      slug: "a".repeat(65),
    });

    expect(result.success).toBe(false);
  });

  it("accepts every slug the generator produces", () => {
    // A generated slug that failed its own schema would only surface in
    // production, so check the two agree.
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = OrgV1Model.body.safeParse({
        orgName: validName,
        orgType: "province",
        slug: generateSlug(),
      });

      expect(result.success).toBe(true);
    }
  });
});

describe("error envelope", () => {
  it("carries a known code alongside the message", () => {
    const result = OrgV1Model.responseError.safeParse({
      code: "slug_required",
      message: "slug is required for this organization type",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a code outside the documented set", () => {
    const result = OrgV1Model.responseError.safeParse({
      code: "made_up",
      message: "x",
    });

    expect(result.success).toBe(false);
  });
});

describe("created response", () => {
  it("records how the slug was chosen", () => {
    const base = {
      id: "o1",
      name: validName,
      slug: "brave-otter-0001",
      createdAt: new Date().toISOString(),
      logo: null,
      orgType: "field",
      parentOrgId: null,
      parentResolution: null,
      areaSource: null,
      members: [],
    };

    expect(
      OrgV1Model.responseCreated.safeParse({ ...base, slugSource: "generated" })
        .success,
    ).toBe(true);
    expect(
      OrgV1Model.responseCreated.safeParse({ ...base, slugSource: "invented" })
        .success,
    ).toBe(false);
  });
});

describe("updateBody", () => {
  it("accepts a single changed field", () => {
    expect(
      OrgV1Model.updateBody.safeParse({ orgName: "Renamed Organization" })
        .success,
    ).toBe(true);
  });

  it("accepts a null logo, so it can be cleared", () => {
    expect(OrgV1Model.updateBody.safeParse({ logo: null }).success).toBe(true);
  });

  it("rejects an empty body rather than issuing a no-op update", () => {
    expect(OrgV1Model.updateBody.safeParse({}).success).toBe(false);
  });

  it("applies the same slug rules as creation", () => {
    expect(OrgV1Model.updateBody.safeParse({ slug: "chiang-mai" }).success).toBe(
      true,
    );
    expect(OrgV1Model.updateBody.safeParse({ slug: "Chiang_Mai" }).success).toBe(
      false,
    );
  });

  it("applies the same name rules as creation", () => {
    expect(OrgV1Model.updateBody.safeParse({ orgName: "ab" }).success).toBe(
      false,
    );
  });
});

describe("delete response", () => {
  const base = {
    id: "o1",
    deletedAt: new Date().toISOString(),
    scope: "subOrg" as const,
    promotedTo: "o-grandparent",
  };

  it("reports the promotion of each child up a rung", () => {
    const result = OrgV1Model.responseDeleted.safeParse({
      ...base,
      reparented: [
        { id: "child-1", from: "o1", to: "o-grandparent", rule: "promoted" },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("allows a null promotion target for a top-level organization", () => {
    const result = OrgV1Model.responseDeleted.safeParse({
      ...base,
      promotedTo: null,
      reparented: [{ id: "child-1", from: "o1", to: null, rule: "promoted" }],
    });

    expect(result.success).toBe(true);
  });

  it("reports an empty list when it had no children", () => {
    expect(
      OrgV1Model.responseDeleted.safeParse({ ...base, reparented: [] }).success,
    ).toBe(true);
  });

  it("rejects a scope outside the permission model", () => {
    const result = OrgV1Model.responseDeleted.safeParse({
      ...base,
      scope: "elsewhere",
      reparented: [],
    });

    expect(result.success).toBe(false);
  });
});

describe("restore response", () => {
  it("reports parentage recomputed from geography", () => {
    const result = OrgV1Model.responseRestored.safeParse({
      id: "o1",
      parentOrgId: "o-parent",
      reparented: [
        { id: "child-1", from: "o-grandparent", to: "o1", rule: "contained" },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("accepts a straddling child reclaimed by majority", () => {
    const result = OrgV1Model.responseRestored.safeParse({
      id: "o1",
      parentOrgId: null,
      reparented: [
        { id: "child-1", from: null, to: "o1", rule: "majority" },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a rule outside the resolution set", () => {
    const result = OrgV1Model.responseRestored.safeParse({
      id: "o1",
      parentOrgId: null,
      reparented: [{ id: "c", from: null, to: "o1", rule: "guessed" }],
    });

    expect(result.success).toBe(false);
  });
});

describe("error codes", () => {
  it("covers the edit, delete and restore failures", () => {
    for (const code of [
      "org_not_found",
      "slug_not_editable",
      "org_not_deleted",
    ]) {
      expect(
        OrgV1Model.responseError.safeParse({ code, message: "x" }).success,
      ).toBe(true);
    }
  });
});
