import crypto from "node:crypto";

/**
 * Pocket's end-to-end channel, the claw's half (the phone's half is
 * public/pocket/e2e.js, on WebCrypto; the tests run one against the other).
 * docs/POCKET-RELAY.md is the specification; this file must match it.
 *
 * Why it exists: in relay mode every byte between the phone and the claw
 * passes through a server Dragon Forge runs. That server must be able to
 * carry the bytes and nothing else — not read them, not change them, not
 * replay them, not stand in the middle of the handshake. TLS to the relay
 * does not give that (the relay terminates it), so the two ends agree keys
 * of their own:
 *
 *   - Three ECDH P-256 shares, ee + es + se (Noise KK's shape, "3DH"): only
 *     the holder of the claw's static private key can compute es, only the
 *     holder of the phone's can compute se, and ee gives forward secrecy.
 *   - Pairing mixes in a pre-shared key derived from the one-time code the
 *     HUD shows in its QR. The relay never sees that code, so it cannot
 *     complete a pairing handshake with either end and swap in its own key.
 *   - Both static keys, the mode and the room id go into the transcript hash
 *     that keys and MACs are derived over, so a handshake moved to another
 *     room, or a key substituted on the way, fails the MAC.
 *   - Records are AES-256-GCM with a separate key per direction and an
 *     implicit counter per direction: a dropped, replayed, reordered or
 *     reflected record does not decrypt, and the channel closes.
 *
 * A leaf: node:crypto only, no imports from the rest of the claw.
 */

export const PROTOCOL = "cc-pocket e2e v1";
const KEYS_INFO = `${PROTOCOL} keys`;
const RECORD_AAD = Buffer.from("cc-pocket rec v1");
const ZERO_SALT = Buffer.alloc(32);

/** A record's plaintext fragment: 128 KiB, so a framed record stays well under the relay's frame cap. */
export const MAX_FRAGMENT = 128 * 1024;
/** One application message, reassembled. A 20MB photo is ~27MB of base64 inside its JSON body. */
export const MAX_MESSAGE = 40 * 1024 * 1024;
/** GCM with 96-bit nonces is safe far beyond this; the cap keeps the counter honest. */
const MAX_RECORDS = 2 ** 32;

export class E2EError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

export function unb64u(s: unknown, what: string, len?: number): Buffer {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new E2EError("format", `${what} is not base64url`);
  const b = Buffer.from(s, "base64url");
  if (len !== undefined && b.length !== len) throw new E2EError("format", `${what} must be ${len} bytes`);
  return b;
}

export interface StaticKey {
  /** The 32-byte private scalar. */
  priv: Buffer;
  /** The uncompressed point, 65 bytes, as WebCrypto's exportKey("raw") gives it. */
  pub: Buffer;
}

export function generateKey(): StaticKey {
  const e = crypto.createECDH("prime256v1");
  e.generateKeys();
  return { priv: e.getPrivateKey(), pub: e.getPublicKey(null, "uncompressed") };
}

/** A peer's public key: an uncompressed P-256 point, checked to be on the curve. */
export function checkPoint(raw: Buffer, what: string): Buffer {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new E2EError("key", `${what} is not an uncompressed P-256 point`);
  try {
    // createPublicKey refuses a point that is not on the curve; an off-curve
    // point is the classic way to make ECDH leak bits of the private key.
    crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: "jwk" });
  } catch {
    throw new E2EError("key", `${what} is not a point on P-256`);
  }
  return raw;
}

function dh(priv: Buffer, peer: Buffer): Buffer {
  const e = crypto.createECDH("prime256v1");
  e.setPrivateKey(priv);
  return e.computeSecret(peer);
}

const sha256 = (...parts: (Buffer | string)[]) => {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** The fingerprint the QR carries in place of the claw's whole key: SHA-256 of the raw point. */
export const fingerprint = (pub: Buffer): string => b64u(sha256(pub));

/**
 * The transcript hash. Every field is fixed-length or NUL-terminated, so no
 * two different handshakes can hash the same bytes.
 */
export function transcript(mode: string, room: string, clawPub: Buffer, phonePub: Buffer, ePhone: Buffer, eClaw: Buffer): Buffer {
  return sha256(PROTOCOL, "\0", mode, "\0", room, "\0", clawPub, phonePub, ePhone, eClaw);
}

export interface Keys { p2c: Buffer; c2p: Buffer; macClaw: Buffer; macPhone: Buffer; th: Buffer }

export function deriveKeys(ee: Buffer, es: Buffer, se: Buffer, psk: Buffer | null, th: Buffer): Keys {
  const okm = Buffer.from(crypto.hkdfSync("sha256", Buffer.concat([ee, es, se]), psk ?? ZERO_SALT, Buffer.concat([Buffer.from(KEYS_INFO), th]), 128));
  return { p2c: okm.subarray(0, 32), c2p: okm.subarray(32, 64), macClaw: okm.subarray(64, 96), macPhone: okm.subarray(96, 128), th };
}

const hmac = (key: Buffer, label: string, th: Buffer) => crypto.createHmac("sha256", key).update(label).update(th).digest();

// --- Pairing-code derivations ------------------------------------------------------

/** The psk the pairing handshake mixes in. The relay is never told the code, so it cannot compute this. */
export const pairingPsk = (code: string): Buffer => sha256("cc-relay psk v1\0", code);
/** What the phone shows the relay to be let into the room while pairing. Reveals nothing about the code. */
export const pairingTicket = (code: string): string => b64u(sha256("cc-relay ticket v1\0", code));
/** The relay stores hashes of tickets and phone tokens, never the values themselves. */
export const relayHash = (value: string): string => b64u(sha256("cc-relay hash v1\0", value));
/** A claw's room is a commitment to its secret: nobody can claim a room id without knowing the preimage. */
export const roomIdFor = (secret: Buffer): string => b64u(sha256("cc-relay room v1\0", secret));

// --- The record layer ----------------------------------------------------------------

/**
 * One direction's keys and counter. The nonce is the counter itself, never
 * sent: the receiver knows which record it expects next, so anything else —
 * a replay, a reorder, a dropped record, our own record reflected back —
 * fails to authenticate.
 */
class Direction {
  n = 0;
  constructor(private key: Buffer) {}
  nonce(): Buffer {
    if (this.n >= MAX_RECORDS) throw new E2EError("exhausted", "record counter exhausted; reconnect");
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(BigInt(this.n), 4);
    this.n++;
    return iv;
  }
  seal(plain: Buffer): Buffer {
    const c = crypto.createCipheriv("aes-256-gcm", this.key, this.nonce());
    c.setAAD(RECORD_AAD);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }
  open(sealed: Buffer): Buffer {
    if (sealed.length < 17) throw new E2EError("record", "record too short");
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, this.nonce());
    d.setAAD(RECORD_AAD);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    try {
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
    } catch {
      throw new E2EError("record", "a record failed to authenticate: tampered, replayed, reordered or dropped");
    }
  }
}

/**
 * An established channel. Application messages are JSON, split into
 * fragments; the first byte of each fragment says whether it is the last.
 * Once a record fails, the session is dead: there is no resynchronising
 * with a relay that has shown it will tamper.
 */
export class Session {
  private tx: Direction;
  private rx: Direction;
  private parts: Buffer[] = [];
  private size = 0;
  dead = false;
  constructor(sendKey: Buffer, recvKey: Buffer, private maxMessage = MAX_MESSAGE) {
    this.tx = new Direction(sendKey);
    this.rx = new Direction(recvKey);
  }

  /** One message out, as the records to send in order. */
  seal(message: unknown): string[] {
    if (this.dead) throw new E2EError("dead", "session is closed");
    const bytes = Buffer.from(JSON.stringify(message));
    const out: string[] = [];
    for (let off = 0; off === 0 || off < bytes.length; off += MAX_FRAGMENT) {
      const chunk = bytes.subarray(off, off + MAX_FRAGMENT);
      const fin = off + MAX_FRAGMENT >= bytes.length;
      out.push(b64u(this.tx.seal(Buffer.concat([Buffer.from([fin ? 1 : 0]), chunk]))));
    }
    return out;
  }

  /** One record in. Returns the message it completes, or undefined while one is still arriving. */
  open(record: unknown): unknown {
    if (this.dead) throw new E2EError("dead", "session is closed");
    try {
      const plain = this.rx.open(unb64u(record, "record"));
      if (plain.length < 1 || plain[0] > 1) throw new E2EError("record", "bad fragment flags");
      this.size += plain.length - 1;
      if (this.size > this.maxMessage) throw new E2EError("size", "message too large");
      this.parts.push(plain.subarray(1));
      if (plain[0] !== 1) return undefined;
      const whole = Buffer.concat(this.parts);
      this.parts = [];
      this.size = 0;
      try {
        return JSON.parse(whole.toString("utf8"));
      } catch {
        throw new E2EError("format", "message is not JSON");
      }
    } catch (err) {
      this.dead = true;
      throw err;
    }
  }
}

// --- The handshake, the claw's side -------------------------------------------------------

export type Mode = "pair" | "session";

export interface Hello {
  mode: Mode;
  room: string;
  ePhone: Buffer;
  phonePub: Buffer;
}

/** hs1, as the phone sent it, checked for shape and for points on the curve. */
export function parseHello(raw: unknown): Hello {
  let m: any;
  try {
    m = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch { /* falls through */ }
  if (!m || m.t !== "hs1") throw new E2EError("format", "expected hs1");
  if (m.v !== 1) throw new E2EError("version", "unsupported protocol version");
  if (m.mode !== "pair" && m.mode !== "session") throw new E2EError("format", "mode must be pair or session");
  if (typeof m.room !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(m.room)) throw new E2EError("format", "bad room id");
  const ePhone = checkPoint(unb64u(m.e, "phone ephemeral key", 65), "phone ephemeral key");
  const phonePub = checkPoint(unb64u(m.s, "phone static key", 65), "phone static key");
  if (ePhone.equals(phonePub)) throw new E2EError("key", "ephemeral and static keys must differ");
  return { mode: m.mode, room: m.room, ePhone, phonePub };
}

export interface Responder {
  /** hs2, to send back. */
  reply: string;
  /** Check hs3: the phone's MAC. Returns the live session, or throws. */
  finish(raw: unknown): Session;
}

/**
 * Answer a checked hs1. The caller has already decided this phone may try:
 * for a session, its static key is a paired relay device's; for pairing, a
 * relay pairing is live and `psk` is derived from its code. Every check that
 * can fail on the claw's side fails here or in finish(), before any request
 * is dispatched.
 */
export function respond(hello: Hello, opts: { room: string; claw: StaticKey; psk: Buffer | null; ephemeral?: StaticKey }): Responder {
  if (hello.room !== opts.room) throw new E2EError("room", "this handshake is for another room");
  if (hello.mode === "pair" && !opts.psk) throw new E2EError("pairing", "no pairing is live");
  if (hello.phonePub.equals(opts.claw.pub)) throw new E2EError("key", "the phone presented the claw's own key");
  const e = opts.ephemeral ?? generateKey();
  const th = transcript(hello.mode, opts.room, opts.claw.pub, hello.phonePub, hello.ePhone, e.pub);
  const keys = deriveKeys(dh(e.priv, hello.ePhone), dh(opts.claw.priv, hello.ePhone), dh(e.priv, hello.phonePub), hello.mode === "pair" ? opts.psk : null, th);
  const reply = JSON.stringify({ t: "hs2", e: b64u(e.pub), ck: b64u(opts.claw.pub), mac: b64u(hmac(keys.macClaw, "claw", th)) });
  let used = false;
  return {
    reply,
    finish(raw) {
      if (used) throw new E2EError("state", "handshake already finished");
      used = true;
      let m: any;
      try {
        m = typeof raw === "string" ? JSON.parse(raw) : null;
      } catch { /* falls through */ }
      if (!m || m.t !== "hs3") throw new E2EError("format", "expected hs3");
      const got = unb64u(m.mac, "phone MAC", 32);
      const want = hmac(keys.macPhone, "phone", th);
      if (!crypto.timingSafeEqual(got, want)) throw new E2EError("mac", "the phone's handshake MAC is wrong: wrong key, wrong pairing code, or tampered on the way");
      return new Session(keys.c2p, keys.p2c);
    },
  };
}
