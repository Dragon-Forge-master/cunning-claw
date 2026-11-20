import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./redact.js";

/**
 * Web Push, sender side, on node:crypto alone: RFC 8291 message encryption
 * (ECDH P-256 + HKDF-SHA-256 into the RFC 8188 aes128gcm content coding) and
 * RFC 8292 VAPID (an ES256 JWT naming this claw to the push service).
 *
 * What is pushed is a count and a short label — "2 approvals waiting" — and
 * never the summary or the detail of a card. A notification is shown on a
 * locked phone's screen to whoever is holding it, and it passes through
 * Google's or Mozilla's push service on the way; the card itself is fetched
 * from home after the phone is unlocked. ntfy (src/ntfy.ts) stays as the
 * fallback for anyone without a paired phone.
 */

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * The push services a browser hands out endpoints for. The endpoint is
 * written by the phone, so without this list a paired device could make the
 * claw POST to any URL — its router, a cloud metadata address, a webhook.
 */
const PUSH_HOSTS: (string | RegExp)[] = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
  "web.push.apple.com",
  /^[a-z0-9-]+\.push\.apple\.com$/,
];

export function validSubscription(raw: unknown): PushSubscription | null {
  const s = raw as PushSubscription;
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase();
  if (!PUSH_HOSTS.some((h) => (typeof h === "string" ? h === host : h.test(host)))) return null;
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  const pub = Buffer.from(p256dh, "base64url");
  const sec = Buffer.from(auth, "base64url");
  if (pub.length !== 65 || pub[0] !== 0x04 || sec.length !== 16) return null;
  if (!onCurve(pub)) return null;
  return { endpoint: url.toString(), keys: { p256dh, auth } };
}

/** RFC 8291 §7: the receiver's key must be a point on P-256, or ECDH leaks ours. */
function onCurve(uncompressed: Buffer): boolean {
  try {
    crypto.createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64u(uncompressed.subarray(1, 33)), y: b64u(uncompressed.subarray(33, 65)) },
      format: "jwk",
    });
    return true;
  } catch {
    return false;
  }
}

// --- RFC 8291 + RFC 8188 ---------------------------------------------------------

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, len));
}

export interface EncryptInputs {
  /** The application server's ephemeral key pair; random per message unless a test fixes it. */
  senderPrivate?: Buffer;
  salt?: Buffer;
  recordSize?: number;
}

/**
 * Encrypt one push message for a subscription. The body is the whole
 * aes128gcm payload: header (salt, record size, key id = our public key)
 * then a single record whose plaintext ends with the 0x02 delimiter.
 */
export function encryptPayload(plaintext: Buffer, sub: PushSubscription, opts: EncryptInputs = {}): Buffer {
  const uaPublic = Buffer.from(sub.keys.p256dh, "base64url");
  const authSecret = Buffer.from(sub.keys.auth, "base64url");
  const ecdh = crypto.createECDH("prime256v1");
  if (opts.senderPrivate) ecdh.setPrivateKey(opts.senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = opts.salt ?? crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const rs = opts.recordSize ?? 4096;
  // One record: plaintext + delimiter + tag must fit, or the push service drops it.
  if (plaintext.length + 1 + 16 > rs) throw new Error("push payload larger than one record");
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** The inverse, for tests and for the receiving side of the RFC vector. */
export function decryptPayload(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const ikm = hkdf(authSecret, ecdh.computeSecret(asPublic), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const rec = body.subarray(21 + idlen);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(rec.subarray(rec.length - 16));
  const padded = Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 0x02) throw new Error("not a last record");
  return padded.subarray(0, end);
}

// --- RFC 8292 VAPID -------------------------------------------------------------

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url — the applicationServerKey the phone subscribes with. */
  publicKey: string;
  /** The private scalar d, base64url. Lives in data/pocket/vapid.json, mode 600. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** Load the claw's VAPID pair, making one the first time. */
export function loadVapidKeys(dir: string): VapidKeys {
  const file = path.join(dir, "vapid.json");
  try {
    const k = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof k.publicKey === "string" && typeof k.privateKey === "string") return k;
  } catch { /* first run */ }
  const k = generateVapidKeys();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
  return k;
}

function vapidSigningKey(keys: VapidKeys): crypto.KeyObject {
  const pub = Buffer.from(keys.publicKey, "base64url");
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

/** The Authorization header value: `vapid t=<JWT>, k=<public key>` (RFC 8292 §3). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const aud = new URL(endpoint).origin;
  const enc = (o: unknown) => b64u(Buffer.from(JSON.stringify(o)));
  // 12 hours: the RFC caps exp at 24h, and a push service may reject one near the cap.
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud, exp: nowSec + 12 * 3600, sub: subject })}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: vapidSigningKey(keys), dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${keys.publicKey}`;
}

// --- Sending ---------------------------------------------------------------------

export interface PushMessage {
  /** Short, lock-screen-safe: a count and a label, never a card's text. */
  title: string;
  body: string;
  /** Same tag replaces the earlier notification instead of stacking. */
  tag: string;
  url: string;
  count?: number;
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; status: number; error?: string };

/**
 * Send one message. `gone` means the push service has forgotten the
 * subscription (404/410) and it should be dropped. The message is redacted
 * like everything else that leaves the machine, though it should never carry
 * anything to redact.
 */
export async function sendPush(
  sub: PushSubscription,
  msg: PushMessage,
  keys: VapidKeys,
  subject: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  const clean: PushMessage = { ...msg, title: redact(msg.title).slice(0, 60), body: redact(msg.body).slice(0, 120) };
  const body = encryptPayload(Buffer.from(JSON.stringify(clean)), sub);
  try {
    const res = await fetchImpl(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(sub.endpoint, keys, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // An approval left for an hour has timed out at home anyway.
        TTL: "3600",
        Urgency: "high",
        Topic: clean.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "claw",
      },
      body: new Uint8Array(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, gone: res.status === 404 || res.status === 410, status: res.status };
  } catch (err) {
    return { ok: false, gone: false, status: 0, error: String((err as Error)?.message ?? err) };
  }
}
