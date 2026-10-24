import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { hasBin, host, missing, POWERSHELL, psArgs } from "./platform.js";
import * as win from "./windows.js";

let enabled = config.voice.enabled;
/** Every process in the current speech pipeline (synth + playback). */
let active: ChildProcess[] = [];

/**
 * Whether the claw is audibly speaking, told to whoever is listening.
 *
 * On 24 Oct the HUD's microphone heard the claw's own reply through the
 * speakers and sent it back as the operator's message — the server spoke and
 * nothing told the browser, so nothing paused the mic. The listener is
 * injected rather than this module importing the SSE bus, because voice.ts is
 * a leaf; it is also what lets the tests watch speech start and stop with no
 * sound card.
 */
export type SpeakingState = { on: boolean; text?: string };
let speakingListener: (state: SpeakingState) => void = () => {};
let speakingNow = false;
/** What is being said, so a mic that hears it anyway can recognise the echo. */
let spokenText = "";
/** A new utterance must be announced even if speech was already running. */
let announce = false;

export function onSpeaking(fn: ((state: SpeakingState) => void) | null): void {
  speakingListener = fn ?? (() => {});
}

export function isSpeaking(): boolean {
  return speakingNow;
}

/**
 * Report a change in "is anything audible", derived from the live process
 * list rather than from each engine remembering to say so — every way speech
 * ends (finished, cancelled, the binary missing) empties that list.
 */
function settle(): void {
  const now = active.length > 0;
  if (now && (!speakingNow || announce)) {
    speakingNow = true;
    announce = false;
    tell({ on: true, text: spokenText });
  } else if (!now) {
    announce = false;
    if (speakingNow) {
      speakingNow = false;
      tell({ on: false });
      // The heartbeat that waited its turn (see react()) speaks now.
      if (queued) {
        const next = queued;
        queued = null;
        void speak(next);
      }
    }
  }
}

function tell(state: SpeakingState): void {
  try { speakingListener(state); } catch { /* a listener's fault must not break speech */ }
}

/** Called by speak()/sample() just before spawning a new utterance. */
function begin(text: string): void {
  spokenText = text;
  announce = true;
}

/** Child processes are spawned through this so the tests can stand in for audio. */
let spawnProc: typeof spawn = spawn;
export function setSpawnForTests(fn: typeof spawn | null): void {
  spawnProc = fn ?? spawn;
}

export type VoiceEngine = "piper" | "spd-say" | "say" | "sapi" | "none";
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
  // Windows has no paplay or afplay, but PowerShell can play a WAV file.
  // The sentinel keeps the rest of the pipeline unchanged.
  if (host() === "win32") return WINDOWS_PLAYER;
  return null;
}

/** Not a binary — a marker meaning "play through PowerShell". */
export const WINDOWS_PLAYER = "__powershell__";

function noneDetail(): string {
  if (host() === "win32") {
    return `no TTS engine found. ${missing("piper")}, or Windows' own speech synthesis will be used.`;
  }
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

export function resetVoiceDetectForTests(
  found: { engine: VoiceEngine; detail: string; player?: string } | null = null,
): void {
  availability = found;
}

/**
 * Decide which engine to use, once. Piper (neural) is strongly preferred;
 * spd-say (espeak) is the Linux fallback; `say` is the macOS fallback.
 * Never report an engine that cannot actually produce audio.
 */
/**
 * What detect() found, without waiting on it. The prompt is assembled per turn
 * and cannot await; the server ran detect() at boot, so by the first turn this
 * is filled in. Null means "not looked yet", never "no voice".
 */
export function detected(): { engine: VoiceEngine; detail: string } | null {
  return availability ? { engine: availability.engine, detail: availability.detail } : null;
}

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

  if (host() === "win32") {
    // System.Speech is part of Windows, so there is always a voice available.
    availability = { engine: "sapi", detail: "Windows speech synthesis" };
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

/** Stop anything currently being spoken, and anything waiting to be. */
export function cancel(): void {
  queued = null;
  halt();
  settle();
}

/** The kind of the turn in flight; turns are serial (agent.ts is a singleton). */
let turnKind: "user" | "heartbeat" = "user";
/** One heartbeat reply held back until the current speech has finished. */
let queued: string | null = null;

/**
 * What the speakers do for each event the HUD is sent. broadcast() hands every
 * event here, so these rules live beside the voice and are tested without a
 * server; the server runs on the operator's machine, so speaking here comes
 * out of their speakers regardless of browser TTS support.
 */
export function react(event: string, data: unknown): void {
  const d = (data ?? {}) as Record<string, unknown>;
  if (event === "turn_start") {
    turnKind = d.kind === "heartbeat" ? "heartbeat" : "user";
    // A heartbeat starting must not cut the operator's speech off mid-sentence.
    if (turnKind !== "heartbeat") cancel();
  } else if (event === "turn_done") {
    // "Stop", said or pressed, ends the turn with stopped: true and must end
    // the voice too. It used to send turn_done with empty text, which matched
    // nothing here, so a long reply (maxChars 0 is unlimited) talked on for
    // minutes after the operator said stop.
    if (d.stopped) cancel();
    else if (typeof d.text === "string" && d.text) {
      // A heartbeat with news used to call speak(), which halts whatever is
      // playing — cutting the operator's own reply off mid-read. It waits.
      if (turnKind === "heartbeat" && speakingNow) queued = d.text;
      else void speak(d.text);
    }
  } else if (event === "timer_fired") void speak(`Sir, a reminder: ${String(d.label ?? "")}`);
  else if (event === "approval_request") void speak("Requesting authorisation, sir.");
  else if (event === "agent_error" && typeof d.message === "string" && d.message) void speak(d.message);
  else if (event === "preview" && d.action === "open") void speak("Preview on the glass, sir.");
  // heartbeat_ok is silent on purpose — OpenClaw-style.
}

/**
 * Kill the pipeline without reporting it. speak() halts the old utterance and
 * starts the new one in the same tick, and a stop-then-start pair would tell
 * the HUD to resume listening for no reason.
 */
function halt(): void {
  const wasSpeaking = active.length > 0;
  for (const proc of active) {
    try { proc.stdout?.unpipe(); } catch { /* noop */ }
    try { proc.stdin?.destroy(); } catch { /* noop */ }
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
  active = [];
  // Killing spd-say does not stop speech-dispatcher, so flush it — but only
  // when something was speaking. The flush is a separate process that races
  // the next utterance, and fired unconditionally it cut a fresh reply off a
  // fifth of a second in (seen driving the HUD, after spd-say gained -w).
  if (wasSpeaking && availability?.engine === "spd-say") {
    try { spawnProc("spd-say", ["-C"], { stdio: "ignore" }).unref(); } catch { /* noop */ }
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
  for (const p of procs) {
    // Only the process that exited leaves the list. Dropping the whole group
    // when Piper finished synthesising meant paplay, still playing the
    // buffered audio, was neither cancellable nor counted as speaking — so the
    // mic reopened mid-sentence on exactly the long replies that echo worst.
    p.on("exit", () => {
      active = active.filter((x) => x !== p);
      settle();
    });
    // A pipeline missing a stage makes no sound: end it all, and say so.
    p.on("error", () => {
      for (const q of procs) if (q !== p) { try { q.kill("SIGKILL"); } catch { /* gone */ } }
      active = active.filter((x) => !procs.includes(x));
      settle();
    });
  }
  settle();
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
  const synth = spawnProc(
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
  const play = spawnProc(player, playArgs, { stdio: ["pipe", "ignore", "ignore"] });

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
  const synth = spawnProc(
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

  // Registered before track() so the hand-over to the player happens before
  // the synth leaves the list — otherwise speech reads as over for a moment
  // between synthesis and playback, and the mic would reopen into it.
  synth.on("exit", (code) => {
    const pcm = Buffer.concat(chunks);
    if (code !== 0 || pcm.length === 0) {
      console.error("Voice: Piper produced no audio. Check the model file and ./setup-voice.sh.");
      return;
    }
    const wav = path.join(os.tmpdir(), `cunningclaw-tts-${process.pid}-${Date.now()}.wav`);
    try {
      fs.writeFileSync(wav, wrapPcmToWav(pcm, piper.sampleRate));
    } catch (err) {
      console.error(`Voice: could not write WAV: ${(err as Error).message}`);
      return;
    }
    const play = spawnProc(player, [wav], { stdio: "ignore" });
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
  track([synth]);
}

function speakWithPiper(text: string, model: string, player: string): void {
  if (player === "afplay") speakWithPiperFile(text, model, player);
  else speakWithPiperStream(text, model, player);
}

function speakWithSpd(text: string): void {
  const s = config.voice.spd;
  const args = ["-l", s.language, "-r", String(s.rate), "-p", String(s.pitch), "-i", String(s.volume)];
  if (s.voiceName) args.push("-y", s.voiceName);
  // -w keeps spd-say alive until the words have been spoken. Without it the
  // client hands the text to speech-dispatcher and exits at once, so the
  // process list — and the HUD's mic — would think speech ended as it began.
  args.push("-w", "--", text);
  const child = spawnProc("spd-say", args, { stdio: "ignore" });
  swallow(child);
  child.on("error", (err) => {
    console.error(`Voice: spd-say failed: ${err.message}`);
  });
  track([child]);
}

function speakWithSay(text: string, voice = sayVoice()): void {
  const child = spawnProc("say", ["-v", voice, "--", text], { stdio: "ignore" });
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

  const max = config.voice.maxChars;
  const clean = max > 0 ? cleanForSpeech(text).slice(0, max) : cleanForSpeech(text);
  if (!clean) return;

  halt();
  begin(clean);
  try {
    const model = resolveModel();
    if (engine === "piper" && model && player) speakWithPiper(clean, model, player);
    else if (engine === "say") speakWithSay(clean);
    else if (engine === "sapi") speakWithSapi(clean);
    else if (engine === "spd-say") speakWithSpd(clean);
    else console.error(`Voice produced no audio: ${detail}`);
  } catch (err) {
    console.error(`Voice: engine vanished mid-run: ${(err as Error).message}`);
  } finally {
    settle(); // nothing spawned is "not speaking", including after the halt
  }
}

/**
 * Windows' built-in speech synthesis, the counterpart to `say` on macOS.
 * Runs detached so it can be cancelled the same way as the other engines.
 */
function speakWithSapi(text: string): void {
  const child = spawnProc(
    POWERSHELL,
    psArgs(
      "Add-Type -AssemblyName System.Speech;" +
      `$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.Speak(${win.psQuote(text)});`,
    ),
    { stdio: "ignore" },
  );
  child.on("error", () => {});
  track([child]);
}

/** Speak a sample with an explicit Piper model or spd/`say` voice — used by the auditioner. */
export async function sample(opts: { model?: string; voiceName?: string; text: string }): Promise<void> {
  const { engine, player } = await detect();
  if (engine === "none") {
    console.error(`Voice produced no audio: ${(await detect()).detail}`);
    return;
  }
  halt();
  const clean = cleanForSpeech(opts.text);
  begin(clean);
  try {
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
  } finally {
    settle(); // a sample that spawned nothing must still end the halted speech
  }
}

/** Piper voice models present on disk. */
export function listPiperVoices(): string[] {
  const dir = path.join(ROOT, "voices");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".onnx")).map((f) => `voices/${f}`);
}
