import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import { organization } from "@/db/schema";
import { OrgLogoModel } from "@/modules/org/logo.v1.model";
import { auth } from "@/utils/auth";
import { checkOrgHierarchyPermission } from "@/utils/auth/hierarchy";
import db from "@/utils/db";
import {
  IMAGE_MAX_BYTES,
  ImageProcessingError,
  isAcceptedFormat,
  normalizeImage,
  sniffImageFormat,
} from "@/utils/image";
import logger from "@/utils/logger";
import {
  deleteObjectQuietly,
  isAbsoluteUrl,
  isStorageConfigured,
  putObject,
  resolveStoredUrl,
} from "@/utils/storage";

/**
 * Organization logo upload, proxied through the API rather than presigned.
 *
 * Going through the API is what makes the checks possible at all: a presigned
 * PUT hands the client a URL and accepts whatever it sends. Here the bytes are
 * sniffed, size-capped and re-encoded before anything reaches storage.
 *
 * Gated on the same `edit` permission as PATCH /v1/org/:orgId.
 */

/** Content-addressed, so the same image dedupes and the URL can cache forever. */
function logoKey(orgId: string, data: Uint8Array): string {
  const digest = createHash("sha256").update(data).digest("hex").slice(0, 32);

  return `org/${orgId}/logo/${digest}.webp`;
}

const orgLogoV1App = new Elysia({ name: "org-logo-v1", prefix: "/v1/org" })
  .post(
    "/:orgId/logo",
    async ({ params, body, request, status }) => {
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session) {
        return status(401, {
          code: "unauthorized" as const,
          message: "Authentication is required to upload a logo",
        });
      }

      if (!isStorageConfigured()) {
        return status(503, {
          code: "storage_not_configured" as const,
          message: "Object storage is not configured",
        });
      }

      const { orgId } = params;
      const { file } = body;

      const [target] = await db
        .select({ id: organization.id, logo: organization.logo })
        .from(organization)
        .where(and(eq(organization.id, orgId), isNull(organization.deletedAt)))
        .limit(1);

      if (!target) {
        return status(404, {
          code: "org_not_found" as const,
          message: "Organization not found",
        });
      }

      const permission = await checkOrgHierarchyPermission({
        userId: session.user.id,
        targetOrgId: orgId,
        action: "edit",
      });

      if (!permission.allowed) {
        return status(403, {
          code: "insufficient_permission" as const,
          message: `Not allowed to edit this organization: ${permission.reason}`,
        });
      }

      // Checked before reading the body into memory.
      if (file.size > IMAGE_MAX_BYTES) {
        return status(413, {
          code: "image_too_large" as const,
          message: `Image must be at most ${IMAGE_MAX_BYTES} bytes`,
        });
      }

      const bytes = new Uint8Array(await file.arrayBuffer());

      // The multipart Content-Type is whatever the client claimed, so the
      // decision is made on the leading bytes instead.
      const format = sniffImageFormat(bytes);

      if (format === "svg") {
        return status(415, {
          code: "svg_not_allowed" as const,
          message:
            "SVG is not accepted: it can carry script and would be served as an active document",
        });
      }

      if (!isAcceptedFormat(format)) {
        return status(415, {
          code: "unsupported_image_type" as const,
          message: "Image must be PNG, JPEG, WebP or GIF",
        });
      }

      let normalized;

      try {
        // Re-encoding is also what drops EXIF, GPS included.
        normalized = await normalizeImage(bytes, format);
      } catch (error) {
        if (error instanceof ImageProcessingError) {
          return status(400, {
            code: "image_invalid" as const,
            message: `Image could not be processed: ${error.message}`,
          });
        }

        throw error;
      }

      const key = logoKey(orgId, normalized.data);

      try {
        await putObject(key, normalized.data, "image/webp");
      } catch (error) {
        logger.error({
          message: "(org.logo.ts) Failed to store organization logo",
          orgId,
          key,
          error,
        });

        return status(502, {
          code: "storage_unavailable" as const,
          message: "Could not store the image",
        });
      }

      await db
        .update(organization)
        .set({ logo: key })
        .where(eq(organization.id, orgId));

      // Best effort, and only for a key of ours: an absolute URL predates
      // uploads and may be shared, and the same key means the identical image
      // was re-uploaded.
      const previous = target.logo;

      if (previous && previous !== key && !isAbsoluteUrl(previous)) {
        await deleteObjectQuietly(previous);
      }

      return status(201, {
        organizationId: orgId,
        logo: key,
        url: resolveStoredUrl(key),
        width: normalized.width,
        height: normalized.height,
        bytes: normalized.bytes,
        sourceFormat: normalized.sourceFormat,
      });
    },
    {
      params: OrgLogoModel.params,
      body: OrgLogoModel.body,
      response: {
        201: OrgLogoModel.responseUploaded,
        400: OrgLogoModel.responseError,
        401: OrgLogoModel.responseError,
        403: OrgLogoModel.responseError,
        404: OrgLogoModel.responseError,
        413: OrgLogoModel.responseError,
        415: OrgLogoModel.responseError,
        502: OrgLogoModel.responseError,
        503: OrgLogoModel.responseError,
      },
      detail: {
        summary: "Upload an organization logo",
        description:
          "multipart/form-data with a `file` field. Rejects SVG, sniffs the real format, caps size, strips EXIF and re-encodes to WebP.",
        tags: ["Organization"],
      },
    },
  )
  .delete(
    "/:orgId/logo",
    async ({ params, request, status }) => {
      const session = await auth.api.getSession({ headers: request.headers });

      if (!session) {
        return status(401, {
          code: "unauthorized" as const,
          message: "Authentication is required to remove a logo",
        });
      }

      const { orgId } = params;

      const [target] = await db
        .select({ id: organization.id, logo: organization.logo })
        .from(organization)
        .where(and(eq(organization.id, orgId), isNull(organization.deletedAt)))
        .limit(1);

      if (!target) {
        return status(404, {
          code: "org_not_found" as const,
          message: "Organization not found",
        });
      }

      const permission = await checkOrgHierarchyPermission({
        userId: session.user.id,
        targetOrgId: orgId,
        action: "edit",
      });

      if (!permission.allowed) {
        return status(403, {
          code: "insufficient_permission" as const,
          message: `Not allowed to edit this organization: ${permission.reason}`,
        });
      }

      await db
        .update(organization)
        .set({ logo: null })
        .where(eq(organization.id, orgId));

      const removed =
        target.logo && !isAbsoluteUrl(target.logo)
          ? await deleteObjectQuietly(target.logo)
          : false;

      return status(200, { organizationId: orgId, removed });
    },
    {
      params: OrgLogoModel.params,
      response: {
        200: OrgLogoModel.responseRemoved,
        401: OrgLogoModel.responseError,
        403: OrgLogoModel.responseError,
        404: OrgLogoModel.responseError,
      },
      detail: {
        summary: "Remove an organization logo",
        tags: ["Organization"],
      },
    },
  );

export default orgLogoV1App;
