import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config, ROOT } from "./config.js";

const execFileAsync = promisify(execFile);

let enabled = config.voice.enabled;
/** Every process in the current speech pipeline (synth + playback). */
let active: ChildProcess[] = [];
let availability: { engine: "piper" | "spd-say" | "none"; detail: string } | null = null;

const PIPER_BIN = path.join(ROOT, ".venv", "bin", "piper");

function resolveModel(): string | null {
  const m = config.voice.piper.model;
  const p = path.isAbsolute(m) ? m : path.join(ROOT, m);
  return fs.existsSync(p) ? p : null;
}

async function has(bin: string): Promise<boolean> {
  try {
    await execFileAsync("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide which engine to use, once. Piper (neural) is strongly preferred;
 * spd-say (espeak formant synthesis) is the intelligible-but-robotic fallback.
 */
export async function detect(): Promise<{ engine: "piper" | "spd-say" | "none"; detail: string }> {
  if (availability) return availability;

  const model = resolveModel();
  const preferred = config.voice.engine;

  if (preferred !== "spd-say" && fs.existsSync(PIPER_BIN) && model) {
    if (await has(config.voice.piper.player)) {
      availability = { engine: "piper", detail: path.basename(model, ".onnx") };
      return availability;
    }
  }
  if (await has("spd-say")) {
    availability = { engine: "spd-say", detail: config.voice.spd.voiceName || "default" };
    return availability;
  }
  availability = { engine: "none", detail: "no TTS engine found" };
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

function speakWithPiper(text: string, model: string): void {
  const { piper, player } = { piper: config.voice.piper, player: config.voice.piper.player };
  const rate = String(config.voice.piper.sampleRate);

  // piper --output-raw  →  paplay (raw s16le mono). Streaming, so audio starts
  // before the whole utterance has been synthesised.
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

  // Killing either half mid-stream leaves the other writing into a dead pipe.
  // Node turns that into an unhandled 'error' event, which takes the whole
  // process down — so every stream in the chain gets a swallowing handler.
  synth.stdout.on("error", () => {});
  synth.stdin.on("error", () => {});
  play.stdin.on("error", () => {});
  synth.on("error", () => {});
  play.on("error", () => {});

  synth.stdout.pipe(play.stdin);
  synth.stdin.end(text);

  active = [synth, play];
  const clear = () => { active = active.filter((p) => p !== synth && p !== play); };
  play.on("exit", clear);
  synth.on("exit", () => {
    // Detach before closing so buffered audio can't write after end.
    try { synth.stdout.unpipe(play.stdin); } catch { /* noop */ }
    try { play.stdin.end(); } catch { /* noop */ }
  });
}

function speakWithSpd(text: string): void {
  const s = config.voice.spd;
  const args = ["-l", s.language, "-r", String(s.rate), "-p", String(s.pitch), "-i", String(s.volume)];
  if (s.voiceName) args.push("-y", s.voiceName);
  args.push("--", text);
  const child = spawn("spd-say", args, { stdio: "ignore" });
  child.on("error", () => {});
  active = [child];
  const clear = () => { active = active.filter((p) => p !== child); };
  child.on("exit", clear);
}

/**
 * Speak text through the local sound card. Non-blocking; interrupts whatever
 * was already speaking. The server runs on the user's own machine, so
 * server-side playback is user-side playback.
 */
export async function speak(text: string): Promise<void> {
  if (!enabled || !text) return;
  const { engine } = await detect();
  if (engine === "none") return;

  const clean = cleanForSpeech(text).slice(0, config.voice.maxChars);
  if (!clean) return;

  cancel();
  try {
    const model = resolveModel();
    if (engine === "piper" && model) speakWithPiper(clean, model);
    else speakWithSpd(clean);
  } catch { /* engine vanished mid-run */ }
}

/** Speak a sample with an explicit Piper model or spd voice — used by the auditioner. */
export async function sample(opts: { model?: string; voiceName?: string; text: string }): Promise<void> {
  const { engine } = await detect();
  if (engine === "none") return;
  cancel();
  const clean = cleanForSpeech(opts.text);
  if (opts.model) {
    const p = path.isAbsolute(opts.model) ? opts.model : path.join(ROOT, opts.model);
    if (fs.existsSync(p)) return void speakWithPiper(clean, p);
  }
  if (opts.voiceName && engine === "spd-say") {
    const saved = config.voice.spd.voiceName;
    config.voice.spd.voiceName = opts.voiceName;
    speakWithSpd(clean);
    config.voice.spd.voiceName = saved;
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
