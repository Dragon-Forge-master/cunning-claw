import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_PREFS, loadPrefs, normalisePrefs, savePrefs } from "./hud-prefs.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hud-prefs-"));
}

test("a fresh install reads the standard face", () => {
  assert.deepEqual(loadPrefs(tmpDir()), DEFAULT_PREFS);
  assert.equal(DEFAULT_PREFS.font, "standard");
});

test("choosing the dyslexic face survives a reload from disk", () => {
  const dir = tmpDir();
  assert.equal(savePrefs(dir, { font: "dyslexic" }).font, "dyslexic");
  assert.equal(loadPrefs(dir).font, "dyslexic", "the choice must follow the install, not one browser");
  assert.equal(savePrefs(dir, { font: "standard" }).font, "standard");
  assert.equal(loadPrefs(dir).font, "standard");
});

test("an unknown font is refused, not written, and does not undo the stored choice", () => {
  const dir = tmpDir();
  savePrefs(dir, { font: "dyslexic" });
  assert.equal(savePrefs(dir, { font: "comic-sans; background:url(x)" }).font, "dyslexic");
  assert.equal(savePrefs(dir, null).font, "dyslexic");
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "hud-prefs.json"), "utf-8"), /comic/);
});

test("a corrupt or hand-edited file falls back to the default rather than breaking the HUD", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "hud-prefs.json"), "{ not json");
  assert.deepEqual(loadPrefs(dir), DEFAULT_PREFS);
  assert.deepEqual(normalisePrefs({ font: 7, extra: "x" }), DEFAULT_PREFS);
});
