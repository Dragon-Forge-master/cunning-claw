#!/usr/bin/env node
/**
 * Build the download-and-double-click bundles, and the installers made from them.
 *
 *   node scripts/bundle.mjs                 # this machine's platform
 *   node scripts/bundle.mjs --target win-x64
 *   node scripts/bundle.mjs --all           # every target, from one machine
 *   node scripts/bundle.mjs --all --installer appimage,nsis
 *   node scripts/bundle.mjs --target darwin-arm64 --target darwin-x64 --installer dmg --no-archive
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
 * The installers wrap the same bundle, plus one file: INSTALL_MARKER in the
 * app folder, which tells the claw its code is read-only and the owner's
 * things live in a per-user folder (src/home-root.ts). An archive is a folder
 * the owner keeps; an installer puts the code where the system keeps apps.
 *
 *   appimage  Linux, one file. appimagetool and the AppImage runtime, both
 *             pinned by version and SHA-256 (APPIMAGE_TOOLS). Needs Linux.
 *   nsis      Windows, a per-user setup .exe. makensis (apt install nsis);
 *             builds on Linux, so the one build machine makes it.
 *   dmg       macOS, Cunning Claw.app on a drag-to-Applications disk image.
 *             hdiutil, so it builds on a Mac only.
 *
 * Plain Node, no dependencies; needs git, tar, unzip and zip on the builder.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

/** Which system each installer is for. Mirrors INSTALL_MARKER in src/home-root.ts. */
export const INSTALLERS = { appimage: "linux", nsis: "win", dmg: "darwin" };
export const INSTALL_MARKER = "installed.json";

/**
 * The AppImage tools, pinned. appimagetool would otherwise fetch the latest
 * runtime from a "continuous" release at build time — a moving target, which
 * is not something a release should be built from. Checksums recorded from
 * the release assets when these versions were pinned (20 Nov 2026); neither
 * project publishes a checksum list. To move to a newer version, change the
 * version, download, and record the new SHA-256 here.
 */
export const APPIMAGE_TOOLS = {
  appimagetool: {
    version: "1.9.1",
    url: (arch) => `https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-${arch}.AppImage`,
    sha256: {
      x86_64: "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0",
      aarch64: "f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158",
    },
  },
  // The type2 runtime is static: it needs no libfuse2, which Ubuntu stopped
  // installing in 22.04 — the commonest reason an AppImage "does nothing".
  runtime: {
    version: "20251108",
    url: (arch) => `https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-${arch}`,
    sha256: {
      x86_64: "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
      aarch64: "00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444",
    },
  },
};

/** Files at the repository root that a running claw reads. */
// The setup scripts ride along because the HUD and doctor name them (local
// ears, Piper's voice); a hint pointing at a file the bundle lacks is a lie.
const TOP_FILES = ["claw.config.json", ".env.example", "package.json", "package-lock.json", "LICENSE", "README.md", "setup-ears.sh", "setup-voice.sh"];
// learn/ is the Learn mode course: lessons and practice fixtures the server reads at boot.
const TRACKED_DIRS = ["public", "workspace", "senses", "learn"];
const ICONS = path.join(ROOT, "packaging", "icons");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
}

export function parseArgs(a) {
  const all = (flag) => a.flatMap((x, i) => (x === flag && a[i + 1] ? [a[i + 1]] : []));
  const here = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  const named = all("--target");
  const targets = a.includes("--all") ? Object.keys(TARGETS) : named.length ? named : [here];
  for (const t of targets) if (!TARGETS[t]) throw new Error(`Unknown target "${t}". Known: ${Object.keys(TARGETS).join(", ")}`);
  const installers = all("--installer").flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  for (const k of installers) if (!INSTALLERS[k]) throw new Error(`Unknown installer "${k}". Known: ${Object.keys(INSTALLERS).join(", ")}`);
  return {
    targets,
    installers,
    nodeVersion: all("--node")[0] ?? process.versions.node,
    archive: !a.includes("--no-archive"),
  };
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

/** A pinned tool: downloaded once into the cache, and refused unless its SHA-256 is the recorded one. */
async function fetchPinned(url, want, name) {
  const dir = path.join(CACHE, "tools");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!fs.existsSync(file) || sha256(file) !== want) {
    console.log(`▸ downloading ${name}`);
    fs.writeFileSync(file, await download(url));
  }
  const got = sha256(file);
  if (got !== want) throw new Error(`${name}: checksum mismatch (got ${got}, want ${want}) — refusing to use it`);
  fs.chmodSync(file, 0o755);
  return file;
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

/**
 * The double-click launcher. Arguments are passed through, so
 * `--import <old folder>` (src/import-old.ts) works from every launcher.
 */
export function launcher(os) {
  if (os === "win") {
    return [
      "@echo off",
      "rem Double-click to start Cunning Claw. Closing this window stops him.",
      "title Cunning Claw",
      'cd /d "%~dp0app"',
      'set "PATH=%~dp0runtime;%PATH%"',
      "set CLAW_OPEN_HUD=1",
      '"%~dp0runtime\\node.exe" dist\\boot.js %*',
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
    'CLAW_OPEN_HUD=1 exec node dist/boot.js "$@"',
    "",
  ].join("\n");
}

/** Where an installed claw keeps the owner's things, as the read-me says it (src/home-root.ts decides). */
const USER_FOLDER = {
  win: "%LOCALAPPDATA%\\CunningClaw",
  darwin: "~/Library/Application Support/cunningclaw",
  linux: "~/.local/share/cunningclaw",
};

/**
 * READ ME FIRST.txt, per artefact. `kind` is "archive" (the unzipped folder),
 * or the installer the text ships inside ("nsis" is installed beside the app;
 * "dmg" sits in the disk image's window; the AppImage is one file, so its
 * words live in the README and the release notes, from `readMe("linux", v,
 * "appimage")`).
 */
export function readMe(os, version, kind = "archive") {
  const nl = os === "win" ? "\r\n" : "\n";
  const installer = kind !== "archive";
  const start = installer
    ? os === "win" ? "Start menu (or the desktop)  →  Cunning Claw"
      : os === "darwin" ? "Drag Cunning Claw into Applications, then open it from there"
        : "Make the file executable once, then double-click it (see below)"
    : os === "win" ? "Double-click  Cunning Claw.cmd"
      : os === "darwin" ? "Double-click  Cunning Claw.command"
        : "Double-click  Cunning Claw.sh  (or run it from a terminal)";
  const firstTime = installer
    ? os === "win"
      ? "The installer is not code-signed yet, so Windows may say it protected your PC.\r\nChoose 'More info', then 'Run anyway'. It installs for you alone and\r\nneeds no administrator password."
      : os === "darwin"
        ? "macOS may say it cannot check the app, because it is not notarised yet.\nIn Applications, right-click Cunning Claw, choose Open, then Open again.\nOn macOS 15 or later, if there is no Open button: System Settings →\nPrivacy & Security → 'Open Anyway' beside Cunning Claw. You only do this once."
        : "Right-click the .AppImage → Properties → Permissions → tick 'Allow executing\nfile as program' (or in a terminal: chmod +x Cunning-Claw-*.AppImage).\nIf it still does not start, your system lacks FUSE; run it as\n  ./Cunning-Claw-*.AppImage --appimage-extract-and-run\nor set APPIMAGE_EXTRACT_AND_RUN=1. It unpacks to a temporary folder each time\ninstead of mounting, which is slower to start and otherwise the same."
    : os === "win"
      ? "Windows may say it protected your PC, because this download is not code-signed yet.\r\nChoose 'More info', then 'Run anyway'. You only do this once."
      : os === "darwin"
        ? "macOS may say it cannot check the app, because it is not notarised yet.\nRight-click Cunning Claw.command, choose Open, then Open again. You only do this once."
        : "If double-clicking only shows the text, right-click the file and choose\n'Run as a Program' (or mark it executable in its properties first).";
  const where = installer
    ? [
      "Everything he knows lives in your own folder, not in the app:",
      `  ${USER_FOLDER[os]}`,
      "your keys (.env), his settings (claw.config.json), his memory and history",
      "(data), and his notes and skills (workspace). Your documents stay on the",
      "Desk, in Documents/CunningClaw.",
      "",
      "To upgrade: install the new version over this one. Your folder is not",
      "touched. Settings and notes you never changed are refreshed to the new",
      "version's; anything you changed is kept as it is.",
      "",
      os === "win"
        ? "To remove him: Settings → Apps → Cunning Claw → Uninstall. Your folder is\r\nkept unless you tick the box to delete it."
        : os === "darwin"
          ? "To remove him: drag Cunning Claw from Applications to the Bin. Your folder\nis kept; delete it too to remove everything."
          : "To remove him: delete the .AppImage. Your folder is kept; delete it too\nto remove everything.",
      "",
      "Coming from an unzipped download? Bring its keys and memory across with",
      os === "win"
        ? '  "%LOCALAPPDATA%\\Programs\\Cunning Claw\\Cunning Claw.cmd" --import "C:\\path\\to\\old\\folder"'
        : os === "darwin"
          ? '  "/Applications/Cunning Claw.app/Contents/MacOS/Cunning Claw" --import ~/Downloads/old-folder'
          : "  ./Cunning-Claw-*.AppImage --import ~/Downloads/old-folder",
      "with him closed. Anything it replaces is kept in a before-import folder.",
    ]
    : [
      "Everything he knows lives in this folder: your keys (app/.env), his",
      "memory and history (app/data), his notes and skills (app/workspace).",
      "Keep the folder, and keep a copy of those three before replacing it with",
      "a newer version.",
      "",
      "Moving to a newer download, or to the installer? Start the new one once",
      "from a terminal with  --import  and the path of this folder, with this",
      "one closed; it copies your keys, memory and notes across.",
    ];
  return [
    `CUNNING CLAW ${version}`,
    "",
    "To start:",
    `  ${start}`,
    "",
    "The first time:",
    `  ${firstTime}`,
    "",
    installer && os !== "win"
      ? "A terminal window opens while he runs; your browser opens on his page."
      : "A small window stays open while he runs; your browser opens on his page.",
    "The first run opens a setup page. The easiest brain is a free Google",
    "Gemini key: any Google account gets one in about two minutes, no card",
    "needed, and the page walks you through it step by step. (Or paste an",
    "OpenRouter key, or choose the offline brain.) Then give your name and",
    "town. That is all.",
    "",
    "To stop him: close the window.",
    "",
    ...where,
    "",
    // Kept true by src/updates.ts: the update check is off until the owner
    // says yes, and src/bundle.test.ts holds this sentence to it.
    "Nothing here phones home, unless you turn on the daily update check,",
    "which asks cunningclaw.com for one small file. He binds to 127.0.0.1",
    "only, behind a token.",
    "There is no Cunning Claw crypto token, and there never will be.",
    "",
    "https://github.com/Dragon-Forge-master/cunning-claw",
    "",
  ].join(nl).split("\n").map((l) => l.replace(/\r$/, "")).join(nl);
}

/** The archive's release file name: a folder name plus .tar.gz (Linux, for the executable bit) or .zip. */
export function archiveName(version, target) {
  return `cunningclaw-${version}-${target}.${TARGETS[target].os === "linux" ? "tar.gz" : "zip"}`;
}

async function bundle(stage, target, nodeVersion, archive) {
  const { os } = TARGETS[target];
  const name = `cunningclaw-${pkg.version}-${target}`;
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`▸ ${name}`);
  fs.cpSync(stage, path.join(dir, "app"), { recursive: true, verbatimSymlinks: true });
  copyRuntime(await fetchNode(nodeVersion, target), path.join(dir, "runtime"));

  fs.writeFileSync(path.join(dir, launcherName(os)), launcher(os), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "READ ME FIRST.txt"), readMe(os, pkg.version));

  if (!archive) return dir;
  // tar keeps the executable bit Linux needs; zip -y keeps Node's symlinks for macOS.
  const out = archiveName(pkg.version, target);
  fs.rmSync(path.join(OUT, out), { force: true });
  if (os === "linux") run("tar", ["-czf", out, name], { cwd: OUT });
  else run("zip", ["-qry", out, name], { cwd: OUT });
  console.log(`  → release/${out}  (${(fs.statSync(path.join(OUT, out)).size / 1e6).toFixed(0)} MB)`);
  return dir;
}

function launcherName(os) {
  return os === "win" ? "Cunning Claw.cmd" : os === "darwin" ? "Cunning Claw.command" : "Cunning Claw.sh";
}

// ---------------------------------------------------------------------------
// Installers
// ---------------------------------------------------------------------------

/** The marker: the claw reads only its presence; the contents are for a person looking. */
export function installedMarker(kind, version) {
  return JSON.stringify({
    installer: kind,
    version,
    note: "This copy of Cunning Claw is installed: its code is read-only and your things live in your own folder (see READ ME FIRST.txt).",
  }, null, 1) + "\n";
}

/** The release file name. No spaces: GitHub turns them into dots in a release asset's name. */
export function installerName(kind, version, target) {
  const arch = TARGETS[target].node.split("-")[1];
  if (kind === "nsis") return `Cunning-Claw-Setup-${version}.exe`;
  if (kind === "dmg") return `Cunning-Claw-${version}-mac-${arch}.dmg`;
  return `Cunning-Claw-${version}-linux-${arch === "x64" ? "x86_64" : "aarch64"}.AppImage`;
}

/** Copy a built bundle's app and runtime into an installer's layout, marked as installed. */
function layOut(bundleDir, into, kind) {
  fs.cpSync(path.join(bundleDir, "app"), path.join(into, "app"), { recursive: true, verbatimSymlinks: true });
  fs.cpSync(path.join(bundleDir, "runtime"), path.join(into, "runtime"), { recursive: true, verbatimSymlinks: true });
  fs.writeFileSync(path.join(into, "app", INSTALL_MARKER), installedMarker(kind, pkg.version));
}

/** An .ico of PNG images (Windows Vista onwards reads PNG entries; so does makensis). */
export function icoFromPngs(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/** An .icns of PNG images, by the icon types macOS reads PNG data from. */
const ICNS_TYPES = { 16: "icp4", 32: "icp5", 128: "ic07", 256: "ic08", 512: "ic09" };
export function icnsFromPngs(images) {
  const parts = images.filter((i) => ICNS_TYPES[i.size]).map(({ size, png }) => {
    const h = Buffer.alloc(8);
    h.write(ICNS_TYPES[size], 0, "ascii");
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write("icns", 0, "ascii");
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

function iconPngs(sizes) {
  return sizes.map((size) => ({ size, png: fs.readFileSync(path.join(ICONS, `cunningclaw-${size}.png`)) }));
}

/**
 * The AppImage's entry point. It runs from the mounted image (or, with
 * --appimage-extract-and-run, an unpacked copy under /tmp) — read-only either
 * way, which is the point: the owner's things are in ~/.local/share/cunningclaw.
 *
 * Double-clicked in a file manager there is no window to show he is running
 * or to close to stop him, so it opens a terminal on itself, as the
 * download's launcher has one. Not in extract-and-run mode: the runtime
 * deletes the unpacked copy the moment this script exits, and the terminal's
 * copy would be unpacking into the same folder.
 */
export function appRun() {
  return [
    "#!/bin/sh",
    "# Cunning Claw's AppImage entry point. Generated by scripts/bundle.mjs.",
    'here="$(dirname "$(readlink -f "$0")")"',
    'if [ "$1" = "--in-terminal" ]; then',
    "  shift",
    'elif [ ! -t 1 ] && [ -z "$CLAW_NO_TERMINAL" ] && [ -n "$APPIMAGE" ] && { [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; }; then',
    '  case "$APPDIR" in',
    "    */appimage_extracted_*) ;;",
    "    *)",
    "      for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal mate-terminal xterm; do",
    '        command -v "$t" >/dev/null 2>&1 || continue',
    '        case "$t" in',
    '          gnome-terminal) exec "$t" -- "$APPIMAGE" --in-terminal "$@" ;;',
    '          xfce4-terminal|mate-terminal) exec "$t" -x "$APPIMAGE" --in-terminal "$@" ;;',
    '          *) exec "$t" -e "$APPIMAGE" --in-terminal "$@" ;;',
    "        esac",
    "      done",
    "      ;;",
    "  esac",
    "fi",
    'cd "$here/app" || exit 1',
    'PATH="$here/runtime/bin:$PATH"; export PATH',
    'CLAW_OPEN_HUD=1 exec "$here/runtime/bin/node" dist/boot.js "$@"',
    "",
  ].join("\n");
}

export function desktopEntry(version) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Cunning Claw",
    "Comment=A local-first personal assistant",
    "Exec=cunningclaw",
    "Icon=cunningclaw",
    "Terminal=false",
    "Categories=Utility;",
    `X-AppImage-Version=${version}`,
    "",
  ].join("\n");
}

async function buildAppImage(bundleDir, target) {
  if (process.platform !== "linux") throw new Error("The AppImage builds on Linux (appimagetool is a Linux program).");
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const arch = TARGETS[target].node.endsWith("arm64") ? "aarch64" : "x86_64";
  const { appimagetool, runtime } = APPIMAGE_TOOLS;
  const tool = await fetchPinned(appimagetool.url(hostArch), appimagetool.sha256[hostArch], `appimagetool-${appimagetool.version}-${hostArch}.AppImage`);
  const rt = await fetchPinned(runtime.url(arch), runtime.sha256[arch], `runtime-${runtime.version}-${arch}`);

  const appDir = path.join(OUT, ".installers", `${target}.AppDir`);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  layOut(bundleDir, appDir, "appimage");
  fs.writeFileSync(path.join(appDir, "AppRun"), appRun(), { mode: 0o755 });
  fs.writeFileSync(path.join(appDir, "cunningclaw.desktop"), desktopEntry(pkg.version));
  fs.copyFileSync(path.join(ICONS, "cunningclaw-256.png"), path.join(appDir, "cunningclaw.png"));
  fs.symlinkSync("cunningclaw.png", path.join(appDir, ".DirIcon"));

  const out = path.join(OUT, installerName("appimage", pkg.version, target));
  fs.rmSync(out, { force: true });
  // Extract-and-run: build machines (CI runners, containers) rarely have FUSE.
  run(tool, ["--no-appstream", "--runtime-file", rt, appDir, out], {
    env: { ...process.env, ARCH: arch, APPIMAGE_EXTRACT_AND_RUN: "1" },
  });
  fs.chmodSync(out, 0o755);
  console.log(`  → ${path.relative(ROOT, out)}  (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
  return out;
}

/** NSIS takes forward slashes on every host, and a double quote never appears in our paths. */
const nsisPath = (p) => p.replace(/\\/g, "/");

/**
 * The Windows installer, as an NSIS script.
 *
 * NSIS rather than Inno Setup because makensis runs on Linux: the one build
 * machine that makes every bundle makes this too, it is built and checked
 * here before CI, and the Windows runner only has to do what a user does —
 * install, start, uninstall.
 *
 * Per-user: RequestExecutionLevel user, %LOCALAPPDATA%\Programs, HKCU. No
 * administrator password, which a home user may not have and an office
 * laptop certainly withholds. The owner's things are in
 * %LOCALAPPDATA%\CunningClaw (src/home-root.ts), outside the install folder,
 * so an upgrade replaces the code whole and the uninstaller keeps them unless
 * a box is ticked.
 *
 * `sign` is the hook for a code-signing certificate (docs/INSTALLERS.md):
 * makensis runs it on the installer and on the uninstaller inside it, so both
 * carry the signature. Absent, both are unsigned and SmartScreen warns.
 */
export function nsisScript({ version, src, out, icon, license, sign }) {
  const v4 = `${version.replace(/[^0-9.]/g, "").split(".").concat(["0", "0", "0"]).slice(0, 3).join(".")}.0`;
  const key = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CunningClaw";
  // Stops the claw this folder is running, and no other node process: by path,
  // never by name (a name match would kill the owner's own Node work too).
  const stop = 'nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \'$INSTDIR\\*\' } | Stop-Process -Force"`';
  return [
    "; Cunning Claw — the per-user Windows installer. Generated by scripts/bundle.mjs.",
    "Unicode true",
    "ManifestDPIAware true",
    "!include \"MUI2.nsh\"",
    "!include \"FileFunc.nsh\"",
    "",
    `Name "Cunning Claw"`,
    `OutFile "${nsisPath(out)}"`,
    "RequestExecutionLevel user",
    'InstallDir "$LOCALAPPDATA\\Programs\\Cunning Claw"',
    `InstallDirRegKey HKCU "${key}" "InstallLocation"`,
    "SetCompressor /SOLID lzma",
    'BrandingText "Cunning Claw ' + version + ' · Dragon Forge AI"',
    `VIProductVersion "${v4}"`,
    `VIAddVersionKey "ProductName" "Cunning Claw"`,
    `VIAddVersionKey "ProductVersion" "${version}"`,
    `VIAddVersionKey "FileVersion" "${version}"`,
    `VIAddVersionKey "CompanyName" "Dragon Forge AI"`,
    `VIAddVersionKey "FileDescription" "Cunning Claw setup"`,
    `VIAddVersionKey "LegalCopyright" "MIT licence"`,
    ...(sign
      ? [
        "; ── Code signing (docs/INSTALLERS.md). Runs only when the build was given a certificate.",
        `!finalize '${sign}'`,
        `!uninstfinalize '${sign}'`,
      ]
      : ["; ── Code signing: no certificate was given to this build, so it is unsigned (docs/INSTALLERS.md)."]),
    "",
    `!define MUI_ICON "${nsisPath(icon)}"`,
    `!define MUI_UNICON "${nsisPath(icon)}"`,
    "!define MUI_ABORTWARNING",
    '!define MUI_WELCOMEPAGE_TEXT "This installs Cunning Claw for you alone; it needs no administrator password.$\\r$\\n$\\r$\\nIf he is running, close his window first.$\\r$\\n$\\r$\\nYour keys, memory and notes are kept in your own folder, so installing a newer version over this one never touches them."',
    "!define MUI_FINISHPAGE_RUN",
    '!define MUI_FINISHPAGE_RUN_TEXT "Start Cunning Claw now"',
    "!define MUI_FINISHPAGE_RUN_FUNCTION StartClaw",
    "!insertmacro MUI_PAGE_WELCOME",
    `!insertmacro MUI_PAGE_LICENSE "${nsisPath(license)}"`,
    "!insertmacro MUI_PAGE_COMPONENTS",
    "!insertmacro MUI_PAGE_DIRECTORY",
    "!insertmacro MUI_PAGE_INSTFILES",
    "!insertmacro MUI_PAGE_FINISH",
    "!insertmacro MUI_UNPAGE_CONFIRM",
    "!insertmacro MUI_UNPAGE_COMPONENTS",
    "!insertmacro MUI_UNPAGE_INSTFILES",
    '!insertmacro MUI_LANGUAGE "English"',
    "",
    "Function StartClaw",
    '  ExecShell "" "$INSTDIR\\Cunning Claw.cmd"',
    "FunctionEnd",
    "",
    "Section \"Cunning Claw\" SecMain",
    "  SectionIn RO",
    `  ${stop}`,
    "  ; An upgrade replaces the code whole, so nothing of the old version lingers.",
    "  ; Only when the marker says this folder is ours: the owner's things are never here.",
    '  IfFileExists "$INSTDIR\\app\\installed.json" 0 +3',
    '    RMDir /r "$INSTDIR\\app"',
    '    RMDir /r "$INSTDIR\\runtime"',
    '  SetOutPath "$INSTDIR"',
    `  File /r "${nsisPath(path.join(src, "app"))}"`,
    `  File /r "${nsisPath(path.join(src, "runtime"))}"`,
    `  File "${nsisPath(path.join(src, "Cunning Claw.cmd"))}"`,
    `  File "${nsisPath(path.join(src, "READ ME FIRST.txt"))}"`,
    `  File "/oname=cunningclaw.ico" "${nsisPath(icon)}"`,
    '  WriteUninstaller "$INSTDIR\\Uninstall Cunning Claw.exe"',
    '  CreateShortCut "$SMPROGRAMS\\Cunning Claw.lnk" "$INSTDIR\\Cunning Claw.cmd" "" "$INSTDIR\\cunningclaw.ico" 0',
    `  WriteRegStr HKCU "${key}" "DisplayName" "Cunning Claw"`,
    `  WriteRegStr HKCU "${key}" "DisplayVersion" "${version}"`,
    `  WriteRegStr HKCU "${key}" "Publisher" "Dragon Forge AI"`,
    `  WriteRegStr HKCU "${key}" "URLInfoAbout" "https://github.com/Dragon-Forge-master/cunning-claw"`,
    `  WriteRegStr HKCU "${key}" "DisplayIcon" "$INSTDIR\\cunningclaw.ico"`,
    `  WriteRegStr HKCU "${key}" "InstallLocation" "$INSTDIR"`,
    `  WriteRegStr HKCU "${key}" "UninstallString" '"$INSTDIR\\Uninstall Cunning Claw.exe"'`,
    `  WriteRegStr HKCU "${key}" "QuietUninstallString" '"$INSTDIR\\Uninstall Cunning Claw.exe" /S'`,
    `  WriteRegDWORD HKCU "${key}" "NoModify" 1`,
    `  WriteRegDWORD HKCU "${key}" "NoRepair" 1`,
    "  ${GetSize} \"$INSTDIR\" \"/S=0K\" $0 $1 $2",
    `  WriteRegDWORD HKCU "${key}" "EstimatedSize" $0`,
    "SectionEnd",
    "",
    "Section \"Desktop shortcut\" SecDesktop",
    '  CreateShortCut "$DESKTOP\\Cunning Claw.lnk" "$INSTDIR\\Cunning Claw.cmd" "" "$INSTDIR\\cunningclaw.ico" 0',
    "SectionEnd",
    "",
    "Section \"un.Cunning Claw\" UnSecMain",
    "  SectionIn RO",
    `  ${stop}`,
    '  Delete "$SMPROGRAMS\\Cunning Claw.lnk"',
    '  Delete "$DESKTOP\\Cunning Claw.lnk"',
    '  IfFileExists "$INSTDIR\\app\\installed.json" 0 +3',
    '    RMDir /r "$INSTDIR\\app"',
    '    RMDir /r "$INSTDIR\\runtime"',
    '  Delete "$INSTDIR\\Cunning Claw.cmd"',
    '  Delete "$INSTDIR\\READ ME FIRST.txt"',
    '  Delete "$INSTDIR\\cunningclaw.ico"',
    '  Delete "$INSTDIR\\Uninstall Cunning Claw.exe"',
    '  RMDir "$INSTDIR"',
    `  DeleteRegKey HKCU "${key}"`,
    "SectionEnd",
    "",
    "; Unticked unless the owner ticks it, and so in a silent uninstall too.",
    "Section /o \"un.Also delete my keys, memory and notes\" UnSecData",
    '  RMDir /r "$LOCALAPPDATA\\CunningClaw"',
    "SectionEnd",
    "",
    "!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN",
    '  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "Cunning Claw and the Node runtime he runs on, with a Start menu entry."',
    '  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "A Cunning Claw icon on your desktop."',
    "!insertmacro MUI_FUNCTION_DESCRIPTION_END",
    "!insertmacro MUI_UNFUNCTION_DESCRIPTION_BEGIN",
    '  !insertmacro MUI_DESCRIPTION_TEXT ${UnSecMain} "The app itself. Your own folder is kept unless you tick the box below."',
    '  !insertmacro MUI_DESCRIPTION_TEXT ${UnSecData} "Deletes %LOCALAPPDATA%\\CunningClaw: your keys, his memory, history and notes, and his own browser\'s sign-ins. Documents on your Desk (Documents\\CunningClaw) are never deleted."',
    "!insertmacro MUI_UNFUNCTION_DESCRIPTION_END",
    "",
  ].join("\n");
}

/**
 * The signing hook's command, or null with no certificate. makensis runs it
 * with %1 as the file to sign, in place. osslsigncode rather than signtool:
 * the installer is built on Linux, and it writes the same Authenticode
 * signature signtool does. WINDOWS_SIGN_PFX is a .pfx path and
 * WINDOWS_SIGN_PASSWORD_FILE a file holding its password — never the
 * password itself, which would sit in the process list.
 */
export function windowsSignCommand(env = process.env) {
  const pfx = env.WINDOWS_SIGN_PFX?.trim();
  if (!pfx) return null;
  const pass = env.WINDOWS_SIGN_PASSWORD_FILE?.trim();
  const ts = env.WINDOWS_SIGN_TIMESTAMP_URL?.trim() || "http://timestamp.digicert.com";
  return `osslsigncode sign -pkcs12 "${pfx}"${pass ? ` -readpass "${pass}"` : ""} -n "Cunning Claw" -i https://github.com/Dragon-Forge-master/cunning-claw -h sha256 -t ${ts} -in "%1" -out "%1.signed" && mv -f "%1.signed" "%1"`;
}

function buildNsis(bundleDir) {
  const work = path.join(OUT, ".installers", "nsis");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  layOut(bundleDir, work, "nsis");
  fs.writeFileSync(path.join(work, "Cunning Claw.cmd"), launcher("win"));
  fs.writeFileSync(path.join(work, "READ ME FIRST.txt"), readMe("win", pkg.version, "nsis"));
  const icon = path.join(work, "cunningclaw.ico");
  fs.writeFileSync(icon, icoFromPngs(iconPngs([16, 32, 48, 256])));
  const license = path.join(work, "LICENSE.txt");
  fs.writeFileSync(license, fs.readFileSync(path.join(ROOT, "LICENSE"), "utf-8").replace(/\r?\n/g, "\r\n"));

  const out = path.join(OUT, installerName("nsis", pkg.version, "win-x64"));
  fs.rmSync(out, { force: true });
  const script = path.join(work, "installer.nsi");
  fs.writeFileSync(script, nsisScript({ version: pkg.version, src: work, out, icon, license, sign: windowsSignCommand() }));
  run("makensis", ["-V2", "-INPUTCHARSET", "UTF8", script]);
  console.log(`  → ${path.relative(ROOT, out)}  (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
  return out;
}

/**
 * The .app's own executable.
 *
 * Opened from Finder, Launchpad or the Dock it has no window — nothing to show
 * he is running, nothing to close to stop him — so it opens Terminal on a
 * two-line script, as the download's launcher has a window. The script is
 * written fresh into the owner's folder each time: a file this app writes is
 * not quarantined, where one inside a downloaded app would make Gatekeeper ask
 * a second time. Run from a terminal (or with CLAW_NO_TERMINAL, as the CI
 * smoke test does) it simply runs.
 */
export function macLauncher() {
  return [
    "#!/bin/sh",
    "# Cunning Claw.app's executable. Generated by scripts/bundle.mjs.",
    'res="$(cd "$(dirname "$0")/../Resources" && pwd)"',
    'if [ "$1" = "--in-terminal" ]; then',
    "  shift",
    'elif [ ! -t 1 ] && [ -z "$CLAW_NO_TERMINAL" ]; then',
    '  dir="$HOME/Library/Application Support/cunningclaw"',
    '  mkdir -p "$dir"',
    '  self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"',
    "  quoted=\"'$(printf '%s' \"$self\" | sed \"s/'/'\\\\\\\\''/g\")'\"",
    '  printf \'#!/bin/sh\\nexec %s --in-terminal\\n\' "$quoted" > "$dir/Cunning Claw.command"',
    '  chmod 755 "$dir/Cunning Claw.command"',
    '  open -a Terminal "$dir/Cunning Claw.command" && exit 0',
    "  # No Terminal to open: run without a window rather than not at all.",
    "fi",
    'cd "$res/app" || exit 1',
    'PATH="$res/runtime/bin:$PATH"; export PATH',
    'CLAW_OPEN_HUD=1 exec "$res/runtime/bin/node" dist/boot.js "$@"',
    "",
  ].join("\n");
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function infoPlist(version) {
  const entries = {
    CFBundleName: "Cunning Claw",
    CFBundleDisplayName: "Cunning Claw",
    // Reverse DNS on the project's own GitHub home: a domain we do not hold is not ours to claim.
    CFBundleIdentifier: "io.github.dragon-forge-master.cunningclaw",
    CFBundleVersion: version,
    CFBundleShortVersionString: version,
    CFBundlePackageType: "APPL",
    CFBundleExecutable: "Cunning Claw",
    CFBundleIconFile: "cunningclaw",
    CFBundleInfoDictionaryVersion: "6.0",
    // Node 22's own floor.
    LSMinimumSystemVersion: "11.0",
    LSApplicationCategoryType: "public.app-category.productivity",
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...Object.entries(entries).map(([k, v]) => `  <key>${k}</key><string>${xml(v)}</string>`),
    "  <key>NSHighResolutionCapable</key><true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The .app, laid out. Pure file work, so it is checked on any system; only the .dmg needs a Mac. */
export function buildMacApp(bundleDir, into) {
  const app = path.join(into, "Cunning Claw.app");
  fs.rmSync(app, { recursive: true, force: true });
  const contents = path.join(app, "Contents");
  fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
  layOut(bundleDir, path.join(contents, "Resources"), "dmg");
  fs.writeFileSync(path.join(contents, "Info.plist"), infoPlist(pkg.version));
  fs.writeFileSync(path.join(contents, "MacOS", "Cunning Claw"), macLauncher(), { mode: 0o755 });
  fs.writeFileSync(path.join(contents, "Resources", "cunningclaw.icns"), icnsFromPngs(iconPngs([16, 32, 128, 256, 512])));
  return app;
}

function buildDmg(bundleDir, target) {
  if (process.platform !== "darwin") throw new Error("The .dmg builds on macOS (hdiutil is a macOS program).");
  const stage = path.join(OUT, ".installers", `${target}-dmg`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const app = buildMacApp(bundleDir, stage);
  fs.symlinkSync("/Applications", path.join(stage, "Applications"));
  fs.writeFileSync(path.join(stage, "READ ME FIRST.txt"), readMe("darwin", pkg.version, "dmg"));

  // ── Code signing and notarisation hook (docs/INSTALLERS.md). Each step runs
  // only when the build was given what it needs; absent, the app is unsigned
  // and macOS asks once before the first run.
  const identity = process.env.MACOS_SIGN_IDENTITY?.trim();
  if (identity) {
    run("codesign", ["--force", "--deep", "--options", "runtime", "--timestamp",
      "--entitlements", path.join(ROOT, "packaging", "macos", "entitlements.plist"), "--sign", identity, app]);
  } else console.log("  (unsigned: no MACOS_SIGN_IDENTITY)");

  const out = path.join(OUT, installerName("dmg", pkg.version, target));
  fs.rmSync(out, { force: true });
  run("hdiutil", ["create", "-volname", "Cunning Claw", "-srcfolder", stage, "-ov", "-format", "UDZO", "-fs", "HFS+", out]);
  if (identity) run("codesign", ["--force", "--timestamp", "--sign", identity, out]);

  const { MACOS_NOTARY_APPLE_ID: appleId, MACOS_NOTARY_TEAM_ID: team, MACOS_NOTARY_PASSWORD: pass } = process.env;
  if (identity && appleId && team && pass) {
    run("xcrun", ["notarytool", "submit", out, "--apple-id", appleId, "--team-id", team, "--password", pass, "--wait"]);
    run("xcrun", ["stapler", "staple", out]);
  } else if (identity) console.log("  (not notarised: no MACOS_NOTARY_* credentials)");
  console.log(`  → ${path.relative(ROOT, out)}  (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
  return out;
}

async function buildInstaller(kind, bundleDir, target) {
  console.log(`▸ ${kind} for ${target}`);
  if (kind === "appimage") return buildAppImage(bundleDir, target);
  if (kind === "nsis") return buildNsis(bundleDir);
  return buildDmg(bundleDir, target);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { targets, installers, nodeVersion, archive } = parseArgs(process.argv.slice(2));
  const stage = stageApp();
  for (const t of targets) {
    const dir = await bundle(stage, t, nodeVersion, archive);
    for (const kind of installers) if (INSTALLERS[kind] === TARGETS[t].os) await buildInstaller(kind, dir, t);
  }
  if (os.platform() === "win32") console.log("(installers are built on Linux and macOS; see docs/INSTALLERS.md)");
}
