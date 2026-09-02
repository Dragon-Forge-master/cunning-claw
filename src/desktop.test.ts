import assert from "node:assert/strict";
import test from "node:test";
import { appleString, captureBackend, keysToDarwinScript, parseLinuxChord, textToDarwinScript } from "./desktop.js";

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

test("each platform selects exactly one screenshot backend", () => {
  // The bug: `if (win32) {…}` then `if (!captured && darwin) {…} else {x11}`.
  // On Windows the first branch succeeded, so !captured was false, so control
  // fell into the ELSE and ran the X11 capture anyway — discarding a good
  // screenshot and answering with a macOS hint on a Windows box. Choosing from
  // one value makes running two branches structurally impossible.
  assert.equal(captureBackend("win32"), "windows");
  assert.equal(captureBackend("darwin"), "darwin");
  assert.equal(captureBackend("linux"), "x11");
  assert.equal(captureBackend("freebsd"), "x11", "unknown unixes get the X11 path");
});
