import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { earsFix, earsSettings, type EarsState } from "./ears.js";
import { missing } from "./platform.js";

/**
 * Voice notes on the phone line: the operator speaks to Telegram, the claw
 * hears it on this machine, and may answer in its own voice.
 *
 * The pieces already existed — whisper.cpp for ears (src/ears.ts), Piper for
 * the voice (src/voice.ts) — and neither reads what Telegram sends. A voice
 * note is OGG/Opus; whisper wants 16 kHz mono WAV, and Telegram only shows a
 * reply as a voice note if it is OGG/Opus too. ffmpeg is the bridge both ways,
 * and the one new binary. Everything here is argv fixed in this file: the
 * model never names a binary, a flag or a path, and ffmpeg is told the input
 * format rather than left to guess it, so a file that claims to be a voice
 * note reaches the OGG demuxer and nothing else.
 *
 * Audio is piped through ffmpeg's stdin and stdout. A voice note is never
 * written to disk on its way in; the WAV whisper reads is the one ears.ts
 * writes, mode 600, and deletes whatever happens.
 */

export type VoiceReplies = "off" | "spoken" | "always";
export const VOICE_REPLY_MODES: readonly VoiceReplies[] = ["off", "spoken", "always"];

export interface VoiceNoteSettings {
  replies: VoiceReplies;
  maxSeconds: number;
  maxBytes: number;
  maxChars: number;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function isVoiceReplies(v: unknown): v is VoiceReplies {
  return VOICE_REPLY_MODES.includes(v as VoiceReplies);
}

/**
 * The caps, from config. The duration cap is also never above the ears' own:
 * a note Telegram accepted would only be refused by whisper after the
 * download and the conversion had both been paid for.
 */
export function voiceNoteSettings(raw = config.telegram, stored: VoiceReplies | null = null): VoiceNoteSettings {
  const ears = earsSettings();
  return {
    replies: stored ?? (isVoiceReplies(raw?.voiceReplies) ? raw!.voiceReplies! : "spoken"),
    maxSeconds: Math.min(clampInt(raw?.voiceMaxSeconds, 5, 600, 120), ears.maxSeconds),
    // Opus at Telegram's ~32 kbit/s is about 240 KB a minute; 2 MB is eight.
    maxBytes: clampInt(raw?.voiceMaxBytes, 64_000, 20_000_000, 2_000_000),
    maxChars: clampInt(raw?.voiceMaxChars, 100, 4000, 1200),
  };
}

/** Should this reply go back as a voice note as well as text? */
export function wantsVoiceReply(mode: VoiceReplies, operatorSpoke: boolean): boolean {
  return mode === "always" || (mode === "spoken" && operatorSpoke);
}

// --- The phone's choice, kept across restarts ---------------------------------

const PREFS_FILE = "telegram-prefs.json";

/** What /voice last set, or null to use config. Directory injected for the tests. */
export function loadVoiceReplies(dir: string): VoiceReplies | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, PREFS_FILE), "utf-8"));
    return isVoiceReplies(raw?.voiceReplies) ? raw.voiceReplies : null;
  } catch {
    return null;
  }
}

export function saveVoiceReplies(dir: string, mode: VoiceReplies): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, PREFS_FILE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify({ voiceReplies: mode }, null, 2) + "\n");
  fs.renameSync(tmp, path.join(dir, PREFS_FILE));
}

/** "/voice", "/voice always", "/voice when I speak" → the mode asked for, "show", or null if not this command. */
export function parseVoiceCommand(text: string): VoiceReplies | "show" | "bad" | null {
  const m = /^\/voice(?:@\w+)?(?:\s+(.*))?$/i.exec(text.trim());
  if (!m) return null;
  const arg = (m[1] ?? "").trim().toLowerCase();
  if (!arg) return "show";
  if (/^(off|never|no|text)$/.test(arg)) return "off";
  if (/^(spoken|when ?i ?speak|when ?spoken|auto|on)$/.test(arg)) return "spoken";
  if (/^(always|all)$/.test(arg)) return "always";
  return "bad";
}

export function describeVoiceReplies(mode: VoiceReplies): string {
  if (mode === "off") return "off — replies come back as text only";
  if (mode === "always") return "always — every reply comes back as text and a voice note";
  return "when you speak — a voice note gets text and a voice note back; typed messages get text";
}

// --- ffmpeg ---------------------------------------------------------------------

/** The argv for one voice note in: OGG/Opus on stdin, 16 kHz mono 16-bit WAV on stdout. */
export function oggToWavArgs(maxSeconds: number): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    // Named, not probed: the bytes reach the OGG demuxer and no other.
    "-f", "ogg", "-i", "pipe:0",
    "-map_metadata", "-1", "-vn",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    // Belt and braces on the duration Telegram reported: a note that lies
    // about its length is cut here rather than fed to whisper for an hour.
    "-t", String(Math.max(1, Math.round(maxSeconds))),
    "-f", "wav", "pipe:1",
  ];
}

/** The argv for one voice note out: Piper's raw s16le mono at `rate` on stdin, OGG/Opus on stdout. */
export function pcmToOggArgs(rate: number): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "s16le", "-ar", String(Math.round(rate)), "-ac", "1", "-i", "pipe:0",
    // Telegram only draws a waveform for Opus in OGG; voip tuning suits speech.
    "-c:a", "libopus", "-b:a", "32k", "-application", "voip",
    "-map_metadata", "-1",
    "-f", "ogg", "pipe:1",
  ];
}

/** Run a binary with bytes on stdin; resolves stdout. Rejects with stderr's last line. */
export type ExecBytes = (bin: string, args: string[], input: Buffer, opts: { timeoutMs: number; maxBytes: number }) => Promise<Buffer>;

export const execBytes: ExecBytes = (bin, args, input, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let err = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      finish(() => reject(new Error(`${bin} took longer than ${Math.round(opts.timeoutMs / 1000)}s`)));
    }, opts.timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > opts.maxBytes) {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        return finish(() => reject(new Error(`${bin} produced more than ${Math.round(opts.maxBytes / 1e6)} MB`)));
      }
      chunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => { err = (err + c.toString("utf-8")).slice(-2000); });
    // ffmpeg may stop reading early (the -t cap); that is not a failure.
    child.stdin.on("error", () => {});
    child.on("error", (e) => finish(() => reject(new Error(`${bin} could not start: ${e.message}`))));
    child.on("close", (code) => {
      if (code === 0) return finish(() => resolve(Buffer.concat(chunks)));
      const last = err.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "";
      finish(() => reject(new Error(`${bin} exited ${code}${last ? `: ${last.slice(0, 200)}` : ""}`)));
    });
    child.stdin.end(input);
  });

export const FFMPEG_TIMEOUT_MS = 60_000;

/** One voice note to the WAV ears.listen() reads. */
export async function oggToWav(run: ExecBytes, ogg: Buffer, maxSeconds: number): Promise<Buffer> {
  // 16 kHz × 2 bytes × seconds, plus a header and a little slack.
  return run("ffmpeg", oggToWavArgs(maxSeconds), ogg, { timeoutMs: FFMPEG_TIMEOUT_MS, maxBytes: 32_000 * (maxSeconds + 2) + 4096 });
}

/** Piper's PCM to a voice note Telegram will show as one. */
export async function pcmToOgg(run: ExecBytes, pcm: Buffer, rate: number): Promise<Buffer> {
  try {
    return await run("ffmpeg", pcmToOggArgs(rate), pcm, { timeoutMs: FFMPEG_TIMEOUT_MS, maxBytes: 20_000_000 });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // A minimal ffmpeg build without libopus is the likeliest failure; name it.
    if (/libopus|Unknown encoder|Encoder not found/i.test(msg)) {
      throw new Error("this ffmpeg has no Opus encoder (libopus) — install a full ffmpeg build");
    }
    throw err;
  }
}

// --- What is missing, said exactly ---------------------------------------------

export interface VoiceNoteReadiness {
  /** Null when a voice note can be heard; else what is missing and the fix. */
  hear: string | null;
  /** Null when a reply can be spoken; else what is missing and the fix. */
  speak: string | null;
}

/**
 * Why a voice note cannot be heard, in the words the operator is sent. The
 * HUD's ears may fall back to the browser's recogniser; a phone has no such
 * fallback, so "browser" is reported as what it is here — no local ears.
 */
export function hearingGap(hasFfmpeg: boolean, ears: EarsState): string | null {
  const gaps: string[] = [];
  if (!hasFfmpeg) gaps.push(`ffmpeg is needed to read Telegram's OGG audio — ${missing("ffmpeg")}`);
  if (ears.engine !== "whisper") {
    const pref = earsSettings().engine;
    gaps.push(pref === "off" || pref === "browser"
      ? `ears.engine is "${pref}" in claw.config.json, so nothing transcribes on this machine — set it to "auto"`
      : `local speech-to-text (whisper.cpp) is not set up — ${earsFix()}`);
  }
  return gaps.length ? gaps.join("; ") : null;
}

export function speakingGap(hasFfmpeg: boolean, piperGap: string | null): string | null {
  const gaps: string[] = [];
  if (piperGap) gaps.push(piperGap);
  if (!hasFfmpeg) gaps.push(`ffmpeg is needed to make a voice note — ${missing("ffmpeg")}`);
  return gaps.length ? gaps.join("; ") : null;
}

/** One doctor line: voice notes both ways, naming ffmpeg, whisper and Piper. */
export function voiceNoteDoctorLine(r: VoiceNoteReadiness): { ok: boolean; line: string } {
  if (!r.hear && !r.speak) return { ok: true, line: "Telegram voice notes: heard locally (ffmpeg + whisper.cpp) and answered with Piper" };
  const parts = [
    r.hear ? `not heard — ${r.hear}` : "heard locally (ffmpeg + whisper.cpp)",
    r.speak ? `replies text only — ${r.speak}` : "answered with Piper",
  ];
  return { ok: false, line: `Telegram voice notes: ${parts.join("; ")}` };
}
