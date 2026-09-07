/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import {
  IMAGE_MAX_DIMENSION,
  isAcceptedFormat,
  normalizeImage,
  sniffImageFormat,
} from "@/utils/image";

const solid = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  });

const png = await solid(64, 48).png().toBuffer();
const jpeg = await solid(64, 48).jpeg().toBuffer();
const webp = await solid(64, 48).webp().toBuffer();
const gif = await solid(64, 48).gif().toBuffer();

describe("sniffImageFormat", () => {
  it.each([
    ["png", png],
    ["jpeg", jpeg],
    ["webp", webp],
    ["gif", gif],
  ])("identifies a real %s by its bytes", (expected, bytes) => {
    expect(sniffImageFormat(bytes)).toBe(expected as never);
  });

  it("identifies SVG so it can be refused by name", () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );

    expect(sniffImageFormat(svg)).toBe("svg");
  });

  it("identifies SVG behind an XML declaration and leading whitespace", () => {
    const svg = Buffer.from(
      '\n  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );

    expect(sniffImageFormat(svg)).toBe("svg");
  });

  it("does not trust an extension or declared type, only bytes", () => {
    // What a "logo.png" containing script would actually be.
    const disguised = Buffer.from("<svg onload=\"alert(1)\"></svg>");

    expect(sniffImageFormat(disguised)).toBe("svg");
    expect(isAcceptedFormat(sniffImageFormat(disguised))).toBe(false);
  });

  it("rejects a PNG header glued in front of other content", () => {
    // Correct magic bytes but not a decodable image: sniffing lets it through,
    // which is why normalizeImage has to fail closed as well.
    const spoofed = Buffer.concat([
      png.subarray(0, 8),
      Buffer.from("not really an image"),
    ]);

    expect(sniffImageFormat(spoofed)).toBe("png");
    expect(normalizeImage(spoofed, "png")).rejects.toThrow();
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["too short to classify", Buffer.from([0x89, 0x50])],
    ["plain text", Buffer.from("hello there, this is not an image at all")],
    ["a PDF", Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj")],
    ["a zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])],
  ])("returns unknown for %s", (_label, bytes) => {
    expect(sniffImageFormat(bytes)).toBe("unknown");
  });

  it("does not mistake a bare RIFF container for WebP", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WAVE"),
    ]);

    expect(sniffImageFormat(wav)).toBe("unknown");
  });
});

describe("isAcceptedFormat", () => {
  it("accepts the four raster formats", () => {
    for (const format of ["png", "jpeg", "webp", "gif"] as const) {
      expect(isAcceptedFormat(format)).toBe(true);
    }
  });

  it("refuses svg and unknown", () => {
    expect(isAcceptedFormat("svg")).toBe(false);
    expect(isAcceptedFormat("unknown")).toBe(false);
  });
});

describe("normalizeImage", () => {
  it("converts to WebP whatever went in", async () => {
    for (const [format, bytes] of [
      ["png", png],
      ["jpeg", jpeg],
      ["gif", gif],
    ] as const) {
      const result = await normalizeImage(bytes, format);

      expect(sniffImageFormat(result.data)).toBe("webp");
      expect(result.sourceFormat).toBe(format);
    }
  });

  it("strips EXIF, which is where GPS coordinates live", async () => {
    const withExif = await solid(64, 48)
      .withExif({ IFD0: { Copyright: "PACT", Software: "camera" } })
      .jpeg()
      .toBuffer();

    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const result = await normalizeImage(withExif, "jpeg");

    expect((await sharp(result.data).metadata()).exif).toBeUndefined();
  });

  it("scales a large image down to the dimension cap", async () => {
    const large = await solid(2000, 1500).png().toBuffer();
    const result = await normalizeImage(large, "png");

    expect(result.width).toBe(IMAGE_MAX_DIMENSION);
    expect(result.height).toBeLessThanOrEqual(IMAGE_MAX_DIMENSION);
  });

  it("leaves a small image at its own size rather than enlarging it", async () => {
    const result = await normalizeImage(png, "png");

    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
  });

  it("reports the encoded size, not the size that arrived", async () => {
    const result = await normalizeImage(png, "png");

    expect(result.bytes).toBe(result.data.length);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("fails closed on undecodable bytes", async () => {
    expect(
      normalizeImage(Buffer.from("definitely not an image"), "png"),
    ).rejects.toThrow();
  });
});
