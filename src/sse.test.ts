import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The HUD and the server talk over SSE with no shared type. Two agents editing
 * both sides in parallel silently desynchronised it: handlers survived for
 * events no longer emitted, and brain_guard — the visible half of a safety
 * feature — was emitted and ignored. This test pins the contract.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

function serverEvents(): Set<string> {
  const names = new Set<string>();
  for (const file of fs.readdirSync(path.join(ROOT, "src"))) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = fs.readFileSync(path.join(ROOT, "src", file), "utf-8");
    for (const m of src.matchAll(/(?:emit|broadcast)\(\s*"([a-z_]+)"/g)) names.add(m[1]);
  }
  return names;
}

function hudEvents(): Set<string> {
  const src = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf-8");
  const names = new Set<string>();
  for (const m of src.matchAll(/es\.addEventListener\(\s*"([a-z_]+)"/g)) names.add(m[1]);
  return names;
}

// Events the server emits that the HUD is not required to render.
const HUD_MAY_IGNORE = new Set(["todos", "preview"]);

test("every HUD listener corresponds to an event the server emits", () => {
  const server = serverEvents();
  const dead = [...hudEvents()].filter((e) => !server.has(e));
  assert.deepEqual(dead, [], `HUD listens for events nothing emits: ${dead.join(", ")}`);
});

test("safety-relevant events are rendered, not silently dropped", () => {
  const hud = hudEvents();
  for (const required of ["brain_guard", "approval_request", "approval_resolved"]) {
    assert.ok(hud.has(required), `HUD must render "${required}" — it is how the operator sees the safety layer`);
  }
});

test("no server event is ignored without being explicitly allowed", () => {
  const hud = hudEvents();
  const ignored = [...serverEvents()].filter((e) => !hud.has(e) && !HUD_MAY_IGNORE.has(e));
  assert.deepEqual(ignored, [], `server emits unhandled events: ${ignored.join(", ")}`);
});
