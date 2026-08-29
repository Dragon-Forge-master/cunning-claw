import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { listSkills, readSkill, readHeartbeat, WORKSPACE } from "./workspace.js";
import { loadLandscape } from "./landscape.js";

test("ships OpenClaw/Hermes workspace files", () => {
  assert.match(readHeartbeat(), /HEARTBEAT_OK/);
  assert.match(fs.readFileSync(path.join(WORKSPACE, "SOUL.md"), "utf-8"), /dynion hysbys/);
  assert.match(fs.readFileSync(path.join(WORKSPACE, "IDENTITY.md"), "utf-8"), /Cunning Claw/);
});

test("ships agentskills.io skills", () => {
  const names = listSkills().map((s) => s.name);
  // Skills are meant to be added, so assert the shipped set is present rather
  // than pinning an exclusive list.
  for (const required of [
    "accountant",
    "cardiff-briefing",
    "forge-doctrine",
    "landscape-watch",
    "code-on-this-machine",
    "desk-hands",
    "browser-hands",
    "linux-box",
    "inbox-triage",
    "mcp-hands",
    "web-research",
    "house-control",
    "butler-eyes",
    "security-pass",
    "spend-aware",
    "auto-care",
    "welsh-copy",
  ]) {
    assert.ok(names.includes(required), `missing skill: ${required}`);
  }
  assert.match(readSkill("landscape-watch"), /OpenClaw/);
  const code = listSkills().find((s) => s.name === "code-on-this-machine");
  assert.equal(code?.category, "machine");
  assert.equal(code?.label, "Code");
});

test("field map tracks the systems that actually moved 2026", () => {
  const data = loadLandscape();
  const ids = data.systems.map((s) => s.id);
  for (const need of ["openclaw", "hermes-agent", "open-interpreter", "stanford-openclaw"]) {
    assert.ok(ids.includes(need), `missing ${need}`);
  }
  assert.ok(data.systems.length >= 8);
});
