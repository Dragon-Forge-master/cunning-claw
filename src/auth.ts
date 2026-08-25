import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { ROOT } from "./config.js";

/**
 * Local API authentication.
 *
 * Binding to loopback keeps JARVIS off the network, but it does not keep it
 * away from *this* machine: any process running as this user — a postinstall
 * script, a rogue dependency, a page in a browser — could POST to /api/chat and
 * get a shell, a file write, or the contents of an inbox. Loopback is not a
 * permission boundary.
 *
 * Three checks, because no single one covers every caller:
 *   1. A bearer token, for scripts and the CLI.
 *   2. A same-site cookie, because EventSource cannot set headers and the HUD's
 *      event stream needs to authenticate somehow.
 *   3. An Origin check on state-changing requests, so a page the user happens to
 *      be visiting cannot ride that cookie (CSRF).
 */

const ENV_FILE = path.join(ROOT, ".env");
export const COOKIE = "jarvis_session";

let token = "";

/** Read the token, generating and persisting one on first run. */
export function ensureToken(): { token: string; generated: boolean } {
  const existing = process.env.JARVIS_TOKEN?.trim();
  if (existing) {
    token = existing;
    return { token, generated: false };
  }

  token = crypto.randomBytes(32).toString("base64url");
  process.env.JARVIS_TOKEN = token;
  try {
    const line = `\nJARVIS_TOKEN=${token}\n`;
    fs.appendFileSync(ENV_FILE, line, { mode: 0o600 });
    fs.chmodSync(ENV_FILE, 0o600);
  } catch {
    // A read-only checkout still works; the token just lives for this process.
  }
  return { token, generated: true };
}

export function currentToken(): string {
  return token;
}

/** Length-independent comparison, so a wrong guess reveals nothing by timing. */
function tokenMatches(candidate: string | undefined): boolean {
  if (!candidate || !token) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function presentedToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = req.headers["x-jarvis-token"];
  if (typeof header === "string") return header.trim();
  return readCookie(req.headers.cookie, COOKIE);
}

/**
 * A browser attaches Origin to cross-site requests. Anything that changes state
 * must either carry no Origin (curl, a script) or one of our own.
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser-initiated cross-site request
  try {
    const host = new URL(origin).host;
    return host === req.headers.host;
  } catch {
    return false;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!tokenMatches(presentedToken(req))) {
    res.status(401).json({
      error: "Unauthorised. Send Authorization: Bearer $JARVIS_TOKEN, or open the HUD in a browser.",
    });
    return;
  }
  if (!SAFE_METHODS.has(req.method) && !originAllowed(req)) {
    res.status(403).json({ error: "Cross-site request refused." });
    return;
  }
  next();
}

/**
 * Hand the browser its session when it loads the HUD. SameSite=Strict is what
 * stops another site's page from using this cookie; httpOnly keeps it away from
 * page scripts, including anything injected into a rendered response.
 */
export function issueSession(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
  );
}
