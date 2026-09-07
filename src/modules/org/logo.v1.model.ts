import { type UnwrapSchema } from "elysia";
import z from "zod";

export const LOGO_ERROR_CODES = [
  "unauthorized",
  "insufficient_permission",
  "org_not_found",
  "image_too_large",
  "svg_not_allowed",
  "unsupported_image_type",
  "image_invalid",
  "storage_unavailable",
  "storage_not_configured",
] as const;

const errorSchema = z.object({
  code: z.enum(LOGO_ERROR_CODES),
  message: z.string(),
});

export const OrgLogoModel = {
  params: z.object({
    orgId: z.string().min(1),
  }),
  body: z.object({
    // The size limit is enforced in the handler too, against file.size, so an
    // oversized upload is refused before its bytes are read into memory.
    file: z.instanceof(File),
  }),
  responseUploaded: z.object({
    organizationId: z.string(),
    /** Storage key, which is what the column holds. */
    logo: z.string(),
    /** Composed from S3_PUBLIC_BASE_URL; null when the bucket is not public. */
    url: z.string().nullable(),
    width: z.number(),
    height: z.number(),
    bytes: z.number(),
    /** What was uploaded, before conversion to WebP. */
    sourceFormat: z.enum(["png", "jpeg", "webp", "gif"]),
  }),
  responseRemoved: z.object({
    organizationId: z.string(),
    /** Whether the stored object was actually deleted. */
    removed: z.boolean(),
  }),
  responseError: errorSchema,
};

export type OrgLogoModel = {
  [k in keyof typeof OrgLogoModel]: UnwrapSchema<(typeof OrgLogoModel)[k]>;
};
