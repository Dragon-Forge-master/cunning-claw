import assert from "node:assert/strict";
import test from "node:test";
import { listSkills, readSkill, readHeartbeat } from "./workspace.js";
import { loadLandscape } from "./landscape.js";

test("ships OpenClaw/Hermes workspace files", () => {
  assert.match(readHeartbeat(), /HEARTBEAT_OK/);
});

test("ships agentskills.io skills", () => {
  const names = listSkills().map((s) => s.name).sort();
  assert.deepEqual(names, ["cardiff-briefing", "forge-doctrine", "landscape-watch"]);
  assert.match(readSkill("landscape-watch"), /OpenClaw/);
});

test("field map tracks the systems that actually moved 2026", () => {
  const data = loadLandscape();
  const ids = data.systems.map((s) => s.id);
  for (const need of ["openclaw", "hermes-agent", "open-interpreter", "stanford-openjarvis"]) {
    assert.ok(ids.includes(need), `missing ${need}`);
  }
  assert.ok(data.systems.length >= 8);
});
