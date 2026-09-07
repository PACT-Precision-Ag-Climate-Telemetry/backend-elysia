import sharp from "sharp";

/**
 * Image intake for user-supplied uploads.
 *
 * Everything here exists because the bytes are hostile until proven otherwise:
 * the declared Content-Type is attacker-controlled, sharp will happily
 * rasterize an SVG carrying a <script> tag, and a few kilobytes of PNG can
 * decode into gigapixels of memory.
 */

/** Largest upload accepted, before decoding. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Longest edge kept; larger images are scaled down, smaller are left alone. */
export const IMAGE_MAX_DIMENSION = 512;

/**
 * Ceiling on decoded pixels, independent of file size. A "decompression bomb"
 * is a tiny file that expands to an enormous raster, so the guard has to be on
 * the decoded dimensions rather than on the bytes received.
 */
export const IMAGE_MAX_PIXELS = 50_000_000;

export const WEBP_QUALITY = 82;

/** Raster formats accepted for upload. Vector formats are deliberately absent. */
export type AcceptedImageFormat = "png" | "jpeg" | "webp" | "gif";

/** What the bytes actually are, including formats we refuse. */
export type SniffedFormat = AcceptedImageFormat | "svg" | "unknown";

const ACCEPTED: readonly AcceptedImageFormat[] = ["png", "jpeg", "webp", "gif"];

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * Identifies an image by its leading bytes rather than by any header the client
 * sent.
 *
 * SVG gets its own answer instead of being lumped into "unknown", so the caller
 * can explain the refusal — it is a legitimate image format that we reject on
 * security grounds, not a corrupt file.
 */
export function sniffImageFormat(bytes: Uint8Array): SniffedFormat {
  if (bytes.length < 12) {
    return "unknown";
  }

  // \x89PNG\r\n\x1a\n
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }

  // JPEG SOI plus a marker byte.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }

  // RIFF....WEBP
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") {
    return "webp";
  }

  const gifHeader = asciiAt(bytes, 0, 6);

  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return "gif";
  }

  if (looksLikeSvg(bytes)) {
    return "svg";
  }

  return "unknown";
}

/**
 * SVG has no magic number — it is XML — so it is detected by looking for a root
 * element in the leading text, past any BOM, whitespace, XML declaration,
 * doctype or comment.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 1024))
    .replace(/^﻿/, "")
    .trimStart()
    .toLowerCase();

  if (!head.startsWith("<")) {
    return false;
  }

  return head.startsWith("<svg") || head.includes("<svg");
}

export function isAcceptedFormat(
  format: SniffedFormat,
): format is AcceptedImageFormat {
  return (ACCEPTED as readonly string[]).includes(format);
}

export interface NormalizedImage {
  data: Buffer;
  width: number;
  height: number;
  bytes: number;
  /** What was uploaded, before conversion. */
  sourceFormat: AcceptedImageFormat;
}

export class ImageProcessingError extends Error {}

/**
 * Re-encodes an accepted image to WebP, scaled to fit IMAGE_MAX_DIMENSION.
 *
 * Re-encoding is what strips EXIF: sharp only carries metadata across when
 * asked to, so GPS coordinates and camera details are dropped by default.
 * `rotate()` is called first so an image whose EXIF said "rotate 90" keeps its
 * intended orientation once that tag is gone.
 */
export async function normalizeImage(
  bytes: Uint8Array,
  sourceFormat: AcceptedImageFormat,
): Promise<NormalizedImage> {
  try {
    const { data, info } = await sharp(bytes, {
      limitInputPixels: IMAGE_MAX_PIXELS,
      // An animated GIF or WebP collapses to its first frame; a logo does not
      // need to move, and animation multiplies the decode cost.
      animated: false,
    })
      .rotate()
      .resize({
        width: IMAGE_MAX_DIMENSION,
        height: IMAGE_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

    return {
      data,
      width: info.width,
      height: info.height,
      bytes: data.length,
      sourceFormat,
    };
  } catch (error) {
    throw new ImageProcessingError(
      error instanceof Error ? error.message : "could not decode image",
    );
  }
}
