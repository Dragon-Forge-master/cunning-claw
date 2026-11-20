import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseWav } from "./ears.js";
import {
  execBytes, hearingGap, loadVoiceReplies, oggToWav, oggToWavArgs, parseVoiceCommand, pcmToOgg, pcmToOggArgs,
  saveVoiceReplies, speakingGap, voiceNoteDoctorLine, voiceNoteSettings, wantsVoiceReply,
} from "./voice-notes.js";

/**
 * Voice notes. ffmpeg is the bridge between Telegram's OGG/Opus and the WAV
 * whisper reads, and between Piper's raw PCM and a voice note the phone will
 * show as one. The argv is fixed here; the live round trip runs wherever
 * ffmpeg is installed, and is skipped (saying so) where it is not.
 */

const hasFfmpeg = (() => {
  try { execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

test("the reply setting defaults to \"when I speak\", and an unknown value does not switch voice on for everything", () => {
  assert.equal(voiceNoteSettings({}).replies, "spoken");
  assert.equal(voiceNoteSettings({ voiceReplies: "loud" as any }).replies, "spoken");
  assert.equal(voiceNoteSettings({ voiceReplies: "off" }).replies, "off");
  assert.equal(voiceNoteSettings({ voiceReplies: "off" }, "always").replies, "always", "/voice's stored choice wins");
  assert.equal(wantsVoiceReply("spoken", true), true);
  assert.equal(wantsVoiceReply("spoken", false), false, "a typed message gets text back");
  assert.equal(wantsVoiceReply("always", false), true);
  assert.equal(wantsVoiceReply("off", true), false);
});

test("the caps are bounded, and a voice note may never be longer than the ears will take", () => {
  const s = voiceNoteSettings({ voiceMaxSeconds: 100_000, voiceMaxBytes: 1, voiceMaxChars: 1e9 });
  assert.ok(s.maxSeconds <= 600);
  assert.ok(s.maxBytes >= 64_000);
  assert.ok(s.maxChars <= 4000);
});

test("/voice reads the three settings in plain words", () => {
  assert.equal(parseVoiceCommand("/voice"), "show");
  assert.equal(parseVoiceCommand("/voice off"), "off");
  assert.equal(parseVoiceCommand("/voice when I speak"), "spoken");
  assert.equal(parseVoiceCommand("/voice@ClawBot always"), "always");
  assert.equal(parseVoiceCommand("/voice shout"), "bad");
  assert.equal(parseVoiceCommand("voice off please"), null, "not a command — a turn");
  assert.equal(parseVoiceCommand("/voicemail"), null);
});

test("the /voice choice survives a restart, and a corrupt file falls back to config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-voiceprefs-"));
  assert.equal(loadVoiceReplies(dir), null);
  saveVoiceReplies(dir, "always");
  assert.equal(loadVoiceReplies(dir), "always");
  fs.writeFileSync(path.join(dir, "telegram-prefs.json"), "{ not json");
  assert.equal(loadVoiceReplies(dir), null);
});

test("ffmpeg is told the input format and is never handed a path, a URL or a filter", () => {
  for (const args of [oggToWavArgs(120), pcmToOggArgs(22050)]) {
    assert.ok(args.includes("pipe:0") && args.includes("pipe:1"), "stdin to stdout, no file on disk");
    assert.ok(args.indexOf("-f") < args.indexOf("-i"), "the input format is named before the input, not probed");
    assert.ok(!args.some((a) => /^(https?:|file:|\/)|-filter|-vf|-af|concat/.test(a)));
  }
  assert.deepEqual(oggToWavArgs(120).slice(oggToWavArgs(120).indexOf("-f"), oggToWavArgs(120).indexOf("-f") + 2), ["-f", "ogg"]);
  const out = oggToWavArgs(90);
  assert.equal(out[out.indexOf("-ar") + 1], "16000");
  assert.equal(out[out.indexOf("-ac") + 1], "1");
  assert.equal(out[out.indexOf("-t") + 1], "90", "a note that lies about its length is cut");
  assert.equal(pcmToOggArgs(22050)[pcmToOggArgs(22050).indexOf("-c:a") + 1], "libopus", "Telegram draws a voice note only for Opus");
});

test("what is missing is named exactly: ffmpeg, whisper.cpp, Piper", () => {
  const whisper = { engine: "whisper" as const, detail: "whisper.cpp · base.en" };
  const none = { engine: "browser" as const, detail: "whisper.cpp (whisper-cli) not found — …" };
  assert.equal(hearingGap(true, whisper), null);
  assert.match(String(hearingGap(false, whisper)), /ffmpeg is not installed/);
  assert.match(String(hearingGap(true, none)), /whisper\.cpp\) is not set up — .*setup-ears\.sh|whisper/);
  assert.doesNotMatch(String(hearingGap(true, none)), /browser/, "a phone has no browser recogniser to fall back on");
  assert.match(String(speakingGap(true, "Piper is not installed — run ./setup-voice.sh")), /setup-voice\.sh/);
  assert.match(String(speakingGap(false, null)), /ffmpeg/);
  const doctor = voiceNoteDoctorLine({ hear: hearingGap(false, whisper), speak: speakingGap(false, null) });
  assert.equal(doctor.ok, false);
  assert.match(doctor.line, /ffmpeg/, "the doctor names ffmpeg");
  assert.equal(voiceNoteDoctorLine({ hear: null, speak: null }).ok, true);
});

test("execBytes pipes stdin to stdout, and a runaway child is capped and killed", async () => {
  const echo = await execBytes(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], Buffer.from("hello"), { timeoutMs: 10_000, maxBytes: 100 });
  assert.equal(echo.toString(), "hello");
  await assert.rejects(
    execBytes(process.execPath, ["-e", "setInterval(()=>process.stdout.write('x'.repeat(1000)),1)"], Buffer.alloc(0), { timeoutMs: 10_000, maxBytes: 5000 }),
    /produced more than/,
  );
  await assert.rejects(
    execBytes(process.execPath, ["-e", "setTimeout(()=>{},60000)"], Buffer.alloc(0), { timeoutMs: 200, maxBytes: 100 }),
    /took longer than/,
  );
  await assert.rejects(
    execBytes(process.execPath, ["-e", "console.error('boom: bad input'); process.exit(3)"], Buffer.alloc(0), { timeoutMs: 10_000, maxBytes: 100 }),
    /exited 3: boom: bad input/,
  );
});

test("a minimal ffmpeg without libopus is named as such, not as a mystery exit code", async () => {
  const run = async () => { throw new Error("ffmpeg exited 1: Unknown encoder 'libopus'"); };
  await assert.rejects(pcmToOgg(run, Buffer.alloc(10), 22050), /no Opus encoder \(libopus\)/);
});

test("live: Piper-shaped PCM → OGG/Opus voice note → 16 kHz mono WAV whisper can read", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  // A second of a 440 Hz tone at Piper's 22.05 kHz, as speak() would hand it over.
  const rate = 22050;
  const pcm = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const ogg = await pcmToOgg(execBytes, pcm, rate);
  assert.equal(ogg.toString("ascii", 0, 4), "OggS", "an Ogg container");
  assert.ok(ogg.includes(Buffer.from("OpusHead")), "carrying Opus, so Telegram shows a voice note");
  const wav = await oggToWav(execBytes, ogg, 120);
  const info = parseWav(wav);
  assert.ok(info.ok, info.ok ? "" : info.error);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.ok(Math.abs(info.seconds - 1) < 0.1, `about a second, got ${info.seconds}`);
  // Something that only claims to be a voice note goes no further than the OGG demuxer.
  await assert.rejects(oggToWav(execBytes, Buffer.from("#!/bin/sh\necho hi\n"), 120), /ffmpeg exited/);
});
