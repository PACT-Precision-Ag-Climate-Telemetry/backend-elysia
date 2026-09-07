/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  buildOrganizationChain,
  type OrganizationRow,
} from "@/modules/telemetry/service";

const org = (
  id: string,
  orgType: string,
  parentOrgId: string | null,
): OrganizationRow => ({
  id,
  name: `${id} name`,
  slug: id,
  orgType,
  parentOrgId,
});

// root -> government -> province -> municipality -> field
const tree = new Map<string, OrganizationRow>([
  ["root", org("root", "root", null)],
  ["gov", org("gov", "government", "root")],
  ["prov", org("prov", "province", "gov")],
  ["muni", org("muni", "municipality", "prov")],
  ["field", org("field", "field", "muni")],
]);

const lookup =
  (source: Map<string, OrganizationRow>) => async (id: string) =>
    source.get(id);

describe("buildOrganizationChain", () => {
  it("returns the full chain root-first with the starting org last", async () => {
    const chain = await buildOrganizationChain("field", lookup(tree));

    expect(chain.map((o) => o.id)).toEqual([
      "root",
      "gov",
      "prov",
      "muni",
      "field",
    ]);
    expect(chain.map((o) => o.level)).toEqual([0, 1, 2, 3, 4]);
    expect(chain[chain.length - 1]!.orgType).toBe("field");
  });

  it("stops at the org itself when it has no parent", async () => {
    const chain = await buildOrganizationChain("root", lookup(tree));

    expect(chain.map((o) => o.id)).toEqual(["root"]);
    expect(chain[0]!.level).toBe(0);
    expect(chain[0]!.parentOrgId).toBeNull();
  });

  it("walks only the ancestors of a mid-tier org", async () => {
    const chain = await buildOrganizationChain("prov", lookup(tree));

    expect(chain.map((o) => o.id)).toEqual(["root", "gov", "prov"]);
  });

  it("returns an empty chain when the org row is missing", async () => {
    const chain = await buildOrganizationChain("ghost", lookup(tree));

    expect(chain).toEqual([]);
  });

  it("stops at a broken parent link instead of throwing", async () => {
    const orphan = new Map([["a", org("a", "province", "missing-parent")]]);
    const chain = await buildOrganizationChain("a", lookup(orphan));

    expect(chain.map((o) => o.id)).toEqual(["a"]);
  });

  it("does not loop forever on a parent cycle", async () => {
    const cyclic = new Map([
      ["a", org("a", "province", "b")],
      ["b", org("b", "government", "a")],
    ]);
    const chain = await buildOrganizationChain("a", lookup(cyclic));

    expect(chain.map((o) => o.id).sort()).toEqual(["a", "b"]);
  });

  it("caps the walk at the depth of orgHierarchy", async () => {
    // A malformed chain deeper than the five real tiers.
    const deep = new Map<string, OrganizationRow>();
    for (let i = 0; i < 12; i++) {
      deep.set(`n${i}`, org(`n${i}`, "province", i === 11 ? null : `n${i + 1}`));
    }

    const chain = await buildOrganizationChain("n0", lookup(deep));

    expect(chain).toHaveLength(5);
  });

  it("reports level null for an org_type outside the hierarchy", async () => {
    const odd = new Map([["x", org("x", "not-a-tier", null)]]);
    const chain = await buildOrganizationChain("x", lookup(odd));

    expect(chain[0]!.level).toBeNull();
    expect(chain[0]!.orgType).toBe("not-a-tier");
  });

  it("queries each organization exactly once", async () => {
    const seen: string[] = [];
    const chain = await buildOrganizationChain("field", async (id) => {
      seen.push(id);
      return tree.get(id);
    });

    expect(seen).toEqual(["field", "muni", "prov", "gov", "root"]);
    expect(chain).toHaveLength(5);
  });
});
