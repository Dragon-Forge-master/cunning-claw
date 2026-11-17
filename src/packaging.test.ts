import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT } from "./config.js";

/**
 * The autostart unit install.sh writes from packaging/cunningclaw.service.
 * Found on the operator's machine, 17 Nov: `systemctl --user enable --now
 * cunningclaw` failed with "bad unit file setting" because the template
 * quoted WorkingDirectory, which systemd rejects as "not absolute". The
 * installer said it had installed the unit; nothing ever started at login.
 */
function rendered(root: string): string {
  return fs
    .readFileSync(path.join(ROOT, "packaging", "cunningclaw.service"), "utf-8")
    .replaceAll("@@ROOT@@", root)
    // Any executable stands in for npm: verify checks the file exists.
    .replaceAll("@@NPM@@", "/bin/sh")
    .replaceAll("@@PATH@@", "/usr/bin:/bin");
}

test("the unit's WorkingDirectory is a bare absolute path, even with a space in it", () => {
  const unit = rendered("/home/someone/Game Dev/jarvis");
  const line = unit.split("\n").find((l) => l.startsWith("WorkingDirectory="));
  assert.equal(line, "WorkingDirectory=/home/someone/Game Dev/jarvis");
});

test("systemd itself accepts the rendered unit, where systemd-analyze is available", (t) => {
  let analyze = "";
  try { analyze = execFileSync("sh", ["-c", "command -v systemd-analyze"], { encoding: "utf-8" }).trim(); } catch { /* none */ }
  if (!analyze) return t.skip("systemd-analyze not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-unit-"));
  try {
    const root = path.join(dir, "Game Dev");
    fs.mkdirSync(root);
    const file = path.join(dir, "cunningclaw.service");
    fs.writeFileSync(file, rendered(root));
    let out = "";
    try {
      out = execFileSync(analyze, ["verify", file], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: any) {
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      // A sandbox with no systemd manager cannot verify anything; that is not a verdict on the unit.
      if (/Failed to initialize manager|RuntimeDirectory/.test(out) && !/WorkingDirectory/.test(out)) return t.skip("no systemd manager here");
      assert.fail(`systemd rejected the unit:\n${out}`);
    }
    assert.doesNotMatch(out, /bad unit file|not absolute/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
