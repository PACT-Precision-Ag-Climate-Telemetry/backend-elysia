import { Elysia } from "elysia";
import logger from "@/utils/logger";

const httpLogger = () => (app: Elysia) =>
  app.onRequest(({ request, set }) => {
    const method = request.method;
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    const userAgent = request.headers.get("user-agent") ?? "-";
    const remoteAddress =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "127.0.0.1";
    const timestamp = new Date().toISOString();
    const protocol = request.headers.get("x-forwarded-proto") ?? "http";
    const date = new Date().toLocaleString("en-GB", {
      timeZone: "UTC",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const formattedDate = date.replace(/,/g, "").replace(/\s+/g, "/");
    const line = `${remoteAddress} - - [${formattedDate} +0000] "${method} ${path} ${protocol.toUpperCase()}/1.1" 200 - "-" "${userAgent}"`;

    logger.http(line);
  });

export default httpLogger;
