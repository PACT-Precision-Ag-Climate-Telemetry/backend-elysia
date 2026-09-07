/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  fromGeometry,
  isValidPolygon,
  parseGeoJsonPolygon,
  toGeometry,
} from "@/utils/geo";
import { farmField } from "@/db/schema";
import type { GeoJsonPolygon } from "@/types/geo";

const square: GeoJsonPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [98.98, 18.79],
      [98.99, 18.79],
      [98.99, 18.8],
      [98.98, 18.8],
      [98.98, 18.79],
    ],
  ],
};

describe("isValidPolygon", () => {
  it("accepts a closed ring", () => {
    expect(isValidPolygon(square)).toBe(true);
  });

  it("rejects a ring whose last position does not repeat the first", () => {
    const open: GeoJsonPolygon = {
      type: "Polygon",
      coordinates: [square.coordinates[0]!.slice(0, -1)],
    };

    expect(isValidPolygon(open)).toBe(false);
  });

  it("rejects a ring with fewer than four positions", () => {
    const sliver: GeoJsonPolygon = {
      type: "Polygon",
      coordinates: [
        [
          [98.98, 18.79],
          [98.99, 18.79],
          [98.98, 18.79],
        ],
      ],
    };

    expect(isValidPolygon(sliver)).toBe(false);
  });

  it("rejects a polygon with no rings", () => {
    expect(isValidPolygon({ type: "Polygon", coordinates: [] })).toBe(false);
  });

  it("rejects a non-Polygon geometry", () => {
    const point = { type: "Point", coordinates: [] } as unknown as GeoJsonPolygon;

    expect(isValidPolygon(point)).toBe(false);
  });

  it("validates holes, not just the outer ring", () => {
    const holed: GeoJsonPolygon = {
      type: "Polygon",
      coordinates: [
        square.coordinates[0]!,
        [
          [98.983, 18.793],
          [98.986, 18.793],
          [98.986, 18.796],
          [98.983, 18.799],
        ],
      ],
    };

    expect(isValidPolygon(holed)).toBe(false);
  });
});

describe("parseGeoJsonPolygon", () => {
  it("parses what ST_AsGeoJSON returns", () => {
    expect(parseGeoJsonPolygon(JSON.stringify(square))).toEqual(square);
  });

  it("returns null for a null column", () => {
    expect(parseGeoJsonPolygon(null)).toBeNull();
  });
});

describe("SQL helpers", () => {
  it("binds the polygon as a parameter rather than inlining it", () => {
    const query = toGeometry(square);

    expect(query.queryChunks.some((chunk) => typeof chunk === "object")).toBe(
      true,
    );
  });

  it("wraps a column in ST_AsGeoJSON", () => {
    expect(fromGeometry(farmField.area)).toBeDefined();
  });
});
