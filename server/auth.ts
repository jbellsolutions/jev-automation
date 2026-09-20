import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/** Shared-secret auth for programmatic callers (the HTTP API, the Chrome bridge).
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
  if (origin === undefined) return true; // non-browser clients: socketAllowed() makes them present the token
  if (allowed.has(origin)) return true;
  return origin.startsWith("chrome-extension://") && allowed.has("chrome-extension://*");
}

/** May this upgrade request open a socket? Browser pages are judged by Origin; anything that
 *  sends no Origin (a local process) must carry the bearer token — as a header or `?token=` —
 *  whenever one is configured. */
export function socketAllowed(req: { url?: string; headers: { origin?: string; authorization?: string } }, auth: Auth, allowed: Set<string>): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) return originAllowed(origin, allowed);
  if (!auth.configured) return true;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (m && auth.check(m[1])) return true;
  const query = new URL(req.url ?? "/", "http://x").searchParams.get("token");
  return auth.check(query);
}

/** Did this upgrade request carry the token (header or `?token=`)? Required no matter the Origin
 *  for sockets that control the user's own browser — and with no token configured at all the
 *  answer is no: any web page can open a loopback socket, and this one would hand it the tab. */
export function tokenPresented(req: { url?: string; headers: { authorization?: string } }, auth: Auth): boolean {
  if (!auth.configured) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (m && auth.check(m[1])) return true;
  const query = new URL(req.url ?? "/", "http://x").searchParams.get("token");
  return auth.check(query);
}
