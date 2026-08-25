import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { hasBin, host, missing } from "./platform.js";

let enabled = config.voice.enabled;
/** Every process in the current speech pipeline (synth + playback). */
let active: ChildProcess[] = [];

export type VoiceEngine = "piper" | "spd-say" | "say" | "none";
let availability: { engine: VoiceEngine; detail: string; player?: string } | null = null;

const PIPER_BIN = path.join(ROOT, ".venv", "bin", "piper");

function resolveModel(): string | null {
  const m = config.voice.piper.model;
  const p = path.isAbsolute(m) ? m : path.join(ROOT, m);
  return fs.existsSync(p) ? p : null;
}

function sayVoice(): string {
  return config.voice.say?.voice?.trim() || "Daniel";
}

/**
 * paplay is the Linux default in config. On macOS the same config should
 * still speak: swap in afplay rather than failing closed.
 */
async function resolvePiperPlayer(): Promise<string | null> {
  const configured = config.voice.piper.player;
  if (await hasBin(configured)) return configured;
  if (host() === "darwin" && (await hasBin("afplay"))) return "afplay";
  return null;
}

function noneDetail(): string {
  if (host() === "darwin") {
    return `no TTS engine found. ${missing("piper")} (player: afplay), or use the built-in say command.`;
  }
  return `no TTS engine found. ${missing("piper")} and ${missing("paplay")}, or ${missing("spd-say")}`;
}

/**
 * Wrap raw s16le mono PCM in a WAV header so afplay (which cannot play
 * Piper's --output-raw stream) has a real file to open.
 */
export function wrapPcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function resetVoiceDetectForTests(): void {
  availability = null;
}

/**
 * Decide which engine to use, once. Piper (neural) is strongly preferred;
 * spd-say (espeak) is the Linux fallback; `say` is the macOS fallback.
 * Never report an engine that cannot actually produce audio.
 */
export async function detect(): Promise<{ engine: VoiceEngine; detail: string; player?: string }> {
  if (availability) return availability;

  const model = resolveModel();
  const preferred = config.voice.engine;

  if (preferred === "say") {
    if (await hasBin("say")) {
      availability = { engine: "say", detail: sayVoice() };
      return availability;
    }
    availability = { engine: "none", detail: missing("say") };
    return availability;
  }

  if (preferred !== "spd-say" && fs.existsSync(PIPER_BIN) && model) {
    const player = await resolvePiperPlayer();
    if (player) {
      availability = { engine: "piper", detail: path.basename(model, ".onnx"), player };
      return availability;
    }
    if (preferred === "piper") {
      const playerHint = host() === "darwin" ? missing("afplay") : missing("paplay");
      availability = { engine: "none", detail: `Piper is installed but has no audio player. ${playerHint}` };
      return availability;
    }
  } else if (preferred === "piper") {
    availability = { engine: "none", detail: missing("piper") };
    return availability;
  }

  if (host() === "darwin" && (await hasBin("say"))) {
    availability = { engine: "say", detail: sayVoice() };
    return availability;
  }

  if (await hasBin("spd-say")) {
    availability = { engine: "spd-say", detail: config.voice.spd.voiceName || "default" };
    return availability;
  }

  if (await hasBin("say")) {
    availability = { engine: "say", detail: sayVoice() };
    return availability;
  }

  availability = { engine: "none", detail: noneDetail() };
  return availability;
}

export async function isAvailable(): Promise<boolean> {
  return (await detect()).engine !== "none";
}

export function isEnabled(): boolean {
  return enabled;
}

export function setEnabled(value: boolean): void {
  enabled = value;
  if (!enabled) cancel();
}

/** Stop anything currently being spoken. */
export function cancel(): void {
  for (const proc of active) {
    try { proc.stdout?.unpipe(); } catch { /* noop */ }
    try { proc.stdin?.destroy(); } catch { /* noop */ }
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
  active = [];
  if (availability?.engine === "spd-say") {
    try { spawn("spd-say", ["-C"], { stdio: "ignore" }).unref(); } catch { /* noop */ }
  }
}

/** Strip markup and artefacts that sound wrong when read aloud. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " — code omitted — ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[*_~`>|#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function track(procs: ChildProcess[]): void {
  active = procs;
  const clear = () => { active = active.filter((p) => !procs.includes(p)); };
  for (const p of procs) p.on("exit", clear);
}

function swallow(proc: ChildProcess): void {
  proc.on("error", () => {});
  proc.stdout?.on("error", () => {});
  proc.stdin?.on("error", () => {});
}

function speakWithPiperStream(text: string, model: string, player: string): void {
  const piper = config.voice.piper;
  const rate = String(piper.sampleRate);

  // piper --output-raw  →  paplay / aplay (raw s16le mono). Streaming, so
  // audio starts before the whole utterance has been synthesised.
  const synth = spawn(
    PIPER_BIN,
    [
      "-m", model,
      "--output-raw",
      "--length-scale", String(piper.lengthScale),
      "--noise-scale", String(piper.noiseScale),
      "--noise-w-scale", String(piper.noiseWScale),
      "--sentence-silence", String(piper.sentenceSilence),
      "--volume", String(piper.volume),
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );

  const playArgs = player === "paplay"
    ? ["--raw", `--rate=${rate}`, "--format=s16le", "--channels=1"]
    : ["-r", rate, "-f", "S16_LE", "-c", "1", "-q", "-t", "raw"];
  const play = spawn(player, playArgs, { stdio: ["pipe", "ignore", "ignore"] });

  swallow(synth);
  swallow(play);
  play.on("error", (err) => {
    console.error(`Voice playback failed (${player}): ${err.message}`);
  });

  synth.stdout.pipe(play.stdin);
  synth.stdin.end(text);

  track([synth, play]);
  synth.on("exit", () => {
    try { synth.stdout.unpipe(play.stdin); } catch { /* noop */ }
    try { play.stdin.end(); } catch { /* noop */ }
  });
}

/**
 * afplay cannot play raw s16le on stdin. Buffer Piper's PCM, wrap a WAV,
 * then play the file. If Piper produces nothing, log it — do not claim success.
 */
function speakWithPiperFile(text: string, model: string, player: string): void {
  const piper = config.voice.piper;
  const synth = spawn(
    PIPER_BIN,
    [
      "-m", model,
      "--output-raw",
      "--length-scale", String(piper.lengthScale),
      "--noise-scale", String(piper.noiseScale),
      "--noise-w-scale", String(piper.noiseWScale),
      "--sentence-silence", String(piper.sentenceSilence),
      "--volume", String(piper.volume),
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  swallow(synth);
  const chunks: Buffer[] = [];
  synth.stdout.on("data", (c: Buffer) => chunks.push(c));
  synth.stdin.end(text);
  track([synth]);

  synth.on("exit", (code) => {
    const pcm = Buffer.concat(chunks);
    if (code !== 0 || pcm.length === 0) {
      console.error("Voice: Piper produced no audio. Check the model file and ./setup-voice.sh.");
      return;
    }
    const wav = path.join(os.tmpdir(), `jarvis-tts-${process.pid}-${Date.now()}.wav`);
    try {
      fs.writeFileSync(wav, wrapPcmToWav(pcm, piper.sampleRate));
    } catch (err) {
      console.error(`Voice: could not write WAV: ${(err as Error).message}`);
      return;
    }
    const play = spawn(player, [wav], { stdio: "ignore" });
    swallow(play);
    play.on("error", (err) => {
      console.error(`Voice playback failed (${player}): ${err.message}`);
      try { fs.unlinkSync(wav); } catch { /* noop */ }
    });
    play.on("exit", () => {
      try { fs.unlinkSync(wav); } catch { /* noop */ }
    });
    track([play]);
  });
}

function speakWithPiper(text: string, model: string, player: string): void {
  if (player === "afplay") speakWithPiperFile(text, model, player);
  else speakWithPiperStream(text, model, player);
}

function speakWithSpd(text: string): void {
  const s = config.voice.spd;
  const args = ["-l", s.language, "-r", String(s.rate), "-p", String(s.pitch), "-i", String(s.volume)];
  if (s.voiceName) args.push("-y", s.voiceName);
  args.push("--", text);
  const child = spawn("spd-say", args, { stdio: "ignore" });
  swallow(child);
  child.on("error", (err) => {
    console.error(`Voice: spd-say failed: ${err.message}`);
  });
  track([child]);
}

function speakWithSay(text: string, voice = sayVoice()): void {
  const child = spawn("say", ["-v", voice, "--", text], { stdio: "ignore" });
  swallow(child);
  child.on("error", (err) => {
    console.error(`Voice: say failed: ${err.message}`);
  });
  track([child]);
}

/**
 * Speak text through the local sound card. Non-blocking; interrupts whatever
 * was already speaking. Logs (does not silently succeed) when no engine can
 * produce audio — that exact bug cost an hour when Chrome TTS reported voices
 * it did not have.
 */
export async function speak(text: string): Promise<void> {
  if (!enabled || !text) return;
  const { engine, detail, player } = await detect();
  if (engine === "none") {
    console.error(`Voice produced no audio: ${detail}`);
    return;
  }

  const clean = cleanForSpeech(text).slice(0, config.voice.maxChars);
  if (!clean) return;

  cancel();
  try {
    const model = resolveModel();
    if (engine === "piper" && model && player) speakWithPiper(clean, model, player);
    else if (engine === "say") speakWithSay(clean);
    else if (engine === "spd-say") speakWithSpd(clean);
    else console.error(`Voice produced no audio: ${detail}`);
  } catch (err) {
    console.error(`Voice: engine vanished mid-run: ${(err as Error).message}`);
  }
}

/** Speak a sample with an explicit Piper model or spd/`say` voice — used by the auditioner. */
export async function sample(opts: { model?: string; voiceName?: string; text: string }): Promise<void> {
  const { engine, player } = await detect();
  if (engine === "none") {
    console.error(`Voice produced no audio: ${(await detect()).detail}`);
    return;
  }
  cancel();
  const clean = cleanForSpeech(opts.text);
  if (opts.model) {
    const p = path.isAbsolute(opts.model) ? opts.model : path.join(ROOT, opts.model);
    if (fs.existsSync(p)) return void speakWithPiper(clean, p, player ?? config.voice.piper.player);
  }
  if (opts.voiceName && engine === "spd-say") {
    const saved = config.voice.spd.voiceName;
    config.voice.spd.voiceName = opts.voiceName;
    speakWithSpd(clean);
    config.voice.spd.voiceName = saved;
    return;
  }
  if (opts.voiceName && engine === "say") {
    speakWithSay(clean, opts.voiceName);
    return;
  }
  await speak(clean);
}

/** Piper voice models present on disk. */
export function listPiperVoices(): string[] {
  const dir = path.join(ROOT, "voices");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".onnx")).map((f) => `voices/${f}`);
}
