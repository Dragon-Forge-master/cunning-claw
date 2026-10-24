import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  cancel,
  cleanForSpeech,
  onSpeaking,
  react,
  resetVoiceDetectForTests,
  sample,
  setEnabled,
  setSpawnForTests,
  speak,
  wrapPcmToWav,
  type SpeakingState,
} from "./voice.js";

test("WAV wrapper is a real RIFF header over the PCM payload", () => {
  const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const wav = wrapPcmToWav(pcm, 22050);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 22050);
  assert.equal(wav.subarray(44).equals(pcm), true);
  assert.equal(wav.readUInt32LE(40), pcm.length);
});

test("cleanForSpeech strips markdown so it is not read aloud", () => {
  const out = cleanForSpeech("See [docs](https://example.com) and `code`.");
  assert.match(out, /docs/);
  assert.match(out, /code/);
  assert.doesNotMatch(out, /https/);
  assert.doesNotMatch(out, /`/);
});

test("the prompt can read what detect() found without waiting, and never mistakes 'not looked' for 'no voice'", async () => {
  // The claw once offered to build offline speech it already had, because
  // nothing told it what engine was installed. The stable prompt now reads
  // this synchronously each turn; before detect() has run it must say so
  // rather than report an absent voice.
  const { detected, detect } = await import("./voice.js");
  resetVoiceDetectForTests();
  assert.equal(detected(), null, "not looked yet is null, not 'none'");
  const found = await detect();
  const seen = detected();
  assert.ok(seen, "cached after detect()");
  assert.equal(seen?.engine, found.engine);
  assert.equal(seen?.detail, found.detail);
});

// --- Speaking state, with no sound card ---------------------------------------
// On 24 Oct the HUD's mic heard the claw's spoken reply and posted it back as
// the operator's message: nothing told the HUD the server was talking. These
// stand a fake process in for every engine and watch what the HUD would be told.

type FakeProc = EventEmitter & {
  cmd: string;
  args: string[];
  stdin: PassThrough;
  stdout: PassThrough;
  killed: boolean;
  kill: () => boolean;
  unref: () => void;
};

let spawned: FakeProc[] = [];
let heard: SpeakingState[] = [];

function fakeSpawn(cmd: string, args: readonly string[] = []): FakeProc {
  const p = new EventEmitter() as FakeProc;
  p.cmd = cmd;
  p.args = [...args];
  p.stdin = new PassThrough();
  p.stdout = new PassThrough();
  p.killed = false;
  // Like a real child: the exit arrives after kill() returns, not inside it.
  p.kill = () => {
    if (!p.killed) { p.killed = true; setImmediate(() => p.emit("exit", null, "SIGKILL")); }
    return true;
  };
  p.unref = () => {};
  spawned.push(p);
  return p;
}

/** The utterances, not the `spd-say -C` flushes that cancel() fires. */
const speakers = () => spawned.filter((p) => !p.args.includes("-C"));
const tick = () => new Promise((r) => setImmediate(r));

function useEngine(found: Parameters<typeof resetVoiceDetectForTests>[0]): void {
  cancel();
  spawned = [];
  heard = [];
  setEnabled(true);
  resetVoiceDetectForTests(found);
  setSpawnForTests(fakeSpawn as unknown as typeof spawn);
  onSpeaking((s) => heard.push(s));
}

test("server speech tells the HUD when it starts, with what it is saying, and when it ends", async () => {
  useEngine({ engine: "spd-say", detail: "default" });
  await speak("Good evening, sir. All systems are nominal.");
  assert.deepEqual(heard, [{ on: true, text: "Good evening, sir. All systems are nominal." }]);
  speakers()[0].emit("exit", 0, null);
  assert.deepEqual(heard.at(-1), { on: false });
});

test("cancelling speech tells the HUD it has stopped", async () => {
  useEngine({ engine: "say", detail: "Daniel" });
  await speak("A long reply that the operator talks over.");
  cancel();
  assert.equal(speakers()[0].killed, true);
  assert.deepEqual(heard.at(-1), { on: false });
});

test("an engine that fails to start reports silence, so the mic is not left shut", async () => {
  useEngine({ engine: "say", detail: "Daniel" });
  await speak("Nobody will hear this.");
  speakers()[0].emit("error", new Error("spawn say ENOENT"));
  assert.deepEqual(heard.at(-1), { on: false });
});

test("spd-say is told to wait until it has spoken, or speech would 'end' as it began", async () => {
  // Without -w the client hands the text to speech-dispatcher and exits at
  // once; the process list would read as silent while espeak talks on.
  useEngine({ engine: "spd-say", detail: "default" });
  await speak("Waiting for the words.");
  assert.ok(speakers()[0].args.includes("-w"), `spd-say args: ${speakers()[0].args.join(" ")}`);
});

test("speaking into silence does not flush speech-dispatcher, which would race and cut off the new words", async () => {
  useEngine({ engine: "spd-say", detail: "default" });
  await speak("A fresh reply with nothing before it.");
  assert.equal(spawned.filter((p) => p.args.includes("-C")).length, 0, "nothing was playing, so nothing to flush");
  cancel();
  assert.equal(spawned.filter((p) => p.args.includes("-C")).length, 1, "stopping real speech still flushes");
});

test("Piper finishing synthesis is not the end of speech: the player is still talking and still cancellable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cunningclaw-voice-"));
  const model = path.join(dir, "fake.onnx");
  fs.writeFileSync(model, "");
  try {
    useEngine({ engine: "piper", detail: "fake", player: "paplay" });
    await sample({ model, text: "A reply long enough that synthesis finishes before playback." });
    const [synth, play] = speakers();
    assert.equal(play.cmd, "paplay");
    synth.emit("exit", 0, null);
    assert.deepEqual(heard.at(-1)?.on, true, "paplay is still playing the buffered audio");
    cancel();
    assert.equal(play.killed, true, "the operator talking over it must be able to stop the player");
    assert.deepEqual(heard.at(-1), { on: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one utterance replacing another is announced, without a stop in between to reopen the mic", async () => {
  useEngine({ engine: "spd-say", detail: "default" });
  await speak("First thing.");
  await speak("Second thing.");
  assert.deepEqual(heard, [{ on: true, text: "First thing." }, { on: true, text: "Second thing." }]);
});

test("'stop' ends the voice: a stopped turn_done cancels what is being read", async () => {
  // Both stop paths sent turn_done with empty text, which matched no voice
  // rule, so a reply with maxChars 0 talked on for minutes after "stop".
  useEngine({ engine: "spd-say", detail: "default" });
  react("turn_start", { kind: "user" });
  react("turn_done", { text: "A very long reply indeed." });
  await tick();
  assert.equal(speakers().length, 1);
  react("turn_done", { text: "", stopped: true });
  assert.equal(speakers()[0].killed, true);
  assert.deepEqual(heard.at(-1), { on: false });
});

test("both stop paths in the server mark their turn_done as stopped", () => {
  // react() can only cancel on what the server sends; pin the sending side.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "server.ts"), "utf-8");
  const empties = [...src.matchAll(/broadcast\("turn_done",\s*\{\s*text:\s*""([^}]*)\}/g)];
  assert.ok(empties.length >= 2, "the /api/cancel and stop-words paths both end the turn");
  for (const m of empties) assert.match(m[1], /stopped:\s*true/, `unmarked stop: ${m[0]}`);
});

test("a heartbeat with news waits for the operator's reply to finish instead of cutting it off", async () => {
  useEngine({ engine: "spd-say", detail: "default" });
  react("turn_start", { kind: "user" });
  react("turn_done", { text: "Here is the answer you asked for." });
  await tick();
  react("turn_start", { kind: "heartbeat" });
  react("turn_done", { text: "Sir, the build has finished." });
  await tick();
  const reply = speakers()[0];
  assert.equal(reply.killed, false, "the reply must not be cut off");
  assert.equal(speakers().length, 1, "the heartbeat waits");
  reply.emit("exit", 0, null);
  await tick();
  assert.equal(speakers().length, 2, "then speaks");
  assert.ok(speakers()[1].args.includes("Sir, the build has finished."));
});

test("a heartbeat queued behind a reply is dropped when the operator stops the voice", async () => {
  useEngine({ engine: "spd-say", detail: "default" });
  react("turn_start", { kind: "user" });
  react("turn_done", { text: "Here is the answer you asked for." });
  await tick();
  react("turn_start", { kind: "heartbeat" });
  react("turn_done", { text: "Sir, the build has finished." });
  await tick();
  react("turn_done", { text: "", stopped: true });
  await tick();
  await tick();
  assert.equal(speakers().length, 1, "stop means quiet, not the next thing in the queue");
});

// --- The HUD's echo guard -------------------------------------------------------
// The second guard runs in the browser, which has no build step. Rather than a
// TypeScript twin that could drift from it, the test runs the exact block the
// HUD ships, cut out of public/app.js between its markers.

function hudEchoGuard(): (heard: string, spoken: string) => boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "public", "app.js"), "utf-8");
  const start = src.indexOf("// echo-guard:begin");
  const end = src.indexOf("// echo-guard:end");
  assert.ok(start >= 0 && end > start, "public/app.js must carry the echo-guard block");
  return vm.runInNewContext(`${src.slice(start, end)}\nisOwnEcho`);
}

const REPLY =
  "I've checked the build server, sir. The last three deploys all passed, but the " +
  "staging box is running low on disk — about four gigabytes left. I'd suggest clearing " +
  "the old Docker images before tonight's release, and I can do that now if you'd like.";

test("the HUD drops a transcript that is the claw's own reply heard back", () => {
  const isOwnEcho = hudEchoGuard();
  // As a recogniser hands it over: no capitals, no punctuation, a curly
  // apostrophe swapped for a straight one, the first words missed.
  const heard =
    "the last three deploys all passed but the staging box is running low on disk about " +
    "four gigabytes left id suggest clearing the old docker images before tonight’s release";
  assert.equal(isOwnEcho(heard, REPLY), true);
});

test("the HUD keeps what the operator actually said, even when it echoes a phrase", () => {
  const isOwnEcho = hudEchoGuard();
  assert.equal(isOwnEcho("go ahead and clear the old images but leave the database volumes alone", REPLY), false);
  // Quoting a few words back inside a new instruction is not an echo.
  assert.equal(
    isOwnEcho("you said the staging box is running low on disk so what is using it all and can we grow the volume", REPLY),
    false,
  );
  // Under five words cannot be judged, and short commands must never be eaten.
  assert.equal(isOwnEcho("stop", REPLY), false);
  assert.equal(isOwnEcho("yes do that now", REPLY), false);
  assert.equal(isOwnEcho("anything at all said here today", ""), false);
});
