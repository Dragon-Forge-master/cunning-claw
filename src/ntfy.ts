import crypto from "node:crypto";
import { config, type ClawConfig } from "./config.js";
import { groupSafeText, redact } from "./redact.js";

/**
 * ntfy — the third way to reach the operator's phone, and the only one that
 * needs no account: a plain POST to https://ntfy.sh/<topic> (or a self-hosted
 * server), read by the free ntfy app on iOS and Android.
 *
 * It is outbound only, on purpose. Telegram and Discord carry EXECUTE buttons
 * because the claw holds their connection open; ntfy's action buttons would
 * have the PHONE call a URL, and the claw listens on 127.0.0.1, which a phone
 * cannot reach. A button that cannot work is worse than none, and any URL we
 * could make reachable would be an unauthenticated approve endpoint on the
 * internet. So an approval alert says where to answer — the HUD, or a phone
 * line that can carry the verdict — and never offers one itself.
 *
 * The topic is the lock. On public ntfy.sh, anyone who knows a topic's name
 * can subscribe to it and read the last twelve hours of what was sent, so the
 * name lives in .env like a token, is masked wherever it is shown, and what is
 * sent is minimal: redacted, then scrubbed the way a Telegram group reply is,
 * then capped. A self-hosted server or an access token (NTFY_TOKEN) is the
 * private option.
 */

type NtfyConfig = NonNullable<ClawConfig["ntfy"]>;

/** Everything this module does to the outside world, in one seam for the tests. */
export interface NtfyIO {
  fetch: typeof fetch;
  /** An abort signal that fires after `ms`; every request carries one. */
  timeout(ms: number): AbortSignal;
  /** Run `fn` after `ms`; returns a cancel. */
  later(fn: () => void, ms: number): () => void;
  log(line: string): void;
}

const defaultIO: NtfyIO = {
  fetch: (...args) => fetch(...args),
  timeout: (ms) => AbortSignal.timeout(ms),
  later: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
  log: (line) => console.log(`  ${line}`),
};

export const PUBLIC_SERVER = "https://ntfy.sh";
/** A push has nobody waiting on it: give up well before a turn would notice. */
export const REQUEST_TIMEOUT_MS = 10_000;
/**
 * ntfy turns a body over 4,096 bytes into an attachment, which the phone shows
 * as a file rather than a message. 1,000 code points is at most 4,000 bytes of
 * UTF-8, and a phone notification is a glance, not a reading.
 */
export const MAX_BODY_CHARS = 1000;
/** An approval alert names the action, never its detail: the command stays on the HUD. */
export const MAX_SUMMARY_CHARS = 120;
const MAX_TITLE_CHARS = 80;
/** ntfy's own rule for topic names. */
const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
/**
 * Shorter than this and a name on a public server is a guess away. The
 * suggestion below is 29 characters, 144 bits of it random.
 */
export const GUESSABLE_BELOW = 20;
/** Long enough that the operator can answer at the HUD before the phone buzzes. */
export const DEFAULT_APPROVAL_DELAY_S = 15;

export type NtfyKind = "approval" | "schedule" | "heartbeat" | "job" | "tool";

/** Tags that ntfy renders as an emoji, so the kind is legible at a glance. */
const TAGS: Record<NtfyKind, string> = {
  approval: "warning",
  schedule: "spiral_calendar",
  heartbeat: "heartpulse",
  job: "gear",
  tool: "bell",
};

export interface Armed {
  server: string;
  topic: string;
  token: string | null;
  priority: number;
  approvalDelayMs: number;
}

export type Resolved = { ok: true; armed: Armed } | { ok: false; why: "disabled" | "no-topic" | "bad-topic" | "bad-server"; detail?: string };

let io: NtfyIO = defaultIO;
let armed: Armed | null = null;
/** "untried" until the first push; then whether the last one landed. */
let delivery: "untried" | "ok" | "failing" = "untried";
let lastFailure: string | null = null;
const pendingAlerts = new Map<string, () => void>();

/** A fresh topic name for the operator to paste into .env. */
export function suggestTopic(): string {
  return `claw-${crypto.randomBytes(18).toString("base64url")}`;
}

/** Same rule as a chat id: the last four tell two topics apart and give nothing away. */
export function maskTopic(topic: string): string {
  return `…${topic.slice(-4)}`;
}

export function topicLooksGuessable(topic: string): boolean {
  return topic.length < GUESSABLE_BELOW;
}

function clampPriority(p: unknown): number {
  const n = Math.round(Number(p));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
}

/**
 * The server as an origin plus optional path, never with credentials in it —
 * a user:pass in the URL would be logged by every proxy on the way. The model
 * never supplies any of this; it comes from claw.config.json and .env only.
 */
export function normaliseServer(raw: string | undefined): string | null {
  try {
    const u = new URL(String(raw || PUBLIC_SERVER));
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Read the switch, the server and the secrets; nothing is sent from here. */
export function resolveNtfy(cfg: NtfyConfig | undefined = config.ntfy, env: NodeJS.ProcessEnv = process.env): Resolved {
  // The config switch wins over .env, as it does for Telegram: a second claw
  // shares the repo's .env and must be able to decline the topic.
  if (cfg?.enabled === false) return { ok: false, why: "disabled" };
  const topic = String(env[cfg?.topicEnv || "NTFY_TOPIC"] ?? "").trim();
  if (!topic) return { ok: false, why: "no-topic" };
  if (!TOPIC_RE.test(topic)) return { ok: false, why: "bad-topic" };
  const server = normaliseServer(cfg?.server);
  if (!server) return { ok: false, why: "bad-server", detail: String(cfg?.server ?? "") };
  const token = String(env[cfg?.tokenEnv || "NTFY_TOKEN"] ?? "").trim() || null;
  const delayS = Number(cfg?.approvalDelaySeconds ?? DEFAULT_APPROVAL_DELAY_S);
  return {
    ok: true,
    armed: {
      server,
      topic,
      token,
      priority: clampPriority(cfg?.priority ?? 3),
      approvalDelayMs: Number.isFinite(delayS) && delayS > 0 ? delayS * 1000 : 0,
    },
  };
}

/** Hold the settings and the network; pass null to disarm. Tests arm against a fake fetch. */
export function armNtfy(settings: Armed | null, withIO: NtfyIO = defaultIO): void {
  for (const cancel of pendingAlerts.values()) cancel();
  pendingAlerts.clear();
  io = withIO;
  armed = settings;
  delivery = "untried";
  lastFailure = null;
}

function serverLabel(server: string): string {
  // A self-hosted server's name can be the operator's own domain, and the
  // status panel is filmed.
  return server === PUBLIC_SERVER ? "ntfy.sh" : "self-hosted";
}

/**
 * For the HUD and the doctor. Non-volatile on purpose — no timestamps, no
 * counters — so a model that reads it twice sees the same thing twice.
 */
export function ntfyStatus() {
  return {
    enabled: Boolean(armed),
    topic: armed ? maskTopic(armed.topic) : null,
    server: armed ? serverLabel(armed.server) : null,
    protected: Boolean(armed?.token),
    delivery,
  };
}

export function startNtfy(withIO: NtfyIO = defaultIO): void {
  const r = resolveNtfy();
  if (!r.ok) {
    armNtfy(null, withIO);
    if (r.why === "bad-topic") {
      console.warn(`  ⚠ ntfy: NTFY_TOPIC may hold only letters, digits, - and _ (64 at most) — not pushing. Try ${suggestTopic()}`);
    } else if (r.why === "bad-server") {
      console.warn("  ⚠ ntfy: ntfy.server in claw.config.json is not an http(s) URL without credentials — not pushing.");
    }
    return;
  }
  armNtfy(r.armed, withIO);
  const s = ntfyStatus();
  console.log(`  ntfy: pushing to ${s.topic} on ${s.server}${s.protected ? " (access token)" : ""}`);
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * What may leave for the topic, in the only safe order: redact the whole text,
 * then take the machine and addresses out, THEN cut. Cutting first leaves a key
 * straddling the cut unmatched, and both passes change the length.
 *
 * Email addresses go too. A Telegram group is at least a room the operator
 * chose; a public topic is one anybody who guesses the name walks into, and a
 * briefing is mostly other people's addresses.
 */
export function phoneText(text: string, cap = MAX_BODY_CHARS): string {
  const clean = groupSafeText(redact(String(text ?? ""))).replace(EMAIL_RE, "[email]").trim();
  const points = Array.from(clean);
  return points.length > cap ? `${points.slice(0, cap - 1).join("").trimEnd()}…` : clean;
}

/**
 * A header must be one line of plain ASCII: fetch refuses anything past
 * Latin-1, and a newline would be a header injection. Accents fold to their
 * letters, so a Welsh persona name still reads.
 */
export function headerSafe(text: string, fallback = "Cunning Claw"): string {
  const ascii = phoneText(text, MAX_TITLE_CHARS)
    .normalize("NFKD")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return ascii || fallback;
}

export interface PhoneMessage {
  kind: NtfyKind;
  title: string;
  body: string;
  /** Overrides the configured priority, 1–5. */
  priority?: number;
}

/** The request, built where it can be tested. There is no Actions, Click or Attach header, ever. */
export function ntfyRequest(msg: PhoneMessage, a: Armed): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    Title: headerSafe(msg.title, headerSafe(config.persona.name)),
    Priority: String(clampPriority(msg.priority ?? a.priority)),
    Tags: TAGS[msg.kind],
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (a.token) headers.Authorization = `Bearer ${a.token}`;
  return {
    url: `${a.server}/${a.topic}`,
    init: { method: "POST", headers, body: phoneText(msg.body) },
  };
}

function reason(err: any): string {
  const msg = String(err?.message ?? err);
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause && !msg.includes(String(cause)) ? `${msg} (${cause})` : msg;
}

function failed(why: string): false {
  delivery = "failing";
  // Once per change, not per failure: a laptop off the network for a day
  // would otherwise fill the journal with the same line every half hour.
  if (why !== lastFailure) io.log(`ntfy: push to ${armed ? maskTopic(armed.topic) : "?"} failed — ${why}`);
  lastFailure = why;
  return false;
}

/**
 * Send one push. Resolves whether it landed and never rejects: a phone that
 * did not buzz is not a reason for a turn, a briefing or an approval to fail.
 */
export async function notifyPhone(msg: PhoneMessage): Promise<boolean> {
  const a = armed;
  if (!a) return false;
  try {
    const { url, init } = ntfyRequest(msg, a);
    if (!String(init.body ?? "").trim()) return false;
    const res = await io.fetch(url, { ...init, signal: io.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403
        ? " — the topic is protected; set NTFY_TOKEN in .env"
        : res.status === 429 ? " — rate limited by the server" : "";
      return failed(`HTTP ${res.status}${hint}`);
    }
    if (lastFailure) io.log("ntfy: pushes are landing again.");
    delivery = "ok";
    lastFailure = null;
    return true;
  } catch (err) {
    return failed(reason(err));
  }
}

/**
 * The approval alert: what is waiting and where to answer it. Only the
 * summary goes — "Run shell command", not the command — and no button.
 */
export function approvalAlertText(summary: string, lines: string[]): string {
  const what = phoneText(summary, MAX_SUMMARY_CHARS).replace(/\s+/g, " ").replace(/[.\s]+$/, "") || "an action";
  const where = lines.length ? `Open the HUD or reply on ${lines.join("/")}.` : "Open the HUD to answer.";
  return `${config.persona.name} is waiting for your approval: ${what}. ${where}`;
}

/**
 * Raise the alert, after a grace period. The operator at the desk answers on
 * the HUD in a few seconds, and a phone that buzzed for every one of those
 * would be switched off by lunchtime; the alert is for the request nobody has
 * answered. approvalSettled cancels it.
 */
export function sendApprovalAlert(id: string, summary: string, lines: string[]): void {
  const a = armed;
  if (!a) return;
  const fire = () => {
    pendingAlerts.delete(id);
    void notifyPhone({
      kind: "approval",
      title: `${config.persona.name}: approval waiting`,
      body: approvalAlertText(summary, lines),
      // It has a timeout; it should not sit below a weather update.
      priority: Math.max(a.priority, 4),
    });
  };
  if (!a.approvalDelayMs) return fire();
  pendingAlerts.set(id, io.later(fire, a.approvalDelayMs));
}

/** The request was answered (or timed out): an alert still in its grace period never goes. */
export function approvalSettled(id: string): void {
  pendingAlerts.get(id)?.();
  pendingAlerts.delete(id);
}

/** The shape of the tool context this needs, without importing tools.ts (which imports this). */
interface ToolGate {
  requestApproval(summary: string, detail: string): Promise<boolean>;
  tainted?: () => boolean;
}

/**
 * The `notify` tool's phone channel.
 *
 * The destination is fixed — the operator's own topic, from .env — so in a
 * clean turn this is the claw talking to its operator, as a Telegram reply
 * is, and runs freely. A turn that has read outside content asks first: that
 * is exactly when a stranger's text could be trying to get something carried
 * off the machine to a topic it might know. The card shows the scrubbed text,
 * which is what would be sent.
 */
export async function phoneNotifyTool(title: string, body: string, ctx: ToolGate, warning = ""): Promise<string> {
  if (!armed) return "Phone notifications are off — set NTFY_TOPIC in .env (npm run doctor suggests a name).";
  if (ctx.tainted?.()) {
    const ok = await ctx.requestApproval(
      "Send a phone notification (ntfy)",
      `${warning}${headerSafe(title)}\n\n${phoneText(body)}`,
    );
    if (!ok) return "Not sent — the operator declined the phone notification.";
  }
  return (await notifyPhone({ kind: "tool", title, body }))
    ? "Sent to the operator's phone (ntfy)."
    : "The phone notification did not go through; the failure is in the log.";
}

/** One row for npm run doctor. Never sends: a test push would buzz the phone. */
export function ntfyDoctorLine(cfg: NtfyConfig | undefined = config.ntfy, env: NodeJS.ProcessEnv = process.env):
  { status: "ok" | "warn"; text: string } {
  const r = resolveNtfy(cfg, env);
  if (!r.ok) {
    switch (r.why) {
      case "disabled": return { status: "ok", text: "ntfy: off in claw.config.json" };
      case "no-topic": return {
        status: "ok",
        text: `ntfy: off (optional — install the ntfy app, subscribe to a topic, and put NTFY_TOPIC=${suggestTopic()} in .env)`,
      };
      case "bad-topic": return {
        status: "warn",
        text: `ntfy: NTFY_TOPIC may hold only letters, digits, - and _ (64 at most). Try NTFY_TOPIC=${suggestTopic()}`,
      };
      case "bad-server": return {
        status: "warn",
        text: "ntfy: ntfy.server in claw.config.json must be an http(s) URL with no credentials in it",
      };
    }
  }
  const a = r.armed;
  const where = serverLabel(a.server);
  if (a.server === PUBLIC_SERVER && !a.token && topicLooksGuessable(a.topic)) {
    return {
      status: "warn",
      text: `ntfy: topic ${maskTopic(a.topic)} is short enough to guess, and anyone who guesses a public ntfy.sh topic reads it. ` +
        `Try NTFY_TOPIC=${suggestTopic()}, or self-host / use NTFY_TOKEN`,
    };
  }
  if (a.server.startsWith("http:") && !/^http:\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(a.server)) {
    return { status: "warn", text: "ntfy: the server is plain http on a public address — pushes and any token travel in clear" };
  }
  return {
    status: "ok",
    text: `ntfy: on (topic ${maskTopic(a.topic)} on ${where}${a.token ? ", access token" : ", open topic — the name is the only lock"})`,
  };
}
