import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_PREFS, loadPrefs, normalisePrefs, normaliseVoiceSpeed, savePrefs } from "./hud-prefs.js";

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

test("the plain face is a choice of its own, stored and read back like the others", () => {
  const dir = tmpDir();
  assert.equal(savePrefs(dir, { font: "plain" }).font, "plain");
  assert.equal(loadPrefs(dir).font, "plain", "plain survives a reload, not quietly reset to standard");
  assert.equal(normalisePrefs({ font: "plain" }).font, "plain");
});

test("the voice speed is kept in tenths within its range, beside the typeface, and nonsense is refused", () => {
  // Asked for on 25 November 2026. Fails with voiceSpeed taken out of savePrefs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-prefs-speed-"));
  assert.equal(loadPrefs(dir).voiceSpeed, 1, "as configured until the owner says otherwise");
  assert.equal(savePrefs(dir, { voiceSpeed: 1.4 }).voiceSpeed, 1.4);
  assert.equal(savePrefs(dir, { font: "plain" }).voiceSpeed, 1.4, "changing the typeface leaves the speed alone");
  assert.equal(loadPrefs(dir).font, "plain");
  for (const bad of [5, 0.1, -1, "1.2", null, NaN, Infinity]) {
    assert.equal(savePrefs(dir, { voiceSpeed: bad }).voiceSpeed, 1.4, `${String(bad)} changes nothing`);
  }
  assert.equal(normaliseVoiceSpeed(1.234), 1.2);
  assert.equal(normaliseVoiceSpeed(0.7), 0.7);
  assert.equal(normaliseVoiceSpeed(1.6), 1.6);
  assert.equal(normalisePrefs({ voiceSpeed: 9 }).voiceSpeed, DEFAULT_PREFS.voiceSpeed);
});
