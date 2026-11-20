import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The code root and the home root.
 *
 * A clone or an unzipped download keeps everything in one folder: the code,
 * and beside it the owner's things — `.env` (keys), `claw.config.json`,
 * `data/` and `workspace/`. An installed app cannot work that way. Its code
 * sits somewhere the owner does not write — a Program Files-style folder, a
 * `.app` on a read-only disk image, an AppImage's squashfs — so the owner's
 * things need a folder of their own, per user, that survives upgrades and
 * uninstalls.
 *
 * So there are two roots. ROOT (src/config.ts) is the code: dist/, public/,
 * learn/, package.json. HOME_ROOT is the owner's: everything the claw writes
 * or the owner edits. For a clone or a download they are the same folder and
 * nothing changes; for an installed app the installer leaves INSTALL_MARKER in
 * the code root, and the home root becomes the per-user folder below.
 *
 * A leaf: node built-ins only, and everything that differs per machine is a
 * parameter, so the per-OS answer is tested on any OS.
 */

/** Written into the code root by the installers (scripts/bundle.mjs), never by a clone or a zip. */
export const INSTALL_MARKER = "installed.json";

/**
 * Where an installed claw keeps the owner's things.
 *
 * - Windows: %LOCALAPPDATA%\CunningClaw. Local, not Roaming: history, memory
 *   and Chrome's profile are hundreds of megabytes that a roaming profile
 *   would copy at every sign-in. It is also the folder the claw's own Chrome
 *   profile already uses (Windows names are case-blind), so one folder holds
 *   everything and one folder deletes it.
 * - macOS: ~/Library/Application Support/cunningclaw, for the same reason —
 *   the Chrome profile is already there.
 * - Linux: $XDG_DATA_HOME/cunningclaw, ~/.local/share/cunningclaw by default.
 *   One folder rather than splitting the config into $XDG_CONFIG_HOME: the
 *   owner backs up, imports and deletes one thing, and the read-me can name it
 *   in one line. The XDG spec says a relative value is invalid and is ignored.
 */
export function userFolder(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homedir: string): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || path.win32.join(homedir, "AppData", "Local");
    return path.win32.join(local, "CunningClaw");
  }
  if (platform === "darwin") return path.posix.join(homedir, "Library", "Application Support", "cunningclaw");
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(homedir, ".local", "share");
  return path.posix.join(base, "cunningclaw");
}

export interface HomeRoot {
  home: string;
  /** True when the code root carries the installers' marker. */
  installed: boolean;
  /** Why this folder: an explicit CLAW_HOME, the installed layout, or the old one-folder layout. */
  source: "CLAW_HOME" | "installed" | "code";
}

/**
 * CLAW_HOME wins (a second claw, a test, an owner who wants their things on
 * another disk); then the installed layout; then the code root, which is what
 * every clone and unzipped download has always done.
 */
export function resolveHomeRoot(o: {
  codeRoot: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  exists: (p: string) => boolean;
}): HomeRoot {
  const installed = o.exists(path.join(o.codeRoot, INSTALL_MARKER));
  const explicit = o.env.CLAW_HOME?.trim();
  if (explicit) return { home: path.resolve(explicit), installed, source: "CLAW_HOME" };
  if (installed) return { home: userFolder(o.platform, o.env, o.homedir), installed, source: "installed" };
  return { home: o.codeRoot, installed, source: "code" };
}

// ---------------------------------------------------------------------------
// Seeding: the shipped defaults, copied into the home root without ever
// overwriting what the owner made.
// ---------------------------------------------------------------------------

/** What the installed app ships for the owner to make their own. Paths are relative and forward-slashed. */
export function shippedFiles(codeRoot: string): string[] {
  const out: string[] = [];
  if (isFile(path.join(codeRoot, "claw.config.json"))) out.push("claw.config.json");
  const walk = (rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(codeRoot, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      // Symlinks are not followed: a shipped tree has none, and a link is the
      // one way a default could copy something from outside the code root.
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push(child);
    }
  };
  walk("workspace");
  return out.sort();
}

/** The record of what was seeded, and with what content, so later starts can tell untouched from edited. */
export const SEED_MANIFEST = ".seeded.json";

type Manifest = { files: Record<string, string> };

function readManifest(homeRoot: string): Manifest {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(homeRoot, SEED_MANIFEST), "utf-8"));
    if (m && typeof m.files === "object" && m.files) return { files: { ...m.files } };
  } catch { /* none yet, or unreadable: start a fresh one */ }
  return { files: {} };
}

function writeManifest(homeRoot: string, m: Manifest): void {
  fs.writeFileSync(path.join(homeRoot, SEED_MANIFEST), JSON.stringify({ files: m.files }, null, 1) + "\n");
}

export function sha256File(p: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export interface SeedResult {
  /** New to this home: copied in. */
  copied: string[];
  /** Still exactly as seeded, and the new version ships a different one: refreshed. */
  updated: string[];
}

/**
 * Copy the shipped defaults into the home root, file by file, on every start.
 *
 * - Missing, and never seeded before: copied (a first run, or a skill that is
 *   new in this version).
 * - Missing, but seeded before: the owner deleted it. Left deleted.
 * - Present and byte-for-byte what was last seeded, while the new version
 *   ships something different: refreshed. That is how an upgrade reaches an
 *   owner who never touched the file — the same thing `git pull` does for a
 *   clone.
 * - Present and anything else (edited, or brought in by an import): theirs.
 *   Never overwritten.
 */
export function seedHome(codeRoot: string, homeRoot: string): SeedResult {
  const result: SeedResult = { copied: [], updated: [] };
  if (path.resolve(codeRoot) === path.resolve(homeRoot)) return result;
  fs.mkdirSync(homeRoot, { recursive: true });
  const manifest = readManifest(homeRoot);
  let changed = false;
  for (const rel of shippedFiles(codeRoot)) {
    const from = path.join(codeRoot, ...rel.split("/"));
    const to = path.join(homeRoot, ...rel.split("/"));
    const shipped = sha256File(from);
    if (!shipped) continue;
    const seeded = manifest.files[rel];
    if (!exists(to)) {
      if (seeded) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      manifest.files[rel] = shipped;
      result.copied.push(rel);
      changed = true;
      continue;
    }
    if (!seeded || seeded === shipped || !isFile(to)) continue;
    if (sha256File(to) !== seeded) continue;
    fs.copyFileSync(from, to);
    manifest.files[rel] = shipped;
    result.updated.push(rel);
    changed = true;
  }
  if (changed) writeManifest(homeRoot, manifest);
  return result;
}

// ---------------------------------------------------------------------------
// Import: bring an old unzipped download (or a clone) into the home root.
// ---------------------------------------------------------------------------

/** Where the old claw's things are: a download's app/ folder, or a clone's root. */
export function findOldInstall(from: string): string | null {
  const given = path.resolve(from);
  // Every download has app/claw.config.json and every clone has claw.config.json.
  for (const base of [path.join(given, "app"), given]) {
    if (isFile(path.join(base, "claw.config.json"))) return base;
  }
  return null;
}

/** `NAME=value` lines, by name. Values are carried, never logged. */
function envEntries(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = line.trim().replace(/^export\s+/, "").match(/^([A-Z0-9_]+)\s*=/);
    if (m && !out.has(m[1])) out.set(m[1], line);
  }
  return out;
}

/**
 * The old .env, plus any name only the new one has. The old one wins a clash
 * because it is what the owner has been running on; the new one's lines are
 * kept in the backup either way.
 */
export function mergeEnv(oldText: string, newText: string): { text: string; added: string[] } {
  const old = envEntries(oldText);
  const added: string[] = [];
  let text = oldText.length && !oldText.endsWith("\n") ? oldText + "\n" : oldText;
  for (const [name, line] of envEntries(newText)) {
    if (old.has(name)) continue;
    text += line + "\n";
    added.push(name);
  }
  return { text, added };
}

export interface ImportResult {
  from: string;
  /** Relative paths written into the home root. */
  copied: string[];
  /** Key names carried over from the old .env (names only — never values). */
  keys: string[];
  /** Where anything that was overwritten now waits, or null when nothing was. */
  backup: string | null;
}

/**
 * Copy an old install's .env, claw.config.json, data/ and workspace/ into the
 * home root.
 *
 * The owner asked for this by pointing at the folder, so the old copy wins —
 * except for files this version ships under workspace/skills and
 * workspace/tax: an old download's copy of a shipped skill is the old
 * version's, and it would otherwise shadow every future update. Their own
 * skills, their LESSONS.md files and the top-level workspace files (SOUL.md,
 * USER.md, MEMORY.md…) come across. Nothing is lost: anything in the home
 * root that is replaced is moved into a dated backup folder first.
 *
 * The seed manifest is then rebuilt to what is really on disk, so the next
 * start seeds what the old folder lacked (skills new since then) and leaves
 * everything the owner brought alone.
 */
export function importOldInstall(o: { from: string; codeRoot: string; homeRoot: string; now?: Date }): ImportResult {
  const base = findOldInstall(o.from);
  if (!base) throw new Error(`${o.from} does not look like a Cunning Claw folder: there is no claw.config.json or app/ folder in it.`);
  const home = path.resolve(o.homeRoot);
  const rel = path.relative(home, base);
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error("That folder is the one he already uses; there is nothing to import.");
  fs.mkdirSync(home, { recursive: true });

  const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(home, `before-import-${stamp}`);
  let backedUp = false;
  const backup = (relPath: string) => {
    const at = path.join(home, relPath);
    if (!exists(at)) return;
    const dest = path.join(backupDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(at, dest);
    backedUp = true;
  };

  const shipped = new Set(shippedFiles(o.codeRoot));
  const result: ImportResult = { from: base, copied: [], keys: [], backup: null };
  const copyIn = (relPath: string) => {
    const src = path.join(base, ...relPath.split("/"));
    const dest = path.join(home, ...relPath.split("/"));
    backup(relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    result.copied.push(relPath);
  };
  const walk = (relDir: string, visit: (relPath: string) => void) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(base, ...relDir.split("/")), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = `${relDir}/${e.name}`;
      if (e.isDirectory()) walk(child, visit);
      else if (e.isFile()) visit(child);
    }
  };

  const oldEnv = path.join(base, ".env");
  if (isFile(oldEnv)) {
    const newEnv = path.join(home, ".env");
    const current = isFile(newEnv) ? fs.readFileSync(newEnv, "utf-8") : "";
    const oldText = fs.readFileSync(oldEnv, "utf-8");
    const merged = mergeEnv(oldText, current);
    backup(".env");
    fs.writeFileSync(newEnv, merged.text, { mode: 0o600 });
    try { fs.chmodSync(newEnv, 0o600); } catch { /* Windows */ }
    result.copied.push(".env");
    result.keys = [...envEntries(oldText).keys()];
  }
  if (isFile(path.join(base, "claw.config.json"))) copyIn("claw.config.json");
  walk("data", copyIn);
  walk("workspace", (relPath) => {
    const inShippedTree = /^workspace\/(skills|tax)\//.test(relPath);
    if (inShippedTree && shipped.has(relPath)) return;
    copyIn(relPath);
  });

  // What is on disk now is the truth: a file is "as seeded" only if it still
  // matches what this version ships. Anything else is the owner's.
  const files: Record<string, string> = {};
  for (const r of shipped) {
    const shippedHash = sha256File(path.join(o.codeRoot, ...r.split("/")));
    if (shippedHash && sha256File(path.join(home, ...r.split("/"))) === shippedHash) files[r] = shippedHash;
  }
  writeManifest(home, { files });
  result.backup = backedUp ? backupDir : null;
  return result;
}
