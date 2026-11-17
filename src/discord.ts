/**
 * Discord — the second phone line.
 *
 * The same four jobs as telegram.ts: take a message from the operator, reply
 * to it, put an approval card where a thumb can press it, and settle the card.
 * Discord differs in one respect only: it pushes events over a WebSocket (the
 * Gateway) instead of being polled, so the loop here is a small state machine
 * rather than a getUpdates call. Node 22 ships WebSocket, so this costs no
 * dependency.
 *
 * Trust is the allowlist and nothing else. Messages from any other user are
 * dropped unread — not fenced, dropped — and a button press from anyone else
 * is answered privately and ignored. Everything outbound is redacted at the
 * one chokepoint, and the bot is forbidden from @-mentioning, so a hostile
 * page summarised into a reply cannot make it ping a server.
 *
 * A server channel is a room, not a person — the rule telegram.ts learnt for
 * groups. Approval cards used to go to the last channel the operator spoke
 * in, which could be a public server channel: the exact command and path in
 * front of everyone there, and the EXECUTE button beside it. Cards now go only
 * to a DM with each allowlisted user, a press counts only in a DM, and
 * anything sent into a server channel has the machine taken out of it.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, addressed, config } from "./config.js";
import { groupSafeText, redact } from "./redact.js";
import type { AgentEvents } from "./agent.js";
import { runTurn } from "./agent.js";
import { systemStatusText } from "./tools.js";
import { applyBrainCommand, catalogStatus, formatCatalog } from "./brain.js";

const API = "https://discord.com/api/v10";
/** Discord's hard cap on a message body. */
export const MESSAGE_LIMIT = 2000;
/** A reply longer than this many chunks is a wall, not a message. */
const MAX_CHUNKS = 4;

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES, and the privileged MESSAGE_CONTENT. */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

/**
 * Close codes after which reconnecting is pointless: the operator has to
 * change something. 4014 is the one a first-time setup actually hits.
 */
const FATAL_CLOSE: Record<number, string> = {
  4004: "the token was rejected — check DISCORD_BOT_TOKEN in .env",
  4010: "invalid shard — this bot does not shard; report this",
  4011: "Discord says this bot must shard, which means it is in too many servers for one connection",
  4012: "invalid gateway version — report this",
  4013: "invalid intents — report this",
  4014:
    "the MESSAGE CONTENT intent is not enabled for this bot — Developer Portal → your app → Bot → " +
    "Privileged Gateway Intents → Message Content, then restart",
};

type ResolveApproval = (id: string, approved: boolean) => boolean;

let botToken: string | null = null;
let allowed = new Set<string>();
let resolveApproval: ResolveApproval | null = null;
/** Each operator's DM channel, opened once with POST /users/@me/channels. */
const dmByUser = new Map<string, string>();
/**
 * Channels known to be DMs: ones we opened, or ones a message arrived in with
 * no guild. Anything else — including a channel never seen — is treated as a
 * room, because the safe mistake is masking a DM, not unmasking a server.
 */
const dmChannels = new Set<string>();
let gateway: Gateway | null = null;
let contentHintShown = false;
/** Every DM a card went to, so a press on one strips the buttons from the rest. */
const approvalMsgs = new Map<string, { channelId: string; messageId: string }[]>();
let fetchImpl: typeof fetch = (...args) => fetch(...args);

const VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version ?? "0");
  } catch {
    return "0";
  }
})();

export function parseUserAllowlist(raw: string): Set<string> {
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** Same rule as Telegram: a user id is personal, and the panel it lands on is filmed. */
export function maskUserId(id: string): string {
  return `…${id.slice(-4)}`;
}

export function discordStatus() {
  return {
    enabled: Boolean(botToken && allowed.size),
    users: [...allowed].map(maskUserId),
  };
}

// ── Outbound shapes (pure, tested) ─────────────────────────────────────────

/**
 * Redact, THEN split. Splitting first leaves a key straddling the cut
 * unmatched — the same ordering rule as telegram.ts. Splits fall on a newline
 * where one is near, so a code block or a list is not sliced mid-line.
 */
export function outboundChunks(text: string, limit = MESSAGE_LIMIT): string[] {
  const clean = redact(String(text ?? "")).trim();
  if (!clean) return [];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > limit && out.length < MAX_CHUNKS - 1) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > limit) rest = rest.slice(0, limit - 1) + "…";
  if (rest) out.push(rest);
  return out;
}

/**
 * What may be said in this channel: redacted everywhere, and outside a DM the
 * machine comes out too — home paths, the hostname, LAN addresses. Redacted
 * before the masking so a hostname inside a key cannot split it.
 */
export function channelText(text: string, dm: boolean, host?: string): string {
  const clean = redact(String(text ?? ""));
  return dm ? clean : groupSafeText(clean, host);
}

/** The card: a redacted summary, the detail in a code fence, two buttons. */
export function approvalCardPayload(id: string, summary: string, detail: string) {
  const head = redact(String(summary ?? "")).slice(0, 150);
  // A ``` inside the detail would close our fence and let the rest render as
  // markdown; three quotes read the same to a human and close nothing.
  const body = redact(String(detail ?? "")).replace(/```/g, "'''").slice(0, 1700);
  return {
    content: `⚠ **APPROVAL REQUIRED** — ${head}\n\`\`\`\n${body}\n\`\`\``,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: "EXECUTE", custom_id: `approve:${id}` },
          { type: 2, style: 4, label: "DENY", custom_id: `deny:${id}` },
        ],
      },
    ],
  };
}

/**
 * The boot greeting — the butler announcing itself to its operator, not the
 * software naming itself, so a renamed claw (config.persona.name) greets under
 * its own name. Same shape as Telegram's onlineText, deliberately: the phone
 * lines are siblings. Read at call time, and exported, so the rename test can
 * prove it.
 */
export function onlineText(): string {
  return `${config.persona.name} online. HUD at http://${config.server.host}:${config.server.port}`;
}

export interface Interaction {
  id: string;
  token: string;
  userId: string;
  channelId: string;
  /** Set when the button was pressed in a server channel rather than a DM. */
  guildId: string | null;
  messageContent: string;
  approvalId: string;
  approved: boolean;
}

/** A button press, or null for anything that is not one of our two buttons. */
export function parseInteraction(d: any): Interaction | null {
  if (!d || d.type !== 3) return null; // 3 = MESSAGE_COMPONENT
  const m = /^(approve|deny):(.+)$/.exec(String(d.data?.custom_id ?? ""));
  if (!m) return null;
  const userId = String(d.member?.user?.id ?? d.user?.id ?? "");
  if (!userId || !d.id || !d.token) return null;
  return {
    id: String(d.id),
    token: String(d.token),
    userId,
    channelId: String(d.channel_id ?? ""),
    guildId: d.guild_id ? String(d.guild_id) : null,
    messageContent: String(d.message?.content ?? ""),
    approvalId: m[2],
    approved: m[1] === "approve",
  };
}

export interface InboundMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  userId: string;
  bot: boolean;
  content: string;
}

// ── The Gateway (pure state machine, sockets and timers injected) ──────────

export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface GatewayDeps {
  connect(url: string): SocketLike;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log(line: string): void;
  onReady(): void;
  onMessage(msg: InboundMessage): void;
  onInteraction(i: Interaction): void;
  onFatal(reason: string): void;
}

export class Gateway {
  private sock: SocketLike | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private heartbeat: unknown = null;
  private reconnect: unknown = null;
  private acked = true;
  private attempts = 0;
  private stopped = false;

  constructor(private readonly token: string, private readonly url: string, private readonly deps: GatewayDeps) {}

  start(): void {
    this.open(this.url);
  }

  stop(): void {
    this.stopped = true;
    this.deps.clearTimer(this.heartbeat);
    this.deps.clearTimer(this.reconnect);
    this.sock?.close(1000);
  }

  private open(base: string): void {
    const sock = this.deps.connect(`${base}${base.includes("?") ? "&" : "?"}v=10&encoding=json`);
    this.sock = sock;
    sock.onopen = () => {};
    sock.onmessage = (ev) => this.receive(String(ev.data));
    sock.onclose = (ev) => this.closed(Number(ev.code));
    sock.onerror = () => { /* the close that follows carries the code */ };
  }

  private send(op: number, d: unknown): void {
    this.sock?.send(JSON.stringify({ op, d }));
  }

  private receive(raw: string): void {
    let f: any;
    try { f = JSON.parse(raw); } catch { return; }
    if (typeof f.s === "number") this.seq = f.s;
    switch (f.op) {
      case OP.HELLO:
        this.startHeartbeat(Number(f.d?.heartbeat_interval) || 41_250);
        if (this.sessionId) this.send(OP.RESUME, { token: this.token, session_id: this.sessionId, seq: this.seq });
        else this.identify();
        break;
      case OP.HEARTBEAT:
        this.send(OP.HEARTBEAT, this.seq);
        break;
      case OP.HEARTBEAT_ACK:
        this.acked = true;
        break;
      case OP.RECONNECT:
        this.deps.log("Discord asked for a reconnect");
        this.sock?.close(4000);
        break;
      case OP.INVALID_SESSION:
        if (!f.d) { this.sessionId = null; this.resumeUrl = null; }
        this.sock?.close(4000);
        break;
      case OP.DISPATCH:
        this.dispatch(String(f.t ?? ""), f.d);
        break;
    }
  }

  private identify(): void {
    this.send(OP.IDENTIFY, {
      token: this.token,
      intents: INTENTS,
      properties: { os: process.platform, browser: "cunningclaw", device: "cunningclaw" },
    });
  }

  private startHeartbeat(interval: number): void {
    this.deps.clearTimer(this.heartbeat);
    this.acked = true;
    const beat = () => {
      if (!this.acked) {
        // A socket that stopped answering is a zombie; Discord's own advice is
        // to close it and resume rather than wait for the OS to notice.
        this.deps.log("Discord heartbeat went unanswered — reconnecting");
        this.sock?.close(4000);
        return;
      }
      this.acked = false;
      this.send(OP.HEARTBEAT, this.seq);
      this.heartbeat = this.deps.setTimer(beat, interval);
    };
    // The first beat is jittered, per the protocol, so a fleet of bots
    // restarting together does not all beat in the same millisecond.
    this.heartbeat = this.deps.setTimer(beat, Math.floor(interval * Math.random()));
  }

  private dispatch(t: string, d: any): void {
    switch (t) {
      case "READY":
        this.sessionId = String(d?.session_id ?? "");
        this.resumeUrl = d?.resume_gateway_url ? String(d.resume_gateway_url) : null;
        this.attempts = 0;
        this.deps.onReady();
        break;
      case "RESUMED":
        this.attempts = 0;
        this.deps.log("Discord session resumed");
        break;
      case "MESSAGE_CREATE":
        this.deps.onMessage({
          id: String(d?.id ?? ""),
          channelId: String(d?.channel_id ?? ""),
          guildId: d?.guild_id ? String(d.guild_id) : null,
          userId: String(d?.author?.id ?? ""),
          bot: Boolean(d?.author?.bot),
          content: String(d?.content ?? ""),
        });
        break;
      case "INTERACTION_CREATE": {
        const i = parseInteraction(d);
        if (i) this.deps.onInteraction(i);
        break;
      }
    }
  }

  private closed(code: number): void {
    this.deps.clearTimer(this.heartbeat);
    this.sock = null;
    if (this.stopped) return;
    const fatal = FATAL_CLOSE[code];
    if (fatal) {
      this.deps.onFatal(fatal);
      return;
    }
    // 4007 (bad sequence) and 4009 (session timed out) cannot be resumed.
    if (code === 4007 || code === 4009) { this.sessionId = null; this.resumeUrl = null; }
    const delay = Math.min(1000 * 2 ** this.attempts, 60_000);
    this.attempts++;
    this.deps.log(`Discord gateway closed (${code}) — reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnect = this.deps.setTimer(
      () => this.open(this.sessionId && this.resumeUrl ? this.resumeUrl : this.url),
      delay,
    );
  }
}

// ── REST ───────────────────────────────────────────────────────────────────

/** An interaction token lives in the path; keep it out of error text. */
function safePath(p: string): string {
  return p.replace(/\/interactions\/[^/]+\/[^/]+\//, "/interactions/…/…/");
}

async function rest(method: string, p: string, body?: unknown, retried = false): Promise<any> {
  const res = await fetchImpl(`${API}${p}`, {
    method,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      "User-Agent": `DiscordBot (https://github.com/Dragon-Forge-master/cunning-claw, ${VERSION})`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && !retried) {
    const j = await res.json().catch(() => ({}));
    const wait = Math.min((Number((j as any)?.retry_after) || 1) * 1000, 10_000);
    await new Promise((r) => setTimeout(r, wait));
    return rest(method, p, body, true);
  }
  if (!res.ok) {
    throw new Error(`Discord ${res.status} on ${method} ${safePath(p)}: ${(await res.text()).slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Every message this module sends leaves through here: redacted, chunked,
 * mention-proof — and, unless the channel is a known DM, with home paths, the
 * hostname and LAN addresses taken out first, as Telegram does for a group.
 */
async function send(channelId: string, text: string): Promise<any> {
  if (!botToken) return null;
  let last: any = null;
  for (const content of outboundChunks(channelText(text, dmChannels.has(channelId)))) {
    last = await rest("POST", `/channels/${channelId}/messages`, { content, allowed_mentions: { parse: [] } });
  }
  return last;
}

/** The operator's DM channel, opened on first use. A user id, never a server channel. */
async function dmChannel(userId: string): Promise<string | null> {
  const known = dmByUser.get(userId);
  if (known) return known;
  const ch = await rest("POST", "/users/@me/channels", { recipient_id: userId });
  const id = ch?.id ? String(ch.id) : "";
  if (!id) return null;
  dmByUser.set(userId, id);
  dmChannels.add(id);
  return id;
}

export async function sendApprovalCard(id: string, summary: string, detail: string): Promise<void> {
  if (!botToken || !allowed.size) return;
  // Cards go to each operator's DM and nowhere else — never the channel they
  // last spoke in. A card in a server channel shows strangers the command and
  // the path, and puts EXECUTE in front of all of them.
  const refs: { channelId: string; messageId: string }[] = [];
  for (const userId of allowed) {
    try {
      const channel = await dmChannel(userId);
      if (!channel) continue;
      const msg = await rest("POST", `/channels/${channel}/messages`, {
        ...approvalCardPayload(id, summary, detail),
        allowed_mentions: { parse: [] },
      });
      if (msg?.id) refs.push({ channelId: channel, messageId: String(msg.id) });
    } catch (err: any) {
      console.error(`  Discord approval card to ${maskUserId(userId)} not sent:`, err?.message ?? err);
    }
  }
  if (refs.length) approvalMsgs.set(id, refs);
}

/** Strip the buttons once the HUD, Telegram or Discord has settled it. */
export function approvalSettled(id: string, approved: boolean): void {
  const refs = approvalMsgs.get(id);
  approvalMsgs.delete(id);
  if (!refs || !botToken) return;
  for (const ref of refs) {
    void rest("PATCH", `/channels/${ref.channelId}/messages/${ref.messageId}`, { components: [] }).catch(() => {});
    void send(ref.channelId, approved ? "Authorised." : "Denied.").catch(() => {});
  }
}

// ── Inbound ────────────────────────────────────────────────────────────────

export async function handleInteraction(i: Interaction): Promise<void> {
  const callback = `/interactions/${i.id}/${i.token}/callback`;
  if (!allowed.has(i.userId)) {
    // 4 = reply; flags 64 = only they see it. Nothing is settled.
    await rest("POST", callback, { type: 4, data: { content: "That button is not yours to press.", flags: 64 } }).catch(() => {});
    return;
  }
  if (i.guildId) {
    // No card is ever sent to a server channel, so a press from one is a stale
    // card or a forged one. Even from the operator, a room is not the place.
    await rest("POST", callback, {
      type: 4,
      data: { content: "Approvals are settled in a DM with me, not in a server channel.", flags: 64 },
    }).catch(() => {});
    return;
  }
  // The card is consumed here so approvalSettled does not send a second line;
  // the copies in any other operator's DM lose their buttons.
  const refs = approvalMsgs.get(i.approvalId) ?? [];
  approvalMsgs.delete(i.approvalId);
  for (const ref of refs) {
    if (ref.channelId === i.channelId) continue;
    void rest("PATCH", `/channels/${ref.channelId}/messages/${ref.messageId}`, { components: [] }).catch(() => {});
  }
  const settled = resolveApproval?.(i.approvalId, i.approved) ?? false;
  const line = settled ? (i.approved ? "▸ Authorised." : "▸ Denied.") : "▸ That request had already been settled.";
  // 7 = update the message the button was on: buttons gone, verdict appended.
  await rest("POST", callback, {
    type: 7,
    data: { content: `${i.messageContent}\n${line}`.slice(0, MESSAGE_LIMIT), components: [] },
  }).catch((err: any) => console.error("  Discord interaction reply failed:", err?.message ?? err));
}

export async function handleMessage(m: InboundMessage, events: AgentEvents): Promise<void> {
  if (m.bot || !m.channelId || !m.userId) return;
  if (!m.guildId) dmChannels.add(m.channelId);
  const text = m.content.trim();

  if (!text) {
    // A guild message with no content means the privileged intent is off;
    // a DM always carries content. Say so once, since the bot otherwise looks deaf.
    if (m.guildId && allowed.has(m.userId) && !contentHintShown) {
      contentHintShown = true;
      console.warn("  ⚠ Discord delivered a message with no content — enable the Message Content intent in the Developer Portal.");
    }
    return;
  }

  if (!allowed.size) {
    // Bootstrap mode, as Telegram's: answer with the id and nothing else.
    await send(m.channelId, `Your Discord user id is ${m.userId}. Ask the operator to put DISCORD_ALLOWED_USER_ID=${m.userId} in .env and restart Cunning Claw. Until then I take no instructions here.`);
    return;
  }

  if (text === "/whoami") {
    await send(m.channelId, `Your Discord user id is ${m.userId}.${allowed.has(m.userId) ? "" : " Put it in DISCORD_ALLOWED_USER_ID and restart CUNNING CLAW."}`);
    return;
  }

  if (!allowed.has(m.userId)) {
    console.warn(`  Discord ignored user ${maskUserId(m.userId)} (not in DISCORD_ALLOWED_USER_ID)`);
    return;
  }

  if (text === "/start" || text === "/help") {
    await send(
      m.channelId,
      "Dragon Forge CUNNING CLAW.\n" +
        "/help — this\n" +
        "/status — machine + brains\n" +
        "/brain — list / pin a model (same tools)\n" +
        "/whoami — your user id\n\n" +
        "Anything else is a turn. Risky tools still need EXECUTE here or on the HUD.",
    );
    return;
  }

  if (text === "/status") {
    if (m.guildId) {
      await send(m.channelId, `I don't share machine details in a server channel, ${addressed()}. Ask me for /status in a DM.`);
      return;
    }
    const body = await systemStatusText();
    const a = catalogStatus().active;
    await send(
      m.channelId,
      `Brain: ${a.id} / ${a.model} (${a.source}${a.ready ? "" : ", NO KEY"})\n${formatCatalog()}\n\n${body}`,
    );
    return;
  }

  const brainReply = applyBrainCommand(text);
  if (brainReply !== null) {
    await send(m.channelId, brainReply);
    return;
  }

  void rest("POST", `/channels/${m.channelId}/typing`).catch(() => {});
  const reply = await runTurn(text, events, { kind: "user" });
  if (reply === null) {
    await send(m.channelId, `Still working on the previous request, ${addressed()}.`);
    return;
  }
  if (reply.trim() && reply.trim() !== "HEARTBEAT_OK") await send(m.channelId, reply);
}

// ── Boot ───────────────────────────────────────────────────────────────────

export function startDiscord(events: AgentEvents, hooks: { resolveApproval: ResolveApproval }): void {
  // Config switch beats env token — see startTelegram: a second claw sharing
  // .env must be able to decline the bot without editing secrets.
  if (config.discord?.enabled === false) return;
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) return;
  armDiscord(token, parseUserAllowlist(process.env.DISCORD_ALLOWED_USER_ID ?? ""), hooks.resolveApproval);
  if (!allowed.size) {
    console.warn("  ⚠ DISCORD_BOT_TOKEN set but DISCORD_ALLOWED_USER_ID missing — commands disabled (safety).");
    console.warn("    Message the bot anything; it replies with your user id for .env.");
  }
  void connect(events);
}

/**
 * Hold the token, allowlist and approval hook — and the network, so a test can
 * arm the module against a fake fetch without opening a Gateway. Pass a null
 * token to disarm. Telegram's armTelegram is the sibling.
 */
export function armDiscord(
  token: string | null,
  allow: Set<string>,
  resolve: ResolveApproval | null,
  withFetch: typeof fetch = (...args) => fetch(...args),
): void {
  fetchImpl = withFetch;
  botToken = token;
  allowed = token ? allow : new Set();
  resolveApproval = token ? resolve : null;
  approvalMsgs.clear();
  dmByUser.clear();
  dmChannels.clear();
}

async function connect(events: AgentEvents): Promise<void> {
  let url: string;
  try {
    url = String((await rest("GET", "/gateway/bot"))?.url ?? "");
    if (!url) throw new Error("no gateway url in the response");
  } catch (err: any) {
    console.error(`  ✗ Discord: could not reach the gateway — ${err?.message ?? err}`);
    return;
  }
  gateway = new Gateway(botToken!, url, {
    connect: (u) => new WebSocket(u) as unknown as SocketLike,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => { if (h) clearTimeout(h as NodeJS.Timeout); },
    log: (line) => console.log(`  ${line}`),
    onReady: () => {
      console.log(`  Discord: connected (allow ${[...allowed].map(maskUserId).join(", ") || "nobody yet"})`);
      // The greeting names the HUD's address, so it goes to a DM, as Telegram's
      // goes to a private chat — never to a server channel.
      const first = [...allowed][0];
      if (first) {
        void dmChannel(first).then((ch) => ch && send(ch, onlineText())).catch(() => {});
      }
    },
    onMessage: (m) => void handleMessage(m, events).catch((err) =>
      console.error("  Discord message handler error:", err?.message ?? err),
    ),
    onInteraction: (i) => void handleInteraction(i),
    onFatal: (reason) => console.error(`  ✗ Discord: ${reason}`),
  });
  gateway.start();
}

export function stopDiscord(): void {
  gateway?.stop();
  gateway = null;
}
