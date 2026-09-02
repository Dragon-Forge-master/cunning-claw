import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  checkHistoryJson,
  hasEssentialFailure,
  noKeyGuide,
  nodeMajor,
  runDoctor,
} from "./doctor.js";
import { envLooksSet } from "./brain.js";
import { setHasBinForTests, setHostForTests } from "./platform.js";
import { resetVoiceDetectForTests } from "./voice.js";

afterEach(() => {
  setHostForTests(null);
  setHasBinForTests(null);
  resetVoiceDetectForTests();
});

test("Node 22 is the floor", () => {
  assert.equal(nodeMajor("22.14.0") >= 22, true);
  assert.equal(nodeMajor("20.19.0") >= 22, false);
  assert.equal(nodeMajor("24.1.0") >= 22, true);
});

test("placeholder keys do not count as present", () => {
  process.env.CLAW_DOCTOR_TEST_KEY = "sk-ant-...";
  assert.equal(envLooksSet("CLAW_DOCTOR_TEST_KEY"), false);
  process.env.CLAW_DOCTOR_TEST_KEY = "sk-or-...";
  assert.equal(envLooksSet("CLAW_DOCTOR_TEST_KEY"), false);
  process.env.CLAW_DOCTOR_TEST_KEY = "sk-ant-api03-realishvaluewithenoughchars";
  assert.equal(envLooksSet("CLAW_DOCTOR_TEST_KEY"), true);
  delete process.env.CLAW_DOCTOR_TEST_KEY;
});

test("no-key guide names the file, the env var, and where to get a key", () => {
  const g = noKeyGuide();
  assert.match(g, /cp \.env\.example \.env/);
  assert.match(g, /OPENROUTER_API_KEY=/);
  assert.match(g, /openrouter\.ai\/keys/);
  assert.match(g, /ollama pull/);
});

test("history.json must be a JSON array when present", () => {
  const missing = checkHistoryJson(null);
  assert.equal(missing.status, "ok");
  const good = checkHistoryJson("[]");
  assert.equal(good.status, "ok");
  const obj = checkHistoryJson("{}");
  assert.equal(obj.status, "fail");
  assert.equal(obj.essential, true);
  assert.match(obj.line, /delete it|restore/);
  const junk = checkHistoryJson("{not json");
  assert.equal(junk.status, "fail");
  assert.match(junk.line, /not valid JSON/);
});

test("Linux doctor names apt packages for missing desktop tools", async () => {
  setHostForTests("linux");
  setHasBinForTests(() => false);
  resetVoiceDetectForTests();
  const checks = await runDoctor();
  const ids = checks.map((c) => c.id);
  for (const required of ["node", "env", "brains", "voice", "ollama", "screenshot", "eyes", "xdotool", "wmctrl", "xclip", "pactl", "chrome", "port", "history"]) {
    assert.ok(ids.includes(required), `doctor must include ${required}`);
  }
  const xdotool = checks.find((c) => c.id === "xdotool");
  assert.ok(xdotool);
  assert.notEqual(xdotool.status, "ok");
  assert.match(xdotool.line, /sudo apt install xdotool/);
  const chrome = checks.find((c) => c.id === "chrome");
  assert.ok(chrome);
  assert.match(chrome!.line, /google-chrome|browser\.binary/);
  assert.equal(checks.find((c) => c.id === "node")?.status, "ok");
});

test("every failed or warned line names a fix", async () => {
  setHostForTests("linux");
  setHasBinForTests(() => false);
  resetVoiceDetectForTests();
  const checks = await runDoctor();
  for (const c of checks) {
    if (c.status === "ok") continue;
    assert.match(
      c.line,
      /install|cp |\.env|setup-voice|ollama|nodejs\.org|delete it|claw\.config|https:\/\//i,
      `failure must name a fix: ${c.line}`,
    );
  }
});

test("essential failures are the ones that fail the process", () => {
  assert.equal(hasEssentialFailure([
    { id: "voice", status: "warn", essential: false, line: "! voice" },
  ]), false);
  assert.equal(hasEssentialFailure([
    { id: "brains", status: "fail", essential: true, line: "✗ brains" },
  ]), true);
});
