// The Pocket relay's room: one claw, its phones, and the frames between them.
//
// This file is the whole of the relay's judgement. worker.js is a thin
// Cloudflare wrapper around it (a Durable Object per room, the WebSocket
// Hibernation API), and the claw's tests run this same file in Node with
// in-memory sockets, so what is tested is what is deployed.
//
// What the relay is for: carrying bytes between a claw and its phones when
// neither can reach the other directly. What it is not for: knowing what the
// bytes say. Everything after the hello is an opaque string `d`, encrypted
// end to end by keys the relay never sees (docs/POCKET-RELAY.md). The relay
// cannot read it, and anything it changes, replays or reorders is refused by
// the far end. So its own checks are about cost and nuisance, not secrecy:
//
//   - A claw proves it owns its room: the room id is SHA-256 of a secret only
//     the claw holds, so a room cannot be squatted before its claw arrives
//     or taken over after. Nothing is registered and nothing is stored.
//   - A phone gets in only with a token the claw has listed (as a hash), or
//     a pairing ticket the claw announced (as a hash, single use, minutes).
//   - Frames are capped in size and rate; connections are capped per room.
//   - Repeated failed hellos lock strangers out for a while, never the claw
//     or a phone the claw lists.
//
// What it keeps: nothing on disk. Per connection, in memory (the socket's
// attachment, which survives hibernation only while the socket is open): its
// role, a random connection id, the hash it was admitted by, and its rate
// counters. The claw's socket also holds the hashes it listed. No message
// content is ever logged, stored or parsed. This file contains no logging.

export const LIMITS = Object.freeze({
  /** One frame, in characters. A record is at most 128 KiB of plaintext, ~171K of base64. */
  maxFrame: 256 * 1024,
  /** Phones connected to one room at once. */
  maxPhones: 8,
  /** Sockets that have not said hello yet. */
  maxPending: 8,
  /** How long a socket may sit without saying hello. */
  helloMs: 10_000,
  /** Phone tokens a claw may list. */
  maxAllow: 32,
  /** Pairing tickets live at once, and the longest one may live. */
  maxTickets: 2,
  maxTicketSeconds: 900,
  /** Per phone, per minute. A 20MB photo is ~36MB on the wire. */
  phoneFramesPerMinute: 1200,
  phoneBytesPerMinute: 64 * 1024 * 1024,
  /** Failed hellos per room before it stops listening for a while. */
  failures: 20,
  failureWindowMs: 10 * 60_000,
});

/** Close codes, all in the application range. The phone app turns them into sentences. */
export const CLOSE = Object.freeze({
  bad: 4400,
  denied: 4401,
  kicked: 4403,
  offline: 4404,
  slow: 4408,
  replaced: 4409,
  clawMoved: 4410,
  tooMuch: 4429,
});

const B64U43 = /^[A-Za-z0-9_-]{43}$/;
const enc = new TextEncoder();

function b64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(label, bytes) {
  const l = enc.encode(label);
  const all = new Uint8Array(l.length + bytes.length);
  all.set(l, 0);
  all.set(bytes, l.length);
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", all)));
}

/** The room id a claw secret commits to. Must match roomIdFor in src/pocket-e2e.ts. */
export const roomIdFor = (secretBytes) => sha256("cc-relay room v1\0", secretBytes);
/** What the relay keeps in place of a token or ticket. Must match relayHash in src/pocket-e2e.ts. */
export const relayHash = (value) => sha256("cc-relay hash v1\0", enc.encode(value));

function randomId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return b64u(b);
}

function parse(data) {
  try {
    const m = JSON.parse(data);
    return m && typeof m === "object" && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

/**
 * A room, rebuilt from its sockets whenever the runtime wakes it. The only
 * state it holds itself is the failure counter, which is soft on purpose: a
 * hibernation forgets it, and that only means a probe gets a fresh window.
 *
 * `sockets()` lists the open sockets as adapters: { send(text), close(code,
 * reason), att (get/set: the attachment) }. Adapters for one socket must
 * share their attachment, which is how the room recognises a socket again.
 */
export class Room {
  constructor({ roomId, sockets, now = () => Date.now(), limits = LIMITS }) {
    this.roomId = roomId;
    this.sockets = sockets;
    this.now = now;
    this.limits = limits;
    this.failed = [];
  }

  live() {
    return this.sockets().filter((s) => s.att && s.att.role !== "closed");
  }

  claw() {
    return this.live().find((s) => s.att.role === "claw") || null;
  }

  phones() {
    return this.live().filter((s) => s.att.role === "phone");
  }

  shut(sock, code, reason) {
    const att = sock.att || {};
    sock.att = { ...att, role: "closed" };
    try { sock.close(code, reason); } catch { /* already gone */ }
    // The claw hears that a phone has gone however it went, so it never
    // holds a channel to a socket that no longer exists.
    if (att.role === "phone") this.tellGone(att.conn);
  }

  tellGone(conn) {
    const claw = this.claw();
    if (claw) claw.send(JSON.stringify({ t: "gone", c: conn }));
  }

  fail(sock, code, reason) {
    const t = this.now();
    this.failed = this.failed.filter((x) => x > t - this.limits.failureWindowMs);
    this.failed.push(t);
    this.shut(sock, code, reason);
  }

  refusing() {
    const t = this.now();
    this.failed = this.failed.filter((x) => x > t - this.limits.failureWindowMs);
    return this.failed.length >= this.limits.failures;
  }

  /** A new socket. It must say hello within helloMs, or it is closed the next time anything happens here. */
  accept(sock) {
    const t = this.now();
    // The new socket has no attachment yet, so live() does not list it.
    const pending = this.live().filter((s) => s.att.role === "pending");
    for (const p of pending) if (t - p.att.at > this.limits.helloMs) this.shut(p, CLOSE.slow, "no hello");
    sock.att = { role: "pending", id: randomId(), room: this.roomId, at: t };
    // No failure lockout here: the claw and its paired phones must always be
    // able to get in, so the lockout is applied in hello(), to strangers only.
    if (this.live().filter((s) => s.att.role === "pending").length > this.limits.maxPending) {
      return this.shut(sock, CLOSE.tooMuch, "too many connections waiting");
    }
  }

  async message(sock, data) {
    const att = sock.att;
    if (!att || att.role === "closed") return;
    if (typeof data !== "string") return this.shut(sock, CLOSE.bad, "text frames only");
    if (data.length > this.limits.maxFrame) return this.shut(sock, CLOSE.bad, "frame too large");
    if (att.role === "pending") return this.hello(sock, data);
    if (att.role === "claw") return this.fromClaw(sock, data);
    if (att.role === "phone") return this.fromPhone(sock, data);
  }

  async hello(sock, data) {
    const att = sock.att;
    if (this.now() - att.at > this.limits.helloMs) return this.shut(sock, CLOSE.slow, "no hello");
    const m = parse(data);
    if (!m || m.t !== "hello") return this.fail(sock, CLOSE.bad, "expected hello");
    if (m.role === "claw") {
      if (typeof m.secret !== "string" || !B64U43.test(m.secret)) return this.fail(sock, CLOSE.denied, "bad claw secret");
      if ((await roomIdFor(unb64u(m.secret))) !== this.roomId) return this.fail(sock, CLOSE.denied, "that secret does not own this room");
      // Only the room's owner can get here, so a second connection is the
      // same claw restarted: the newer one wins, and its phones reconnect.
      for (const s of this.live()) {
        if (s.att.id === att.id) continue; // this socket, under another wrapper
        if (s.att.role === "claw") this.shut(s, CLOSE.replaced, "replaced by a newer connection");
        else if (s.att.role === "phone") this.shut(s, CLOSE.clawMoved, "the claw reconnected");
      }
      sock.att = { role: "claw", id: att.id, room: this.roomId, allow: [], tickets: [] };
      sock.send(JSON.stringify({ t: "ready" }));
      return;
    }
    if (m.role === "phone") {
      const claw = this.claw();
      if (!claw) return this.shut(sock, CLOSE.offline, "the claw is not connected");
      let via;
      let hash;
      // Someone keeps guessing (a revoked phone, a stranger who saw a room id
      // in a QR): stop answering their guesses for a while. A token the claw
      // lists still gets in, so the lockout can never be turned against the
      // owner's own phones, and the claw's own hello is never refused.
      const refusing = this.refusing();
      if (typeof m.token === "string" && B64U43.test(m.token)) {
        hash = await relayHash(m.token);
        if (!claw.att.allow.includes(hash)) {
          if (refusing) return this.shut(sock, CLOSE.tooMuch, "too many failed attempts; try again later");
          return this.fail(sock, CLOSE.denied, "this phone is not paired with this claw");
        }
        via = "token";
      } else if (typeof m.ticket === "string" && B64U43.test(m.ticket)) {
        if (refusing) return this.shut(sock, CLOSE.tooMuch, "too many failed attempts; try again later");
        hash = await relayHash(m.ticket);
        const t = this.now();
        const tickets = claw.att.tickets.filter((x) => x.exp > t);
        const i = tickets.findIndex((x) => x.h === hash);
        if (i < 0) {
          claw.att = { ...claw.att, tickets };
          return this.fail(sock, CLOSE.denied, "that pairing code is used or expired");
        }
        // Single use: spent the moment a phone shows it.
        tickets.splice(i, 1);
        claw.att = { ...claw.att, tickets };
        via = "ticket";
      } else {
        return this.fail(sock, CLOSE.bad, "a phone says hello with a token or a ticket");
      }
      if (this.phones().length >= this.limits.maxPhones) return this.shut(sock, CLOSE.tooMuch, "too many phones connected");
      const conn = randomId();
      sock.att = { role: "phone", id: att.id, room: this.roomId, conn, via, h: hash, win: this.now(), frames: 0, bytes: 0 };
      sock.send(JSON.stringify({ t: "ready" }));
      claw.send(JSON.stringify({ t: "open", c: conn, via }));
      return;
    }
    return this.fail(sock, CLOSE.bad, "unknown role");
  }

  fromClaw(sock, data) {
    const m = parse(data);
    if (!m) return;
    if (m.t === "to" && typeof m.c === "string" && typeof m.d === "string") {
      const p = this.phones().find((s) => s.att.conn === m.c);
      if (p) p.send(JSON.stringify({ t: "m", d: m.d }));
      return;
    }
    if (m.t === "kick" && typeof m.c === "string") {
      const p = this.phones().find((s) => s.att.conn === m.c);
      if (p) this.shut(p, CLOSE.kicked, typeof m.why === "string" ? m.why.slice(0, 120) : "refused by the claw");
      return;
    }
    if (m.t === "allow" && Array.isArray(m.tokens)) {
      const allow = [...new Set(m.tokens.filter((h) => typeof h === "string" && B64U43.test(h)))].slice(0, this.limits.maxAllow);
      sock.att = { ...sock.att, allow };
      // A token the claw stopped listing is a phone it revoked: it goes now,
      // not at its next reconnect.
      for (const p of this.phones()) {
        if (p.att.via === "token" && !allow.includes(p.att.h)) this.shut(p, CLOSE.denied, "this phone was unpaired");
      }
      return;
    }
    if (m.t === "ticket" && typeof m.hash === "string" && B64U43.test(m.hash)) {
      const ttl = Math.max(1, Math.min(this.limits.maxTicketSeconds, Number(m.ttl) || 0));
      const t = this.now();
      const tickets = sock.att.tickets.filter((x) => x.exp > t && x.h !== m.hash);
      tickets.push({ h: m.hash, exp: t + ttl * 1000 });
      sock.att = { ...sock.att, tickets: tickets.slice(-this.limits.maxTickets) };
      return;
    }
    if (m.t === "unticket") {
      sock.att = { ...sock.att, tickets: [] };
    }
  }

  fromPhone(sock, data) {
    const t = this.now();
    let att = sock.att;
    if (t - att.win >= 60_000) att = { ...att, win: t, frames: 0, bytes: 0 };
    att = { ...att, frames: att.frames + 1, bytes: att.bytes + data.length };
    sock.att = att;
    if (att.frames > this.limits.phoneFramesPerMinute || att.bytes > this.limits.phoneBytesPerMinute) {
      return this.shut(sock, CLOSE.tooMuch, "slow down");
    }
    const m = parse(data);
    if (!m || m.t !== "m" || typeof m.d !== "string") return this.shut(sock, CLOSE.bad, "expected a message frame");
    const claw = this.claw();
    if (!claw) return this.shut(sock, CLOSE.offline, "the claw is not connected");
    claw.send(JSON.stringify({ t: "from", c: att.conn, d: m.d }));
  }

  /** A socket went away, whoever closed it. */
  closed(sock) {
    const att = sock.att;
    if (!att) return;
    sock.att = { ...att, role: "closed" };
    if (att.role === "phone") {
      this.tellGone(att.conn);
    } else if (att.role === "claw") {
      for (const p of this.phones()) this.shut(p, CLOSE.offline, "the claw went offline");
    }
  }
}
