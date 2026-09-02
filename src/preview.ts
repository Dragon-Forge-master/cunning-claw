import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Claude Code's "when it's done, a browser opens on the glass."
 * Same idea: a viewport inside the HUD, not a new Chrome window.
 */

export type PreviewState = { open: boolean; url: string | null };

let state: PreviewState = { open: false, url: null };

export function previewState(): PreviewState {
  return { ...state };
}

/**
 * Where a URL points, in the only terms that matter for consent.
 *
 * "public" is the open web. "loopback" and "private" are this machine and the
 * network it sits on — a dev server, the router's admin page, the cloud
 * metadata endpoint. Reaching those is not obviously wrong, but it is not
 * something to do unasked either, so the caller can put a card in front of it.
 */
export type UrlScope = "public" | "loopback" | "private";

function scopeOf(hostname: string): UrlScope {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (h === "::1" || /^127\./.test(h)) return "loopback";
  if (/^10\./.test(h)) return "private";
  if (/^192\.168\./.test(h)) return "private";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return "private";
  // 169.254/16 is link-local — and 169.254.169.254 is the cloud metadata
  // address, which is the classic SSRF prize.
  if (/^169\.254\./.test(h)) return "private";
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return "private";
  if (h.endsWith(".local") || h.endsWith(".internal")) return "private";
  // A single-label host resolves through the local search domain, so it is a
  // machine on this network rather than somewhere on the web.
  if (!h.includes(".")) return "private";
  return "public";
}

/**
 * The one URL rule in this codebase.
 *
 * Both the HUD viewport and browser_open need the same three things: reject
 * anything that is not http(s) (file:, data:, javascript:, chrome: — a
 * navigation to file:/// is a file read that walks straight past the
 * sensitive-path denylist), rewrite the unroutable wildcard addresses, and say
 * where the result points so the caller can decide whether to ask first.
 */
export function parseNavigableUrl(
  raw: string,
): { ok: true; url: string; scope: UrlScope } | { ok: false; error: string } {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "Give me a URL to put on the glass." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    try {
      parsed = new URL(`http://${trimmed}`);
    } catch {
      return { ok: false, error: `Not a URL: ${trimmed}` };
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error:
        `Refused ${parsed.protocol} — only http(s) addresses can be opened. ` +
        `No file:, data:, javascript: or chrome:. To read a file from disk use read_file, ` +
        `which checks the sensitive-path denylist; navigating to it would not.`,
    };
  }
  if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]" || parsed.hostname === "::") {
    parsed.hostname = "127.0.0.1";
  }
  return { ok: true, url: parsed.toString(), scope: scopeOf(parsed.hostname) };
}

export function parsePreviewUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const parsed = parseNavigableUrl(raw);
  return parsed.ok ? { ok: true, url: parsed.url } : parsed;
}

export function openPreview(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const parsed = parsePreviewUrl(raw);
  if (!parsed.ok) return parsed;
  state = { open: true, url: parsed.url };
  return parsed;
}

// ---------------------------------------------------------------------------
// Static serving — "show me this folder" without a second web server.
//
// run_command waits for commands to finish, so `python -m http.server` can
// never work through it: the server starts, the timeout reaps it, and the
// error reads like a mystery (it read like one on the first Windows field
// test). The HUD's own Express serves the folder instead: one tool call, no
// child processes, no Python, every platform.
// ---------------------------------------------------------------------------

const served = new Map<string, string>(); // token -> absolute directory

export function servePath(absPath: string): { ok: true; url: string } | { ok: false; error: string } {
  if (!fs.existsSync(absPath)) return { ok: false, error: `Nothing exists at ${absPath} to serve.` };
  const isDir = fs.statSync(absPath).isDirectory();
  const dir = isDir ? path.resolve(absPath) : path.resolve(path.dirname(absPath));
  const entry = isDir ? "" : path.basename(absPath);
  let token = [...served.entries()].find(([, d]) => d === dir)?.[0];
  if (!token) {
    token = crypto.randomBytes(8).toString("hex");
    served.set(token, dir);
  }
  const url = `http://127.0.0.1:${config.server.port}/served/${token}/${entry}`;
  state = { open: true, url };
  return { ok: true, url };
}

export function servedDir(token: string): string | undefined {
  return served.get(token);
}

export function closePreview(): PreviewState {
  state = { open: false, url: state.url };
  return previewState();
}

export function reloadPreview(): PreviewState {
  if (state.url) state = { open: true, url: state.url };
  return previewState();
}
