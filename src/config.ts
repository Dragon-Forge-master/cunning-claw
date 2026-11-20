import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHomeRoot, seedHome } from "./home-root.js";
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

/**
 * Where the owner's things live: `.env`, `claw.config.json`, `data/`,
 * `workspace/`. ROOT itself for a clone or an unzipped download, as it always
 * was; a per-user folder for an installed app, whose code is read-only
 * (src/home-root.ts says which folder, and why).
 */
const homeRoot = resolveHomeRoot({
  codeRoot: ROOT, env: process.env, platform: process.platform, homedir: os.homedir(), exists: fs.existsSync,
});
export const HOME_ROOT = homeRoot.home;
/** True when this claw runs from an installer's read-only copy (the marker is in ROOT). */
export const INSTALLED = homeRoot.installed;

// Before anything reads the config or the workspace: a first run gets the
// shipped defaults, an upgrade refreshes the ones the owner never touched,
// and nothing the owner made is ever overwritten.
if (HOME_ROOT !== ROOT) {
  try {
    seedHome(ROOT, HOME_ROOT);
  } catch (err) {
    console.warn(`  ⚠ Could not set up ${HOME_ROOT}: ${(err as Error).message}`);
  }
}

// Load .env before anything else reads process.env (the Anthropic client is
// constructed at module import time, so this must happen first).
const envPath = path.join(HOME_ROOT, ".env");
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
  : path.join(HOME_ROOT, "data");

/**
 * The config file, so two claws on one machine can differ (port, persona,
 * brain). The shipped one in ROOT only when the home root could not be
 * seeded — a claw that starts on its defaults beats one that does not start.
 */
export const CONFIG_FILE = process.env.CLAW_CONFIG
  ? path.resolve(process.env.CLAW_CONFIG)
  : fs.existsSync(path.join(HOME_ROOT, "claw.config.json"))
    ? path.join(HOME_ROOT, "claw.config.json")
    : path.join(ROOT, "claw.config.json");

/**
 * One thing in the house worth telling the operator about. Declared here, the
 * leaf, so config.ts imports nothing upward to describe it.
 */
export interface HomeWatchRule {
  /** An entity id, or a prefix ending in * — "event.front_door_ding", "person.*". */
  entity: string;
  /** Which change counts. Omitted: whatever that kind of entity does (see home-events.ts). */
  on?: "pressed" | "motion" | "opened" | "arrived" | "left";
  /** Where the alert goes. Default "both". The visitor log is written either way. */
  notify?: "phone" | "hud" | "both";
  /** A camera.* entity to take one still from when this fires. */
  snapshot?: string;
  /** "23:00-07:00": inside it the phone stays silent; the HUD and the log still get it. */
  quiet?: string;
  /** Overrides homeAssistant.debounceMinutes for this rule. */
  debounceMinutes?: number;
}

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
  sandbox?: { mode?: "off" | "auto" | "required"; network?: boolean; writable?: string[]; hide?: string[]; reveal?: string[] };
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
  homeAssistant: {
    enabled: boolean;
    baseUrl: string;
    tokenEnv: string;
    /**
     * Live events (src/home-events.ts). Empty or absent: nothing is watched and
     * no socket is opened. The operator chooses every rule.
     */
    watch?: HomeWatchRule[];
    /** One alert per entity per this many minutes; a flapping sensor is one alert. Default 5. */
    debounceMinutes?: number;
    /** Snapshots and visitor-log lines older than this are deleted. Default 30. */
    visitorRetentionDays?: number;
    /** Ask a vision brain for a one-line generic caption of a snapshot. Off unless true. */
    describeVisitors?: boolean;
    /** Brain id for that caption; defaults to the first trusted brain, then the default. */
    visionBrain?: string;
  };
  /**
   * Butler eyes — one webcam still on demand. Off unless enabled is true.
   * device is /dev/videoN on Linux, an avfoundation index on macOS.
   */
  eyes?: { enabled?: boolean; device?: string; maxImageWidth?: number };
  /**
   * Private ears — the HUD mic transcribed on this machine by whisper.cpp.
   * "auto" uses whisper when found, else the browser's recogniser (which
   * sends audio off the machine, and the HUD says so). See src/ears.ts.
   */
  ears?: {
    engine?: "auto" | "whisper" | "browser" | "off";
    maxBytes?: number;
    maxSeconds?: number;
    whisper?: { bin?: string; model?: string; language?: string; threads?: number; timeoutMs?: number };
  };
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
  telegram?: {
    enabled?: boolean;
    /**
     * Voice notes back (src/voice-notes.ts): "off", "spoken" — only when the
     * operator's own message was a voice note, the default — or "always".
     * The text is sent every time; the voice is in addition, never instead.
     * /voice on the phone changes it, and that choice is kept in the data dir.
     */
    voiceReplies?: "off" | "spoken" | "always";
    /** Longer voice notes are refused before they are downloaded. Default 120 s. */
    voiceMaxSeconds?: number;
    /** Larger voice notes are refused before they are downloaded. Default 2 MB. */
    voiceMaxBytes?: number;
    /** The most of a reply read aloud; the text always carries all of it. Default 1200. */
    voiceMaxChars?: number;
  };
  discord?: { enabled?: boolean };
  /**
   * Receipts (src/receipts.ts): photos read into a ledger under DATA_DIR/receipts.
   * visionBrain defaults to the first trusted brain, then the default brain.
   */
  receipts?: { visionBrain?: string; maxBytes?: number };
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
   * The "ask the forge" wall on the project's site (site/functions/_wall/,
   * src/wall.ts). `url` is the one address the site_wall tool talks to — the
   * model never supplies it. The admin token is a secret and lives in .env
   * under `tokenEnv` (default WALL_ADMIN_TOKEN); without it the tool says so.
   */
  siteWall?: { enabled?: boolean; url?: string; tokenEnv?: string };
  /**
   * Approve the plan once instead of every step of it. Off means every action
   * keeps asking individually, which is the old behaviour.
   */
  workOrder?: { enabled?: boolean; expiryMinutes?: number };
  /**
   * The desk marketer's consent guard (src/marketing.ts). `register` moves the
   * consent register off the Desk (default ~/Documents/CunningClaw/Marketing
   * consent.md); `bulkThreshold` is how many recipients make a Gmail send a
   * marketing send whatever it was called (default 5). There is no off switch.
   */
  marketing?: { register?: string; bulkThreshold?: number };
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
  /**
   * The foreman (src/foreman.ts): coding jobs handed to Claude Code, headless,
   * each in a fresh worktree beside the project. Projects are named here and
   * chosen by id — the model never supplies a path. The permission mode,
   * allow rules and deny rules pass through a floor in code: bypassPermissions
   * and auto are refused, a bare Bash allow rule is dropped, and the deny
   * list can only grow. `auth` is "login" (Claude Code's own sign-in, the
   * default), "apiKey" or "oauthToken", read from the variable `authEnv` names.
   */
  foreman?: {
    enabled?: boolean;
    bin?: string;
    maxTurns?: number;
    timeoutMinutes?: number;
    maxParallel?: number;
    model?: string;
    permissionMode?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    settingSources?: string;
    allowHooks?: boolean;
    auth?: "login" | "apiKey" | "oauthToken";
    authEnv?: string;
    worktreeRoot?: string;
    maxBriefChars?: number;
    projects?: { id: string; label?: string; path: string; base?: string; addDirs?: string[]; note?: string }[];
  };
  board?: { githubOwner?: string; weatherPlace?: string; staleAfterDays?: number };
  server: { port: number; host: string };
  /**
   * Pocket Claw, the phone app (docs/POCKET-CLAW.md). `hosts` are the names
   * it answers to — the tailnet name `tailscale serve` gives this machine;
   * the HUD's POCKET panel can also save one to the data dir. The server
   * still binds to `server.host`; these are names, not addresses to listen on.
   */
  pocket?: {
    hosts?: string[];
    /** Idle minutes before the phone needs a fingerprint again to read or send (default 10). */
    unlockMinutes?: number;
    /** How long a pairing QR stays good (default 5, at most 15). */
    pairingMinutes?: number;
    /** VAPID contact for the push services; a URL or mailto:. Defaults to the project page. */
    vapidSubject?: string;
  };
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
