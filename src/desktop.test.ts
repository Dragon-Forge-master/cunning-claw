import assert from "node:assert/strict";
import test from "node:test";
import { appleString, keysToDarwinScript, parseLinuxChord, textToDarwinScript } from "./desktop.js";

test("ctrl maps to command on Darwin so Save is command+s", () => {
  const chord = parseLinuxChord("ctrl+s");
  assert.deepEqual(chord.mods, ["command"]);
  assert.equal(chord.keystroke, "s");
  assert.match(keysToDarwinScript("ctrl+s"), /keystroke "s" using command down/);
});

test("alt+Tab is the app switcher: command+tab, not option+tab", () => {
  const chord = parseLinuxChord("alt+Tab");
  assert.deepEqual(chord.mods, ["command"]);
  assert.equal(chord.keyCode, 48);
  assert.match(keysToDarwinScript("alt+Tab"), /key code 48 using command down/);
});

test("Return, Escape and F-keys become AppleScript key codes", () => {
  assert.equal(parseLinuxChord("Return").keyCode, 36);
  assert.equal(parseLinuxChord("Escape").keyCode, 53);
  assert.equal(parseLinuxChord("F5").keyCode, 96);
  const script = keysToDarwinScript("ctrl+shift+s Return");
  assert.match(script, /keystroke "s" using command down, shift down/);
  assert.match(script, /key code 36/);
  assert.match(script, /tell application "System Events"/);
});

test("AppleScript strings escape quotes and backslashes", () => {
  assert.equal(appleString('say "hi"'), `"say \\"hi\\""`);
  assert.equal(appleString("a\\b"), `"a\\\\b"`);
});

test("typed newlines become Return key codes, not literal slashes", () => {
  const script = textToDarwinScript("hello\nworld");
  assert.match(script, /keystroke "hello"/);
  assert.match(script, /key code 36/);
  assert.match(script, /keystroke "world"/);
});
