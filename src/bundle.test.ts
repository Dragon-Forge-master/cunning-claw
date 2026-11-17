import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error — a plain .mjs build script with no types; imported for its pure helpers.
import { TARGETS, launcher, readMe } from "../scripts/bundle.mjs";

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
});

test("the Linux and macOS launcher runs the bundled node from its own folder", () => {
  const sh: string = launcher("darwin");
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(sh, /\r/);
  assert.match(sh, /PATH="\$here\/runtime\/bin:\$PATH"/);
  assert.match(sh, /exec node dist\/boot\.js/);
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
