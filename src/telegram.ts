import { config } from "./config.js";
import { redact } from "./redact.js";
import type { AgentEvents } from "./agent.js";
import { runTurn } from "./agent.js";
import { systemStatusText } from "./tools.js";
import { applyBrainCommand, catalogStatus, formatCatalog } from "./brain.js";

const API = "https://api.telegram.org";

type ResolveApproval = (id: string, approved: boolean) => boolean;

/**
 * Everything this module does to the outside world, in one seam, so the tests
 * can stand in a network that fails on cue and a clock that does not wait.
 */
export interface TelegramIO {
  fetch: typeof fetch;
  /** An abort signal that fires after `ms`; every request carries one. */
  timeout(ms: number): AbortSignal;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

const defaultIO: TelegramIO = {
  fetch: (...args) => fetch(...args),
  timeout: (ms) => AbortSignal.timeout(ms),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  log: (line) => console.log(`  ${line}`),
};

let io: TelegramIO = defaultIO;
let botToken: string | null = null;
let allowed = new Set<string>();
let resolveApproval: ResolveApproval | null = null;
const approvalMsgs = new Map<string, { chatId: string; messageId: number }>();
// Approvals still waiting on a verdict. A card retry checks this before each
// attempt: a card for a request the HUD already settled is only noise.
const liveCards = new Set<string>();

export function parseChatAllowlist(raw: string): Set<string> {
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * A chat id is a personal identifier, and the telemetry panel it lands on gets
 * filmed. The last four digits are enough to tell two allowed chats apart.
 */
export function maskChatId(id: string): string {
  return `…${id.slice(-4)}`;
}

export function telegramStatus() {
  return {
    enabled: Boolean(botToken && allowed.size),
    chats: [...allowed].map(maskChatId),
  };
}

/** Telegram's own refusal, with its error code kept so a 409 can be told apart. */
export class TelegramError extends Error {
  constructor(message: string, readonly code: number, readonly retryAfterS?: number) {
    super(message);
  }
}

/**
 * How long any ordinary request may take. The live log had a fetch with no
 * timeout at all: a half-open connection after the laptop woke could hang a
 * send for as long as the kernel cared to keep the socket.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A long poll holds the request open for `pollSeconds` by design, so its
 * timeout must outlast that or every quiet poll would be cut off and counted
 * as a failure.
 */
export function pollTimeoutMs(pollSeconds: number): number {
  return (pollSeconds + 15) * 1000;
}

async function api(token: string, method: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS) {
  const res = await io.fetch(`${API}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: io.timeout(timeoutMs),
  });
  // A proxy's HTML error page is not JSON; say what came back instead of
  // throwing a SyntaxError that names nothing.
  const json = (await res.json().catch(() => null)) as any;
  if (!json?.ok) {
    throw new TelegramError(
      json?.description || `${method}: HTTP ${res.status}`,
      Number(json?.error_code ?? res.status),
      json?.parameters?.retry_after,
    );
  }
  return json.result;
}

/** One short reason for the log: "fetch failed" alone does not say DNS or reset. */
function reason(err: any): string {
  const msg = String(err?.message ?? err);
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause && !msg.includes(String(cause)) ? `${msg} (${cause})` : msg;
}

/**
 * Telegram's 409: another getUpdates poller holds this bot token. A 409 also
 * comes back while a webhook is set, which is not a second claw; that one keeps
 * Telegram's own wording in the ordinary "polling down" line.
 */
export function isConflict(err: any): boolean {
  const msg = String(err?.message ?? "");
  if (/webhook/i.test(msg)) return false;
  return err?.code === 409 || /^Conflict\b/i.test(msg);
}

export const CONFLICT_LINE =
  "Telegram: Conflict (409) — a second copy of the claw is polling the same bot. " +
  "Telegram allows one poller per token; stop the other copy, or set telegram.enabled=false in its claw.config.json.";

export const POLL_BACKOFF_BASE_MS = 4000;
export const POLL_BACKOFF_CAP_MS = 5 * 60_000;

/** 4 s, 8 s, 16 s … to five minutes: the wait after the nth failure in a row. */
export function pollBackoffMs(failures: number): number {
  return Math.min(POLL_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), POLL_BACKOFF_CAP_MS);
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)} min`;
}

/**
 * Whether polling is up, and what to say about it — once per change, not per
 * failure. The live log had ~1,586 "fetch failed" lines, 1,082 of them on one
 * day, because the loop logged and retried every 4 s for as long as the network
 * was gone. The journal learnt nothing from line two onwards and lost
 * everything else in the noise.
 */
export class PollHealth {
  private failures = 0;
  private downSince = 0;
  private conflictSaid = false;

  constructor(private readonly now: () => number) {}

  /** Record a failed poll; returns how long to wait and the line to log, if any. */
  failed(err: unknown): { delayMs: number; line: string | null } {
    this.failures++;
    let line: string | null = null;
    if (isConflict(err)) {
      // Said once per outage even if the outage began as a network error: it
      // is the one failure the operator has to fix by hand.
      if (!this.conflictSaid) line = CONFLICT_LINE;
      this.conflictSaid = true;
    } else if (this.failures === 1) {
      line = `Telegram: polling down — ${reason(err)}. Retrying with backoff up to every ${duration(POLL_BACKOFF_CAP_MS)}; quiet until it recovers.`;
    }
    if (this.failures === 1) this.downSince = this.now();
    return { delayMs: pollBackoffMs(this.failures), line };
  }

  /** Record a good poll; returns the recovery line if polling had been down. */
  succeeded(): string | null {
    if (!this.failures) return null;
    const line = `Telegram: polling recovered after ${this.failures} failed attempt(s) over ${duration(this.now() - this.downSince)}.`;
    this.failures = 0;
    this.conflictSaid = false;
    return line;
  }
}

export interface PollDeps {
  getUpdates(offset: number): Promise<unknown>;
  handle(update: any): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
  /** Tests stop the loop; the claw never does. */
  running?(): boolean;
}

/**
 * The poll loop, with its network and timers injected.
 *
 * A poll failure and a handler failure are different things: the old loop
 * shared one try, so a reply that failed to send was logged as a poll error
 * and cost a 4 s sleep. Now only getUpdates itself counts towards the backoff,
 * and nothing in here can reject — a rejection escaping a `void`-ed loop is
 * how the live log came to hold an unhandled rejection from inside fetch.
 */
export async function pollLoop(d: PollDeps): Promise<void> {
  const health = new PollHealth(d.now);
  let offset = 0;
  while (d.running?.() ?? true) {
    let updates: unknown;
    try {
      updates = await d.getUpdates(offset);
    } catch (err) {
      const { delayMs, line } = health.failed(err);
      if (line) d.log(line);
      await d.sleep(delayMs);
      continue;
    }
    const recovered = health.succeeded();
    if (recovered) d.log(recovered);
    for (const upd of Array.isArray(updates) ? updates : []) {
      offset = Number(upd?.update_id) + 1 || offset;
      try {
        await d.handle(upd);
      } catch (err) {
        d.log(`Telegram: update handler error — ${reason(err)}`);
      }
    }
  }
}

/**
 * Everything this module says out loud, cleaned before it leaves the machine.
 *
 * server.ts pipes every SSE event through redactDeep and agent.ts redacts
 * before history.json is written — but Telegram imported no redaction at all,
 * so a shell command carrying a pasted key, or a file preview of .env, went to
 * api.telegram.org in clear while the HUD showed the same card redacted. This
 * is the one place every outbound message passes, so nothing added later has
 * to remember.
 *
 * Order matters: redact the whole text, THEN truncate. Truncating first leaves
 * a key that straddles the cut unmatched, and redact() can lengthen the string.
 */
export function outboundText(text: string): string {
  return redact(String(text ?? "")).slice(0, 3900);
}

/** The approval card's body, redacted before its own truncation for the same reason. */
export function approvalCardText(summary: string, detail: string): string {
  return `⚠ APPROVAL REQUIRED\n${redact(String(summary ?? ""))}\n\n${redact(String(detail ?? "")).slice(0, 2800)}`;
}

/**
 * The boot greeting. It is the butler announcing itself to its operator, not
 * the software naming itself, so a renamed claw (config.persona.name) must
 * greet under its own name. Read at call time, and exported, so the rename
 * test can prove it.
 */
export function onlineText(): string {
  return `${config.persona.name} online. HUD at http://${config.server.host}:${config.server.port}`;
}

async function send(chatId: string, text: string, extra?: Record<string, unknown>): Promise<any> {
  if (!botToken) return null;
  return api(botToken, "sendMessage", {
    chat_id: Number(chatId) || chatId,
    text: outboundText(text),
    ...extra,
  });
}

export const CARD_ATTEMPTS = 3;
export const CARD_RETRY_BASE_MS = 2000;

/**
 * A refusal that will be the same next time: a malformed card, a bot the
 * operator blocked, a chat that no longer exists. Network errors, timeouts,
 * 429 and 5xx are worth another go.
 */
function permanent(err: any): boolean {
  return err instanceof TelegramError && err.code >= 400 && err.code < 500 && err.code !== 429;
}

/**
 * Push a card to every allowlisted chat so the phone can authorise HUD-less turns.
 *
 * Three cards in the live log failed to send and were never retried, so a turn
 * that had gone to the phone for a verdict sat waiting for a button nobody had.
 * Now each chat gets a small bounded number of attempts with backoff, and stops
 * early once the request is settled elsewhere. A send that timed out may still
 * have been delivered, so a retry can occasionally leave two cards; both carry
 * working buttons, which beats none.
 */
export async function sendApprovalCard(id: string, summary: string, detail: string): Promise<void> {
  if (!botToken || !allowed.size) return;
  liveCards.add(id);
  const text = approvalCardText(summary, detail);
  for (const chatId of allowed) {
    for (let attempt = 1; liveCards.has(id); attempt++) {
      try {
        const msg = await send(chatId, text, {
          reply_markup: {
            inline_keyboard: [[
              { text: "EXECUTE", callback_data: `yes:${id}` },
              { text: "DENY", callback_data: `no:${id}` },
            ]],
          },
        });
        if (msg?.message_id) {
          approvalMsgs.set(id, { chatId, messageId: msg.message_id });
        }
        break;
      } catch (err: any) {
        if (attempt >= CARD_ATTEMPTS || permanent(err)) {
          io.log(`Telegram: approval card to ${maskChatId(chatId)} not sent after ${attempt} attempt(s) — ${reason(err)}`);
          break;
        }
        const wait = err?.retryAfterS
          ? Math.min(err.retryAfterS * 1000, 30_000)
          : CARD_RETRY_BASE_MS * 2 ** (attempt - 1);
        await io.sleep(wait);
      }
    }
  }
}

/** Strip buttons once HUD or Telegram settles the request. */
export function approvalSettled(id: string, approved: boolean): void {
  liveCards.delete(id);
  const ref = approvalMsgs.get(id);
  approvalMsgs.delete(id);
  if (!ref || !botToken) return;
  void api(botToken, "editMessageReplyMarkup", {
    chat_id: Number(ref.chatId) || ref.chatId,
    message_id: ref.messageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => { /* message may already be gone */ });
  // This `void send` had no catch: with the network down, the verdict line's
  // fetch rejected with nobody listening — the unhandled rejection in the log.
  void send(ref.chatId, approved ? "Authorised." : "Denied.").catch((err) =>
    io.log(`Telegram: verdict line not sent — ${reason(err)}`),
  );
}

/**
 * Setup-mode listener: replies to every message with the sender's chat id and
 * nothing else. It carries no tools, reads no instructions, and dies the
 * moment the real loop can start (after .env gains the id and a restart).
 */
async function bootstrapWhoamiLoop(token: string): Promise<void> {
  // The same loop as the real one, so the same backoff and the same once-only
  // logging: a claw left in setup mode on a laptop with no network would
  // otherwise spin every 5 s all day.
  await pollLoop({
    getUpdates: (offset) =>
      api(token, "getUpdates", { timeout: 50, offset, allowed_updates: ["message"] }, pollTimeoutMs(50)),
    handle: async (u) => {
      const chatId = u.message?.chat?.id;
      if (!chatId) return;
      await api(token, "sendMessage", {
        chat_id: chatId,
        text:
          `Your chat id is: ${chatId}\n\n` +
          `Ask the operator to put TELEGRAM_CHAT_ID=${chatId} in .env and restart Cunning Claw. ` +
          `Until then I take no instructions here.`,
      }).catch(() => {});
    },
    sleep: io.sleep,
    now: io.now,
    log: io.log,
  });
}

/**
 * Hold the token, allowlist and approval hook — and the network, so a test can
 * arm the module against a fake one without starting a poller. Pass a null
 * token to disarm.
 */
export function armTelegram(
  token: string | null,
  allow: Set<string>,
  resolve: ResolveApproval | null,
  withIO: TelegramIO = defaultIO,
): void {
  io = withIO;
  botToken = token;
  allowed = token ? allow : new Set();
  resolveApproval = token ? resolve : null;
  approvalMsgs.clear();
  liveCards.clear();
}

export function startTelegram(
  events: AgentEvents,
  hooks: { resolveApproval: ResolveApproval },
  withIO: TelegramIO = defaultIO,
): void {
  // The config switch must win over the env token: a second claw on the same
  // machine (the film studio, a QA stand-in) shares .env via the repo but must
  // not fight the live claw for the bot — Telegram allows one getUpdates
  // poller per token, so two claws polling means both go deaf.
  if (config.telegram?.enabled === false) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allow = process.env.TELEGRAM_CHAT_ID;
  if (!token) return;
  if (!allow) {
    // The old behaviour was a chicken-and-egg: no chat id -> no polling at
    // all -> the advertised /whoami could never be answered. Now a bootstrap
    // listener runs that does exactly one thing: tell whoever messages the
    // bot what their chat id is, so it can be put in .env. No instruction of
    // any kind is processed until the allowlist exists.
    console.warn("  ⚠ TELEGRAM_BOT_TOKEN set but TELEGRAM_CHAT_ID missing — commands disabled (safety).");
    console.warn("    Message the bot anything from your phone; it replies with the chat id for .env.");
    void bootstrapWhoamiLoop(token);
    return;
  }
  armTelegram(token, parseChatAllowlist(allow), hooks.resolveApproval, withIO);
  console.log(`  Telegram: polling (allow ${[...allowed].map(maskChatId).join(", ")})`);
  void send([...allowed][0], onlineText()).catch(() => {});
  void pollLoop({
    getUpdates: (offset) =>
      api(
        token,
        "getUpdates",
        { offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
        pollTimeoutMs(25),
      ),
    handle: async (upd) => {
      if (upd.callback_query) {
        await handleCallback(upd.callback_query);
        return;
      }
      // Do NOT await the turn inside the poll loop. A turn that parks on an
      // approval is released only by a callback_query (the EXECUTE button) —
      // which this same loop must stay free to fetch. Awaiting handleMessage
      // froze getUpdates until the approval timed out, so the button press
      // never arrived and every Telegram approval silently expired. Run the
      // turn alongside the poll; runTurn's own `busy` guard serialises them.
      void handleMessage(upd.message, events).catch((err) =>
        io.log(`Telegram: message handler error — ${reason(err)}`),
      );
    },
    sleep: io.sleep,
    now: io.now,
    log: io.log,
  });
}

export async function handleCallback(cb: any): Promise<void> {
  const data = String(cb.data ?? "");
  const chatId = String(cb.message?.chat?.id ?? "");
  // Field debugging left in on purpose: "the button does nothing" is only
  // diagnosable if button presses are visible in the journal at all. Masked,
  // because the journal reaches the glass and the full id is personal data.
  io.log(`Telegram callback: ${data.slice(0, 12)}… from ${maskChatId(chatId)} (allowed: ${allowed.has(chatId)})`);
  try {
    await api(botToken!, "answerCallbackQuery", { callback_query_id: cb.id });
  } catch { /* already answered */ }
  const m = /^(yes|no):(.+)$/.exec(data);
  if (!m || !allowed.has(chatId)) return;
  const approved = m[1] === "yes";
  const id = m[2];
  if (!resolveApproval?.(id, approved)) {
    await send(chatId, "That request has already been settled, sir.");
  }
}

async function handleMessage(msg: any, events: AgentEvents): Promise<void> {
  const chatId = String(msg?.chat?.id ?? "");
  const text = String(msg?.text ?? "").trim();
  if (!chatId || !text) return;

  // /whoami works from unknown chats so the operator can learn their id.
  if (text === "/whoami" || (text === "/start" && !allowed.has(chatId))) {
    await send(chatId, `Your Telegram chat id is ${chatId}. Put it in TELEGRAM_CHAT_ID and restart CUNNING CLAW.`);
    return;
  }

  if (!allowed.has(chatId)) {
    io.log(`Telegram ignored chat ${maskChatId(chatId)} (not in TELEGRAM_CHAT_ID)`);
    return;
  }

  if (text === "/start" || text === "/help") {
    await send(
      chatId,
      "Dragon Forge CUNNING CLAW.\n" +
        "/help — this\n" +
        "/status — machine + brains\n" +
        "/brain — list / pin a model (same tools)\n" +
        "/whoami — this chat id\n\n" +
        "Anything else is a turn. Risky tools still need EXECUTE on this chat or the HUD.",
    );
    return;
  }

  if (text === "/status") {
    const body = await systemStatusText();
    const brains = catalogStatus();
    const a = brains.active;
    await send(
      chatId,
      `Brain: ${a.id} / ${a.model} (${a.source}${a.ready ? "" : ", NO KEY"})\n` +
        `${formatCatalog()}\n\n${body}`,
    );
    return;
  }

  const brainReply = applyBrainCommand(text);
  if (brainReply !== null) {
    await send(chatId, brainReply);
    return;
  }

  const reply = await runTurn(text, events, { kind: "user" });
  if (reply === null) {
    await send(chatId, "Still working on the previous request, sir.");
    return;
  }
  if (reply.trim() && reply.trim() !== "HEARTBEAT_OK") {
    await send(chatId, reply);
  }
}
