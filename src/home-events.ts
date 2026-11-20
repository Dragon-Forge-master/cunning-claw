import { config, type HomeWatchRule } from "./config.js";
import { haCameraStill } from "./http.js";
import { appendEntry, cleanCaption, cleanLabel, DEFAULT_RETENTION_DAYS, prune, saveStill, stamp } from "./visitor-log.js";

/**
 * Hearing the house: Home Assistant's WebSocket API, watched for the few
 * changes the operator asked about — the doorbell, a motion sensor, a door, a
 * person arriving or leaving — and told to them on the HUD and the phone.
 *
 * Ring has no third-party API of its own; Home Assistant's Ring integration is
 * the route, and it surfaces the doorbell as an event.* entity (a ding or a
 * motion) and the camera as a camera.* entity. So nothing here knows about
 * Ring: it knows about entities, which also means any other doorbell HA
 * understands works the same way.
 *
 * Events are information, never instructions. Nothing in this file calls
 * runTurn or a tool. The doorbell ringing does not unlock anything, does not
 * turn a light on, does not start a conversation that could; what the house
 * does about an event is the operator's standing orders, written as HA
 * automations or SCHEDULE.md lines, not something an event can ask for.
 *
 * The pieces, each with its own seam for the tests:
 *   HaLink      the socket: auth, subscribe, ping, reconnect with backoff
 *               (sockets and timers injected, as discord.ts's Gateway is)
 *   eventKind   what a state change means: pressed, motion, opened, arrived, left
 *   matchRule   which configured rule, if any, it answers
 *   HomeWatch   debounce, quiet hours, the still, the caption, the log, the alerts
 */

// ── The socket ─────────────────────────────────────────────────────────────

export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface StateChange {
  entity_id: string;
  old_state: { state: string; attributes?: Record<string, any> } | null;
  new_state: { state: string; attributes?: Record<string, any> } | null;
}

export interface LinkDeps {
  connect(url: string): SocketLike;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log(line: string): void;
  onChange(change: StateChange): void;
}

/**
 * Where the link is. Shown on the HUD and by the doctor, and non-volatile on
 * purpose: no attempt counts, no "since" times (see coherence.ts).
 */
export type LinkState = "off" | "connecting" | "authenticating" | "subscribing" | "live" | "reconnecting" | "token rejected" | "stopped";

export const PING_INTERVAL_MS = 30_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 5 * 60_000;

/** 2 s, 4 s, 8 s … five minutes at most: an HA reboot is a minute, a dead router is longer. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts), BACKOFF_CAP_MS);
}

/** http://ha.local:8123 → ws://ha.local:8123/api/websocket. Nothing else is accepted. */
export function websocketUrl(baseUrl: string): string | null {
  try {
    const u = new URL(String(baseUrl ?? ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}${path}/api/websocket`;
  } catch {
    return null;
  }
}

export class HaLink {
  state: LinkState = "off";
  private sock: SocketLike | null = null;
  private nextId = 1;
  private subId = 0;
  private pingId = 0;
  private acked = true;
  private attempts = 0;
  private pingTimer: unknown = null;
  private retryTimer: unknown = null;

  constructor(private readonly url: string, private readonly token: string, private readonly deps: LinkDeps) {}

  start(): void {
    this.open();
  }

  stop(): void {
    this.state = "stopped";
    this.deps.clearTimer(this.pingTimer);
    this.deps.clearTimer(this.retryTimer);
    this.sock?.close(1000);
    this.sock = null;
  }

  private open(): void {
    this.state = "connecting";
    let sock: SocketLike;
    try {
      sock = this.deps.connect(this.url);
    } catch (err: any) {
      this.deps.log(`Home Assistant: could not open the socket — ${err?.message ?? err}`);
      this.retry();
      return;
    }
    this.sock = sock;
    sock.onopen = () => {};
    sock.onmessage = (ev) => this.receive(String(ev.data));
    sock.onclose = (ev) => this.closed(sock, Number(ev?.code));
    sock.onerror = () => { /* the close that follows is what we act on */ };
  }

  private send(msg: Record<string, unknown>): void {
    this.sock?.send(JSON.stringify(msg));
  }

  private receive(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    // HA may batch messages into an array.
    for (const msg of Array.isArray(m) ? m : [m]) this.handle(msg);
  }

  private handle(m: any): void {
    switch (m?.type) {
      case "auth_required":
        this.state = "authenticating";
        this.send({ type: "auth", access_token: this.token });
        break;
      case "auth_ok":
        this.state = "subscribing";
        this.subId = this.nextId++;
        // Every state change, filtered here rather than by HA: subscribe_trigger
        // cannot take a wildcard like person.*, and one subscription is one
        // thing to resubscribe after a reconnect.
        this.send({ id: this.subId, type: "subscribe_events", event_type: "state_changed" });
        break;
      case "auth_invalid":
        // Retrying a rejected token is a loop that gets the claw's address
        // banned (HA's ip_ban after repeated failed logins). Stop and say so.
        this.state = "token rejected";
        this.deps.log(`Home Assistant rejected the token — make a new long-lived access token and put it in .env as ${config.homeAssistant.tokenEnv}`);
        this.deps.clearTimer(this.pingTimer);
        this.sock?.close(1000);
        break;
      case "result":
        if (m.id !== this.subId) break;
        if (m.success) {
          this.state = "live";
          this.attempts = 0;
          this.startPing();
        } else {
          this.deps.log(`Home Assistant refused the subscription — ${String(m.error?.message ?? "no reason given").slice(0, 120)}`);
          this.sock?.close(4000);
        }
        break;
      case "event":
        if (m.id === this.subId && m.event?.event_type === "state_changed" && m.event?.data?.entity_id) {
          this.deps.onChange(m.event.data as StateChange);
        }
        break;
      case "pong":
        if (m.id === this.pingId) this.acked = true;
        break;
    }
  }

  private startPing(): void {
    this.deps.clearTimer(this.pingTimer);
    this.acked = true;
    const beat = () => {
      if (!this.acked) {
        // A laptop that slept, or Wi-Fi that dropped, leaves a socket that
        // looks open and hears nothing. A missed pong is the only way to know.
        this.deps.log("Home Assistant stopped answering pings — reconnecting");
        this.sock?.close(4000);
        return;
      }
      this.acked = false;
      this.pingId = this.nextId++;
      this.send({ id: this.pingId, type: "ping" });
      this.pingTimer = this.deps.setTimer(beat, PING_INTERVAL_MS);
    };
    this.pingTimer = this.deps.setTimer(beat, PING_INTERVAL_MS);
  }

  private closed(sock: SocketLike, code: number): void {
    // A close from a socket we already replaced is history, not news.
    if (sock !== this.sock) return;
    this.sock = null;
    this.deps.clearTimer(this.pingTimer);
    if (this.state === "stopped" || this.state === "token rejected") return;
    this.deps.log(`Home Assistant socket closed (${Number.isFinite(code) ? code : "?"}) — reconnecting in ${Math.round(backoffMs(this.attempts) / 1000)}s`);
    this.retry();
  }

  private retry(): void {
    this.state = "reconnecting";
    const wait = backoffMs(this.attempts);
    this.attempts++;
    this.retryTimer = this.deps.setTimer(() => this.open(), wait);
  }
}

// ── What a change means ────────────────────────────────────────────────────

export type EventKind = "pressed" | "motion" | "opened" | "arrived" | "left";
const KINDS: EventKind[] = ["pressed", "motion", "opened", "arrived", "left"];

const GONE = new Set(["unavailable", "unknown", ""]);
const MOTION_CLASSES = new Set(["motion", "occupancy", "presence"]);

/**
 * One state change, read as one of five things, or nothing.
 *
 * The rules lean towards silence on the boundary cases, because a false
 * doorbell at 3 a.m. costs more than a missed one costs a log line: an entity
 * coming back from "unavailable" (HA restarted, the Ring cloud blinked) is not
 * a press, and an attribute changing under an unchanged state is not an event.
 */
export function eventKind(change: StateChange): EventKind | null {
  const id = String(change?.entity_id ?? "");
  const domain = id.split(".")[0];
  const before = change?.old_state?.state;
  const after = change?.new_state?.state;
  if (after === undefined || GONE.has(after)) return null;
  if (before === after) return null;
  const attrs = change.new_state?.attributes ?? {};

  if (domain === "event") {
    // An event entity's state is the time of its last event. From
    // "unavailable" it is HA restoring the last one, not a new one.
    if (!change.old_state || before === "unavailable") return null;
    const type = String(attrs.event_type ?? "").toLowerCase();
    return /motion/.test(type) || /_motion$/.test(id) ? "motion" : "pressed";
  }
  if (domain === "binary_sensor") {
    if (before !== "off" || after !== "on") return null;
    const cls = String(attrs.device_class ?? "");
    if (MOTION_CLASSES.has(cls) || /motion|occupancy|presence/.test(id)) return "motion";
    // Ring's older integration exposed the button as binary_sensor.*_ding.
    if (/_ding$/.test(id)) return "pressed";
    return "opened";
  }
  if (domain === "cover") {
    return (before === "closed" || before === "closing") && (after === "open" || after === "opening") ? "opened" : null;
  }
  if (domain === "lock") {
    return before === "locked" && (after === "unlocked" || after === "open" || after === "opening") ? "opened" : null;
  }
  if (domain === "person" || domain === "device_tracker") {
    if (before === undefined || GONE.has(before)) return null;
    if (after === "home") return "arrived";
    if (before === "home") return "left";
    return null;
  }
  return null;
}

/** "person.*" matches any person; anything else is an exact entity id. */
export function entityMatches(pattern: string, entityId: string): boolean {
  const p = String(pattern ?? "").trim().toLowerCase();
  if (p.endsWith("*")) return entityId.startsWith(p.slice(0, -1));
  return p === entityId;
}

export interface Rule {
  entity: string;
  on: EventKind | null;
  notify: "phone" | "hud" | "both";
  snapshot: string | null;
  quiet: { from: number; to: number } | null;
  debounceMs: number;
}

/** "23:00-07:00" → minutes past midnight. A range may cross midnight. */
export function parseQuiet(raw: string | undefined): { from: number; to: number } | null {
  const m = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  return { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]) };
}

export function inQuiet(q: { from: number; to: number } | null, at: Date): boolean {
  if (!q || q.from === q.to) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return q.from < q.to ? now >= q.from && now < q.to : now >= q.from || now < q.to;
}

export const DEFAULT_DEBOUNCE_MINUTES = 5;

/**
 * The operator's rules, checked once. A rule that cannot work is reported by
 * name in the status rather than silently watching nothing.
 */
export function parseRules(raw: HomeWatchRule[] | undefined, debounceMinutes = DEFAULT_DEBOUNCE_MINUTES): { rules: Rule[]; ignored: string[] } {
  const rules: Rule[] = [];
  const ignored: string[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const entity = String(r?.entity ?? "").trim().toLowerCase();
    if (!/^[a-z_]+\.([a-z0-9_]+|[a-z0-9_]*\*)$/.test(entity)) { ignored.push(`${entity || "(no entity)"}: not an entity id or prefix*`); continue; }
    if (r.on !== undefined && !KINDS.includes(r.on)) { ignored.push(`${entity}: on must be one of ${KINDS.join(", ")}`); continue; }
    if (r.notify !== undefined && !["phone", "hud", "both"].includes(r.notify)) { ignored.push(`${entity}: notify must be phone, hud or both`); continue; }
    const snapshot = r.snapshot ? String(r.snapshot).trim().toLowerCase() : null;
    if (snapshot && !/^camera\.[a-z0-9_]+$/.test(snapshot)) { ignored.push(`${entity}: snapshot must be a camera.* entity`); continue; }
    const quiet = r.quiet ? parseQuiet(r.quiet) : null;
    if (r.quiet && !quiet) { ignored.push(`${entity}: quiet must look like 23:00-07:00`); continue; }
    const minutes = Number(r.debounceMinutes ?? debounceMinutes);
    rules.push({
      entity,
      on: r.on ?? null,
      notify: r.notify ?? "both",
      snapshot,
      quiet,
      debounceMs: Math.max(0, Number.isFinite(minutes) ? minutes : DEFAULT_DEBOUNCE_MINUTES) * 60_000,
    });
  }
  return { rules, ignored };
}

/** The first rule this change answers, and what it was. */
export function matchRule(rules: Rule[], change: StateChange): { rule: Rule; kind: EventKind } | null {
  const kind = eventKind(change);
  if (!kind) return null;
  for (const rule of rules) {
    if (!entityMatches(rule.entity, change.entity_id)) continue;
    if (rule.on && rule.on !== kind) continue;
    return { rule, kind };
  }
  return null;
}

const SAYS: Record<EventKind, string> = {
  pressed: "doorbell pressed",
  motion: "motion",
  opened: "opened",
  arrived: "arrived home",
  left: "left home",
};

/** "Front door — doorbell pressed". Built from our words and HA's name for the thing. */
export function headline(change: StateChange, kind: EventKind): string {
  const name = cleanLabel(String(change.new_state?.attributes?.friendly_name ?? "")) || change.entity_id;
  return `${name} — ${SAYS[kind]}`;
}

// ── The watcher ────────────────────────────────────────────────────────────

/** A push to the operator; resolves however it went, never rejects. */
export type Alert = (text: string) => Promise<unknown>;

export interface WatchDeps {
  now(): Date;
  /** The HUD (broadcast in server.ts: redacted there). */
  emit(event: string, data: unknown): void;
  /** Telegram and Discord: private chats only, text only. */
  phone: Alert[];
  /** ntfy: text only, and never the caption or the still (see below). */
  push: Alert;
  /** One still from a camera entity. */
  still(entityId: string): Promise<{ ok: true; bytes: Buffer; mediaType: "image/jpeg" | "image/png" } | { ok: false; error: string }>;
  /** Only present when the operator set describeVisitors: true. */
  describe?: (bytes: Buffer, mediaType: "image/jpeg" | "image/png") => Promise<string>;
  saveStill(bytes: Buffer, mediaType: "image/jpeg" | "image/png", at: Date, entityId: string): string;
  log(entry: { at: Date; what: string; snapshot?: string; caption?: string }): void;
  warn(line: string): void;
}

export interface HomeEvent {
  entity: string;
  kind: EventKind;
  what: string;
  at: string;
  snapshot?: string;
  caption?: string;
  quiet: boolean;
}

export class HomeWatch {
  private last = new Map<string, number>();

  constructor(private readonly rules: Rule[], private readonly deps: WatchDeps) {}

  /** Returns what was told, or null when the change was not news (tests read it). */
  async handle(change: StateChange): Promise<HomeEvent | null> {
    const hit = matchRule(this.rules, change);
    if (!hit) return null;
    const { rule, kind } = hit;
    const at = this.deps.now();

    // One alert per entity per window. A PIR sensor in a draughty porch flips
    // every few seconds; the first is news and the rest are the same news.
    const prev = this.last.get(change.entity_id);
    if (prev !== undefined && at.getTime() - prev < rule.debounceMs) return null;
    this.last.set(change.entity_id, at.getTime());

    const what = headline(change, kind);
    const event: HomeEvent = { entity: change.entity_id, kind, what, at: stamp(at), quiet: inQuiet(rule.quiet, at) };

    if (rule.snapshot) {
      const still = await this.deps.still(rule.snapshot);
      if (still.ok) {
        try {
          event.snapshot = this.deps.saveStill(still.bytes, still.mediaType, at, rule.snapshot);
        } catch (err: any) {
          this.deps.warn(`Home: could not save the still — ${err?.message ?? err}`);
        }
        if (this.deps.describe) {
          try {
            event.caption = cleanCaption(await this.deps.describe(still.bytes, still.mediaType)) || undefined;
          } catch (err: any) {
            this.deps.warn(`Home: no caption — ${String(err?.message ?? err).slice(0, 120)}`);
          }
        }
      } else {
        this.deps.warn(`Home: no still from ${rule.snapshot} — ${still.error}`);
      }
    }

    // The log first: if every phone line is down the event still happened.
    this.deps.log({ at, what, snapshot: event.snapshot, caption: event.caption });

    if (rule.notify !== "phone") {
      this.deps.emit("home_event", event);
    }
    if (rule.notify !== "hud" && !event.quiet) {
      const time = event.at.slice(11);
      const lines = [`${what} at ${time}.`];
      if (event.snapshot) lines.push("A still is saved on the claw's machine (visitor log on the Desk).");
      // Telegram and Discord are the operator's own private chats; the caption
      // is labelled for what it is, a guess about a stranger's image.
      const rich = event.caption ? [...lines, `Camera caption (automatic, may be wrong): ${event.caption}`] : lines;
      for (const send of this.deps.phone) void send(rich.join("\n")).catch(() => {});
      // ntfy is not the operator's server: on public ntfy.sh a topic is read by
      // whoever guesses its name. Text only — never the still — and not the
      // caption either, which describes a person who agreed to none of this.
      void this.deps.push(lines.join("\n")).catch(() => {});
    }
    return event;
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

let link: HaLink | null = null;
let ruleCount = 0;
let ignoredRules: string[] = [];
let off: string | null = "not started";

/** For /api/status and the doctor. Non-volatile: states and settings only. */
export function homeWatchStatus() {
  return {
    enabled: Boolean(link),
    link: link?.state ?? "off",
    why: link ? null : off,
    rules: ruleCount,
    ignored: ignoredRules,
    describeVisitors: config.homeAssistant.describeVisitors === true,
    retentionDays: Number(config.homeAssistant.visitorRetentionDays ?? DEFAULT_RETENTION_DAYS),
  };
}

export interface StartHooks {
  phone: Alert[];
  push: Alert;
  describe?: (bytes: Buffer, mediaType: "image/jpeg" | "image/png") => Promise<string>;
  /** Tests pass a fake socket factory; the default is Node 22's own WebSocket. */
  connect?: (url: string) => SocketLike;
}

const DAY_MS = 86_400_000;

export function startHomeWatch(events: { emit(event: string, data: unknown): void }, hooks: StartHooks): void {
  const ha = config.homeAssistant;
  const parsed = parseRules(ha.watch, Number(ha.debounceMinutes ?? DEFAULT_DEBOUNCE_MINUTES));
  ruleCount = parsed.rules.length;
  ignoredRules = parsed.ignored;
  for (const why of parsed.ignored) console.warn(`  ⚠ homeAssistant.watch: ignoring ${why}`);
  if (!ha.enabled) { off = "homeAssistant.enabled is false"; return; }
  if (!parsed.rules.length) { off = "no watch rules"; return; }
  const token = process.env[ha.tokenEnv]?.trim();
  if (!token) { off = `no ${ha.tokenEnv} in .env`; return; }
  const url = websocketUrl(ha.baseUrl);
  if (!url) { off = "homeAssistant.baseUrl is not an http(s) URL"; return; }

  const retentionDays = Number(ha.visitorRetentionDays ?? DEFAULT_RETENTION_DAYS);
  const tidy = () => {
    try {
      const gone = prune({ retentionDays });
      if (gone.lines || gone.stills) console.log(`  Home: retention removed ${gone.lines} log line(s) and ${gone.stills} still(s) older than ${retentionDays} days`);
    } catch (err: any) {
      console.warn(`  ⚠ Home: retention pass failed — ${err?.message ?? err}`);
    }
  };
  tidy();
  setInterval(tidy, DAY_MS).unref?.();

  const watch = new HomeWatch(parsed.rules, {
    now: () => new Date(),
    emit: events.emit,
    phone: hooks.phone,
    push: hooks.push,
    still: haCameraStill,
    describe: ha.describeVisitors === true ? hooks.describe : undefined,
    saveStill: (bytes, mediaType, at, entityId) => saveStill(bytes, mediaType, at, entityId),
    log: (entry) => { appendEntry(entry); },
    warn: (line) => console.warn(`  ${line}`),
  });

  link = new HaLink(url, token, {
    connect: hooks.connect ?? ((u) => new WebSocket(u) as unknown as SocketLike),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => { if (h) clearTimeout(h as NodeJS.Timeout); },
    log: (line) => console.log(`  ${line}`),
    onChange: (change) => void watch.handle(change).catch((err) =>
      console.warn(`  ⚠ Home: event handler failed — ${err?.message ?? err}`)),
  });
  off = null;
  console.log(`  Home Assistant: watching ${ruleCount} rule(s)`);
  link.start();
}

/**
 * Two rows for npm run doctor: can the claw reach HA with its token, and what
 * would the watcher do. The probe is GET /api/ — HA's "API running." — which
 * reads nothing and changes nothing. No host is printed: the doctor's output
 * gets pasted into issues, and a LAN address is the operator's.
 */
export async function homeDoctorRows(
  ha = config.homeAssistant,
  env: NodeJS.ProcessEnv = process.env,
  doFetch: typeof fetch = (...args) => fetch(...args),
  captionBrain?: { id: string; local: boolean },
): Promise<{ id: string; status: "ok" | "warn"; text: string }[]> {
  if (!ha?.enabled) {
    return [{ id: "home", status: "ok", text: "Home Assistant: off (optional — homeAssistant.enabled in claw.config.json, and a token in .env)" }];
  }
  const rows: { id: string; status: "ok" | "warn"; text: string }[] = [];
  const token = env[ha.tokenEnv]?.trim();
  const base = websocketUrl(ha.baseUrl) ? ha.baseUrl.replace(/\/+$/, "") : null;
  if (!base) {
    rows.push({ id: "home", status: "warn", text: "Home Assistant: homeAssistant.baseUrl must be an http(s) URL such as http://homeassistant.local:8123" });
  } else if (!token) {
    rows.push({
      id: "home", status: "warn",
      text: `Home Assistant: enabled but ${ha.tokenEnv} is not in .env — make one in HA under your profile → Security → Long-lived access tokens`,
    });
  } else {
    try {
      const res = await doFetch(`${base}/api/`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      rows.push(res.ok
        ? { id: "home", status: "ok", text: "Home Assistant: reachable, and the token is accepted" }
        : res.status === 401 || res.status === 403
          ? { id: "home", status: "warn", text: `Home Assistant: the token in ${ha.tokenEnv} was rejected (HTTP ${res.status}) — make a new long-lived access token` }
          : { id: "home", status: "warn", text: `Home Assistant: answered HTTP ${res.status} — is baseUrl the HA address, port included?` });
    } catch (err: any) {
      rows.push({ id: "home", status: "warn", text: `Home Assistant: not reachable (${err?.cause?.code ?? err?.message ?? err}) — is it on, and is baseUrl right?` });
    }
  }

  const { rules, ignored } = parseRules(ha.watch, Number(ha.debounceMinutes ?? DEFAULT_DEBOUNCE_MINUTES));
  if (!rules.length) {
    rows.push({
      id: "home-watch", status: ignored.length ? "warn" : "ok",
      text: ignored.length
        ? `Home watcher: every rule was ignored — ${ignored.join("; ")}`
        : "Home watcher: off — homeAssistant.watch is empty (the house skill has doorbell, motion and presence examples)",
    });
    return rows;
  }
  const days = Number(ha.visitorRetentionDays ?? DEFAULT_RETENTION_DAYS);
  const captions = ha.describeVisitors !== true
    ? "captions off"
    : captionBrain
      ? `captions on via brain ${captionBrain.id}${captionBrain.local ? " (local)" : " — doorbell stills leave this machine for that provider"}`
      : "captions on, but no vision brain is in the roster";
  const warn = ignored.length > 0 || (ha.describeVisitors === true && !captionBrain?.local);
  rows.push({
    id: "home-watch", status: warn ? "warn" : "ok",
    text: `Home watcher: ${rules.length} rule(s); ${captions}; stills and log lines kept ${days} days` +
      (ignored.length ? `; ignored — ${ignored.join("; ")}` : ""),
  });
  return rows;
}

export function stopHomeWatch(): void {
  link?.stop();
  link = null;
  off = "stopped";
}
