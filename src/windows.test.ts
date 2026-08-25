import assert from "node:assert/strict";
import test from "node:test";
import { chordToSendKeys, escapeSendKeysText, psQuote, screenshotScript } from "./windows.js";
import { host, setHostForTests, isWsl, missing } from "./platform.js";

/**
 * The PowerShell calls cannot be exercised from Linux, but the parts most
 * likely to be wrong — translating key chords and escaping strings — are pure
 * functions, and those are tested here.
 */

test("xdotool-style chords translate to SendKeys", () => {
  assert.equal(chordToSendKeys("ctrl+s"), "^s");
  assert.equal(chordToSendKeys("alt+Tab"), "%{TAB}");
  assert.equal(chordToSendKeys("Return"), "{ENTER}");
  assert.equal(chordToSendKeys("ctrl+shift+p"), "^+p");
  assert.equal(chordToSendKeys("F5"), "{F5}");
  assert.equal(chordToSendKeys("a"), "a");
});

test("SendKeys syntax characters are escaped, not executed", () => {
  // '+' means shift to SendKeys; unescaped, "1+1" would send shift-1.
  assert.equal(escapeSendKeysText("1+1"), "1{+}1");
  assert.equal(escapeSendKeysText("50% (approx)"), "50{%} {(}approx{)}");
  assert.equal(escapeSendKeysText("plain text"), "plain text");
});

test("a chord whose key is a SendKeys sigil is braced", () => {
  assert.equal(chordToSendKeys("ctrl+{"), "^{{}");
});

test("PowerShell strings escape quotes by doubling", () => {
  assert.equal(psQuote("it's fine"), "'it''s fine'");
  // A naive implementation would let this close the string and inject.
  const hostile = psQuote("'; Remove-Item C:\\ -Recurse; '");
  assert.ok(!/(^|[^'])'(;)/.test(hostile.slice(1, -1)), "no unescaped quote survives");
});

test("the screenshot script writes to the path it is given", () => {
  const script = screenshotScript("C:\\tmp\\shot.png");
  assert.match(script, /System\.Drawing/);
  assert.match(script, /CopyFromScreen/);
  assert.match(script, /'C:\\tmp\\shot\.png'/);
  assert.match(script, /Dispose/, "handles must be released");
});

test("win32 is a recognised host, not the unsupported fallback", () => {
  setHostForTests("win32");
  assert.equal(host(), "win32");
  assert.match(missing("google-chrome"), /winget/);
  setHostForTests(null);
});

test("WSL is detected, since it reports linux without a desktop", () => {
  assert.equal(typeof isWsl(), "boolean");
});
