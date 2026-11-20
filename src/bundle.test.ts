import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  APPIMAGE_TOOLS, INSTALL_MARKER, TARGETS, appRun, buildMacApp, icnsFromPngs, icoFromPngs, infoPlist, installedMarker,
  installerName, launcher, macLauncher, nsisScript, parseArgs, readMe, windowsSignCommand,
// @ts-expect-error — a plain .mjs build script with no types; imported for its pure helpers.
} from "../scripts/bundle.mjs";
import { INSTALL_MARKER as CLAW_MARKER } from "./home-root.js";

const execFileAsync = promisify(execFile);

/**
 * The double-click bundles. The build itself is proven by running it (and by
 * the Bundles workflow on real Windows and macOS runners); these pin the parts
 * a mistake in would only show on someone else's computer.
 */

test("the Windows launcher is a real .cmd: CRLF, the bundled node.exe, its own folder on PATH", () => {
  const cmd: string = launcher("win");
  assert.ok(cmd.split("\n").slice(0, -1).every((l) => l.endsWith("\r")), "every line ends CRLF — cmd.exe misreads LF-only files");
  assert.match(cmd, /"%~dp0runtime\\node\.exe" dist\\boot\.js/, "runs the bundled Node, not whatever is installed");
  assert.match(cmd, /set "PATH=%~dp0runtime;%PATH%"/, "connectors that spawn node or npx find the bundled one");
  assert.match(cmd, /cd \/d "%~dp0app"/, "works however it was opened, from any folder or drive");
  assert.match(cmd, /CLAW_OPEN_HUD=1/);
  assert.match(cmd, /dist\\boot\.js %\*/, "arguments pass through, so --import works from it");
});

test("the Linux and macOS launcher runs the bundled node from its own folder", () => {
  const sh: string = launcher("darwin");
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(sh, /\r/);
  assert.match(sh, /PATH="\$here\/runtime\/bin:\$PATH"/);
  assert.match(sh, /exec node dist\/boot\.js "\$@"/);
  assert.equal(launcher("linux"), sh, "one script for both");
});

test("every target names a real Node download, and the read-me says how to get past the unsigned-app warning", () => {
  for (const [id, t] of Object.entries(TARGETS) as [string, { node: string; ext: string; os: string }][]) {
    assert.match(t.node, /^(linux|darwin|win)-(x64|arm64)$/, id);
    assert.equal(t.ext, t.os === "win" ? "zip" : "tar.xz", id);
  }
  assert.match(readMe("win", "0.0.0"), /More info.*Run anyway/s);
  assert.match(readMe("darwin", "0.0.0"), /Right-click.*Open/s);
  for (const os of ["win", "darwin", "linux"]) assert.match(readMe(os, "0.0.0"), /no Cunning Claw crypto token/);
  // The no-terminal path must tell a first-timer that a free key exists.
  for (const os of ["win", "darwin", "linux"]) assert.match(readMe(os, "0.0.0"), /free Google\s+Gemini key/);
});

test("a dropped download is retried; a missing file is not", async () => {
  // Run 4 of the bundles workflow died on one ECONNRESET from nodejs.org.
  const { download } = await import("../scripts/bundle.mjs");
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new TypeError("terminated");
    return new Response("node-bytes");
  };
  const got = await download("https://nodejs.org/x", { fetchImpl: flaky, wait: async () => {} });
  assert.equal(String(got), "node-bytes");
  assert.equal(calls, 3);

  let missing = 0;
  const notFound = async () => { missing++; return new Response("nope", { status: 404 }); };
  await assert.rejects(download("https://nodejs.org/y", { fetchImpl: notFound, wait: async () => {} }), /HTTP 404/);
  assert.equal(missing, 1, "a 404 is not worth retrying");

  let busy = 0;
  const unavailable = async () => { busy++; return new Response("busy", { status: 503 }); };
  await assert.rejects(download("https://nodejs.org/z", { fetchImpl: unavailable, wait: async () => {}, tries: 3 }), /HTTP 503/);
  assert.equal(busy, 3);
});

// --- Installers ---------------------------------------------------------------
// The archives are folders the owner keeps; the installers put read-only code
// where the system keeps apps, and the owner's things in their own folder.
// What a mistake here would break shows only on someone else's computer, so
// the generated scripts are pinned here and the launchers are run for real.

test("the installers' marker is the one the claw looks for", () => {
  assert.equal(INSTALL_MARKER, CLAW_MARKER, "scripts/bundle.mjs and src/home-root.ts must agree, or an installed claw writes beside its read-only code");
  assert.equal(JSON.parse(installedMarker("nsis", "1.2.3")).installer, "nsis");
});

test("installer file names carry no spaces (GitHub turns them into dots) and say which system", () => {
  assert.equal(installerName("nsis", "1.2.3", "win-x64"), "Cunning-Claw-Setup-1.2.3.exe");
  assert.equal(installerName("dmg", "1.2.3", "darwin-arm64"), "Cunning-Claw-1.2.3-mac-arm64.dmg");
  assert.equal(installerName("dmg", "1.2.3", "darwin-x64"), "Cunning-Claw-1.2.3-mac-x64.dmg");
  assert.equal(installerName("appimage", "1.2.3", "linux-x64"), "Cunning-Claw-1.2.3-linux-x86_64.AppImage");
  assert.equal(installerName("appimage", "1.2.3", "linux-arm64"), "Cunning-Claw-1.2.3-linux-aarch64.AppImage");
});

test("arguments: several targets, a list of installers, and a typo refused", () => {
  const a = parseArgs(["--target", "darwin-arm64", "--target", "darwin-x64", "--installer", "dmg", "--no-archive"]);
  assert.deepEqual(a.targets, ["darwin-arm64", "darwin-x64"]);
  assert.deepEqual(a.installers, ["dmg"]);
  assert.equal(a.archive, false);
  assert.deepEqual(parseArgs(["--all", "--installer", "appimage,nsis"]).installers, ["appimage", "nsis"]);
  assert.equal(parseArgs(["--all"]).targets.length, Object.keys(TARGETS).length);
  assert.throws(() => parseArgs(["--installer", "msi"]), /Unknown installer/);
});

test("the AppImage tools are pinned by version and checksum, never a moving release", () => {
  for (const tool of Object.values(APPIMAGE_TOOLS) as { version: string; url: (a: string) => string; sha256: Record<string, string> }[]) {
    for (const arch of ["x86_64", "aarch64"]) {
      assert.match(tool.sha256[arch], /^[0-9a-f]{64}$/, arch);
      assert.ok(tool.url(arch).includes(`/download/${tool.version}/`), tool.url(arch));
      assert.doesNotMatch(tool.url(arch), /continuous/);
    }
  }
});

test("the Windows installer is per-user, keeps the owner's folder, and replaces only its own code", () => {
  const nsi: string = nsisScript({ version: "1.2.3", src: "/b/work", out: "/b/out.exe", icon: "/b/i.ico", license: "/b/L.txt", sign: null });
  assert.match(nsi, /^RequestExecutionLevel user$/m, "no administrator password");
  assert.match(nsi, /^InstallDir "\$LOCALAPPDATA\\Programs\\Cunning Claw"$/m);
  assert.doesNotMatch(nsi, /HKLM|\$PROGRAMFILES/, "nothing machine-wide");
  assert.match(nsi, /WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CunningClaw" "UninstallString"/, "listed in Add or remove programs");
  assert.match(nsi, /QuietUninstallString/);
  assert.match(nsi, /CreateShortCut "\$SMPROGRAMS\\Cunning Claw\.lnk"/);
  assert.match(nsi, /Section "Desktop shortcut"/, "the desktop icon is a choice");
  // The data box is unticked (/o) — so a silent uninstall keeps the owner's things too.
  assert.match(nsi, /Section \/o "un\.Also delete my keys, memory and notes" UnSecData\n {2}RMDir \/r "\$LOCALAPPDATA\\CunningClaw"/);
  // Every recursive delete inside the install folder is behind the marker.
  const lines = nsi.split("\n");
  lines.forEach((l, i) => {
    if (/RMDir \/r "\$INSTDIR/.test(l)) {
      const guard = lines.slice(Math.max(0, i - 2), i).join("\n");
      assert.match(guard, /IfFileExists "\$INSTDIR\\app\\installed\.json"/, `unguarded: ${l.trim()}`);
    }
  });
  assert.match(nsi, /\$\$_\.Path -like '\$INSTDIR\\\*'/, "a running claw is stopped by its path, never every node.exe by name");
  assert.match(nsi, /Code signing: no certificate/);
  assert.doesNotMatch(nsi, /!finalize/);
});

test("the signing hook signs the installer and its uninstaller when, and only when, a certificate is given", () => {
  assert.equal(windowsSignCommand({}), null);
  const cmd: string = windowsSignCommand({ WINDOWS_SIGN_PFX: "/secrets/cert.pfx", WINDOWS_SIGN_PASSWORD_FILE: "/secrets/pass" });
  assert.match(cmd, /^osslsigncode sign -pkcs12 "\/secrets\/cert\.pfx" -readpass "\/secrets\/pass"/);
  assert.match(cmd, /-in "%1" -out "%1\.signed" && mv -f "%1\.signed" "%1"$/, "in place, as makensis expects");
  const nsi: string = nsisScript({ version: "1.2.3", src: "/b", out: "/b/o.exe", icon: "/b/i.ico", license: "/b/L", sign: cmd });
  assert.match(nsi, /^!finalize '/m);
  assert.match(nsi, /^!uninstfinalize '/m, "the uninstaller inside it too");
});

test("installer read-mes say where the owner's things live, how to upgrade and remove, and get past each warning", () => {
  const win: string = readMe("win", "1.2.3", "nsis");
  assert.match(win, /%LOCALAPPDATA%\\CunningClaw/);
  assert.match(win, /More info.*Run anyway/s);
  assert.match(win, /kept unless you tick/);
  assert.ok(win.split("\n").slice(0, -1).every((l) => l.endsWith("\r")), "CRLF throughout, for Notepad");
  const mac: string = readMe("darwin", "1.2.3", "dmg");
  assert.match(mac, /Library\/Application Support\/cunningclaw/);
  assert.match(mac, /right-click Cunning Claw, choose Open/);
  assert.match(mac, /Open Anyway/, "macOS 15 took the right-click route away");
  const lin: string = readMe("linux", "1.2.3", "appimage");
  assert.match(lin, /\.local\/share\/cunningclaw/);
  assert.match(lin, /Allow executing\s+file as program/);
  assert.match(lin, /chmod \+x/);
  assert.match(lin, /--appimage-extract-and-run/);
  assert.match(lin, /APPIMAGE_EXTRACT_AND_RUN=1/);
  for (const t of [win, mac, lin]) {
    assert.match(t, /install the new version over this one/);
    assert.match(t, /--import/);
    assert.match(t, /no Cunning Claw crypto token/);
  }
  assert.match(readMe("linux", "1.2.3"), /app\/\.env/, "an archive keeps everything in its own folder");
  assert.match(readMe("linux", "1.2.3"), /--import/);
});

test("ico and icns hold the PNGs they were given, with the headers Windows and macOS read", () => {
  const png = (n: number) => Buffer.from(`png-${n}`);
  const ico: Buffer = icoFromPngs([{ size: 16, png: png(16) }, { size: 256, png: png(256) }]);
  assert.equal(ico.readUInt16LE(2), 1, "type 1 is an icon");
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico.readUInt8(6), 16);
  assert.equal(ico.readUInt8(6 + 16), 0, "256 is written as 0");
  const second = ico.readUInt32LE(6 + 16 + 12);
  assert.equal(ico.subarray(second, second + 7).toString(), "png-256");
  const icns: Buffer = icnsFromPngs([{ size: 16, png: png(16) }, { size: 48, png: png(48) }, { size: 512, png: png(512) }]);
  assert.equal(icns.subarray(0, 4).toString(), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.equal(icns.subarray(8, 12).toString(), "icp4");
  assert.ok(icns.includes("ic09"));
  assert.ok(!icns.includes("png-48"), "a size macOS has no PNG slot for is left out");
});

test("the .app is laid out as macOS expects, with its code marked installed", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "claw-macapp-"));
  try {
    const bundleDir = path.join(work, "bundle");
    fs.mkdirSync(path.join(bundleDir, "app", "dist"), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "app", "dist", "boot.js"), "");
    fs.mkdirSync(path.join(bundleDir, "runtime", "bin"), { recursive: true });
    const app: string = buildMacApp(bundleDir, work);
    const c = path.join(app, "Contents");
    assert.ok(fs.existsSync(path.join(c, "Resources", "app", INSTALL_MARKER)));
    assert.ok(fs.existsSync(path.join(c, "Resources", "runtime", "bin")));
    assert.ok(fs.statSync(path.join(c, "MacOS", "Cunning Claw")).mode & 0o100, "the executable is executable");
    assert.equal(fs.readFileSync(path.join(c, "Resources", "cunningclaw.icns")).subarray(0, 4).toString(), "icns");
    const plist = fs.readFileSync(path.join(c, "Info.plist"), "utf-8");
    assert.match(plist, /<key>CFBundleExecutable<\/key><string>Cunning Claw<\/string>/);
    assert.match(plist, /<key>CFBundleIconFile<\/key><string>cunningclaw<\/string>/);
    const version = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf-8")).version;
    assert.equal(plist, infoPlist(version));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

/** A launcher's folders, with a stand-in node that reports where it ran and with what. */
function fakeApp(appDir: string, runtimeBin: string): void {
  fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
  fs.mkdirSync(runtimeBin, { recursive: true });
  fs.writeFileSync(path.join(runtimeBin, "node"), '#!/bin/sh\necho "node in $(pwd) with $* open=$CLAW_OPEN_HUD"\n', { mode: 0o755 });
}

const unixOnly = process.platform === "win32" ? "runs sh launchers" : false;

test("the AppImage's AppRun runs its own node from its own app folder, and passes arguments", { skip: unixOnly }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-apprun-"));
  try {
    fakeApp(path.join(dir, "app"), path.join(dir, "runtime", "bin"));
    fs.writeFileSync(path.join(dir, "AppRun"), appRun(), { mode: 0o755 });
    const env = { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "", APPIMAGE: "" };
    const { stdout } = await execFileAsync(path.join(dir, "AppRun"), ["--import", "/old"], { env });
    assert.equal(stdout.trim(), `node in ${fs.realpathSync(path.join(dir, "app"))} with dist/boot.js --import /old open=1`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("double-clicked, the AppImage opens a terminal on itself; unpacked to /tmp it does not", { skip: unixOnly }, async () => {
  // A file manager gives no terminal: nothing to show he is running, nothing
  // to close. Extract-and-run is the exception: the runtime deletes the
  // unpacked copy when AppRun exits, under the terminal's copy's feet.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-apprun-"));
  try {
    fakeApp(path.join(dir, "app"), path.join(dir, "runtime", "bin"));
    fs.writeFileSync(path.join(dir, "AppRun"), appRun(), { mode: 0o755 });
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "x-terminal-emulator"), '#!/bin/sh\necho "terminal $*"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPLAY: ":0", APPIMAGE: "/home/owner/Cunning.AppImage", CLAW_NO_TERMINAL: "" };
    const mounted = await execFileAsync(path.join(dir, "AppRun"), [], { env: { ...env, APPDIR: "/tmp/.mount_Cunnin123" } });
    assert.equal(mounted.stdout.trim(), "terminal -e /home/owner/Cunning.AppImage --in-terminal");
    const inside = await execFileAsync(path.join(dir, "AppRun"), ["--in-terminal"], { env });
    assert.match(inside.stdout, /^node in .* with dist\/boot\.js open=1$/m, "the terminal's copy runs, and does not loop");
    const unpacked = await execFileAsync(path.join(dir, "AppRun"), [], { env: { ...env, APPDIR: "/tmp/appimage_extracted_0123" } });
    assert.match(unpacked.stdout, /^node in /m);
    const ci = await execFileAsync(path.join(dir, "AppRun"), [], { env: { ...env, APPDIR: "/tmp/.mount_x", CLAW_NO_TERMINAL: "1" } });
    assert.match(ci.stdout, /^node in /m, "CLAW_NO_TERMINAL runs it where it stands");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opened from Finder, the .app opens Terminal on a script it writes, which survives a quote in the path", { skip: unixOnly }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-macrun-"));
  try {
    const contents = path.join(dir, "O'Brien's Apps", "Cunning Claw.app", "Contents");
    fakeApp(path.join(contents, "Resources", "app"), path.join(contents, "Resources", "runtime", "bin"));
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    const exe = path.join(contents, "MacOS", "Cunning Claw");
    fs.writeFileSync(exe, macLauncher(), { mode: 0o755 });
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    // Stands in for `open -a Terminal <file>`: runs the file, as Terminal does.
    fs.writeFileSync(path.join(bin, "open"), '#!/bin/sh\necho "open $1 $2"\nexec sh "$3"\n', { mode: 0o755 });
    const owner = path.join(dir, "owner");
    const env = { ...process.env, HOME: owner, PATH: `${bin}:${process.env.PATH}`, CLAW_NO_TERMINAL: "" };
    const { stdout } = await execFileAsync(exe, [], { env });
    assert.match(stdout, /^open -a Terminal$/m);
    assert.match(stdout, /^node in .*O'Brien's Apps\/Cunning Claw\.app\/Contents\/Resources\/app with dist\/boot\.js open=1$/m);
    assert.ok(fs.existsSync(path.join(owner, "Library", "Application Support", "cunningclaw", "Cunning Claw.command")));
    const direct = await execFileAsync(exe, ["--import", "/old"], { env: { ...env, CLAW_NO_TERMINAL: "1" } });
    assert.match(direct.stdout, /with dist\/boot\.js --import \/old open=1/, "CI, and a terminal user, run it where it stands");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
