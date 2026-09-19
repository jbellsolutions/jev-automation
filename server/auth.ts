import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/** Shared-secret auth for programmatic callers (HTTP API, the Chrome bridge, the MCP server).
 *  UI sockets from allowed origins don't need it; the companion only listens on loopback. */
export interface Auth {
  readonly configured: boolean;
  check(presented: string | undefined | null): boolean;
  /** Express middleware: 401 unless `Authorization: Bearer <token>` matches. */
  bearer: RequestHandler;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function createAuth(token: string | undefined): Auth {
  const expected = token?.trim() ? digest(token.trim()) : null;
  const check = (presented: string | undefined | null): boolean => {
    if (!expected || !presented) return false;
    return timingSafeEqual(expected, digest(presented.trim()));
  };
  return {
    configured: expected !== null,
    check,
    bearer(req, res, next) {
      const header = req.header("authorization") ?? "";
      const m = /^Bearer\s+(.+)$/i.exec(header);
      if (!expected) return void res.status(401).json({ error: "JEV_TOKEN is not set on the server" });
      if (!m || !check(m[1])) return void res.status(401).json({ error: "invalid or missing bearer token" });
      next();
    },
  };
}

/** Origins allowed to open a UI WebSocket without a token: the companion's own pages. */
export function allowedOrigins(port: number, extra: string[] = []): Set<string> {
  return new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
    "http://localhost:5173", // vite dev server
    ...extra,
  ]);
}

export function originAllowed(origin: string | undefined, allowed: Set<string>): boolean {
  if (origin === undefined) return true; // non-browser clients: they must present the token in their first frame
  if (allowed.has(origin)) return true;
  return origin.startsWith("chrome-extension://") && allowed.has("chrome-extension://*");
}
