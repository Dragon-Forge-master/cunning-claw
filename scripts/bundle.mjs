#!/usr/bin/env node
/**
 * Build the download-and-double-click bundles, and the installers made from them.
 *
 *   node scripts/bundle.mjs                 # this machine's platform
 *   node scripts/bundle.mjs --target win-x64
 *   node scripts/bundle.mjs --all           # every target, from one machine
 *   node scripts/bundle.mjs --all --installer appimage,deb,nsis
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
 *   deb       Ubuntu and Debian: the code in /opt/cunningclaw, a menu entry,
 *             installed with apt. dpkg-deb, which every Debian-family
 *             builder has; any Linux with dpkg-deb installed builds it.
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
export const INSTALLERS = { appimage: "linux", deb: "linux", nsis: "win", dmg: "darwin" };
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
  // Linux: a file manager's "Run as a Program" gives no window at all, so a
  // claw that could not start, or handed over to a running one, did so out
  // of sight. It opens a terminal on itself, as the AppImage does.
  if (os === "linux") {
    return posixLauncher({
      what: "Double-click (or run) to start Cunning Claw. Closing this window stops him.",
      locate: 'here="$(cd "$(dirname "$0")" && pwd)"',
      self: '"$here/$(basename "$0")"',
    });
  }
  // macOS: Finder runs a .command in Terminal, whose default profile keeps the
  // window open when the script ends ("When the shell exits: Don't close the
  // window"), so the last words stay on screen without any help from here.
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
 * "appimage")`; "deb" is installed as /usr/share/doc/cunningclaw/README).
 */
export function readMe(os, version, kind = "archive") {
  const nl = os === "win" ? "\r\n" : "\n";
  const installer = kind !== "archive";
  const deb = kind === "deb";
  const debFile = `cunningclaw_${debVersion(version)}_amd64.deb`;
  const start = deb
    ? "Applications  →  Cunning Claw  (or type  cunningclaw  in a terminal)"
    : installer
    ? os === "win" ? "Start menu (or the desktop)  →  Cunning Claw"
      : os === "darwin" ? "Drag Cunning Claw into Applications, then open it from there"
        : "Make the file executable once, then double-click it (see below)"
    : os === "win" ? "Double-click  Cunning Claw.cmd"
      : os === "darwin" ? "Double-click  Cunning Claw.command"
        : "Double-click  Cunning Claw.sh  (or run it from a terminal)";
  const firstTime = deb
    ? `Install it from the folder it downloaded to, in a terminal:\n  sudo apt install ./${debFile}\n(on an arm64 machine, the _arm64.deb). On Ubuntu, double-clicking the .deb may\nopen App Center with an Install button instead; the apt line always works.\nThere is no warning to get past: apt installs it like any other package.`
    : installer
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
      deb
        ? "To remove him: sudo apt remove cunningclaw. Your folder is kept; delete it\ntoo to remove everything."
        : os === "win"
        ? "To remove him: Settings → Apps → Cunning Claw → Uninstall. Your folder is\r\nkept unless you tick the box to delete it."
        : os === "darwin"
          ? "To remove him: drag Cunning Claw from Applications to the Bin. Your folder\nis kept; delete it too to remove everything."
          : "To remove him: delete the .AppImage. Your folder is kept; delete it too\nto remove everything.",
      "",
      "Coming from an unzipped download? Bring its keys and memory across with",
      deb
        ? "  cunningclaw --import ~/Downloads/old-folder"
        : os === "win"
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
      ...(os === "linux"
        ? [
          "",
          "An installer is easier. On Ubuntu or Debian, take the .deb (_arm64 on Arm) and run",
          `  sudo apt install ./${debFile}`,
          "then open Cunning Claw from Applications. On any other Linux, take the",
          ".AppImage, mark it executable (chmod +x) and double-click it.",
        ]
        : []),
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
    "Nothing here phones home. He binds to 127.0.0.1 only, behind a token.",
    "There is no Cunning Claw crypto token, and there never will be.",
    "",
    "https://github.com/Dragon-Forge-master/cunning-claw",
    "",
  ].join(nl).split("\n").map((l) => l.replace(/\r$/, "")).join(nl);
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
  const out = os === "linux" ? `${name}.tar.gz` : `${name}.zip`;
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
  // Debian's own shape, name_version_arch.deb, so apt and App Center read it as people expect.
  if (kind === "deb") return `cunningclaw_${debVersion(version)}_${debArch(target)}.deb`;
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
  return posixLauncher({
    what: "Cunning Claw's AppImage entry point.",
    locate: 'here="$(dirname "$(readlink -f "$0")")"',
    self: '"$APPIMAGE"',
    // Only a real AppImage launch: $APPIMAGE is the file a terminal can run again.
    when: '[ -n "$APPIMAGE" ]',
    unpackedGuard: true,
  });
}

/**
 * Terminals to open on a double-click, the first found. x-terminal-emulator
 * first, because on Debian and Ubuntu it is the one the system was told to
 * prefer — but it is resolved to the program it points at before choosing
 * how to hand it a command: Ptyxis, Ubuntu 25.10's terminal, is installed as
 * x-terminal-emulator and documents `--`, not xterm's `-e`.
 */
export const TERMINALS = ["x-terminal-emulator", "xdg-terminal-exec", "ptyxis", "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "mate-terminal", "xterm"];

/** How long a run counts as "stopped at once", in seconds: long enough for a handover, a port clash or a missing piece. */
export const QUICK_EXIT_SECONDS = 60;

/**
 * The Linux launchers — the download's Cunning Claw.sh, the AppImage's
 * AppRun and the .deb's /usr/bin/cunningclaw — one POSIX sh script with three
 * ways of finding itself.
 *
 * Double-clicked (no terminal on stdout, a display, CLAW_NO_TERMINAL unset)
 * it opens a terminal on itself with --in-terminal, so there is a window to
 * show he is running and to close to stop him. The founder's v0.5.1 AppImage
 * "didn't seem to do anything": in that window the claw handed over to his
 * running one within seconds and the window shut with it. So in a
 * window it opened itself, a claw that stops within QUICK_EXIT_SECONDS, or
 * with an error, leaves its last words up until Enter is pressed. Never in
 * the owner's own terminal (no --in-terminal), never without a terminal on
 * stdin, never with CLAW_NO_TERMINAL; and not after a signal, which is the
 * window being closed or Ctrl+C.
 *
 * No terminal to open (or an unpacked AppImage, see appRun) and it runs
 * without a window: the claw opens the browser — on itself, or on the copy
 * already running — and if it cannot start at all, a desktop notification
 * (notify-send, where there is one) says so, rather than nothing.
 */
export function posixLauncher({ what, locate, self, when = "", unpackedGuard = false }) {
  const pick = [
    `for t in ${TERMINALS.join(" ")}; do`,
    '  p="$(command -v "$t" 2>/dev/null)" || continue',
    '  k="$t"',
    '  [ "$t" = x-terminal-emulator ] && k="$(basename "$(readlink -f "$p")")"',
    '  case "$k" in',
    '    xdg-terminal-exec) exec "$p" "$self" --in-terminal "$@" ;;',
    '    ptyxis|gnome-terminal|kgx) exec "$p" -- "$self" --in-terminal "$@" ;;',
    '    xfce4-terminal|mate-terminal) exec "$p" -x "$self" --in-terminal "$@" ;;',
    '    *) exec "$p" -e "$self" --in-terminal "$@" ;;',
    "  esac",
    "done",
  ];
  const indent = (lines, n) => lines.map((l) => " ".repeat(n) + l);
  return [
    "#!/bin/sh",
    `# ${what} Generated by scripts/bundle.mjs.`,
    locate,
    `self=${self}`,
    "pause=; nowin=",
    'if [ "$1" = "--in-terminal" ]; then',
    "  shift; pause=1",
    `elif [ ! -t 1 ] && [ -z "$CLAW_NO_TERMINAL" ]${when ? ` && ${when}` : ""} && { [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; }; then`,
    "  nowin=1",
    ...(unpackedGuard
      ? ['  case "$APPDIR" in', "    */appimage_extracted_*) ;;", "    *)", ...indent(pick, 6), "      ;;", "  esac"]
      : indent(pick, 2)),
    "fi",
    'cd "$here/app" || exit 1',
    'PATH="$here/runtime/bin:$PATH"; export PATH',
    "CLAW_OPEN_HUD=1; export CLAW_OPEN_HUD",
    'node="$here/runtime/bin/node"',
    'if [ -n "$pause" ] && [ -t 0 ] && [ -z "$CLAW_NO_TERMINAL" ]; then',
    '  started="$(date +%s 2>/dev/null)"',
    '  "$node" dist/boot.js "$@"',
    "  status=$?",
    '  ended="$(date +%s 2>/dev/null)"',
    "  # A signal is the window closing or Ctrl+C: nobody is waiting to read.",
    '  [ "$status" -gt 128 ] && exit "$status"',
    "  case \"$started\" in ''|*[!0-9]*) started= ;; esac",
    "  case \"$ended\" in ''|*[!0-9]*) ended= ;; esac",
    `  if [ "$status" -ne 0 ] || [ -z "$started" ] || [ -z "$ended" ] || [ $((ended - started)) -lt ${QUICK_EXIT_SECONDS} ]; then`,
    "    printf '\\nPress Enter to close this window.'",
    "    read -r _ || true",
    "  fi",
    '  exit "$status"',
    "fi",
    'if [ -n "$nowin" ]; then',
    '  "$node" dist/boot.js "$@"',
    "  status=$?",
    '  if [ "$status" -ne 0 ] && [ "$status" -le 128 ] && command -v notify-send >/dev/null 2>&1; then',
    '    notify-send -i cunningclaw "Cunning Claw could not start" "Run it from a terminal to see why: $self"',
    "  fi",
    '  exit "$status"',
    "fi",
    'exec "$node" dist/boot.js "$@"',
    "",
  ].join("\n");
}

/** The .deb's /usr/bin/cunningclaw: the same script, with the code at DEB_PREFIX. */
export const DEB_PREFIX = "/opt/cunningclaw";
export function debLauncher() {
  return posixLauncher({
    what: "Cunning Claw, installed from the .deb (the code is in /opt/cunningclaw).",
    locate: `here=${DEB_PREFIX}`,
    self: "/usr/bin/cunningclaw",
  });
}

/**
 * The menu entry. Terminal=false on purpose, for the .deb as for the
 * AppImage: the launcher opens its own terminal (posixLauncher), so it can
 * keep that window up when the claw stops at once, and so that a desktop with
 * no terminal it knows still gets the browser and a notification. With
 * Terminal=true the desktop would choose the window, and close it the moment
 * the claw handed over to a running one.
 */
export function desktopEntry(version, kind = "appimage") {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Cunning Claw",
    "GenericName=Personal assistant",
    "Comment=A local-first personal assistant",
    "Exec=cunningclaw",
    "Icon=cunningclaw",
    "Terminal=false",
    "Categories=Utility;",
    ...(kind === "appimage" ? [`X-AppImage-Version=${version}`] : []),
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

// ---------------------------------------------------------------------------
// The .deb, for Ubuntu and Debian
// ---------------------------------------------------------------------------

/**
 * Who the package says made it. A placeholder the founder replaces with the
 * project's real address: Debian wants a name and an email in Maintainer, and
 * a person's own address does not belong in a public package.
 */
export const DEB_MAINTAINER = "Dragon Forge AI <placeholder@cunningclaw.com>";

/** Debian sorts "~" before anything, so 1.0.0~rc1 comes before 1.0.0 as semver's 1.0.0-rc1 does. */
export function debVersion(version) {
  return version.replace(/-/g, "~");
}

export function debArch(target) {
  return TARGETS[target].node.endsWith("arm64") ? "arm64" : "amd64";
}

/**
 * DEBIAN/control. Depends names only what the bundled Node itself links
 * against — read from its ELF header (readelf -d: libc, libstdc++, libgcc_s;
 * the newest symbol versions it asks for are GLIBC_2.28 and GLIBCXX_3.4.21,
 * which is Node 22's own floor) — because everything else, Node included,
 * ships inside. libgcc1 is the older name of libgcc-s1 (Debian 10).
 *
 * Recommends bubblewrap: the shell's box on Linux (src/sandbox.ts). He runs
 * without it — the doctor names it as missing — so it is not a Depends; but
 * apt installs what a package recommends unless told not to, so an owner who
 * installs the .deb gets the boxed shell without having to know to ask.
 */
export function debControl({ version, arch, installedSizeKiB }) {
  return [
    "Package: cunningclaw",
    `Version: ${debVersion(version)}`,
    `Architecture: ${arch}`,
    `Maintainer: ${DEB_MAINTAINER}`,
    `Installed-Size: ${installedSizeKiB}`,
    "Depends: libc6 (>= 2.28), libstdc++6 (>= 5.2), libgcc-s1 | libgcc1",
    "Recommends: bubblewrap",
    "Section: utils",
    "Priority: optional",
    "Homepage: https://github.com/Dragon-Forge-master/cunning-claw",
    "Description: local-first personal AI assistant",
    " Cunning Claw is a personal assistant that runs on this computer: a HUD in",
    " your browser on 127.0.0.1, a brain you choose (a free Gemini key, an",
    " OpenRouter key, or an offline model), and hands on this machine that ask",
    " before they act. Prompt injection is the threat model: he reads",
    " strangers' text and never takes orders from it.",
    " .",
    " The app and its own Node runtime are installed in /opt/cunningclaw. Your",
    " keys, settings, memory and notes live in ~/.local/share/cunningclaw, which",
    " removing the package leaves alone.",
    "",
  ].join("\n");
}

/** Debian's copyright file: the licence, in the machine-readable format, from LICENSE itself. */
export function debCopyright(license) {
  const holder = license.match(/^Copyright \(c\) (.+)$/m)?.[1] ?? "Dragon Forge AI";
  const terms = license.slice(Math.max(0, license.indexOf("Permission is hereby granted")));
  const body = terms.trim().split("\n").map((l) => (l.trim() ? ` ${l.trim()}` : " .")).join("\n");
  return [
    "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/",
    "Upstream-Name: cunningclaw",
    "Source: https://github.com/Dragon-Forge-master/cunning-claw",
    "",
    "Files: *",
    `Copyright: ${holder}`,
    "License: MIT",
    body,
    "",
  ].join("\n");
}

/** Every path under `root`, files and symlinks, relative and forward-slashed. */
function walk(root, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push({ rel: r, dir: true }, ...walk(root, r));
    else out.push({ rel: r, dir: false, link: e.isSymbolicLink() });
  }
  return out;
}

/**
 * The package's tree, laid out under `root`, without DEBIAN/:
 *
 *   opt/cunningclaw/app, runtime        the bundle, marked installed (read-only to the owner)
 *   usr/bin/cunningclaw                 debLauncher()
 *   usr/share/applications/cunningclaw.desktop
 *   usr/share/icons/hicolor/NxN/apps/cunningclaw.png
 *   usr/share/doc/cunningclaw/README, copyright
 *
 * No postinst or prerm. Ubuntu's and Debian's desktop-file-utils and
 * gtk-update-icon-cache already hold dpkg triggers on
 * /usr/share/applications and /usr/share/icons/hicolor, so the menu entry
 * and icon appear without a script of ours; and nothing of the owner's is
 * under a path dpkg knows, so removal cannot touch it.
 */
export function layOutDeb(bundleDir, root, version) {
  const prefix = path.join(root, DEB_PREFIX.slice(1));
  fs.mkdirSync(prefix, { recursive: true });
  layOut(bundleDir, prefix, "deb");
  const put = (rel, text, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, { mode });
  };
  put("usr/bin/cunningclaw", debLauncher(), 0o755);
  put("usr/share/applications/cunningclaw.desktop", desktopEntry(version, "deb"));
  for (const size of [16, 32, 48, 128, 256, 512]) {
    put(`usr/share/icons/hicolor/${size}x${size}/apps/cunningclaw.png`, fs.readFileSync(path.join(ICONS, `cunningclaw-${size}.png`)));
  }
  put("usr/share/doc/cunningclaw/README", readMe("linux", version, "deb"));
  put("usr/share/doc/cunningclaw/copyright", debCopyright(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf-8")));
  // dpkg installs modes as they are: 755 for folders and anything executable,
  // 644 for the rest, whatever the builder's umask made of the copies.
  for (const e of walk(root)) {
    if (e.link) continue;
    const p = path.join(root, e.rel);
    fs.chmodSync(p, e.dir || fs.statSync(p).mode & 0o111 ? 0o755 : 0o644);
  }
  return root;
}

/** Installed-Size, in KiB, as dpkg counts it: each file rounded up, and one for each folder and link. */
export function installedSizeKiB(root) {
  let kib = 0;
  for (const e of walk(root)) {
    if (e.rel === "DEBIAN" || e.rel.startsWith("DEBIAN/")) continue;
    kib += e.dir || e.link ? 1 : Math.ceil(fs.statSync(path.join(root, e.rel)).size / 1024);
  }
  return kib;
}

function buildDeb(bundleDir, target) {
  if (process.platform !== "linux") throw new Error("The .deb builds on Linux (dpkg-deb).");
  const root = path.join(OUT, ".installers", `${target}.deb`);
  fs.rmSync(root, { recursive: true, force: true });
  layOutDeb(bundleDir, root, pkg.version);
  const control = path.join(root, "DEBIAN");
  fs.mkdirSync(control, { mode: 0o755 });
  // md5sums lets `dpkg --verify cunningclaw` say whether the code was changed after install.
  const sums = walk(root)
    .filter((e) => !e.dir && !e.link && !e.rel.startsWith("DEBIAN/"))
    .map((e) => `${crypto.createHash("md5").update(fs.readFileSync(path.join(root, e.rel))).digest("hex")}  ${e.rel}`);
  fs.writeFileSync(path.join(control, "md5sums"), sums.join("\n") + "\n", { mode: 0o644 });
  fs.writeFileSync(path.join(control, "control"),
    debControl({ version: pkg.version, arch: debArch(target), installedSizeKiB: installedSizeKiB(root) }), { mode: 0o644 });
  const out = path.join(OUT, installerName("deb", pkg.version, target));
  fs.rmSync(out, { force: true });
  // root:root owners whoever builds it; xz, which every dpkg reads (zstd needs Debian 12).
  run("dpkg-deb", ["--root-owner-group", "-Zxz", "--build", root, out]);
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
  if (kind === "deb") return buildDeb(bundleDir, target);
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
