#!/usr/bin/env node
/**
 * Build the download-and-double-click bundles.
 *
 *   node scripts/bundle.mjs                 # this machine's platform
 *   node scripts/bundle.mjs --target win-x64
 *   node scripts/bundle.mjs --all           # every target, from one machine
 *
 * The claw's two runtime dependencies are plain JavaScript, so everything in a
 * bundle is the same for every system except Node itself. One machine can
 * therefore build all five: the app is staged once, and each target gets the
 * official Node runtime for its system, fetched from nodejs.org and checked
 * against Node's published SHA-256 before a byte of it is used.
 *
 * What goes in is decided by git, not by what happens to be on disk: public/,
 * workspace/ and senses/ come from `git ls-files`, so a builder's own memory,
 * schedule, Desk images or .env can never ride into a release. dist/ is built
 * fresh, without the tests.
 *
 * Plain Node, no dependencies; needs git, tar, unzip and zip on the builder.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release");
const CACHE = path.join(OUT, ".cache");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));

/** Our name for a target → Node's name for its download. */
export const TARGETS = {
  "linux-x64": { node: "linux-x64", ext: "tar.xz", os: "linux" },
  "linux-arm64": { node: "linux-arm64", ext: "tar.xz", os: "linux" },
  "darwin-arm64": { node: "darwin-arm64", ext: "tar.xz", os: "darwin" },
  "darwin-x64": { node: "darwin-x64", ext: "tar.xz", os: "darwin" },
  "win-x64": { node: "win-x64", ext: "zip", os: "win" },
};

/** Files at the repository root that a running claw reads. */
// The setup scripts ride along because the HUD and doctor name them (local
// ears, Piper's voice); a hint pointing at a file the bundle lacks is a lie.
const TOP_FILES = ["claw.config.json", ".env.example", "package.json", "package-lock.json", "LICENSE", "README.md", "setup-ears.sh", "setup-voice.sh"];
const TRACKED_DIRS = ["public", "workspace", "senses"];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
}

function args() {
  const a = process.argv.slice(2);
  const get = (flag) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const here = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  const targets = a.includes("--all") ? Object.keys(TARGETS) : [get("--target") ?? here];
  for (const t of targets) if (!TARGETS[t]) throw new Error(`Unknown target "${t}". Known: ${Object.keys(TARGETS).join(", ")}`);
  return { targets, nodeVersion: get("--node") ?? process.versions.node, archive: !a.includes("--no-archive") };
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** The app, staged once: fresh dist/, tracked files only, production node_modules. */
function stageApp() {
  console.log("▸ building dist/");
  fs.rmSync(path.join(ROOT, "dist"), { recursive: true, force: true });
  run("npm", ["run", "build"], { cwd: ROOT });

  const stage = path.join(OUT, ".stage", "app");
  fs.rmSync(path.dirname(stage), { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  for (const f of fs.readdirSync(path.join(ROOT, "dist"), { recursive: true })) {
    const rel = String(f);
    const from = path.join(ROOT, "dist", rel);
    if (fs.statSync(from).isDirectory() || /\.test\.js$/.test(rel)) continue;
    copyFile(from, path.join(stage, "dist", rel));
  }
  const tracked = execFileSync("git", ["ls-files", "-z", ...TRACKED_DIRS], { cwd: ROOT, encoding: "utf-8" })
    .split("\0").filter(Boolean);
  for (const rel of tracked) copyFile(path.join(ROOT, rel), path.join(stage, rel));
  for (const rel of TOP_FILES) if (fs.existsSync(path.join(ROOT, rel))) copyFile(path.join(ROOT, rel), path.join(stage, rel));

  console.log("▸ production dependencies");
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage });
  return stage;
}

/** The Node runtime for one target, verified against Node's own checksum list. */
async function fetchNode(version, target) {
  const { node, ext } = TARGETS[target];
  const name = `node-v${version}-${node}`;
  const file = `${name}.${ext}`;
  const dir = path.join(CACHE, `v${version}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = `https://nodejs.org/dist/v${version}`;

  const sums = path.join(dir, "SHASUMS256.txt");
  if (!fs.existsSync(sums)) fs.writeFileSync(sums, await download(`${base}/SHASUMS256.txt`));
  const want = fs.readFileSync(sums, "utf-8").split("\n").find((l) => l.trim().endsWith(`  ${file}`))?.split(/\s+/)[0];
  if (!want) throw new Error(`Node's checksum list has no entry for ${file}`);

  const archive = path.join(dir, file);
  if (!fs.existsSync(archive) || sha256(archive) !== want) {
    console.log(`▸ downloading ${file}`);
    fs.writeFileSync(archive, await download(`${base}/${file}`));
  }
  const got = sha256(archive);
  if (got !== want) throw new Error(`${file}: checksum mismatch (got ${got}, want ${want}) — refusing to bundle it`);

  // Extracted into its own empty directory, never over anything of ours.
  const unpacked = path.join(dir, `${name}-unpacked`);
  if (!fs.existsSync(path.join(unpacked, name))) {
    fs.rmSync(unpacked, { recursive: true, force: true });
    fs.mkdirSync(unpacked, { recursive: true });
    if (ext === "zip") run("unzip", ["-q", archive, "-d", unpacked]);
    else run("tar", ["-xJf", archive, "-C", unpacked]);
  }
  return path.join(unpacked, name);
}

/**
 * Fetch with retries. Run 4 of the bundles workflow (17 Nov) died when
 * nodejs.org reset the connection partway through a 30 MB runtime
 * ("TypeError: terminated … ECONNRESET"): one dropped socket sank every
 * platform's build. A dropped or 5xx download is retried with backoff; a
 * 4xx is not, because the file is not there. The checksum check after this
 * is what decides whether the bytes are good.
 */
export async function download(url, { tries = 4, fetchImpl = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      last = new Error(`${url}: HTTP ${res.status}`);
      if (res.status < 500) throw last;
    } catch (err) {
      if (err === last && last.message.includes("HTTP 4")) throw err;
      last = err;
    }
    if (attempt < tries) {
      console.log(`  ↻ ${url} failed (${last?.message ?? last}); retrying (${attempt + 1}/${tries})`);
      await wait(2000 * attempt);
    }
  }
  throw last;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Node's docs, headers and man pages are not needed to run anything. */
function copyRuntime(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !/[\\/](include|share)$/.test(src) && !/[\\/](CHANGELOG\.md|README\.md)$/.test(src),
  });
}

export function launcher(os) {
  if (os === "win") {
    return [
      "@echo off",
      "rem Double-click to start Cunning Claw. Closing this window stops him.",
      "title Cunning Claw",
      'cd /d "%~dp0app"',
      'set "PATH=%~dp0runtime;%PATH%"',
      "set CLAW_OPEN_HUD=1",
      '"%~dp0runtime\\node.exe" dist\\boot.js',
      "if errorlevel 1 pause",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    "# Double-click (or run) to start Cunning Claw. Closing this window stops him.",
    'here="$(cd "$(dirname "$0")" && pwd)"',
    'cd "$here/app" || exit 1',
    'PATH="$here/runtime/bin:$PATH"; export PATH',
    "CLAW_OPEN_HUD=1 exec node dist/boot.js",
    "",
  ].join("\n");
}

export function readMe(os, version) {
  const start =
    os === "win" ? "Double-click  Cunning Claw.cmd"
      : os === "darwin" ? "Double-click  Cunning Claw.command"
        : "Double-click  Cunning Claw.sh  (or run it from a terminal)";
  const firstTime =
    os === "win"
      ? "Windows may say it protected your PC, because this download is not code-signed yet.\r\nChoose 'More info', then 'Run anyway'. You only do this once."
      : os === "darwin"
        ? "macOS may say it cannot check the app, because it is not notarised yet.\nRight-click Cunning Claw.command, choose Open, then Open again. You only do this once."
        : "If double-clicking only shows the text, right-click the file and choose\n'Run as a Program' (or mark it executable in its properties first).";
  const nl = os === "win" ? "\r\n" : "\n";
  return [
    `CUNNING CLAW ${version}`,
    "",
    "To start:",
    `  ${start}`,
    "",
    "The first time:",
    `  ${firstTime}`,
    "",
    "A small window stays open while he runs; your browser opens on his page.",
    "The first run opens a setup page. The easiest brain is a free Google",
    "Gemini key: any Google account gets one in about two minutes, no card",
    "needed, and the page walks you through it step by step. (Or paste an",
    "OpenRouter key, or choose the offline brain.) Then give your name and",
    "town. That is all.",
    "",
    "To stop him: close the window.",
    "",
    "Everything he knows lives in this folder: your keys (app/.env), his",
    "memory and history (app/data), his notes and skills (app/workspace).",
    "Keep the folder, and keep a copy of those three before replacing it with",
    "a newer version.",
    "",
    "Nothing here phones home. He binds to 127.0.0.1 only, behind a token.",
    "There is no Cunning Claw crypto token, and there never will be.",
    "",
    "https://github.com/Dragon-Forge-master/cunning-claw",
    "",
  ].join(nl);
}

async function bundle(stage, target, nodeVersion, archive) {
  const { os } = TARGETS[target];
  const name = `cunningclaw-${pkg.version}-${target}`;
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`▸ ${name}`);
  fs.cpSync(stage, path.join(dir, "app"), { recursive: true, verbatimSymlinks: true });
  copyRuntime(await fetchNode(nodeVersion, target), path.join(dir, "runtime"));

  const start = os === "win" ? "Cunning Claw.cmd" : os === "darwin" ? "Cunning Claw.command" : "Cunning Claw.sh";
  fs.writeFileSync(path.join(dir, start), launcher(os), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "READ ME FIRST.txt"), readMe(os, pkg.version));

  if (!archive) return dir;
  // tar keeps the executable bit Linux needs; zip -y keeps Node's symlinks for macOS.
  const out = os === "linux" ? `${name}.tar.gz` : `${name}.zip`;
  fs.rmSync(path.join(OUT, out), { force: true });
  if (os === "linux") run("tar", ["-czf", out, name], { cwd: OUT });
  else run("zip", ["-qry", out, name], { cwd: OUT });
  console.log(`  → release/${out}  (${(fs.statSync(path.join(OUT, out)).size / 1e6).toFixed(0)} MB)`);
  return dir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { targets, nodeVersion, archive } = args();
  const stage = stageApp();
  for (const t of targets) await bundle(stage, t, nodeVersion, archive);
}
