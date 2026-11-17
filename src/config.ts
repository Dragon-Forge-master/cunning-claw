import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addressAs, applyOwner, loadOwner } from "./owner.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where this install lives, and where its state goes.
 *
 * Both were derived from this file's own location with no way to override
 * them, which meant one machine could only ever run one claw: a second one
 * would share history.json, memory, the journal, the todo list and the brain
 * pin with the first. That is the blocker for workers — a worker is a claw
 * with its own state — so both are now overridable, and nothing changes for an
 * ordinary install where neither variable is set.
 */
export const ROOT = process.env.CLAW_ROOT
  ? path.resolve(process.env.CLAW_ROOT)
  : path.resolve(here, "..");

// Load .env before anything else reads process.env (the Anthropic client is
// constructed at module import time, so this must happen first).
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let value = m[2];
    const quoted = value.startsWith('"') || value.startsWith("'");
    if (!quoted) value = value.replace(/\s+#.*$/, "");
    process.env[m[1]] = value.replace(/^["']|["']$/g, "");
  }
}
export const DATA_DIR = process.env.CLAW_DATA_DIR
  ? path.resolve(process.env.CLAW_DATA_DIR)
  : path.join(ROOT, "data");

/** The config file, so two claws on one machine can differ (port, persona, brain). */
export const CONFIG_FILE = process.env.CLAW_CONFIG
  ? path.resolve(process.env.CLAW_CONFIG)
  : path.join(ROOT, "claw.config.json");

export interface ClawConfig {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  persona: { name: string; addressUserAs: string; userName: string };
  history: { maxMessages: number; persist: boolean };
  webSearch: { enabled: boolean; maxUses: number };
  commandPolicy: {
    autoApprovePatterns: string[];
    denyPatterns: string[];
    timeoutMs: number;
    approvalTimeoutMs: number;
  };
  /**
   * The box around run_command (src/sandbox.ts). auto: bubblewrap or
   * sandbox-exec when present, the host with a visible note when not;
   * required: no sandbox, no command. Only writes are confined.
   */
  sandbox?: { mode?: "off" | "auto" | "required"; network?: boolean; writable?: string[] };
  voice: {
    enabled: boolean;
    engine: "auto" | "piper" | "spd-say" | "say";
    maxChars: number;
    /** macOS `say` voice. Daniel is the closest built-in to a butler. */
    say?: { voice?: string };
    piper: {
      model: string;
      player: string;
      sampleRate: number;
      lengthScale: number;
      noiseScale: number;
      noiseWScale: number;
      sentenceSilence: number;
      volume: number;
    };
    spd: {
      language: string;
      voiceName: string;
      rate: number;
      pitch: number;
      volume: number;
    };
  };
  browser: {
    enabled: boolean;
    binary: string;
    debugPort: number;
    timeoutMs: number;
    extraFlags: string[];
    requireApprovalFor: string[];
    /** Gate every browser action, not just the irreversible ones. */
    approveEveryAction?: boolean;
    /** Extra regexes treated as irreversible. Adds to the code-level list. */
    committingPatterns?: string[];
  };
  desktop: {
    enabled: boolean;
    maxImageWidth: number;
    requireApprovalFor: string[];
  };
  http: { allowlist: string[]; timeoutMs: number; maxResponseChars: number };
  homeAssistant: { enabled: boolean; baseUrl: string; tokenEnv: string };
  /**
   * Butler eyes — one webcam still on demand. Off unless enabled is true.
   * device is /dev/videoN on Linux, an avfoundation index on macOS.
   */
  eyes?: { enabled?: boolean; device?: string; maxImageWidth?: number };
  coherence: {
    ouroborosLimit: number;
    maxIterations: number;
    /** Repetition ratio at which to nudge, and at which to stop. */
    repetitionWarn?: number;
    repetitionHalt?: number;
    /** How many identical turns in a row before the claw is warned it is circling. */
    repeatTurnsBeforeWarning?: number;
    minStepsBeforeJudging?: number;
  };
  heartbeat: { enabled: boolean; intervalMinutes: number };
  /**
   * Named brains that all share the same tools. One butler, several models.
   * Legacy `model` / `brain.provider` still work if `catalog` is omitted.
   */
  brains?: {
    default?: string;
    heartbeat?: string;
    fallbacks?: string[];
    catalog?: Array<{
      id: string;
      label?: string;
      provider?: "anthropic" | "openai";
      model: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      maxTokens?: number;
      thinking?: boolean;
      baseUrl?: string;
      apiKeyEnv?: string;
    }>;
  };
  brain?: {
    provider?: "anthropic" | "openai";
    openai?: { baseUrl?: string; model?: string; apiKeyEnv?: string };
  };
  routing?: {
    /** Force a trusted brain on turns that can see attacker-controlled text. */
    enforceTrustedBrain?: boolean;
    /** Brain ids cleared to handle hostile input. Defaults to brains.default. */
    trustedBrains?: string[];
    /** Route obviously-trivial turns to a cheap brain. */
    cheapWhenTrivial?: boolean;
    cheapBrain?: string;
    /** Route making jobs (a site, a logo, a plan, a document) to a capable brain. Default on. */
    capableWhenMaking?: boolean;
    capableBrain?: string;
    /** Let the trusted-brain guard override an explicit pin. Off: the operator decides. */
    guardOverridesPin?: boolean;
  };
  coding?: { root?: string; skip?: string[] };
  /**
   * read_document. maxChars is one read's share of the context window (40k);
   * a longer document is paged with `start`. ocrLang is tesseract's code.
   */
  documents?: { maxChars?: number; maxFileMB?: number; timeoutMs?: number; ocrMaxPages?: number; ocrLang?: string };
  mcp?: {
    enabled: boolean;
    timeoutMs: number;
    maxToolsPerServer: number;
    maxResultChars: number;
    servers: {
      id: string;
      transport: "stdio" | "http" | "sse";
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
      headers?: Record<string, string>;
      allow?: string[];
      writeTools?: string[];
    }[];
  };
  /**
   * Send only the MCP schemas a turn needs, plus a roster of the rest, and
   * cut very long tool results. On unless enabled is false; see src/tool-diet.ts.
   */
  toolDiet?: {
    enabled?: boolean;
    sendAllAtMost?: number;
    stickyTurns?: number;
    rosterDescChars?: number;
    maxResultChars?: number;
  };
  agent?: { maxTurnMinutes?: number };
  /**
   * Memory search by meaning. "auto" picks a keyed provider (Ollama first when
   * the default brain is local); "off" is keyword search only. Memory text goes
   * only to a provider you have keyed — Ollama keeps it on this machine.
   */
  memory?: {
    embeddings?: "auto" | "gemini" | "openrouter" | "ollama" | "off";
    model?: string;
    /** Ollama's root URL; defaults to a local brain on :11434, then 127.0.0.1:11434. */
    ollamaUrl?: string;
    timeoutMs?: number;
    /** Cosine floor for a meaning-only hit; the default depends on the provider. */
    minSimilarity?: number;
    maxResults?: number;
  };
  /**
   * The phone lines' master switches. The token in .env says a line *can*
   * run; these say whether *this* claw may — a second claw (film studio, QA)
   * shares .env and must be able to decline the bot without editing secrets.
   */
  telegram?: { enabled?: boolean };
  discord?: { enabled?: boolean };
  /**
   * ntfy pushes — outbound only, no account. The topic and any access token
   * are secrets and live in .env under the names given here; on public
   * ntfy.sh the topic's name is the only lock on it.
   */
  ntfy?: {
    enabled?: boolean;
    server?: string;
    topicEnv?: string;
    tokenEnv?: string;
    /** 1 (min) to 5 (max); approval alerts are sent at no less than 4. */
    priority?: number;
    /** How long an approval may wait unanswered before the phone is told. 0 = at once. */
    approvalDelaySeconds?: number;
  };
  /**
   * Approve the plan once instead of every step of it. Off means every action
   * keeps asking individually, which is the old behaviour.
   */
  workOrder?: { enabled?: boolean; expiryMinutes?: number };
  /**
   * The injection scanner (src/injection.ts): the score, 0..1, at which a
   * fenced block is marked and committing actions in that turn ask afresh.
   * Default 0.5. There is no off switch — invisible characters are always
   * stripped, and a warning costs nothing but a line.
   */
  injection?: { threshold?: number };
  /**
   * Second machines the claw may work on. Boxes are named here and chosen by
   * id — the model never supplies a host, a user or an ssh option.
   */
  remote?: {
    enabled?: boolean;
    defaultBox?: string;
    connectTimeoutSec?: number;
    runTimeoutMs?: number;
    maxOutputChars?: number;
    boxes?: {
      id: string; label?: string; host: string; user: string; port?: number;
      identityFile?: string; workdir?: string; jobsDir?: string;
      allowSudo?: boolean; allowReboot?: boolean; note?: string;
    }[];
  };
  board?: { githubOwner?: string; weatherPlace?: string; staleAfterDays?: number };
  server: { port: number; host: string };
  /**
   * USD per million tokens, keyed by model id (prefix match allowed).
   * Unknown models record tokens and mark the turn unpriced rather than guessing.
   */
  pricing?: {
    currency?: string;
    models?: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
  };
}

export const config: ClawConfig = JSON.parse(
  fs.readFileSync(CONFIG_FILE, "utf-8"),
);

// Who the operator is lives in the data dir, not in claw.config.json: the
// setup page writes it, and a tracked file edited by hand is what makes
// `npm run update` refuse to pull.
applyOwner(config, loadOwner(DATA_DIR));

/**
 * How a fixed line addresses the operator, read at call time: the setup page
 * can change it while the claw is running.
 */
export function addressed(start = false): string {
  return addressAs(config.persona.addressUserAs, start);
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
