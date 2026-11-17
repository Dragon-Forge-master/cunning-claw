import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { config, DATA_DIR, ROOT } from "./config.js";
import { hasBin, host, type Host } from "./platform.js";
import { collapseHomeIn } from "./redact.js";

/**
 * Private ears: speech-to-text on this machine, with whisper.cpp.
 *
 * The HUD's mic used the browser's SpeechRecognition, which in Chrome streams
 * the operator's voice to Google to be transcribed — every dictated message,
 * and with WAKE on, everything said in the room. That contradicted the one
 * promise in the name "local-first". whisper.cpp is an external binary, found
 * and spawned the way Piper is for the voice (src/voice.ts): nothing to npm
 * install, a plain "not found, here is the fix" when it is missing, and the
 * browser recogniser kept only as a fallback the HUD labels honestly.
 *
 * The client sends audio and nothing else. It never names the binary, the
 * model, a path or a flag — the arguments are fixed here, the file is one this
 * module wrote, and the audio is re-encoded before whisper sees it, so
 * whisper's own file parser only ever reads a WAV we made.
 */

export type EarsEngine = "whisper" | "browser" | "off";
export type EarsPreference = "auto" | "whisper" | "browser" | "off";

export interface EarsSettings {
  engine: EarsPreference;
  /** "" = search the usual places. */
  bin: string;
  /** "" = the best ggml-*.bin under models/. */
  model: string;
  language: string;
  threads: number;
  timeoutMs: number;
  maxBytes: number;
  maxSeconds: number;
}

export interface EarsState {
  engine: EarsEngine;
  /** One line for the HUD and the doctor: what was found, or what to do. */
  detail: string;
  bin?: string;
  model?: string;
}

/** whisper.cpp is trained on 16 kHz mono; every clip is converted to this. */
export const WHISPER_RATE = 16000;

const LANGUAGE = /^(auto|[a-z]{2,3})$/;

export function earsSettings(raw = config.ears): EarsSettings {
  const w = raw?.whisper ?? {};
  const pref = raw?.engine;
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const language = String(w.language ?? "en").trim().toLowerCase();
  return {
    engine: pref === "whisper" || pref === "browser" || pref === "off" ? pref : "auto",
    bin: String(w.bin ?? "").trim(),
    model: String(w.model ?? "").trim(),
    // The language reaches whisper's argv; anything but a short code is "en".
    language: LANGUAGE.test(language) ? language : "en",
    threads: clampInt(w.threads, 1, 16, Math.min(4, Math.max(1, cpus))),
    timeoutMs: clampInt(w.timeoutMs, 5_000, 600_000, 90_000),
    maxBytes: clampInt(raw?.maxBytes, 64_000, 50_000_000, 10_000_000),
    maxSeconds: clampInt(raw?.maxSeconds, 5, 600, 120),
  };
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Where ./setup-ears.sh puts things, so a fresh build is found with no config. */
export const LOCAL_WHISPER_DIR = ".whisper";
export const MODELS_DIR = "models";

/**
 * Binaries to try, in order. A configured path is the only candidate — if the
 * operator named one, silently using another would hide their mistake.
 * `main` is the pre-2025 name; it is only trusted at a path we built, never as
 * a bare word on PATH, where "main" could be anything at all.
 */
export function whisperCandidates(bin: string, root = ROOT, h: Host = host()): string[] {
  if (bin) return [bin.includes("/") || bin.includes("\\") ? path.resolve(root, bin) : bin];
  const exe = h === "win32" ? ".exe" : "";
  const local = path.join(root, LOCAL_WHISPER_DIR);
  return [
    path.join(local, "bin", `whisper-cli${exe}`),
    path.join(local, "build", "bin", `whisper-cli${exe}`),
    `whisper-cli${exe}`,
    // Homebrew's formula installed it under this name before the rename.
    `whisper-cpp${exe}`,
    path.join(local, "build", "bin", `main${exe}`),
    path.join(local, `main${exe}`),
  ];
}

/**
 * The best model among the files in models/. base.en first: tiny.en mishears
 * names and numbers too often to dictate with, small.en is three times slower
 * on a laptop CPU for a modest gain. Quantised variants (q5_1, q8_0) count.
 */
export function pickModel(files: string[]): string | null {
  const ggml = files.filter((f) => /^ggml-[A-Za-z0-9._-]+\.bin$/.test(f) && !/silero|vad/i.test(f));
  const order = ["base.en", "small.en", "base", "small", "tiny.en", "medium.en", "tiny", "medium"];
  for (const size of order) {
    const hit = ggml.filter((f) => f === `ggml-${size}.bin` || f.startsWith(`ggml-${size}-q`)).sort()[0];
    if (hit) return hit;
  }
  return ggml.sort()[0] ?? null;
}

/** The exact fix for "no local ears", per platform. Shared with the doctor. */
export function earsFix(h: Host = host()): string {
  const model = "ggml-base.en.bin into models/ (https://huggingface.co/ggerganov/whisper.cpp)";
  if (h === "darwin") return `brew install whisper-cpp, then ./setup-ears.sh to fetch ${model}`;
  if (h === "win32") {
    return "download whisper-bin-x64.zip from https://github.com/ggml-org/whisper.cpp/releases, " +
      `set ears.whisper.bin to its whisper-cli.exe in claw.config.json, and put ${model}`;
  }
  return `run ./setup-ears.sh — it builds whisper.cpp (https://github.com/ggml-org/whisper.cpp, needs cmake and a C++ compiler) into .whisper/ and fetches ${model}`;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (host() !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findBin(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (isExecutableFile(c)) return c;
    } else if (await hasBin(c)) {
      return c;
    }
  }
  return null;
}

function findModel(configured: string, root = ROOT): string | null {
  if (configured) {
    const p = path.isAbsolute(configured) ? configured : path.join(root, configured);
    return fs.existsSync(p) ? p : null;
  }
  const dir = path.join(root, MODELS_DIR);
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return null; }
  const pick = pickModel(files);
  return pick ? path.join(dir, pick) : null;
}

let cached: EarsState | null = null;
let lookedAt = 0;
/** The HUD polls status every 5 s; a miss is re-checked at most this often. */
const RELOOK_MS = 30_000;

export function resetEarsForTests(state: EarsState | null = null): void {
  cached = state;
  lookedAt = state ? Date.now() : 0;
}

/**
 * Decide which ears are in use. Cached once found; a miss is looked at again
 * after a while, because "I ran setup-ears.sh, why is it still Google?"
 * should not need a restart to answer.
 */
export async function detectEars(settings = earsSettings(), root = ROOT, fresh = false): Promise<EarsState> {
  if (!fresh && cached && (cached.engine === "whisper" || Date.now() - lookedAt < RELOOK_MS)) return cached;
  cached = await lookFor(settings, root);
  lookedAt = Date.now();
  return cached;
}

/** What detectEars() last found, for callers that cannot await. */
export function earsDetected(): EarsState | null {
  return cached;
}

async function lookFor(s: EarsSettings, root: string): Promise<EarsState> {
  if (s.engine === "off") return { engine: "off", detail: "ears.engine is \"off\" in claw.config.json" };
  if (s.engine === "browser") {
    return { engine: "browser", detail: "ears.engine is \"browser\" — the browser's recogniser, which sends audio off this machine" };
  }
  const bin = await findBin(whisperCandidates(s.bin, root));
  const model = findModel(s.model, root);
  if (bin && model) {
    return { engine: "whisper", detail: `whisper.cpp · ${path.basename(model, ".bin").replace(/^ggml-/, "")}`, bin, model };
  }
  const what = !bin
    ? (s.bin ? `ears.whisper.bin (${collapseHomeIn(s.bin)}) is not an executable` : "whisper.cpp (whisper-cli) not found")
    : (s.model ? `ears.whisper.model (${collapseHomeIn(s.model)}) does not exist` : `no ggml-*.bin model in ${MODELS_DIR}/`);
  const fix = earsFix();
  // Asked for whisper by name: falling back to a cloud recogniser would send
  // the operator's voice somewhere they chose it not to go. The mic stays off.
  if (s.engine === "whisper") return { engine: "off", detail: `${what}. ${fix}` };
  return { engine: "browser", detail: `${what} — the browser's recogniser hears instead, and its audio leaves this machine. For local ears, ${fix}` };
}

/** Small and stable for /api/status and GET /api/listen — no paths on the glass. */
export function earsStatus(state = cached): { engine: EarsEngine | "unknown"; label: string; detail: string } {
  if (!state) return { engine: "unknown", label: "EARS", detail: "not looked yet" };
  const label = state.engine === "whisper" ? "LOCAL EARS" : state.engine === "browser" ? "BROWSER EARS" : "EARS OFF";
  return { engine: state.engine, label, detail: collapseHomeIn(state.detail) };
}

// --- Audio --------------------------------------------------------------------

export type WavInfo =
  | { ok: true; sampleRate: number; channels: number; bitsPerSample: number; dataOffset: number; dataBytes: number; seconds: number }
  | { ok: false; error: string };

/**
 * Read a RIFF/WAVE header. Only 16-bit integer PCM is accepted: it is what the
 * HUD sends, what every recorder can write, and the less of whisper's decoder
 * a stranger's bytes can reach, the better.
 */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return { ok: false, error: "not a WAV file (send 16-bit PCM WAV)" };
  }
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) return { ok: false, error: "truncated fmt chunk" };
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) return { ok: false, error: "data before fmt" };
      if (fmt.format !== 1 || fmt.bits !== 16) return { ok: false, error: "only 16-bit integer PCM WAV is accepted" };
      if (fmt.channels < 1 || fmt.channels > 2) return { ok: false, error: "mono or stereo only" };
      if (fmt.rate < 8000 || fmt.rate > 96000) return { ok: false, error: `unsupported sample rate ${fmt.rate}` };
      // A streamed recorder may leave the size as 0 or 0xFFFFFFFF; take what is there.
      const avail = buf.length - body;
      const declared = size === 0 || size === 0xffffffff ? avail : size;
      const frame = 2 * fmt.channels;
      const dataBytes = Math.floor(Math.min(declared, avail) / frame) * frame;
      return {
        ok: true,
        sampleRate: fmt.rate,
        channels: fmt.channels,
        bitsPerSample: 16,
        dataOffset: body,
        dataBytes,
        seconds: dataBytes / frame / fmt.rate,
      };
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  return { ok: false, error: "no data chunk" };
}

/** Mono 16-bit PCM WAV at `rate`. The same header voice.ts writes for afplay. */
export function encodeWav(samples: Int16Array, rate = WHISPER_RATE): Buffer {
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Any accepted WAV → 16 kHz mono 16-bit, the one shape every whisper.cpp
 * version reads (older builds refuse anything that is not 16 kHz). Stereo is
 * averaged; the rate change is linear interpolation, after a box filter when
 * going down so 48 kHz room hiss does not fold into the speech band.
 */
export function toWhisperPcm(buf: Buffer, info: Extract<WavInfo, { ok: true }>): Int16Array {
  const frames = info.dataBytes / (2 * info.channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < info.channels; c++) sum += buf.readInt16LE(info.dataOffset + 2 * (i * info.channels + c));
    mono[i] = sum / info.channels;
  }
  if (info.sampleRate === WHISPER_RATE) return Int16Array.from(mono, (v) => Math.round(v));
  const ratio = info.sampleRate / WHISPER_RATE;
  const src = ratio > 1 ? boxFilter(mono, Math.floor(ratio)) : mono;
  const outLen = Math.floor(frames / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = src[j] ?? 0;
    const b = src[j + 1] ?? a;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac)));
  }
  return out;
}

function boxFilter(x: Float32Array, width: number): Float32Array {
  if (width <= 1) return x;
  const out = new Float32Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i];
    if (i >= width) acc -= x[i - width];
    out[i] = acc / Math.min(i + 1, width);
  }
  return out;
}

/**
 * Loudest 30 ms frame, as RMS in 0..1. A clip that never rises above a whisper
 * of a whisper is sent nowhere: whisper.cpp, handed silence, invents speech
 * ("Thank you.", "you") and that would land in the operator's message box.
 */
export function peakFrameRms(pcm: Int16Array, rate = WHISPER_RATE): number {
  const n = Math.max(1, Math.round(rate * 0.03));
  let peak = 0;
  for (let start = 0; start < pcm.length; start += n) {
    let sum = 0;
    const end = Math.min(pcm.length, start + n);
    for (let i = start; i < end; i++) sum += (pcm[i] / 32768) ** 2;
    peak = Math.max(peak, Math.sqrt(sum / Math.max(1, end - start)));
  }
  return peak;
}

/** Below about -50 dBFS at its loudest, there is nobody speaking. */
export const SILENCE_RMS = 0.003;

// --- whisper.cpp ------------------------------------------------------------

/**
 * The argv, fixed. -nt drops the timestamps, -np the model-loading chatter, so
 * stdout is the words. Every value here comes from config or from this module;
 * none from the request.
 */
export function whisperArgs(o: { model: string; file: string; language: string; threads: number }): string[] {
  return ["-m", o.model, "-f", o.file, "-l", o.language, "-t", String(o.threads), "-nt", "-np"];
}

/**
 * whisper's stdout → the operator's sentence. -nt should mean no timestamps,
 * but older builds and `main` ignore -np and print logs to stdout, so both are
 * stripped here as well. Annotations of non-speech — [BLANK_AUDIO], [MUSIC],
 * (wind blowing), *coughs*, ♪ — are not words anyone said.
 */
export function parseWhisperOutput(stdout: string): string {
  const STAMP = /^\s*\[\s*\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}\s*\]\s*/;
  const LOG = /^\s*(whisper_|main:|system_info:|ggml_|output_|log_mel|load_backend|read_audio|error:|warning:)/i;
  return stdout
    .split(/\r?\n/)
    .filter((line) => !LOG.test(line))
    .map((line) => line.replace(STAMP, ""))
    .join(" ")
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]{1,40}\*|[♪♫]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

/** Spawned through this so the tests can stand in for whisper. */
let spawnProc: typeof spawn = spawn;
export function setSpawnForTests(fn: typeof spawn | null): void {
  spawnProc = fn ?? spawn;
}

export class EarsError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
  }
}

const MAX_STDOUT = 1_000_000;

/** Run whisper on a file this module wrote. Rejects with an EarsError. */
export function runWhisper(file: string, state: EarsState, s: EarsSettings): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!state.bin || !state.model) return reject(new EarsError("local ears are not set up", 409));
    let out = "";
    let err = "";
    let done = false;
    const child = spawnProc(state.bin, whisperArgs({ model: state.model, file, language: s.language, threads: s.threads }), {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(() => reject(new EarsError(`whisper.cpp took longer than ${Math.round(s.timeoutMs / 1000)}s — try a smaller model (ggml-base.en.bin)`, 504)));
    }, s.timeoutMs);
    child.stdout?.on("data", (c: Buffer) => { if (out.length < MAX_STDOUT) out += c.toString("utf-8"); });
    child.stderr?.on("data", (c: Buffer) => { err = (err + c.toString("utf-8")).slice(-4000); });
    child.on("error", (e) => finish(() => reject(new EarsError(`whisper.cpp could not start: ${collapseHomeIn(e.message)}`, 500))));
    child.on("close", (code) => {
      if (code === 0) return finish(() => resolve(parseWhisperOutput(out)));
      const last = err.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "";
      finish(() => reject(new EarsError(`whisper.cpp exited ${code}${last ? `: ${collapseHomeIn(last).slice(0, 200)}` : ""}`, 500)));
    });
  });
}

/**
 * Read a request body with a hard cap. Not express.raw: body-parser answers an
 * oversize body with its own HTML error page (see the /api/upload comment in
 * server.ts), and the HUD wants a sentence it can show.
 */
export function readCapped(stream: Readable, max: number, declared?: number): Promise<Buffer | null> {
  if (declared !== undefined && Number.isFinite(declared) && declared > max) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    stream.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        stream.pause();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    stream.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
    stream.on("error", (e) => { if (!over) reject(e); });
  });
}

let busy = false;

/** Leftovers from a crash mid-transcription; a voice clip is not kept. */
function sweep(dir: string, olderThanMs = 10 * 60_000): void {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".wav")) continue;
      const p = path.join(dir, f);
      if (Date.now() - fs.statSync(p).mtimeMs > olderThanMs) fs.rmSync(p, { force: true });
    }
  } catch { /* nothing to sweep */ }
}

export interface ListenResult { text: string; seconds: number; silent: boolean }

/**
 * Audio in, words out. The clip is written under the data dir (mode 600, a
 * random name), handed to whisper, and deleted whatever happens.
 */
export async function listen(body: Buffer, opts: { dir?: string; settings?: EarsSettings } = {}): Promise<ListenResult> {
  const s = opts.settings ?? earsSettings();
  const state = await detectEars(s);
  if (state.engine !== "whisper") throw new EarsError(`local ears are not available: ${collapseHomeIn(state.detail)}`, 409);
  if (body.length > s.maxBytes) throw new EarsError(`audio too large (cap ${Math.round(s.maxBytes / 1e6)} MB)`, 413);
  const info = parseWav(body);
  if (!info.ok) throw new EarsError(info.error, 400);
  if (info.seconds > s.maxSeconds) throw new EarsError(`audio too long (${Math.round(info.seconds)}s; cap ${s.maxSeconds}s)`, 413);
  const pcm = toWhisperPcm(body, info);
  const seconds = pcm.length / WHISPER_RATE;
  if (seconds < 0.2 || peakFrameRms(pcm) < SILENCE_RMS) return { text: "", seconds, silent: true };
  if (busy) throw new EarsError("already transcribing — one clip at a time", 429);

  const dir = opts.dir ?? path.join(DATA_DIR, "ears");
  busy = true;
  const file = path.join(dir, `${crypto.randomUUID()}.wav`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweep(dir);
    fs.writeFileSync(file, encodeWav(pcm), { mode: 0o600 });
    const text = await runWhisper(file, state, s);
    return { text, seconds, silent: false };
  } finally {
    busy = false;
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
  }
}
