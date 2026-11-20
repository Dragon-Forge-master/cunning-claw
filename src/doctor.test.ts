import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkHistoryJson,
  earsCheck,
  hasEssentialFailure,
  noKeyGuide,
  nodeMajor,
  runDoctor,
  setChromeFinderForTests,
  voiceNotesCheck,
} from "./doctor.js";
import { envLooksSet } from "./brain.js";
import { setHasBinForTests, setHostForTests } from "./platform.js";
import { resetVoiceDetectForTests } from "./voice.js";
import { resetEarsForTests } from "./ears.js";

afterEach(() => {
  setHostForTests(null);
  setHasBinForTests(null);
  setChromeFinderForTests(null);
  resetVoiceDetectForTests();
  resetEarsForTests();
});

test("doctor names ffmpeg, whisper.cpp and Piper for Telegram voice notes — ffmpeg was only ever named under the webcam", async () => {
  setHostForTests("linux");
  setHasBinForTests(() => false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cunningclaw-doctor-notes-"));
  resetEarsForTests();
  const row = await voiceNotesCheck(root);
  assert.equal(row.id, "voice-notes");
  assert.equal(row.status, "warn");
  assert.equal(row.essential, false, "a phone line without voice still works by text");
  assert.match(row.line, /ffmpeg is not installed\. sudo apt install ffmpeg/);
  assert.match(row.line, /whisper\.cpp/);
  assert.match(row.line, /setup-ears\.sh/);
  // In this checkout Piper's venv is absent, so the reply half names it too.
  if (!fs.existsSync(path.join(process.cwd(), ".venv", "bin", "piper"))) assert.match(row.line, /setup-voice\.sh/);
  const ids = (await runDoctor()).map((c) => c.id);
  assert.ok(ids.includes("voice-notes"), "and runDoctor carries the row");
});

test("doctor says the mic's audio leaves the machine, and names the fix for local ears", async () => {
  setHostForTests("linux");
  setHasBinForTests(() => false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cunningclaw-doctor-ears-"));
  try {
    const cloud = await earsCheck(root);
    assert.equal(cloud.status, "warn");
    assert.equal(cloud.essential, false);
    assert.match(cloud.line, /audio leaves this machine/);
    assert.match(cloud.line, /setup-ears\.sh/);
    assert.match(cloud.line, /github\.com\/ggml-org\/whisper\.cpp/);
    assert.match(cloud.line, /ggml-base\.en\.bin/);

    setHostForTests("darwin");
    assert.match((await earsCheck(root)).line, /brew install whisper-cpp/);

    fs.mkdirSync(path.join(root, ".whisper", "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".whisper", "bin", "whisper-cli"), "#!/bin/sh\n", { mode: 0o755 });
    fs.mkdirSync(path.join(root, "models"));
    fs.writeFileSync(path.join(root, "models", "ggml-base.en.bin"), "x");
    const local = await earsCheck(root);
    assert.equal(local.status, "ok");
    assert.match(local.line, /Ears: local — whisper\.cpp · base\.en/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  // The hasBin fake cannot hide a Chrome at an absolute path — Apple's CI
  // runner ships one at /Applications and failed this test honestly.
  setChromeFinderForTests(async () => null);
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
  // The shell sandbox: absent bubblewrap is a warning with the package named.
  const box = checks.find((c) => c.id === "sandbox");
  assert.ok(box, "doctor must say what run_command runs inside");
  assert.equal(box!.status, "warn");
  assert.match(box!.line, /sudo apt install bubblewrap/);
});

test("every failed or warned line names a fix", async () => {
  setHostForTests("linux");
  setHasBinForTests(() => false);
  setChromeFinderForTests(async () => null);
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

test("doctor names each document converter, what it is for, and how to install it", async () => {
  setHostForTests("linux");
  setHasBinForTests(() => false);
  setChromeFinderForTests(async () => null);
  resetVoiceDetectForTests();
  const checks = await runDoctor();
  const want: Record<string, RegExp> = {
    "doc-markitdown": /pipx install 'markitdown\[all\]'/,
    "doc-pdftotext": /sudo apt install poppler-utils/,
    "doc-tesseract": /sudo apt install tesseract-ocr/,
  };
  for (const [id, fix] of Object.entries(want)) {
    const c = checks.find((x) => x.id === id);
    assert.ok(c, `doctor must include ${id}`);
    assert.equal(c!.status, "warn");
    // The built-in reader covers Office files, so none of these may fail the run.
    assert.equal(c!.essential, false);
    assert.match(c!.line, fix);
    assert.match(c!.line, /read_document/);
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
