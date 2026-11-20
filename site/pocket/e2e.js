// Pocket's end-to-end channel, the phone's half, on WebCrypto alone. The
// claw's half is src/pocket-e2e.ts on node:crypto; docs/POCKET-RELAY.md is
// the specification both follow, and the claw's tests run this very file
// against that one, so the two cannot drift apart unnoticed.
//
// What the phone checks: the claw's static key is the one the QR named (by
// its SHA-256) or the one pinned at pairing; the claw's MAC proves it holds
// that key's private half, and while pairing, that it knows the one-time
// code too. A relay that swaps a key, moves the handshake to another room,
// or replays, reorders or alters a record is caught here.
//
// The phone's static private key is generated non-extractable: script on
// this page can use it, but nothing can read it out, not even this file.

const PROTOCOL = "cc-pocket e2e v1";
const KEYS_INFO = `${PROTOCOL} keys`;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const RECORD_AAD = enc.encode("cc-pocket rec v1");
export const MAX_FRAGMENT = 128 * 1024;
export const MAX_MESSAGE = 40 * 1024 * 1024;

const subtle = () => globalThis.crypto.subtle;

export class E2EError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function b64u(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s, what, len) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new E2EError("format", `${what} is not base64url`);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (len !== undefined && out.length !== len) throw new E2EError("format", `${what} must be ${len} bytes`);
  return out;
}

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const sha256 = async (...parts) => new Uint8Array(await subtle().digest("SHA-256", concat(...parts.map((p) => (typeof p === "string" ? enc.encode(p) : p)))));

function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** A key pair for ECDH. The private half never leaves WebCrypto. */
export async function generateKey() {
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, pub: new Uint8Array(await subtle().exportKey("raw", pair.publicKey)) };
}

async function importPoint(raw, what) {
  if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 0x04) throw new E2EError("key", `${what} is not an uncompressed P-256 point`);
  try {
    // importKey validates that the point is on the curve.
    return await subtle().importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    throw new E2EError("key", `${what} is not a point on P-256`);
  }
}

async function dh(privateKey, peerRaw, what) {
  const pub = await importPoint(peerRaw, what);
  return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: pub }, privateKey, 256));
}

export const fingerprint = async (pub) => b64u(await sha256(pub));
export const pairingPsk = (code) => sha256("cc-relay psk v1\0", code);
export const pairingTicket = async (code) => b64u(await sha256("cc-relay ticket v1\0", code));

const transcript = (mode, room, clawPub, phonePub, ePhone, eClaw) =>
  sha256(PROTOCOL, "\0", mode, "\0", room, "\0", clawPub, phonePub, ePhone, eClaw);

async function deriveKeys(ee, es, se, psk, th) {
  const ikm = await subtle().importKey("raw", concat(ee, es, se), "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: psk || new Uint8Array(32), info: concat(enc.encode(KEYS_INFO), th) }, ikm, 1024));
  return { p2c: okm.slice(0, 32), c2p: okm.slice(32, 64), macClaw: okm.slice(64, 96), macPhone: okm.slice(96, 128), th };
}

const hmacKey = (raw) => subtle().importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

// --- Records ---------------------------------------------------------------------------

function nonce(n) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(n));
  return iv;
}

/**
 * An established channel. Each record's nonce is its place in the stream,
 * never sent, so the next record must be exactly the next one the claw
 * sealed. The first failure kills the session; the app reconnects and
 * handshakes afresh.
 */
export class Session {
  constructor(sendKey, recvKey) {
    this.txKey = sendKey;
    this.rxKey = recvKey;
    this.tx = 0;
    this.rx = 0;
    this.parts = [];
    this.size = 0;
    this.dead = false;
    // Records must be opened strictly in order; WebCrypto is async, so each
    // open waits for the one before it.
    this.queue = Promise.resolve();
  }

  static async create(sendRaw, recvRaw) {
    const imp = (raw, use) => subtle().importKey("raw", raw, "AES-GCM", false, [use]);
    return new Session(await imp(sendRaw, "encrypt"), await imp(recvRaw, "decrypt"));
  }

  async seal(message) {
    if (this.dead) throw new E2EError("dead", "session is closed");
    const bytes = enc.encode(JSON.stringify(message));
    const out = [];
    // Nonces are claimed synchronously, so two seals in flight never share one.
    const jobs = [];
    for (let off = 0; off === 0 || off < bytes.length; off += MAX_FRAGMENT) {
      const fin = off + MAX_FRAGMENT >= bytes.length;
      const plain = concat(new Uint8Array([fin ? 1 : 0]), bytes.subarray(off, off + MAX_FRAGMENT));
      jobs.push(subtle().encrypt({ name: "AES-GCM", iv: nonce(this.tx++), additionalData: RECORD_AAD }, this.txKey, plain));
    }
    for (const j of jobs) out.push(b64u(new Uint8Array(await j)));
    return out;
  }

  /** Resolves to the message a record completes, or undefined while one is still arriving. */
  open(record) {
    const run = this.queue.then(() => this.openNow(record));
    this.queue = run.catch(() => {});
    return run;
  }

  async openNow(record) {
    if (this.dead) throw new E2EError("dead", "session is closed");
    try {
      const sealed = unb64u(record, "record");
      if (sealed.length < 17) throw new E2EError("record", "record too short");
      let plain;
      try {
        plain = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: nonce(this.rx++), additionalData: RECORD_AAD }, this.rxKey, sealed));
      } catch {
        throw new E2EError("record", "a record failed to authenticate: tampered, replayed, reordered or dropped");
      }
      if (plain.length < 1 || plain[0] > 1) throw new E2EError("record", "bad fragment flags");
      this.size += plain.length - 1;
      if (this.size > MAX_MESSAGE) throw new E2EError("size", "message too large");
      this.parts.push(plain.subarray(1));
      if (plain[0] !== 1) return undefined;
      const whole = concat(...this.parts);
      this.parts = [];
      this.size = 0;
      try {
        return JSON.parse(dec.decode(whole));
      } catch {
        throw new E2EError("format", "message is not JSON");
      }
    } catch (err) {
      this.dead = true;
      throw err;
    }
  }
}

// --- The handshake, the phone's side ------------------------------------------------------

/**
 * Start a handshake. `mode` is "pair" (with `psk` from the QR's code and
 * `clawFingerprint` from the QR) or "session" (with `clawKey`, pinned at
 * pairing). `phone` is this phone's static key from generateKey().
 * Returns hs1 to send, and finish(hs2) which checks the claw and returns
 * { reply: hs3, session, clawKey }.
 */
export async function initiate({ mode, room, phone, psk, clawKey, clawFingerprint, ephemeral }) {
  if (mode !== "pair" && mode !== "session") throw new E2EError("format", "mode must be pair or session");
  if (mode === "pair" && (!psk || !clawFingerprint)) throw new E2EError("pairing", "pairing needs the code and the claw's fingerprint");
  if (mode === "session" && !(clawKey instanceof Uint8Array)) throw new E2EError("state", "no pinned claw key");
  const e = ephemeral || await generateKey();
  const hello = JSON.stringify({ t: "hs1", v: 1, mode, room, e: b64u(e.pub), s: b64u(phone.pub) });
  let used = false;
  return {
    hello,
    async finish(raw) {
      if (used) throw new E2EError("state", "handshake already finished");
      used = true;
      let m = null;
      try { m = typeof raw === "string" ? JSON.parse(raw) : null; } catch { /* below */ }
      if (!m || m.t !== "hs2") throw new E2EError("format", "expected hs2");
      const eClaw = unb64u(m.e, "claw ephemeral key", 65);
      const ck = unb64u(m.ck, "claw static key", 65);
      // The key the claw claims must be the one this phone already trusts.
      if (mode === "pair" ? (await fingerprint(ck)) !== clawFingerprint : !equal(ck, clawKey)) {
        throw new E2EError("key", "the claw's key is not the one this phone trusts: the relay, or something on the way, substituted it");
      }
      await importPoint(ck, "claw static key");
      const th = await transcript(mode, room, ck, phone.pub, e.pub, eClaw);
      const keys = await deriveKeys(
        await dh(e.privateKey, eClaw, "claw ephemeral key"),
        await dh(e.privateKey, ck, "claw static key"),
        await dh(phone.privateKey, eClaw, "claw ephemeral key"),
        mode === "pair" ? psk : null,
        th,
      );
      const macClaw = await hmacKey(keys.macClaw);
      const ok = await subtle().verify("HMAC", macClaw, unb64u(m.mac, "claw MAC", 32), concat(enc.encode("claw"), th));
      if (!ok) throw new E2EError("mac", "the claw's handshake MAC is wrong: wrong pairing code, wrong room, or tampered on the way");
      const macPhone = await hmacKey(keys.macPhone);
      const mine = new Uint8Array(await subtle().sign("HMAC", macPhone, concat(enc.encode("phone"), th)));
      return { reply: JSON.stringify({ t: "hs3", mac: b64u(mine) }), session: await Session.create(keys.p2c, keys.c2p), clawKey: ck };
    },
  };
}
