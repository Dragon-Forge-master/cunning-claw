import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BridgeReply, BridgeRequest, Dispatched } from "./pocket-bridge.js";
import { refuseRequest } from "./pocket-bridge.js";
import type { PocketRelayHooks, RelayLocals } from "./pocket.js";
import {
  b64u,
  E2EError,
  fingerprint,
  parseHello,
  pairingPsk,
  pairingTicket,
  relayHash,
  respond,
  roomIdFor,
  unb64u,
  type Responder,
  type Session,
  type StaticKey,
} from "./pocket-e2e.js";

/**
 * Pocket through Dragon Forge's relay: the claw's side of the transport.
 *
 * The claw dials OUT to the relay over a WebSocket (Node 22's own client), so
 * nothing is opened on the operator's machine or router. Phones connect to
 * the same room on the relay, and every byte between them and the claw is
 * end-to-end encrypted (src/pocket-e2e.ts). Inside the channel, a phone's
 * requests are Pocket's own requests, dispatched into Pocket's own router by
 * src/pocket-bridge.ts — this module adds a way in, never a second set of
 * rules.
 *
 * It dials out only when there is a reason to: a phone paired this way, or a
 * pairing QR on the HUD waiting for one. A claw that never pairs a phone
 * through the relay never tells Dragon Forge it exists.
 *
 * Kept in data/pocket/relay.json (mode 600): the claw's room secret (the
 * relay checks its hash against the room id) and the claw's static key pair
 * (what phones pin). Neither is ever sent anywhere but the secret to the
 * relay, and the public key to phones.
 */

export interface RelayConfig {
  /** wss://… — the relay's base URL. */
  url: string;
  /** Where the phone app is served from: its origin is the WebAuthn origin for relay phones. */
  appOrigin: string;
}

/**
 * The relay settings, or null when the relay is off: switched off, or no
 * URL. Plain ws:// and http:// are accepted only for this machine's own
 * names, which is what a local `wrangler dev` relay and test app use.
 */
export function relayConfig(raw: { enabled?: boolean; url?: string; appOrigin?: string } | undefined): RelayConfig | null {
  if (!raw || raw.enabled === false || !raw.url) return null;
  const local = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  let u: URL;
  let a: URL;
  try {
    u = new URL(raw.url);
    a = new URL(raw.appOrigin || "https://cunningclaw.com");
  } catch {
    return null;
  }
  if (!(u.protocol === "wss:" || (u.protocol === "ws:" && local(u.hostname)))) return null;
  if (!(a.protocol === "https:" || (a.protocol === "http:" && local(a.hostname)))) return null;
  return { url: u.href.replace(/\/+$/, ""), appOrigin: a.origin };
}

/** What every warned relay line ends with: the way that works without it. */
const PRIVATE_FIX = "pair with the private network instead (Tailscale: https://tailscale.com/download), or switch the easy way off with pocket.relay.enabled: false in claw.config.json";

/**
 * The doctor's relay line: can this machine reach the relay's health check?
 * The doctor only runs when asked, so asking the relay here is the operator's
 * choice; the claw itself still dials out only for a phone (see ensure()).
 */
export async function relayDoctorLine(cfg: RelayConfig | null, fetchImpl: typeof fetch = fetch): Promise<{ status: "ok" | "warn"; text: string }> {
  if (!cfg) return { status: "ok", text: "Pocket relay: off (pocket.relay in claw.config.json) — phones pair over the private network only" };
  const health = `${cfg.url.replace(/^ws/, "http")}/healthz`;
  try {
    const res = await fetchImpl(health, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; protocol?: number } | null;
    if (res.ok && body?.ok === true && body.protocol === 1) return { status: "ok", text: `Pocket relay: reachable at ${cfg.url}` };
    return { status: "warn", text: `Pocket relay: ${cfg.url} answered, but not as the Pocket relay (HTTP ${res.status}) — check pocket.relay.url in claw.config.json` };
  } catch {
    return {
      status: "warn",
      text: `Pocket relay: ${cfg.url} cannot be reached — if Dragon Forge has not deployed it yet (relay/pocket/README.md), ${PRIVATE_FIX}`,
    };
  }
}

/**
 * Is the phone app the website serves the one in this claw's own code? The
 * site is in the trust chain for relay phones (docs/POCKET-RELAY.md), and
 * this is the check anyone can run: the scripts byte for byte. It catches a
 * site serving everyone something else; it cannot catch a site that serves
 * one phone something different from what it serves this check.
 */
export async function siteAppDoctorLine(cfg: RelayConfig | null, localDir: string, fetchImpl: typeof fetch = fetch): Promise<{ status: "ok" | "warn"; text: string } | null> {
  if (!cfg) return null;
  const files = ["pocket.js", "relay.js", "e2e.js", "sw.js"];
  const differ: string[] = [];
  try {
    for (const f of files) {
      const res = await fetchImpl(`${cfg.appOrigin}/pocket/${f}`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
      if (!res.ok) return { status: "warn", text: `Pocket app: ${cfg.appOrigin}/pocket/ is not serving ${f} yet (HTTP ${res.status}) — the easy way needs it; until then, ${PRIVATE_FIX}` };
      const theirs = crypto.createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
      const ours = crypto.createHash("sha256").update(fs.readFileSync(path.join(localDir, f))).digest("hex");
      if (theirs !== ours) differ.push(f);
    }
  } catch {
    return { status: "warn", text: `Pocket app: ${cfg.appOrigin}/pocket/ cannot be reached from here — ${PRIVATE_FIX}` };
  }
  if (!differ.length) return { status: "ok", text: `Pocket app: ${cfg.appOrigin}/pocket/ serves the same scripts as this claw's own copy (${files.length} files)` };
  return {
    status: "warn",
    text: `Pocket app: ${cfg.appOrigin}/pocket/ serves different ${differ.join(", ")} from this claw's copy — expected for a while after an update to one of them (compare its release.json with https://github.com/Dragon-Forge-master/cunning-claw); if both are current, do not pair the easy way until it is explained: ${PRIVATE_FIX}`,
  };
}

export interface RelayIdentity { secret: Buffer; room: string; key: StaticKey }

/** The claw's room secret and static key, made on first use and kept mode 600. */
export function loadRelayIdentity(dataDir: string): RelayIdentity {
  const file = path.join(dataDir, "pocket", "relay.json");
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const secret = unb64u(j.secret, "secret", 32);
    const key = { priv: unb64u(j.priv, "private key", 32), pub: unb64u(j.pub, "public key", 65) };
    return { secret, room: roomIdFor(secret), key };
  } catch { /* first use */ }
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const secret = crypto.randomBytes(32);
  const key = { priv: ecdh.getPrivateKey(), pub: ecdh.getPublicKey(null, "uncompressed") };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ secret: b64u(secret), priv: b64u(key.priv), pub: b64u(key.pub) }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { secret, room: roomIdFor(secret), key };
}

/** The slice of Pocket this needs (src/pocket.ts). */
export interface RelayPocket {
  relayDevices(): { id: string; relayKey: string; relayTokenHash: string }[];
  relayPairingLive(): boolean;
}

/** The slice of the WebSocket API used: Node 22's global, or a test's stand-in. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((e?: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null;
  onerror: ((e?: unknown) => void) | null;
}

export interface RelayDeps {
  config: RelayConfig;
  identity: RelayIdentity;
  pocket: RelayPocket;
  dispatch: (m: BridgeRequest, relay: RelayLocals, send: (r: BridgeReply) => void) => Dispatched;
  connect?: (url: string) => SocketLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Something the operator should know, e.g. that a pairing handshake failed. */
  notice?: (message: string) => void;
}

const HANDSHAKE_MS = 20_000;
/**
 * How long a dial may take to reach "ready". Node's WebSocket has no connect
 * timeout of its own, and a relay restarting mid-handshake can leave the
 * socket neither open nor closed for good: found when a local relay restart
 * left a claw "connecting…" for ever while its phone kept knocking.
 */
const READY_MS = 15_000;
const MAX_INFLIGHT = 16;
const PING_MS = 30_000;
const PAIR_FAILURES = 3;

type Phase = "hs1" | "hs3" | "open";
interface Channel {
  c: string;
  via: string;
  phase: Phase;
  mode: "pair" | "session";
  responder?: Responder;
  session?: Session;
  peerKey: string;
  deviceId: string | null;
  inflight: Map<number, Dispatched>;
  timer: unknown;
}

export type RelayState = "idle" | "connecting" | "connected" | "unreachable";

export function createRelayTransport(deps: RelayDeps): PocketRelayHooks & {
  /** Dial out if there is a reason to, and keep the line up while there is. */
  ensure(): void;
  stop(): void;
  state(): RelayState;
  /** For tests: the open channels' device ids. */
  channels(): { c: string; deviceId: string | null; phase: Phase }[];
} {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  const connect = deps.connect ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const { identity, config } = deps;
  const appHost = new URL(config.appOrigin).host;
  const roomUrl = `${config.url}/v1/room/${identity.room}`;

  let ws: SocketLike | null = null;
  let ready = false;
  let state: RelayState = "idle";
  let lastError = "";
  let backoff = 1000;
  let retry: unknown = null;
  let ping: unknown = null;
  let awaitingPong = 0;
  let stopped = false;
  /** The live relay pairing: its psk, held in memory only, and whether a phone has claimed it. */
  let pairing: { psk: Buffer; ticketHash: string; expires: number; claimed: boolean; failures: number } | null = null;
  const chans = new Map<string, Channel>();

  // Our own record decides whether to dial (Pocket records the pairing only
  // after pairingLink returns); both must agree before a phone may pair.
  const pairingHeld = () => Boolean(pairing && pairing.expires > now());
  const pairingLive = () => pairingHeld() && deps.pocket.relayPairingLive();
  const wanted = () => !stopped && (deps.pocket.relayDevices().length > 0 || pairingHeld() || chans.size > 0);

  function raw(obj: unknown): void {
    if (ws && ready) ws.send(JSON.stringify(obj));
  }

  function allow(): void {
    raw({ t: "allow", tokens: deps.pocket.relayDevices().map((d) => d.relayTokenHash) });
  }

  function announceTicket(): void {
    if (pairing && !pairing.claimed && pairing.expires > now()) {
      raw({ t: "ticket", hash: pairing.ticketHash, ttl: Math.ceil((pairing.expires - now()) / 1000) });
    }
  }

  function drop(ch: Channel, why?: string): void {
    if (!chans.has(ch.c)) return;
    chans.delete(ch.c);
    clearTimer(ch.timer);
    for (const d of ch.inflight.values()) d.abort();
    ch.inflight.clear();
    if (why !== undefined) raw({ t: "kick", c: ch.c, why });
  }

  function sendTo(ch: Channel, msg: BridgeReply | { t: string; [k: string]: unknown }): void {
    if (!ch.session || !chans.has(ch.c)) return;
    try {
      for (const d of ch.session.seal(msg)) raw({ t: "to", c: ch.c, d });
    } catch {
      drop(ch, "channel closed");
    }
  }

  function teardown(): void {
    for (const ch of [...chans.values()]) drop(ch);
    ready = false;
    if (ping) clearTimer(ping);
    ping = null;
    const s = ws;
    ws = null;
    if (s) {
      s.onopen = s.onmessage = s.onerror = null;
      s.onclose = null;
      try { s.close(1000, "bye"); } catch { /* gone */ }
    }
  }

  function scheduleRetry(): void {
    if (retry || !wanted()) return;
    // Jitter, so a relay restart does not get every claw back in the same second.
    const wait = Math.round(backoff * (0.75 + Math.random() * 0.5));
    backoff = Math.min(backoff * 2, 60_000);
    retry = setTimer(() => { retry = null; ensure(); }, wait);
  }

  function keepalive(): void {
    ping = setTimer(() => {
      if (!ws || !ready) return;
      // The relay answers "ping" without waking its Durable Object. Two
      // unanswered in a row is a dead line, whatever the socket says.
      if (awaitingPong >= 2) {
        lastError = "the relay stopped answering";
        teardown();
        state = "unreachable";
        return scheduleRetry();
      }
      awaitingPong++;
      ws.send("ping");
      keepalive();
    }, PING_MS);
  }

  function ensure(): void {
    if (!wanted()) {
      if (ws) teardown();
      state = "idle";
      return;
    }
    if (ws || retry) return;
    state = "connecting";
    let s: SocketLike;
    try {
      s = connect(roomUrl);
    } catch (err) {
      lastError = String((err as Error)?.message ?? err);
      state = "unreachable";
      return scheduleRetry();
    }
    ws = s;
    setTimer(() => {
      if (ws !== s || ready) return;
      lastError = "the relay did not answer";
      teardown();
      state = "unreachable";
      scheduleRetry();
    }, READY_MS);
    s.onopen = () => s.send(JSON.stringify({ t: "hello", role: "claw", secret: b64u(identity.secret) }));
    s.onmessage = (e) => onRelay(String(e.data));
    s.onerror = () => { lastError = "could not reach the relay"; };
    s.onclose = (e) => {
      if (ws !== s) return;
      lastError = e?.reason ? `the relay closed the line: ${e.reason}` : lastError || "the relay closed the line";
      teardown();
      state = "unreachable";
      scheduleRetry();
    };
  }

  function onRelay(text: string): void {
    if (text === "pong") { awaitingPong = 0; return; }
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (m?.t === "ready") {
      ready = true;
      state = "connected";
      lastError = "";
      backoff = 1000;
      awaitingPong = 0;
      allow();
      announceTicket();
      keepalive();
      return;
    }
    if (!ready) return;
    if (m?.t === "open" && typeof m.c === "string") {
      if (chans.has(m.c)) return;
      const ch: Channel = { c: m.c, via: String(m.via ?? ""), phase: "hs1", mode: "session", peerKey: "", deviceId: null, inflight: new Map(), timer: null };
      ch.timer = setTimer(() => { if (ch.phase !== "open") drop(ch, "handshake took too long"); }, HANDSHAKE_MS);
      chans.set(m.c, ch);
      return;
    }
    if (m?.t === "gone" && typeof m.c === "string") {
      const ch = chans.get(m.c);
      if (ch) drop(ch);
      ensure();
      return;
    }
    if (m?.t === "from" && typeof m.c === "string" && typeof m.d === "string") {
      const ch = chans.get(m.c);
      if (ch) onChannel(ch, m.d);
    }
  }

  function pairFailed(): void {
    if (!pairing) return;
    pairing.failures++;
    // A pairing code a relay keeps guessing at is burned, not left open to
    // the next guess. The HUD's QR will fail; press PAIR again.
    if (pairing.failures >= PAIR_FAILURES) {
      pairing = null;
      raw({ t: "unticket" });
      deps.notice?.("A relay pairing was attempted with the wrong code several times, so that code was cancelled. Press PAIR A PHONE for a new one.");
    }
  }

  function onChannel(ch: Channel, d: string): void {
    try {
      if (ch.phase === "hs1") {
        const hello = parseHello(d);
        const peerKey = b64u(hello.phonePub);
        let psk: Buffer | null = null;
        if (hello.mode === "session") {
          // The relay admitted it by a phone token; the handshake must now
          // prove a paired phone's own key.
          if (ch.via !== "token") throw new E2EError("mode", "a session must come in with a phone token");
          const dev = deps.pocket.relayDevices().find((x) => x.relayKey === peerKey);
          if (!dev) throw new E2EError("unknown", "no phone with that key is paired through the relay");
          ch.deviceId = dev.id;
        } else {
          if (ch.via !== "ticket") throw new E2EError("mode", "pairing must come in with a pairing ticket");
          if (!pairingLive() || !pairing || pairing.claimed) throw new E2EError("pairing", "no pairing is waiting, or it was already used");
          psk = pairing.psk;
        }
        ch.mode = hello.mode;
        ch.peerKey = peerKey;
        ch.responder = respond(hello, { room: identity.room, claw: identity.key, psk });
        ch.phase = "hs3";
        raw({ t: "to", c: ch.c, d: ch.responder.reply });
        return;
      }
      if (ch.phase === "hs3") {
        try {
          ch.session = ch.responder!.finish(d);
        } catch (err) {
          if (ch.mode === "pair") pairFailed();
          throw err;
        }
        ch.responder = undefined;
        if (ch.mode === "pair") {
          // One phone per code: the first to prove the code holds it.
          if (!pairing || pairing.claimed || !pairingLive()) throw new E2EError("pairing", "that pairing was already used");
          pairing.claimed = true;
          raw({ t: "unticket" });
        }
        ch.phase = "open";
        clearTimer(ch.timer);
        return;
      }
      const msg = ch.session!.open(d) as any;
      if (msg === undefined) return;
      onMessage(ch, msg);
    } catch (err) {
      // Nothing about why goes back to whoever is on the other end beyond a
      // word; the far end learns nothing it could use to adjust an attack.
      drop(ch, err instanceof E2EError ? err.code : "error");
    }
  }

  function onMessage(ch: Channel, msg: any): void {
    if (msg?.t === "cancel" && Number.isSafeInteger(msg.id)) {
      ch.inflight.get(msg.id)?.abort();
      ch.inflight.delete(msg.id);
      return;
    }
    if (msg?.t !== "req") return;
    const why = refuseRequest(msg);
    if (why) return sendTo(ch, { t: "res", id: Number(msg.id) || 0, status: 400, type: "application/json", body: JSON.stringify({ error: why }) });
    if (ch.inflight.has(msg.id) || ch.inflight.size >= MAX_INFLIGHT) {
      return sendTo(ch, { t: "res", id: msg.id, status: 429, type: "application/json", body: JSON.stringify({ error: "Too many requests at once." }) });
    }
    const locals: RelayLocals = {
      deviceId: ch.deviceId,
      peerKey: ch.peerKey,
      pairing: ch.mode === "pair" && ch.deviceId === null,
      bind: (id) => { ch.deviceId = id; },
      client: ch.c,
    };
    let settled = false;
    const handle = deps.dispatch(msg as BridgeRequest, locals, (reply) => {
      if (reply.t === "res" || reply.t === "end") {
        settled = true;
        ch.inflight.delete(msg.id);
      }
      sendTo(ch, reply);
    });
    // Dispatch can answer before it returns; only requests still open are tracked.
    if (!settled) ch.inflight.set(msg.id, handle);
  }

  return {
    pairingLink(code, expires) {
      pairing = { psk: pairingPsk(code), ticketHash: relayHash(pairingTicket(code)), expires, claimed: false, failures: 0 };
      ensure();
      announceTicket();
      const frag = new URLSearchParams({ pair: code, room: identity.room, ck: fingerprint(identity.key.pub), relay: config.url });
      return { url: `${config.appOrigin}/pocket/#${frag.toString()}` };
    },
    pairingEnded() {
      if (pairing && !pairing.claimed) raw({ t: "unticket" });
      pairing = null;
      // Safe mid-enrolment: an open channel is itself a reason to stay on the line.
      ensure();
    },
    devicesChanged() {
      allow();
      const ids = new Set(deps.pocket.relayDevices().map((d) => d.id));
      for (const ch of [...chans.values()]) {
        if (ch.deviceId && !ids.has(ch.deviceId)) drop(ch, "unpaired");
      }
      ensure();
    },
    status() {
      const messages: Record<RelayState, string> = {
        idle: "Not connected: nothing is paired through the relay yet, so the claw has not dialled out.",
        connecting: "Connecting to the relay…",
        connected: "Connected to the relay. Phones paired this way can reach the claw.",
        unreachable: `The relay cannot be reached${lastError ? ` (${lastError})` : ""}. It retries by itself; the private network works without it.`,
      };
      return { url: config.url, state, message: messages[state] };
    },
    ensure,
    stop() {
      stopped = true;
      if (retry) clearTimer(retry);
      retry = null;
      teardown();
      state = "idle";
    },
    state: () => state,
    channels: () => [...chans.values()].map((c) => ({ c: c.c, deviceId: c.deviceId, phase: c.phase })),
  };
}
