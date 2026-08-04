import { auditLog, sessionAudit } from "@/db/schema";
import db from "@/utils/db";
import logger from "@/utils/logger";

type AuditResult = "success" | "failure";

type AuditContext = {
  request: Request;
  path?: string;
  user?: { id?: string | null } | null;
  session?: { id?: string | null } | null;
};

type WriteAuditEventInput = {
  ctx: AuditContext;
  action: string;
  result: AuditResult;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown> | null;
  userId?: string | null;
};

type WriteSessionAuditEventInput = {
  ctx: AuditContext;
  event: string;
  metadata?: Record<string, unknown> | null;
  userId?: string | null;
  sessionId?: string | null;
};

function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const forwardedIp = forwarded?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();

  return forwardedIp || realIp || null;
}

function getRequestPath(ctx: AuditContext): string | null {
  if (ctx.path) {
    return ctx.path;
  }

  try {
    const url = new URL(ctx.request.url);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

async function writeAuditEvent(input: WriteAuditEventInput): Promise<void> {
  try {
    const { ctx } = input;
    const sessionId = ctx.session?.id ?? null;
    const userId = input.userId ?? ctx.user?.id ?? null;

    await db.insert(auditLog).values({
      userId,
      sessionId,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      result: input.result,
      ipAddress: getClientIp(ctx.request),
      userAgent: ctx.request.headers.get("user-agent") ?? null,
      requestPath: getRequestPath(ctx),
      requestMethod: ctx.request.method,
      metadata: input.metadata ?? null,
    });
  } catch (error) {
    logger.warn(`(audit.ts) Failed to write audit event: ${error}`);
  }
}

async function writeSessionAuditEvent(
  input: WriteSessionAuditEventInput,
): Promise<void> {
  try {
    const { ctx } = input;
    const sessionId = input.sessionId ?? ctx.session?.id ?? null;

    if (!sessionId) {
      return;
    }

    const userId = input.userId ?? ctx.user?.id ?? null;

    await db.insert(sessionAudit).values({
      userId,
      sessionId,
      event: input.event,
      ipAddress: getClientIp(ctx.request),
      userAgent: ctx.request.headers.get("user-agent") ?? null,
      requestPath: getRequestPath(ctx),
      requestMethod: ctx.request.method,
      metadata: input.metadata ?? null,
    });
  } catch (error) {
    logger.warn(`(audit.ts) Failed to write session audit event: ${error}`);
  }
}

export { writeAuditEvent, writeSessionAuditEvent };
