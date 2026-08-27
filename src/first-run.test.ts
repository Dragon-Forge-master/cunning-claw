import assert from "node:assert/strict";
import test from "node:test";
import { decideBoot } from "./first-run.js";
import { noKeyGuide } from "./doctor.js";

test("a cloud key is enough to boot", () => {
  assert.equal(decideBoot(true, false, false), true);
  assert.equal(decideBoot(true, true, false), true);
});

test("a local runtime is enough only when it answers", () => {
  assert.equal(decideBoot(false, true, true), true);
  assert.equal(decideBoot(false, true, false), false);
  assert.equal(decideBoot(false, false, false), false);
  assert.equal(decideBoot(false, false, true), false);
});

test("the keyless message still tells you the file, the line, and the URL", () => {
  assert.match(noKeyGuide(), /OPENROUTER_API_KEY=/);
  assert.match(noKeyGuide(), /openrouter\.ai\/keys/);
  assert.match(noKeyGuide(), /\.env/);
});
