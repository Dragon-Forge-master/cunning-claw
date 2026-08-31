import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

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
export const DATA_DIR = path.join(ROOT, "data");

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
    /** Let the trusted-brain guard override an explicit pin. Off: the operator decides. */
    guardOverridesPin?: boolean;
  };
  coding?: { root?: string; skip?: string[] };
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
  agent?: { maxTurnMinutes?: number };
  /**
   * Approve the plan once instead of every step of it. Off means every action
   * keeps asking individually, which is the old behaviour.
   */
  workOrder?: { enabled?: boolean; expiryMinutes?: number };
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
  fs.readFileSync(path.join(ROOT, "claw.config.json"), "utf-8"),
);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
