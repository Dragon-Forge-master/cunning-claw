import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { ROOT, DATA_DIR } from "./config.js";

/**
 * Paths the model must not read or write, even via the dedicated file tools.
 *
 * This was one regex — `/etc/shadow|sudoers`, `.ssh/id_*`, `/root/` — which
 * left the credentials this product creates *itself* wide open: `.env` holds
 * CLAW_TOKEN and every provider key, `data/mcp-oauth.json` holds live OAuth
 * access and refresh tokens, and the Chrome profile holds the cookies that are
 * a logged-in Gmail session. It was also written with forward slashes only, so
 * on Windows — the platform the README sells as "nothing to install" — it
 * matched nothing at all and the denylist was inert.
 *
 * Every consumer calls isSensitivePath(), so widening the rule here fixes
 * read_file, write_file, the coding tools and the served-files route at once.
 */

export const PROFILE_DIR =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "cunningclaw", "chrome-profile")
    : process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "cunningclaw", "chrome-profile")
      : path.join(os.homedir(), ".config", "cunningclaw", "chrome-profile");

/** Where Cunning Claw's own Chrome keeps its profile — cookies included. */
export function chromeProfileDir(): string {
  return PROFILE_DIR;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * The inverse, for anything shown on the glass. A full path under the home
 * directory carries the operator's username, and the HUD gets screenshotted
 * and filmed. `home` is a parameter so the collapse can be tested on a box
 * whose real home is somewhere else.
 */
export function collapseHome(p: string, home = os.homedir()): string {
  if (p === home) return "~";
  return p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

/**
 * One shape to match against: absolute, forward-slashed, lowercased.
 *
 * Lowercasing is correct on Windows and macOS and a deliberate
 * over-approximation on Linux — refusing `~/.SSH/id_rsa` costs nothing.
 */
function norm(p: string): string {
  return path.resolve(expandHome(String(p ?? ""))).replace(/\\/g, "/").toLowerCase();
}

/** Templates are meant to be read — install.sh copies one, and coding.ts lists it. */
const ENV_TEMPLATES = /(^|\/)\.env\.(example|sample|template)$/;

const SENSITIVE: RegExp[] = [
  // The original floor, kept verbatim so nothing that was blocked stops being.
  /\/etc\/(shadow|sudoers)/,
  /\.ssh\/.*(id_|authorized_keys)/,
  /\/root\//,

  // Secret stores, whole directories.
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.password-store(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/,

  // Single files that hold credentials.
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.?netrc$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.npmrc$/,

  // Keys by name and by extension, wherever they sit.
  /(^|\/)id_[a-z0-9_]+$/,
  /(^|\/)authorized_keys$/,
  /\.(pem|p12|pfx|jks|keystore)$/,

  // Any .env — this product's own and any project's. Templates are excluded
  // above, before this list is consulted.
  /(^|\/)\.env(\.[^/]*)?$/,

  // Windows' own credential store.
  /\/windows\/system32\/config(\/|$)/,
];

/** Absolute paths this install creates, computed once. */
const SENSITIVE_PREFIXES = [
  path.join(DATA_DIR, "mcp-oauth.json"),
  path.join(DATA_DIR, "history.json"),
  path.join(DATA_DIR, "memory.json"),
  path.join(DATA_DIR, "remote-jobs.json"),
  path.join(ROOT, ".env"),
  // The cookie jar IS the logged-in Gmail and WhatsApp session.
  PROFILE_DIR,
].map((p) => p.replace(/\\/g, "/").toLowerCase());

function matches(normalised: string): boolean {
  if (ENV_TEMPLATES.test(normalised)) return false;
  if (SENSITIVE.some((re) => re.test(normalised))) return true;
  return SENSITIVE_PREFIXES.some((p) => normalised === p || normalised.startsWith(p + "/"));
}

export function isSensitivePath(p: string): boolean {
  const given = norm(p);
  if (matches(given)) return true;
  // A symlink is the obvious way round a path denylist: workspace/ is a
  // free-write zone, so `ln -s ~/.ssh/id_rsa workspace/notes.txt` would
  // otherwise read the key through a name that matches nothing. Resolve and
  // check again — of the real path when it exists, of its parent when it does
  // not (the write case, where the file is about to be created).
  try {
    const real = fs.realpathSync.native(expandHome(String(p ?? "")));
    if (matches(norm(real))) return true;
  } catch {
    try {
      const parent = fs.realpathSync.native(path.dirname(expandHome(String(p ?? ""))));
      const base = path.basename(expandHome(String(p ?? "")));
      if (matches(norm(path.join(parent, base)))) return true;
    } catch {
      // Neither exists — the literal check above is all there is, and that is
      // fine: isSensitivePath must never throw, whatever it is handed.
    }
  }
  return false;
}
