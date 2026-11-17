import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  detectEars,
  EarsError,
  earsSettings,
  earsStatus,
  encodeWav,
  listen,
  parseWav,
  parseWhisperOutput,
  peakFrameRms,
  pickModel,
  readCapped,
  resetEarsForTests,
  setSpawnForTests,
  toWhisperPcm,
  whisperArgs,
  whisperCandidates,
  WHISPER_RATE,
  type EarsSettings,
  type EarsState,
} from "./ears.js";
import { setHasBinForTests, setHostForTests } from "./platform.js";

afterEach(() => {
  setSpawnForTests(null);
  setHasBinForTests(null);
  setHostForTests(null);
  resetEarsForTests();
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cunningclaw-ears-"));

const FOUND: EarsState = { engine: "whisper", detail: "whisper.cpp · base.en", bin: "/opt/fake/whisper-cli", model: "/opt/fake/ggml-base.en.bin" };

function settings(over: Partial<EarsSettings> = {}): EarsSettings {
  return { ...earsSettings({ engine: "auto" }), ...over };
}

/** A clip with something said in it: a 220 Hz tone at a speaking level. */
function speech(seconds: number, rate = WHISPER_RATE, amp = 6000): Int16Array {
  const out = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / rate));
  return out;
}

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (sig?: string) => boolean; killed?: string };

/** Stand in for whisper-cli: record the call, then answer as told. */
function fakeWhisper(answer: (args: string[], child: FakeChild) => void) {
  const calls: { bin: string; args: string[]; opts: any; fileExisted: boolean }[] = [];
  const fn = ((bin: string, args: string[], opts: any) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (sig?: string) => { child.killed = sig ?? "SIGTERM"; return true; };
    const file = args[args.indexOf("-f") + 1];
    calls.push({ bin, args, opts, fileExisted: fs.existsSync(file) });
    setImmediate(() => answer(args, child));
    return child;
  }) as unknown as typeof spawn;
  return { fn, calls };
}

test("whisper is run with fixed arguments and no shell — nothing from the request reaches argv", () => {
  const args = whisperArgs({ model: "/m/ggml-base.en.bin", file: "/d/ears/x.wav", language: "en", threads: 4 });
  assert.deepEqual(args, ["-m", "/m/ggml-base.en.bin", "-f", "/d/ears/x.wav", "-l", "en", "-t", "4", "-nt", "-np"]);
  // The one free-text setting is the language; anything but a short code is "en".
  assert.equal(earsSettings({ whisper: { language: "en; rm -rf ~" } }).language, "en");
  assert.equal(earsSettings({ whisper: { language: "--prompt=x" } }).language, "en");
  assert.equal(earsSettings({ whisper: { language: "cy" } }).language, "cy");
  assert.equal(earsSettings({ whisper: { threads: 999 } }).threads, 16);
  assert.equal(earsSettings({ engine: "nonsense" as any }).engine, "auto");
});

test("whisper's output becomes the sentence: no timestamps, no [BLANK_AUDIO], no log lines", () => {
  const raw = [
    "whisper_init_from_file_with_params_no_state: loading model from 'models/ggml-base.en.bin'",
    "[00:00:00.000 --> 00:00:02.500]   Please check the build server",
    "[00:00:02.500 --> 00:00:04.000]   [BLANK_AUDIO]",
    "[00:00:04.000 --> 00:00:06.100]   and tell me how much disk is left (keyboard clicking) .",
    " ♪ ♪ ",
    "[MUSIC]",
    "system_info: n_threads = 4",
  ].join("\n");
  assert.equal(parseWhisperOutput(raw), "Please check the build server and tell me how much disk is left.");
  assert.equal(parseWhisperOutput(" [BLANK_AUDIO]\n"), "");
  assert.equal(parseWhisperOutput(" Hello there, sir.\n"), "Hello there, sir.");
  assert.equal(parseWhisperOutput("*coughs* Right, stop."), "Right, stop.");
});

test("the model is chosen from models/ by name — base.en first, VAD models never", () => {
  assert.equal(pickModel(["ggml-tiny.en.bin", "ggml-base.en.bin", "ggml-small.en.bin"]), "ggml-base.en.bin");
  assert.equal(pickModel(["ggml-tiny.en.bin", "README.md"]), "ggml-tiny.en.bin");
  assert.equal(pickModel(["ggml-base.en-q5_1.bin"]), "ggml-base.en-q5_1.bin");
  assert.equal(pickModel(["ggml-silero-v5.1.2.bin"]), null);
  assert.equal(pickModel(["model.onnx", "notes.txt"]), null);
});

test("a configured binary is the only candidate, and a bare 'main' is never trusted from PATH", () => {
  assert.deepEqual(whisperCandidates("/usr/local/bin/whisper-cli", "/root"), ["/usr/local/bin/whisper-cli"]);
  assert.deepEqual(whisperCandidates("tools/whisper-cli", "/root"), [path.resolve("/root", "tools/whisper-cli")]);
  const found = whisperCandidates("", "/root", "linux");
  assert.ok(found.includes("whisper-cli"));
  assert.ok(found.includes(path.join("/root", ".whisper", "bin", "whisper-cli")));
  assert.ok(!found.includes("main"), "a bare `main` on PATH could be anything");
  assert.ok(whisperCandidates("", "/root", "win32").includes("whisper-cli.exe"));
});

test("detection: a local build + model is LOCAL EARS; without it, auto falls back to the browser and says how to fix it", async () => {
  setHasBinForTests(() => false);
  setHostForTests("linux");
  const root = tmp();
  try {
    const none = await detectEars(earsSettings({ engine: "auto" }), root, true);
    assert.equal(none.engine, "browser");
    assert.match(none.detail, /whisper\.cpp \(whisper-cli\) not found/);
    assert.match(none.detail, /setup-ears\.sh/);
    assert.equal(earsStatus(none).label, "BROWSER EARS");

    // Asked for whisper by name and it is missing: the mic stays off rather
    // than quietly sending the voice to the cloud.
    const strict = await detectEars(earsSettings({ engine: "whisper" }), root, true);
    assert.equal(strict.engine, "off");

    fs.mkdirSync(path.join(root, ".whisper", "bin"), { recursive: true });
    const bin = path.join(root, ".whisper", "bin", "whisper-cli");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    const noModel = await detectEars(earsSettings({ engine: "auto" }), root, true);
    assert.equal(noModel.engine, "browser");
    assert.match(noModel.detail, /no ggml-\*\.bin model in models\//);

    fs.mkdirSync(path.join(root, "models"));
    fs.writeFileSync(path.join(root, "models", "ggml-base.en.bin"), "x");
    const found = await detectEars(earsSettings({ engine: "auto" }), root, true);
    assert.equal(found.engine, "whisper");
    assert.equal(found.bin, bin);
    assert.equal(earsStatus(found).label, "LOCAL EARS");
    assert.equal(earsStatus(found).detail, "whisper.cpp · base.en");

    const off = await detectEars(earsSettings({ engine: "off" }), root, true);
    assert.equal(off.engine, "off");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only 16-bit PCM WAV is accepted, and any rate or channel count becomes 16 kHz mono", () => {
  assert.equal(parseWav(Buffer.from("OggS not a wav at all, honestly, not even close to one")).ok, false);
  const float = encodeWav(speech(0.1));
  float.writeUInt16LE(3, 20); // IEEE float
  assert.equal(parseWav(float).ok, false);
  const eightBit = encodeWav(speech(0.1));
  eightBit.writeUInt16LE(8, 34);
  assert.equal(parseWav(eightBit).ok, false);

  // 44.1 kHz stereo, the shape a phone or Audacity export usually has.
  const frames = 44100;
  const stereo = Buffer.alloc(44 + frames * 4);
  encodeWav(new Int16Array(0), 44100).copy(stereo, 0, 0, 44);
  stereo.writeUInt32LE(36 + frames * 4, 4);
  stereo.writeUInt16LE(2, 22);
  stereo.writeUInt32LE(44100 * 4, 28);
  stereo.writeUInt16LE(4, 32);
  stereo.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    stereo.writeInt16LE(8000, 44 + i * 4);
    stereo.writeInt16LE(4000, 46 + i * 4);
  }
  const info = parseWav(stereo);
  assert.ok(info.ok);
  assert.equal(info.channels, 2);
  assert.equal(Math.round(info.seconds * 100) / 100, 1);
  const pcm = toWhisperPcm(stereo, info);
  assert.equal(pcm.length, 16000);
  assert.equal(pcm[8000], 6000, "the two channels are averaged");
});

test("listen() writes a private temp file, hands whisper its path, returns the words, and deletes it", async () => {
  resetEarsForTests(FOUND);
  const dir = tmp();
  const fake = fakeWhisper((_args, child) => {
    child.stdout.write(" Turn the heating down a notch.\n");
    child.emit("close", 0);
  });
  setSpawnForTests(fake.fn);
  try {
    const heard = await listen(encodeWav(speech(1.5)), { dir, settings: settings() });
    assert.equal(heard.text, "Turn the heating down a notch.");
    assert.equal(heard.silent, false);
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.bin, FOUND.bin);
    assert.equal(call.opts.shell, false);
    const file = call.args[call.args.indexOf("-f") + 1];
    assert.equal(path.dirname(file), dir, "the clip lives in the ears dir, under a name we chose");
    assert.match(path.basename(file), /^[0-9a-f-]{36}\.wav$/);
    assert.equal(call.fileExisted, true);
    assert.equal(fs.existsSync(file), false, "the clip is deleted once heard");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed or hung transcription still deletes the clip, and says why", async () => {
  resetEarsForTests(FOUND);
  const dir = tmp();
  try {
    setSpawnForTests(fakeWhisper((_a, child) => {
      child.stderr.write(`error: failed to open model '${os.homedir()}/models/ggml-base.en.bin'\n`);
      child.emit("close", 1);
    }).fn);
    await assert.rejects(listen(encodeWav(speech(1)), { dir, settings: settings() }), (err: EarsError) => {
      assert.equal(err.status, 500);
      assert.match(err.message, /whisper\.cpp exited 1: error: failed to open model '~\/models/);
      return true;
    });
    assert.deepEqual(fs.readdirSync(dir), []);

    let child: FakeChild | null = null;
    setSpawnForTests(fakeWhisper((_a, c) => { child = c; }).fn);
    await assert.rejects(listen(encodeWav(speech(1)), { dir, settings: settings({ timeoutMs: 50 }) }), (err: EarsError) => {
      assert.equal(err.status, 504);
      return true;
    });
    assert.equal(child!.killed, "SIGKILL");
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("silence is never sent to whisper, which would invent words for it", async () => {
  resetEarsForTests(FOUND);
  const fake = fakeWhisper((_a, child) => { child.stdout.write(" Thank you.\n"); child.emit("close", 0); });
  setSpawnForTests(fake.fn);
  const quiet = speech(2, WHISPER_RATE, 40); // about -58 dBFS: a room, not a voice
  assert.ok(peakFrameRms(quiet) < 0.003);
  const heard = await listen(encodeWav(quiet), { dir: tmp(), settings: settings() });
  assert.deepEqual([heard.text, heard.silent], ["", true]);
  assert.equal(fake.calls.length, 0);
});

test("without local ears, listen() refuses rather than sending audio anywhere else", async () => {
  resetEarsForTests({ engine: "browser", detail: "whisper.cpp (whisper-cli) not found" });
  const fake = fakeWhisper(() => {});
  setSpawnForTests(fake.fn);
  await assert.rejects(listen(encodeWav(speech(1)), { settings: settings() }), (err: EarsError) => err.status === 409);
  await assert.rejects(listen(Buffer.from("not audio"), { settings: settings() }), (err: EarsError) => err.status === 409);
  assert.equal(fake.calls.length, 0);
});

test("oversize and overlong audio is refused before anything is written", async () => {
  resetEarsForTests(FOUND);
  const fake = fakeWhisper(() => {});
  setSpawnForTests(fake.fn);
  const dir = tmp();
  await assert.rejects(listen(encodeWav(speech(3)), { dir, settings: settings({ maxSeconds: 2 }) }), (err: EarsError) => err.status === 413);
  await assert.rejects(listen(Buffer.from("RIFF....WAVEjunkjunkjunkjunkjunkjunkjunkjunkjunk"), { dir, settings: settings() }), (err: EarsError) => err.status === 400);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("the request body is read with a hard cap", async () => {
  const feed = (chunks: Buffer[]) => {
    const s = new PassThrough();
    setImmediate(() => { for (const c of chunks) s.write(c); s.end(); });
    return s;
  };
  assert.equal((await readCapped(feed([Buffer.alloc(10), Buffer.alloc(10)]), 100))?.length, 20);
  assert.equal(await readCapped(feed([Buffer.alloc(60), Buffer.alloc(60)]), 100), null);
  assert.equal(await readCapped(feed([]), 100, 5_000_000), null, "a declared Content-Length over the cap is refused unread");
});

// --- The HUD half: public/app.js ---------------------------------------------

function hudEars(): {
  encodeWav16: (f: Float32Array, rate: number) => ArrayBuffer;
  downsampleTo16k: (f: Float32Array, rate: number) => Float32Array;
  createVad: (o?: object) => { feed: (rms: number, ms: number) => string; started: boolean };
  earsLabel: (s: object, ua: string, vendor: string) => { text: string; cls: string };
} {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "public", "app.js"), "utf-8");
  const start = src.indexOf("// local-ears:begin");
  const end = src.indexOf("// local-ears:end");
  assert.ok(start >= 0 && end > start, "public/app.js must carry the local-ears block");
  return vm.runInNewContext(`${src.slice(start, end)}\n({ encodeWav16, downsampleTo16k, createVad, earsLabel })`);
}

test("the HUD's WAV is one the server accepts: 16 kHz mono 16-bit, from a 48 kHz mic", () => {
  const { encodeWav16, downsampleTo16k } = hudEars();
  const mic = new Float32Array(48000); // one second at 48 kHz
  for (let i = 0; i < mic.length; i++) mic[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / 48000);
  const down = downsampleTo16k(mic, 48000);
  assert.equal(down.length, 16000);
  const wav = Buffer.from(encodeWav16(down, 16000));
  const info = parseWav(wav);
  assert.ok(info.ok);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(Math.round(info.seconds * 1000), 1000);
  const peak = Math.max(...Array.from(toWhisperPcm(wav, info).slice(1000, 2000)));
  assert.ok(peak > 15000 && peak < 16500, `a 0.5 sine should peak near 16384, got ${peak}`);
});

test("the HUD's ears stop by themselves 1.2 s after the operator stops talking", () => {
  const { createVad } = hudEars();
  const frame = 2048 / 48; // ms per 2048-sample block at 48 kHz
  const run = (pattern: Array<[number, number]>) => {
    const vad = createVad();
    let t = 0;
    for (const [rms, ms] of pattern) {
      for (let end = t + ms; t < end; t += frame) {
        const v = vad.feed(rms, frame);
        if (v === "end" || v === "none") return { verdict: v, at: Math.round(t + frame) };
      }
    }
    return { verdict: "open", at: Math.round(t) };
  };
  // Quiet room, two seconds of speech with a breath in it, then quiet.
  const said = run([[0.002, 500], [0.08, 900], [0.003, 400], [0.07, 700], [0.002, 3000]]);
  assert.equal(said.verdict, "end");
  assert.ok(said.at >= 2500 + 1200 && said.at < 2500 + 1400, `ended at ${said.at} ms`);
  // A breath (400 ms) did not end it — only the long quiet did.
  // Nobody speaks: give up after 8 s and send nothing.
  assert.deepEqual(run([[0.002, 10_000]]).verdict, "none");
  // A click on the desk is not speech starting.
  assert.equal(run([[0.002, 500], [0.2, 40], [0.002, 9000]]).verdict, "none");
  // A fan louder than the floor is the room, not speech: alone it sends
  // nothing, and speech over it still ends when the speaking does.
  assert.equal(run([[0.02, 10_000]]).verdict, "none");
  const fan = run([[0.02, 1000], [0.2, 1500], [0.02, 3000]]);
  assert.equal(fan.verdict, "end");
  assert.ok(fan.at >= 2500 + 1200 && fan.at < 2500 + 1400, `ended at ${fan.at} ms`);
  // Talking the instant the mic opens still counts, once a gap between words
  // shows the floor where the room really is.
  const eager = run([[0.08, 300], [0.003, 120], [0.08, 1200], [0.002, 3000]]);
  assert.equal(eager.verdict, "end");
});

test("the HUD says honestly where the mic's audio goes", () => {
  const { earsLabel } = hudEars();
  const chrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
  assert.equal(earsLabel({ engine: "whisper", detail: "whisper.cpp · base.en" }, chrome, "Google Inc.").text, "LOCAL EARS · base.en");
  assert.equal(earsLabel({ engine: "browser" }, chrome, "Google Inc.").text, "BROWSER EARS — audio goes to Google");
  assert.equal(earsLabel({ engine: "browser" }, chrome + " Edg/131.0", "Google Inc.").text, "BROWSER EARS — audio goes to Microsoft");
  assert.equal(earsLabel({ engine: "browser" }, "Mozilla/5.0 (Macintosh) Version/18 Safari/605", "Apple Computer, Inc.").text, "BROWSER EARS — audio goes to Apple");
  assert.equal(earsLabel({ engine: "off" }, chrome, "").text, "EARS OFF");
});
