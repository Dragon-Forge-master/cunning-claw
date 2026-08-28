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

export function parsePreviewUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
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
    return { ok: false, error: "Only http(s) previews. No file:, javascript:, or data:." };
  }
  if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]" || parsed.hostname === "::") {
    parsed.hostname = "127.0.0.1";
  }
  return { ok: true, url: parsed.toString() };
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
