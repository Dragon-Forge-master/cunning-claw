import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { normalisePocketHost, pocketOrigin, pocketRpId } from "./pocket-host.js";
import { encodeQr, qrRows } from "./qr.js";
import { collapseHomeIn, redactDeep } from "./redact.js";
import {
  b64url,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
  type StoredKey,
} from "./webauthn.js";
import { loadVapidKeys, sendPush, validSubscription, type PushSubscription, type VapidKeys } from "./webpush.js";
import { applyFix, fileReceipt, parseFixText, summaryLine, type Filed, type ReadReceipt } from "./receipts.js";
import { shortId, type Job } from "./jobs.js";
import { relayHash } from "./pocket-e2e.js";

/**
 * Pocket Claw: the claw's own phone app, served on the operator's tailnet
 * name and nowhere else (src/pocket-host.ts decides which name a request was
 * sent to; this module only ever sees Pocket requests on the phone side).
 *
 * The trust chain, from the operator's screen to the approval card:
 *   1. The HUD mints a pairing code (single-use, minutes long) and shows it
 *      as a QR. The code is in the URL fragment, so no proxy logs it.
 *   2. The phone spends the code to get a WebAuthn creation challenge, and
 *      enrols a platform credential with user verification required. Only
 *      then is a device token issued: 256 random bits, stored as a SHA-256
 *      hash, sent back as an HttpOnly, SameSite=Strict cookie.
 *   3. The token alone opens the approvals list and nothing else. Reading
 *      the conversation, sending, uploading and the mic need a biometric
 *      unlock that lapses after a few idle minutes.
 *   4. Approving or denying a card needs a fresh assertion over a challenge
 *      that names that approval and that verdict, single-use, two minutes
 *      long — then settles through the same settleApproval the HUD,
 *      Telegram and Discord use, so all of them see it.
 * Revoking a device on the HUD deletes its record; its token is then 401
 * everywhere and its open streams are closed.
 */

// --- Rate limiting ----------------------------------------------------------------

/**
 * Failures per client in a sliding window. The tokens and codes are far too
 * long to guess, so this is not what keeps them safe; it is what stops a
 * confused or hostile tailnet device from making the claw verify signatures
 * and hash tokens in a tight loop, and it makes a probe loud.
 */
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}
  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }
  blocked(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }
  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
  }
}

// --- Storage -----------------------------------------------------------------------

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  created: string;
  lastSeen: string;
  credentialId: string;
  key: StoredKey;
  signCount: number;
  push?: PushSubscription;
  /** Ids of the receipts this phone filed, newest last: the ones it may correct. */
  receipts?: string[];
  /**
   * "relay": paired through Dragon Forge's relay (src/pocket-relay.ts). Such
   * a phone has no device token at all: it is known by the static key its
   * end-to-end channel was authenticated with, and it is reachable through
   * that channel and nowhere else. Absent: the tailnet path, token and cookie.
   */
  via?: "relay";
  /** A relay phone's static key, raw P-256, base64url: what its channel must prove. */
  relayKey?: string;
  /** What the relay is told to let this phone into the room by: a hash of the phone's relay token. */
  relayTokenHash?: string;
}

/**
 * What the relay transport puts on res.locals.pocket beside host and origin,
 * in place of the host gate's verdict. Set only by src/pocket-bridge.ts for
 * a request that arrived on an authenticated end-to-end channel; nothing a
 * request carries can set it.
 */
export interface RelayLocals {
  /** The device the channel was authenticated as, or null on a pairing channel. */
  deviceId: string | null;
  /** The phone static key the channel proved, base64url. */
  peerKey: string;
  /** A channel opened with the pairing code's psk: it may pair, and do nothing else. */
  pairing: boolean;
  /** Called once pairing has made a device of this channel's key. */
  bind(deviceId: string): void;
  /** For the limiter: which relay connection this is. */
  client: string;
}

/** The relay transport, as Pocket sees it. Injected so Pocket does not import it. */
export interface PocketRelayHooks {
  /** A pairing QR's link for this code, or why there is none. */
  pairingLink(code: string, expires: number): { url: string } | { error: string };
  /** The live pairing was spent, cancelled or replaced. */
  pairingEnded(): void;
  /** A relay device was added or revoked. */
  devicesChanged(): void;
  /** For the HUD's panel. */
  status(): { url: string; state: string; message: string };
}

interface Stored { devices: DeviceRecord[]; host?: string }

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function writeJson600(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A device name as shown on the HUD: printable, short, chosen by the operator. */
export function cleanDeviceName(raw: unknown): string {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || "Phone";
}

// --- Files from the phone ------------------------------------------------------------

/**
 * What a share or a camera snap may be, decided by its bytes, not by the name
 * or type the sending app claims. The saved name is ours, so no stranger's
 * filename ever reaches the operator's turn as if the operator had typed it.
 */
const KINDS: { ext: string; test: (b: Buffer) => boolean }[] = [
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: "heic", test: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1|hevc)$/.test(b.subarray(8, 12).toString("latin1")) },
  { ext: "pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
];

export function sniffKind(buf: Buffer): string | null {
  return KINDS.find((k) => k.test(buf))?.ext ?? null;
}

export function shareFileName(ext: string, now: Date, rand = crypto.randomBytes(3).toString("hex")): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `pocket-${stamp}-${rand}.${ext}`;
}

/**
 * The turn a shared file starts. The path is ours and the marker is the
 * paperclip's own, so the existing untrusted path applies unchanged: the
 * routing guard pins "[file attached:" turns to a trusted brain, and
 * read_document fences whatever the file says.
 *
 * Receipts do not come this way. A file the operator marks as a receipt goes
 * to the ledger (POST /pocket/api/receipt, the same fileReceipt the Telegram
 * flow uses) and never becomes a turn, so nothing printed on a stranger's
 * slip is put to the model as conversation.
 */
export function shareMessage(file: string, note: string): string {
  return `[file attached: ${file}] ${note.trim() || "Shared from my phone — what is it?"}`;
}

/** What the phone shows after filing: our summary line, and why it may be wrong. */
export function filedView(f: Filed): { id: string; line: string; status: string; warning: string } {
  const r = f.receipt;
  const warning = f.readError
    ? `Saved, but it could not be read: ${f.readError}. Type the figures below.`
    : f.doubt ? "The reader did not think this is a receipt. Check it, or void it." : "";
  return { id: r.id, line: summaryLine(r), status: r.status, warning };
}

/** The slice of the job registry Pocket uses (src/jobs.ts); injected so tests build their own. */
export interface PocketJobs {
  list(): Job[];
  get(id: string): Job | null;
  canCancel(id: string): boolean;
  cancel(id: string): Promise<{ ok: boolean; message: string }>;
}

/** A job as the phone sees it: our own status line, never the work's output. */
export function jobView(j: Job, cancellable: boolean) {
  return { id: j.id, short: shortId(j.id), kind: j.kind, title: j.title, state: j.state, status: j.status, rev: j.rev, cancellable };
}

// --- The module ----------------------------------------------------------------------

export interface PocketDeps {
  dataDir: string;
  uploadsDir: string;
  /** Hosts from claw.config.json's pocket.hosts. */
  configuredHosts: () => string[];
  settleApproval: (id: string, approved: boolean) => boolean;
  chat: (message: string) => { status: number; body: unknown };
  history: () => { role: string; text: string }[];
  listen?: (wav: Buffer) => Promise<{ text: string }>;
  readBody?: (req: Request, max: number) => Promise<Buffer | null>;
  notice?: (message: string) => void;
  clawName?: () => string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  vapidSubject?: string;
  unlockMinutes?: number;
  pairingMinutes?: number;
  /** Where the phone's static files live (public/pocket). */
  staticDir?: string;
  /** Mission control's registry (src/jobs.ts). Without it the Jobs view says there is none. */
  jobs?: PocketJobs;
  /**
   * Where receipts are filed, and who reads them. Left out, the claw's own
   * ledger, Desk page and vision brain (src/receipts.ts); tests pass their own.
   */
  receipts?: { root?: string; desk?: string | null; read?: ReadReceipt };
  /**
   * The relay transport (src/pocket-relay.ts), or null when it is switched
   * off. A function because the transport is built after Pocket: it needs
   * Pocket's router to dispatch into.
   */
  relay?: () => PocketRelayHooks | null;
}

/**
 * Pocket routes whose bodies are photos, parsed by their own larger parser.
 * server.ts's 1MB global parser must skip them: body-parser marks a request
 * parsed after the first parse, so a later, larger limit never runs and a
 * phone photo dies at 1MB. Exported so the server and the tests share one list.
 */
export const POCKET_LARGE_BODIES: ReadonlySet<string> = new Set(["/pocket/api/upload", "/pocket/api/receipt"]);

const COOKIE = "cc_pocket";
const CHALLENGE_MS = 2 * 60_000;
const MAX_UPLOAD = 20 * 1024 * 1024;

/** Events a locked phone still receives: the cards it can answer. */
const LOCKED_EVENTS = new Set(["approval_request", "approval_resolved"]);
/**
 * What an unlocked phone receives. Tool results are left off on purpose —
 * they are other people's words (pages, inboxes) and the phone does not need
 * them to follow a turn; a tool's name is enough.
 */
const UNLOCKED_EVENTS = new Set(["turn_start", "text", "tool_start", "turn_done", "agent_error", "notice", "job"]);

/** How many receipts a phone remembers filing, so it can correct its own and only its own. */
const RECEIPTS_REMEMBERED = 20;

type Purpose = "unlock" | "approve" | "deny" | "cancel";
interface Challenge { deviceId: string; purpose: Purpose; approvalId: string; expires: number }

export function createPocket(deps: PocketDeps) {
  const now = deps.now ?? Date.now;
  const dir = path.join(deps.dataDir, "pocket");
  const storeFile = path.join(dir, "devices.json");
  const unlockMs = Math.max(1, deps.unlockMinutes ?? 10) * 60_000;
  const pairingMs = Math.max(1, Math.min(15, deps.pairingMinutes ?? 5)) * 60_000;
  const limiter = new FailureLimiter(10, 10 * 60_000, now);
  // Pairing is the one door with no token in front of it, so it has a
  // ceiling for everyone as well as one per client.
  const pairLimiter = new FailureLimiter(30, 10 * 60_000, now);
  let vapid: VapidKeys | null = null;

  let store: Stored = { devices: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    if (Array.isArray(raw?.devices)) store = { devices: raw.devices, host: typeof raw.host === "string" ? raw.host : undefined };
  } catch { /* nothing paired yet */ }
  const save = () => writeJson600(storeFile, store);

  // A code is minted for one path. A relay code cannot be spent on the
  // tailnet name, nor a tailnet code through the relay: each path's origin,
  // and what the device is bound to afterwards, follow from the code.
  let pairing: { hash: string; expires: number; mode: "direct" | "relay" } | null = null;
  const enrolments = new Map<string, { challenge: string; host: string; expires: number; relayKey?: string }>();
  const endPairing = () => {
    if (pairing?.mode === "relay") deps.relay?.()?.pairingEnded();
    pairing = null;
  };
  const challenges = new Map<string, Challenge>();
  const unlockedUntil = new Map<string, number>();
  const pending = new Map<string, { id: string; summary: string; detail: string }>();
  const streams = new Set<{ res: Response; deviceId: string }>();
  const lastSeenWritten = new Map<string, number>();

  function hosts(): string[] {
    const out = new Set<string>();
    for (const h of deps.configuredHosts()) {
      const n = normalisePocketHost(h);
      if (n) out.add(n);
    }
    if (store.host) out.add(store.host);
    return [...out];
  }

  function clientKey(req: Request, res?: Response): string {
    // A relay channel is its own client: the relay connection it came on.
    const relayed = res && pocketOf(res)?.relay?.client;
    if (relayed) return `relay:${relayed}`;
    // tailscale serve sets X-Forwarded-For to the tailnet address; without a
    // proxy (the .localhost test name) the socket's address is all there is.
    const fwd = req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    return first || req.socket.remoteAddress || "unknown";
  }

  function pocketOf(res: Response): { host: string; origin: string; relay?: RelayLocals } | null {
    return (res.locals.pocket as { host: string; origin: string; relay?: RelayLocals } | undefined) ?? null;
  }

  function sweep(): void {
    const t = now();
    for (const [k, c] of challenges) if (c.expires < t) challenges.delete(k);
    for (const [k, e] of enrolments) if (e.expires < t) enrolments.delete(k);
    if (pairing && pairing.expires < t) endPairing();
  }

  function isUnlocked(deviceId: string): boolean {
    return (unlockedUntil.get(deviceId) ?? 0) > now();
  }

  function unlock(deviceId: string): void {
    unlockedUntil.set(deviceId, now() + unlockMs);
  }

  function setCookie(res: Response, origin: string, value: string, maxAge: number): void {
    const secure = origin.startsWith("https:") ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/pocket/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
  }

  function presented(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === COOKIE) return rest.join("=");
    }
    return undefined;
  }

  function findDevice(token: string | undefined): DeviceRecord | null {
    if (!token) return null;
    const dot = token.indexOf(".");
    if (dot < 1) return null;
    const id = token.slice(0, dot);
    const d = store.devices.find((x) => x.id === id);
    // A relay phone has no token; nothing presented on the tailnet name can be one.
    if (!d || d.via === "relay") return null;
    const a = Buffer.from(sha256(token.slice(dot + 1)), "hex");
    const b = Buffer.from(d.tokenHash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? d : null;
  }

  function touch(d: DeviceRecord): void {
    d.lastSeen = new Date(now()).toISOString();
    // lastSeen is for the HUD's list, not an audit log; once a minute is plenty of disk.
    if (now() - (lastSeenWritten.get(d.id) ?? 0) > 60_000) {
      lastSeenWritten.set(d.id, now());
      save();
    }
  }

  // --- Middleware ------------------------------------------------------------------

  const requirePocketHost = (req: Request, res: Response, next: NextFunction): void => {
    if (!pocketOf(res)) {
      // On the loopback name the page loads, but there is no phone API: the
      // WebAuthn origin would be wrong, and the HUD already has its own.
      res.status(404).json({ error: "Pocket Claw answers on your tailnet address, not this one." });
      return;
    }
    next();
  };

  /** Every state-changing call must come from the Pocket page itself. */
  const sameOrigin = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.headers.origin !== pocketOf(res)?.origin) {
      res.status(403).json({ error: "Cross-site request refused." });
      return;
    }
    next();
  };

  /**
   * A relay request's device is the one its channel proved it is: the
   * transport authenticated the phone's static key in the handshake and names
   * the device it belongs to. The record must still exist (revoke is
   * immediate) and still be bound to that same key.
   */
  function relayDevice(r: RelayLocals): DeviceRecord | null {
    if (!r.deviceId) return null;
    const d = store.devices.find((x) => x.id === r.deviceId);
    return d && d.via === "relay" && d.relayKey === r.peerKey ? d : null;
  }

  const requireDevice = (req: Request, res: Response, next: NextFunction): void => {
    const key = clientKey(req, res);
    if (limiter.blocked(key)) {
      res.status(429).json({ error: "Too many failed attempts. Wait a few minutes." });
      return;
    }
    const relay = pocketOf(res)?.relay;
    const d = relay ? relayDevice(relay) : findDevice(presented(req));
    if (!d) {
      limiter.fail(key);
      res.status(401).json({ error: "This phone is not paired, or was revoked. Pair it again from the HUD." });
      return;
    }
    touch(d);
    res.locals.device = d;
    next();
  };

  const requireUnlocked = (_req: Request, res: Response, next: NextFunction): void => {
    const d = res.locals.device as DeviceRecord;
    if (!isUnlocked(d.id)) {
      res.status(423).json({ error: "Locked. Unlock with your fingerprint or screen lock.", locked: true });
      return;
    }
    unlock(d.id); // idle timeout: use keeps it open
    next();
  };

  // --- Challenges ------------------------------------------------------------------

  /**
   * The challenge carries its own meaning: 16 random bytes, then
   * "<purpose>:<approval id>". An assertion minted to deny card A cannot
   * approve card A, and cannot answer card B, even before the server-side
   * record is consulted.
   */
  function mintChallenge(deviceId: string, purpose: Purpose, approvalId = ""): string {
    sweep();
    const c = b64url(Buffer.concat([crypto.randomBytes(16), Buffer.from(`${purpose}:${approvalId}`)]));
    challenges.set(c, { deviceId, purpose, approvalId, expires: now() + CHALLENGE_MS });
    return c;
  }

  /** Spend a challenge: look it up by what the browser signed, delete it whatever happens next. */
  function spendChallenge(assertion: any, deviceId: string, purpose: Purpose, approvalId = ""): string {
    let signed = "";
    try {
      signed = String(JSON.parse(Buffer.from(String(assertion?.response?.clientDataJSON ?? ""), "base64url").toString("utf8")).challenge ?? "");
    } catch { /* falls through to "unknown" */ }
    const rec = challenges.get(signed);
    challenges.delete(signed);
    if (!rec || rec.expires < now()) throw new WebAuthnError("challenge", "unknown, used or expired challenge");
    if (rec.deviceId !== deviceId || rec.purpose !== purpose || rec.approvalId !== approvalId) {
      throw new WebAuthnError("challenge", "challenge was minted for something else");
    }
    const embedded = Buffer.from(signed, "base64url").subarray(16).toString("utf8");
    if (embedded !== `${purpose}:${approvalId}`) throw new WebAuthnError("challenge", "challenge does not name this approval");
    return signed;
  }

  function checkAssertion(req: Request, res: Response, purpose: Purpose, approvalId = ""): boolean {
    const d = res.locals.device as DeviceRecord;
    const p = pocketOf(res)!;
    try {
      const challenge = spendChallenge(req.body?.assertion, d.id, purpose, approvalId);
      const out = verifyAssertion(req.body.assertion, {
        challenge,
        origins: [p.origin],
        rpId: pocketRpId(p.host),
        credentialId: d.credentialId,
        key: d.key,
        signCount: d.signCount,
      });
      d.signCount = out.signCount;
      save();
      unlock(d.id);
      return true;
    } catch (err) {
      limiter.fail(clientKey(req, res));
      const msg = err instanceof WebAuthnError ? err.message : "assertion could not be checked";
      res.status(401).json({ error: `Not verified: ${msg}` });
      return false;
    }
  }

  function requestOptions(d: DeviceRecord, host: string, challenge: string) {
    return {
      challenge,
      rpId: pocketRpId(host),
      allowCredentials: [{ type: "public-key", id: d.credentialId, transports: ["internal", "hybrid"] }],
      userVerification: "required",
      timeout: CHALLENGE_MS,
    };
  }

  // --- Push ------------------------------------------------------------------------

  function vapidKeys(): VapidKeys {
    vapid ??= loadVapidKeys(dir);
    return vapid;
  }

  async function pushAll(count: number): Promise<void> {
    const targets = store.devices.filter((d) => d.push);
    if (!targets.length) return;
    // A count and a label. Never the card: this is read off a locked screen.
    const msg = {
      title: deps.clawName?.() ?? "Pocket Claw",
      body: `${count} approval${count === 1 ? "" : "s"} waiting`,
      tag: "approvals",
      url: "/pocket/#approvals",
      count,
    };
    let changed = false;
    await Promise.all(targets.map(async (d) => {
      const out = await sendPush(d.push!, msg, vapidKeys(), deps.vapidSubject ?? "https://github.com/Dragon-Forge-master/cunning-claw", deps.fetchImpl);
      if (!out.ok && out.gone) {
        delete d.push;
        changed = true;
      }
    }));
    if (changed) save();
  }

  // --- Events from broadcast() -------------------------------------------------------

  /**
   * Fed by server.ts's broadcast(), after redaction, so the phone sees
   * nothing the HUD would not. Pending cards are tracked from the same
   * stream, which keeps this module off the approval registry's internals.
   */
  function onEvent(event: string, data: any): void {
    // A Learn mode practice card belongs to the HUD alone (src/approvals.ts):
    // it is never pushed, listed or answerable on a phone, and a practice
    // card buzzing a pocket would teach the reflex the course exists to undo.
    if (data?.practice === true) return;
    if (event === "approval_request" && data?.id) {
      pending.set(String(data.id), { id: String(data.id), summary: String(data.summary ?? ""), detail: String(data.detail ?? "") });
      void pushAll(pending.size).catch(() => {});
    } else if (event === "approval_resolved" && data?.id) {
      pending.delete(String(data.id));
    }
    if (!LOCKED_EVENTS.has(event) && !UNLOCKED_EVENTS.has(event)) return;
    let payload = data;
    if (event === "tool_start") payload = { name: data?.name };
    // The registry's own view of a job, cut to what the phone shows; the
    // result pointer and timestamps stay home.
    if (event === "job") {
      if (!data?.id) return;
      payload = jobView(data as Job, deps.jobs?.canCancel(String(data.id)) ?? false);
    }
    const line = `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const s of streams) {
      if (LOCKED_EVENTS.has(event) || isUnlocked(s.deviceId)) s.res.write(line);
    }
  }

  function revoke(id: string): boolean {
    const gone = store.devices.find((d) => d.id === id);
    if (!gone) return false;
    store.devices = store.devices.filter((d) => d.id !== id);
    save();
    // The transport drops the phone's token from the relay's list (the relay
    // then closes it) and closes its end-to-end channels itself.
    if (gone.via === "relay") deps.relay?.()?.devicesChanged();
    unlockedUntil.delete(id);
    for (const [k, c] of challenges) if (c.deviceId === id) challenges.delete(k);
    for (const s of streams) {
      if (s.deviceId === id) {
        s.res.end();
        streams.delete(s);
      }
    }
    return true;
  }

  // --- The phone's routes (/pocket/...) -------------------------------------------------

  const phone = express.Router();
  const api = express.Router();

  api.use(requirePocketHost, sameOrigin);

  api.post("/pair/options", (req, res) => {
    sweep();
    const key = clientKey(req, res);
    if (limiter.blocked(key) || pairLimiter.blocked("*")) {
      return res.status(429).json({ error: "Too many failed attempts. Wait a few minutes." });
    }
    const code = String(req.body?.code ?? "");
    const p = pocketOf(res)!;
    // Through the relay, only a channel the pairing handshake opened (one that
    // proved it knows this code's psk) may spend it, and only a relay code.
    const path = p.relay ? "relay" : "direct";
    const ok = pairing && code && sha256(code) === pairing.hash && pairing.expires >= now() &&
      pairing.mode === path && (!p.relay || p.relay.pairing);
    if (!ok) {
      limiter.fail(key);
      pairLimiter.fail("*");
      return res.status(401).json({ error: "That pairing code is wrong, used or expired. Press POCKET on the HUD for a fresh one." });
    }
    // Single use: the code is gone the moment it is spent, whatever happens next.
    endPairing();
    const enrolment = b64url(crypto.randomBytes(16));
    const challenge = b64url(crypto.randomBytes(32));
    enrolments.set(enrolment, { challenge, host: p.host, expires: now() + pairingMs, relayKey: p.relay?.peerKey });
    res.json({
      enrolment,
      publicKey: {
        challenge,
        rp: { id: pocketRpId(p.host), name: deps.clawName?.() ?? "Pocket Claw" },
        user: { id: b64url(crypto.randomBytes(16)), name: "pocket", displayName: "Pocket Claw" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
        attestation: "none",
        timeout: pairingMs,
      },
    });
  });

  api.post("/pair/finish", (req, res) => {
    sweep();
    const key = clientKey(req, res);
    const e = enrolments.get(String(req.body?.enrolment ?? ""));
    enrolments.delete(String(req.body?.enrolment ?? ""));
    const p = pocketOf(res)!;
    // The enrolment is finished by the channel that started it, or not at all:
    // a relay pairing's passkey and its static key belong to one phone.
    if (!e || e.host !== p.host || e.relayKey !== p.relay?.peerKey) {
      limiter.fail(key);
      return res.status(401).json({ error: "That enrolment is unknown or expired. Pair again from the HUD." });
    }
    let reg;
    try {
      reg = verifyRegistration(req.body?.credential, { challenge: e.challenge, origins: [p.origin], rpId: pocketRpId(p.host) });
    } catch (err) {
      limiter.fail(key);
      return res.status(400).json({ error: `Not enrolled: ${err instanceof WebAuthnError ? err.message : "credential could not be checked"}` });
    }
    const id = b64url(crypto.randomBytes(9));
    const secret = b64url(crypto.randomBytes(32));
    const stamp = new Date(now()).toISOString();
    const device: DeviceRecord = {
      id,
      name: cleanDeviceName(req.body?.name),
      // A relay phone gets no token: it is its channel's key, and an empty
      // hash matches nothing (findDevice refuses relay devices outright).
      tokenHash: p.relay ? "" : sha256(secret),
      created: stamp,
      lastSeen: stamp,
      credentialId: reg.credentialId,
      key: reg.key,
      signCount: reg.signCount,
    };
    let relayToken: string | undefined;
    if (p.relay) {
      // What the phone shows the relay to be let into the room. It opens the
      // door to the room and nothing more: the channel inside still has to
      // prove the phone's static key.
      relayToken = b64url(crypto.randomBytes(32));
      device.via = "relay";
      device.relayKey = p.relay.peerKey;
      device.relayTokenHash = relayHash(relayToken);
    }
    store.devices.push(device);
    save();
    unlock(id); // the finger that enrolled is a fresh verification
    if (p.relay) {
      p.relay.bind(id);
      deps.relay?.()?.devicesChanged();
    } else {
      setCookie(res, p.origin, `${id}.${secret}`, 365 * 24 * 3600);
    }
    deps.notice?.(`A phone was paired with Pocket Claw${p.relay ? " through the relay" : ""}: ${device.name}. Revoke it from POCKET on the HUD if that was not you.`);
    res.json({ ok: true, device: { id, name: device.name }, ...(relayToken ? { relayToken } : {}) });
  });

  api.use(requireDevice);

  api.get("/me", (_req, res) => {
    const d = res.locals.device as DeviceRecord;
    res.json({
      name: d.name,
      claw: deps.clawName?.() ?? "Pocket Claw",
      unlocked: isUnlocked(d.id),
      unlockMinutes: unlockMs / 60_000,
      pending: pending.size,
      push: Boolean(d.push),
      vapidKey: vapidKeys().publicKey,
    });
  });

  api.post("/challenge", (req, res) => {
    const d = res.locals.device as DeviceRecord;
    const purpose = String(req.body?.purpose ?? "") as Purpose;
    if (!["unlock", "approve", "deny", "cancel"].includes(purpose)) return res.status(400).json({ error: "purpose must be unlock, approve, deny or cancel" });
    let subject = "";
    if (purpose === "cancel") {
      // Stopping work is a consequence too. The challenge names the job's
      // full id, so a short id typed on the phone cannot later match another.
      if (!isUnlocked(d.id)) return res.status(423).json({ error: "Locked. Unlock first.", locked: true });
      const job = deps.jobs?.get(String(req.body?.jobId ?? ""));
      if (!job || !deps.jobs?.canCancel(job.id)) return res.status(404).json({ error: "No such job that can be cancelled." });
      subject = job.id;
    } else if (purpose !== "unlock") {
      subject = String(req.body?.approvalId ?? "");
      if (!pending.has(subject)) return res.status(404).json({ error: "No such pending approval." });
    }
    res.json({ publicKey: requestOptions(d, pocketOf(res)!.host, mintChallenge(d.id, purpose, subject)) });
  });

  api.post("/unlock", (req, res) => {
    if (!checkAssertion(req, res, "unlock")) return;
    res.json({ ok: true, unlockMinutes: unlockMs / 60_000 });
  });

  api.post("/lock", (_req, res) => {
    unlockedUntil.delete((res.locals.device as DeviceRecord).id);
    res.json({ ok: true });
  });

  // Visible while locked: the cards are what a notification sends you here for.
  api.get("/approvals", (_req, res) => {
    res.json({ approvals: [...pending.values()] });
  });

  api.post("/approvals/:id", (req, res) => {
    const id = String(req.params.id ?? "");
    const approved = req.body?.approved === true;
    if (!pending.has(id)) return res.status(404).json({ error: "No such pending approval — it may have been answered elsewhere or timed out." });
    if (!checkAssertion(req, res, approved ? "approve" : "deny", id)) return;
    if (!deps.settleApproval(id, approved)) return res.status(404).json({ error: "That approval was settled a moment ago." });
    const d = res.locals.device as DeviceRecord;
    deps.notice?.(`${approved ? "Approved" : "Denied"} from Pocket Claw (${d.name}).`);
    res.json({ ok: true });
  });

  api.get("/events", (req, res) => {
    const d = res.locals.device as DeviceRecord;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify({ unlocked: isUnlocked(d.id) })}\n\n`);
    const s = { res, deviceId: d.id };
    streams.add(s);
    const keepalive = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(keepalive);
      streams.delete(s);
    });
  });

  api.get("/history", requireUnlocked, (_req, res) => {
    // Leaving the machine: redacted like broadcast, and only the recent end.
    res.json({ turns: redactDeep(deps.history().slice(-40)) });
  });

  api.post("/chat", requireUnlocked, (req, res) => {
    const out = deps.chat(String(req.body?.message ?? ""));
    res.status(out.status).json(out.body);
  });

  api.post("/upload", express.json({ limit: "30mb" }), requireUnlocked, (req, res) => {
    // A receipt is filed, never chatted about: that is POST /receipt.
    if (req.body?.intent === "receipt") return res.status(400).json({ error: "Receipts are filed with File as receipt, not attached to the chat." });
    const data = String(req.body?.data ?? "");
    if (!data) return res.status(400).json({ error: "No file." });
    if (data.length > Math.ceil(MAX_UPLOAD / 3) * 4) return res.status(413).json({ error: "That file is over 20MB." });
    const buf = Buffer.from(data, "base64");
    const ext = sniffKind(buf);
    if (!ext) return res.status(415).json({ error: "Pocket Claw takes photos (JPEG, PNG, WebP, HEIC) and PDFs." });
    fs.mkdirSync(deps.uploadsDir, { recursive: true });
    const file = path.join(deps.uploadsDir, shareFileName(ext, new Date(now())));
    fs.writeFileSync(file, buf, { flag: "wx" });
    const intent = String(req.body?.intent ?? "keep");
    const shown = collapseHomeIn(file);
    if (intent === "keep") return res.json({ ok: true, path: shown });
    const out = deps.chat(shareMessage(file, String(req.body?.note ?? "").slice(0, 2000)));
    res.status(out.status).json({ ...(out.body as object), path: shown });
  });

  // --- Receipts: the Telegram flow's filing path, no turn in between -----------------

  api.post("/receipt", express.json({ limit: "30mb" }), requireUnlocked, async (req, res) => {
    const d = res.locals.device as DeviceRecord;
    const data = String(req.body?.data ?? "");
    if (!data) return res.status(400).json({ error: "No photo." });
    if (data.length > Math.ceil(MAX_UPLOAD / 3) * 4) return res.status(413).json({ error: "That photo is over 20MB." });
    let filed: Filed;
    try {
      filed = await fileReceipt({
        bytes: Buffer.from(data, "base64"),
        note: String(req.body?.note ?? ""),
        source: "pocket",
        at: new Date(now()),
        root: deps.receipts?.root,
        desk: deps.receipts?.desk,
        read: deps.receipts?.read,
      });
    } catch (err) {
      // Not JPEG or PNG (a PDF, a HEIC), or too large: nothing was filed.
      return res.status(415).json({ error: `Not filed: ${String((err as Error)?.message ?? err)}. Attach it to the chat instead.` });
    }
    d.receipts = [...(d.receipts ?? []), filed.receipt.id].slice(-RECEIPTS_REMEMBERED);
    save();
    // The HUD hears that one was filed, not what it says: the supplier was
    // read off a stranger's slip and has no business in a notice.
    deps.notice?.(`Receipt ${filed.receipt.id} filed from Pocket Claw (${d.name}).`);
    res.json({ ok: true, receipt: filedView(filed) });
  });

  /**
   * "total £12.40, supplier Tesco" — the operator's own words, parsed and
   * applied with no model in between, as Telegram's "fix that:" is. Only a
   * receipt this phone filed: a paired phone corrects its own slips, not the
   * whole ledger.
   */
  api.post("/receipts/:id/fix", requireUnlocked, (req, res) => {
    const d = res.locals.device as DeviceRecord;
    const id = String(req.params.id ?? "");
    if (!/^R-\d{1,6}$/.test(id) || !(d.receipts ?? []).includes(id)) {
      return res.status(404).json({ error: "This phone did not file that receipt." });
    }
    const changes = parseFixText(String(req.body?.text ?? "").slice(0, 500));
    if (typeof changes === "string") return res.status(400).json({ error: `Not changed: ${changes}.` });
    const out = applyFix(id, changes, { root: deps.receipts?.root, desk: deps.receipts?.desk, at: new Date(now()) });
    if ("error" in out) return res.status(404).json({ error: `Not changed: ${out.error}.` });
    res.json({ ok: true, changed: out.changed, receipt: { id: out.receipt.id, line: summaryLine(out.receipt), status: out.receipt.status, warning: "" } });
  });

  // --- Jobs: mission control's list, and Cancel behind a fresh fingerprint -------------

  api.get("/jobs", requireUnlocked, (_req, res) => {
    const list = deps.jobs?.list() ?? [];
    res.json(redactDeep({ jobs: list.slice(0, 30).map((j) => jobView(j, deps.jobs!.canCancel(j.id))) }));
  });

  api.post("/jobs/:id/cancel", requireUnlocked, async (req, res) => {
    const job = deps.jobs?.get(String(req.params.id ?? ""));
    if (!job) return res.status(404).json({ error: "No such job." });
    if (!checkAssertion(req, res, "cancel", job.id)) return;
    const out = await deps.jobs!.cancel(job.id);
    const d = res.locals.device as DeviceRecord;
    if (out.ok) deps.notice?.(`Job ${shortId(job.id)} cancelled from Pocket Claw (${d.name}).`);
    const now2 = deps.jobs!.get(job.id);
    res.status(out.ok ? 200 : 409).json(redactDeep({ ...out, job: now2 ? jobView(now2, deps.jobs!.canCancel(now2.id)) : null }));
  });

  api.post("/listen", requireUnlocked, async (req, res) => {
    if (!deps.listen || !deps.readBody) return res.status(503).json({ error: "Local ears are not set up on the claw. Run ./setup-ears.sh there." });
    try {
      const body = await deps.readBody(req, 10_000_000);
      if (!body) {
        res.set("Connection", "close");
        return res.status(413).json({ error: "That recording is too long." });
      }
      const heard = await deps.listen(body);
      res.json({ text: heard.text });
    } catch (err) {
      const status = typeof (err as { status?: number })?.status === "number" ? (err as { status: number }).status : 500;
      res.status(status).json({ error: String((err as Error)?.message ?? err) });
    }
  });

  api.post("/push", requireUnlocked, (req, res) => {
    const sub = validSubscription(req.body?.subscription);
    if (!sub) return res.status(400).json({ error: "That is not a push subscription from a known push service." });
    (res.locals.device as DeviceRecord).push = sub;
    save();
    res.json({ ok: true });
  });

  api.delete("/push", (req, res) => {
    delete (res.locals.device as DeviceRecord).push;
    save();
    res.json({ ok: true });
  });

  api.use((_req, res) => res.status(404).json({ error: "No such Pocket route." }));

  phone.use("/pocket/api", api);

  // The share target's POST is caught by the service worker. One that reaches
  // the server means the worker was not installed yet; say so rather than
  // parse a multipart body this module has no parser for.
  phone.post("/pocket/share", (_req, res) => res.redirect(303, "/pocket/#share-unavailable"));

  if (deps.staticDir) {
    phone.use("/pocket", express.static(deps.staticDir, {
      index: "index.html",
      setHeaders(res, file) {
        res.setHeader("Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
          "connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
        // The worker must be re-checked on every load, or a fix to it waits a day.
        if (file.endsWith("sw.js") || file.endsWith(".html") || file.endsWith(".webmanifest")) res.setHeader("Cache-Control", "no-cache");
      },
    }));
  }

  // --- The HUD's routes (/api/pocket/..., behind requireAuth) -----------------------------

  const admin = express.Router();

  const devicesView = () => store.devices.map((d) => ({
    id: d.id,
    name: d.name,
    created: d.created,
    lastSeen: d.lastSeen,
    push: Boolean(d.push),
    unlocked: isUnlocked(d.id),
    via: d.via === "relay" ? "relay" : "tailnet",
  }));

  admin.get("/", (_req, res) => {
    sweep();
    res.json({
      hosts: hosts(),
      savedHost: store.host ?? "",
      devices: devicesView(),
      pairingExpires: pairing ? new Date(pairing.expires).toISOString() : null,
      // null: the relay is switched off in claw.config.json, or has no URL.
      relay: deps.relay?.()?.status() ?? null,
    });
  });

  admin.post("/host", (req, res) => {
    const raw = String(req.body?.host ?? "").trim();
    if (!raw) {
      delete store.host;
      save();
      return res.json({ ok: true, hosts: hosts() });
    }
    const h = normalisePocketHost(raw);
    if (!h) return res.status(400).json({ error: "That is not a host name. It looks like claw-desk.tail1a2b3c.ts.net — `tailscale serve status` prints it." });
    store.host = h;
    save();
    res.json({ ok: true, hosts: hosts() });
  });

  admin.post("/pair", (req, res) => {
    // 144 random bits: the code, and through the relay the psk and the ticket derived from it.
    const code = b64url(crypto.randomBytes(18));
    const expires = now() + pairingMs;
    if (req.body?.mode === "relay") {
      const hooks = deps.relay?.();
      if (!hooks) return res.status(409).json({ error: "The relay is switched off (pocket.relay in claw.config.json). Use the private network instead." });
      // One live code at a time: a new one cancels the last, on either path.
      endPairing();
      const link = hooks.pairingLink(code, expires);
      if ("error" in link) return res.status(503).json({ error: link.error });
      pairing = { hash: sha256(code), expires, mode: "relay" };
      return res.json({ mode: "relay", url: link.url, expiresAt: new Date(expires).toISOString(), qr: qrRows(encodeQr(link.url, { ecl: "M" })) });
    }
    const h = hosts()[0];
    if (!h) return res.status(409).json({ error: "Tell the claw its tailnet address first." });
    endPairing();
    pairing = { hash: sha256(code), expires, mode: "direct" };
    const url = `${pocketOrigin(h)}/pocket/#pair=${code}`;
    res.json({ mode: "tailnet", url, host: h, expiresAt: new Date(pairing.expires).toISOString(), qr: qrRows(encodeQr(url, { ecl: "M" })) });
  });

  admin.delete("/pair", (_req, res) => {
    endPairing();
    res.json({ ok: true });
  });

  admin.delete("/devices/:id", (req, res) => {
    if (!revoke(String(req.params.id ?? ""))) return res.status(404).json({ error: "No such device." });
    res.json({ ok: true, devices: devicesView() });
  });

  return {
    phone,
    admin,
    onEvent,
    hosts,
    status: () => ({ devices: store.devices.length, hosts: hosts(), pending: pending.size }),
    /** For the relay transport: the phones it may admit, and the keys their channels must prove. */
    relayDevices: () => store.devices.filter((d) => d.via === "relay" && d.relayKey && d.relayTokenHash)
      .map((d) => ({ id: d.id, relayKey: d.relayKey!, relayTokenHash: d.relayTokenHash! })),
    /** For the relay transport: whether a relay pairing is live right now. */
    relayPairingLive: () => {
      sweep();
      return pairing?.mode === "relay" && pairing.expires >= now();
    },
    /** For tests: the claw's VAPID public key, so a test can check what was pushed. */
    vapidPublicKey: () => vapidKeys().publicKey,
  };
}
