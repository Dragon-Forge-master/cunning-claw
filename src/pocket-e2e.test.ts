import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  b64u,
  E2EError,
  fingerprint,
  generateKey,
  MAX_FRAGMENT,
  pairingPsk,
  pairingTicket,
  parseHello,
  respond,
  roomIdFor,
  relayHash,
  Session,
  type StaticKey,
} from "./pocket-e2e.js";
// The phone's own file, exactly as a browser loads it: WebCrypto, no build.
import * as phone from "../public/pocket/e2e.js";
import * as relayRoom from "../relay/pocket/src/room.js";

/**
 * The end-to-end channel, both halves: the claw's (node:crypto) against the
 * phone's (WebCrypto), honestly and then with a relay in the middle that
 * tampers, replays, reorders, swaps rooms and substitutes keys. Every
 * attack must be caught, and caught before anything is accepted.
 */

const ROOM = roomIdFor(crypto.randomBytes(32));
const CODE = crypto.randomBytes(18).toString("base64url");

interface Phone { privateKey: CryptoKey; pub: Uint8Array }

async function handshake(opts: {
  mode?: "pair" | "session";
  claw?: StaticKey;
  phoneKey?: Phone;
  /** What the phone believes. */
  phoneRoom?: string; phoneCode?: string; phoneClawKey?: Uint8Array; phoneFingerprint?: string;
  /** What the claw believes. */
  clawRoom?: string; clawCode?: string | null;
  /** The relay's hand on each message. */
  onHs1?: (s: string) => string; onHs2?: (s: string) => string; onHs3?: (s: string) => string;
} = {}) {
  const mode = opts.mode ?? "pair";
  const claw = opts.claw ?? generateKey();
  const ph: Phone = opts.phoneKey ?? await phone.generateKey();
  const code = opts.phoneCode ?? CODE;
  const start = await phone.initiate({
    mode,
    room: opts.phoneRoom ?? ROOM,
    phone: ph,
    psk: mode === "pair" ? await phone.pairingPsk(code) : undefined,
    clawFingerprint: mode === "pair" ? (opts.phoneFingerprint ?? fingerprint(claw.pub)) : undefined,
    clawKey: mode === "session" ? (opts.phoneClawKey ?? new Uint8Array(claw.pub)) : undefined,
  });
  const hs1 = opts.onHs1 ? opts.onHs1(start.hello) : start.hello;
  const hello = parseHello(hs1);
  const clawCode = opts.clawCode === undefined ? CODE : opts.clawCode;
  const r = respond(hello, { room: opts.clawRoom ?? ROOM, claw, psk: mode === "pair" && clawCode ? pairingPsk(clawCode) : null });
  const hs2 = opts.onHs2 ? opts.onHs2(r.reply) : r.reply;
  const out = await start.finish(hs2);
  const hs3 = opts.onHs3 ? opts.onHs3(out.reply) : out.reply;
  const clawSession = r.finish(hs3);
  return { clawSession, phoneSession: out.session as InstanceType<typeof phone.Session>, claw, ph, hello };
}

const rejects = async (p: Promise<unknown> | (() => unknown), code: string, why: string) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    assert.equal((err as E2EError).code, code, `${why}: ${(err as Error).message}`);
    return;
  }
  assert.fail(`${why}: was accepted`);
};

test("e2e: the claw's half and the phone's half agree, pairing and session, both directions", async () => {
  for (const mode of ["pair", "session"] as const) {
    const { clawSession, phoneSession } = await handshake({ mode });
    for (const d of await phoneSession.seal({ t: "req", id: 1, path: "/pocket/api/me" })) {
      const got = clawSession.open(d);
      assert.deepEqual(got, { t: "req", id: 1, path: "/pocket/api/me" });
    }
    for (const d of clawSession.seal({ t: "res", id: 1, status: 200, body: "{\"name\":\"Pixel\"}" })) {
      assert.deepEqual(await phoneSession.open(d), { t: "res", id: 1, status: 200, body: "{\"name\":\"Pixel\"}" });
    }
  }
});

test("e2e: a message larger than a record is split and rebuilt in order, both directions", async () => {
  const { clawSession, phoneSession } = await handshake();
  const big = { t: "req", id: 2, body: crypto.randomBytes(MAX_FRAGMENT * 2).toString("base64") };
  const out = await phoneSession.seal(big);
  assert.ok(out.length >= 3, "split into several records");
  let got: unknown;
  for (const d of out) got = clawSession.open(d) ?? got;
  assert.deepEqual(got, big);
  const back = clawSession.seal(big);
  let mine: unknown;
  for (const d of back) mine = (await phoneSession.open(d)) ?? mine;
  assert.deepEqual(mine, big);
});

test("e2e: the derivations the relay sees match on both sides, and reveal neither the code nor the psk", async () => {
  assert.equal(await phone.pairingTicket(CODE), pairingTicket(CODE));
  assert.deepEqual(Buffer.from(await phone.pairingPsk(CODE)), pairingPsk(CODE));
  assert.notEqual(pairingTicket(CODE), b64u(pairingPsk(CODE)), "the ticket is not the psk");
  assert.ok(!pairingTicket(CODE).includes(CODE));
  // The relay's own copies of the hashes (relay/pocket/src/room.js) are the claw's.
  const secret = crypto.randomBytes(32);
  assert.equal(await relayRoom.roomIdFor(new Uint8Array(secret)), roomIdFor(secret));
  assert.equal(await relayRoom.relayHash("df_token"), relayHash("df_token"));
});

test("e2e: a relay that substitutes the claw's key is caught by the phone, pairing and session", async () => {
  // Pairing: the relay answers with a key of its own (it would need the claw's to be the claw).
  const relayKey = generateKey();
  await rejects(handshake({
    onHs2: (s) => {
      const m = JSON.parse(s);
      m.ck = b64u(relayKey.pub);
      return JSON.stringify(m);
    },
  }), "key", "a substituted claw key while pairing");
  // The relay runs a whole claw of its own: the QR's fingerprint does not match.
  await rejects(handshake({ phoneFingerprint: fingerprint(generateKey().pub) }), "key", "a claw that is not the one in the QR");
  // Session: a different claw than the one pinned at pairing.
  await rejects(handshake({ mode: "session", phoneClawKey: new Uint8Array(generateKey().pub) }), "key", "a claw that is not the pinned one");
});

test("e2e: a relay that substitutes the phone's key while pairing cannot complete the handshake without the code", async () => {
  // The man in the middle swaps in its own phone key toward the claw. It
  // knows everything the relay sees, but not the code from the QR.
  const claw = generateKey();
  const mitm = await phone.generateKey();
  const start = await phone.initiate({ mode: "pair", room: ROOM, phone: mitm, psk: await phone.pairingPsk("not-the-code-relay-guess"), clawFingerprint: fingerprint(claw.pub) });
  const r = respond(parseHello(start.hello), { room: ROOM, claw, psk: pairingPsk(CODE) });
  await rejects(start.finish(r.reply), "mac", "the relay's own phone, without the code");
  // And if it forges hs3 rather than trusting finish(): the claw refuses it.
  const r2 = respond(parseHello(start.hello), { room: ROOM, claw, psk: pairingPsk(CODE) });
  assert.throws(() => r2.finish(JSON.stringify({ t: "hs3", mac: b64u(crypto.randomBytes(32)) })), (e: E2EError) => e.code === "mac");
});

test("e2e: a relay that swaps the phone's static key in hs1 is refused by the claw's MAC check", async () => {
  // Session mode: the relay replaces P with another paired phone's key it has
  // seen. The claw would derive keys for that phone; this phone's MAC fails.
  const other = await phone.generateKey();
  await rejects(handshake({
    mode: "session",
    onHs1: (s) => { const m = JSON.parse(s); m.s = b64u(other.pub); return JSON.stringify(m); },
  }), "mac", "a swapped phone key");
});

test("e2e: a handshake moved to another room fails, whichever side is told the other room", async () => {
  const elsewhere = roomIdFor(crypto.randomBytes(32));
  // The relay rewrites the room in hs1: the claw sees a handshake for a room it does not own.
  await rejects(handshake({ onHs1: (s) => { const m = JSON.parse(s); m.room = elsewhere; return JSON.stringify(m); } }), "room", "hs1 rewritten to another room");
  // The phone was sent to another claw's room (with that claw's real keys): the fingerprint fails first.
  await rejects(handshake({ phoneRoom: elsewhere, clawRoom: elsewhere, phoneFingerprint: fingerprint(generateKey().pub) }), "key", "another claw's room");
  // Same claw key in two rooms (a cloned install): the room is in the transcript, so the MACs do not match.
  const claw = generateKey();
  const ph = await phone.generateKey();
  const start = await phone.initiate({ mode: "session", room: ROOM, phone: ph, clawKey: new Uint8Array(claw.pub) });
  const hello = parseHello(start.hello);
  const r = respond({ ...hello, room: elsewhere }, { room: elsewhere, claw, psk: null });
  await rejects(start.finish(r.reply), "mac", "a transcript over a different room");
});

test("e2e: an expired, reused or wrong pairing code fails the handshake", async () => {
  // The claw holds no psk once the code is spent or has expired.
  await rejects(handshake({ clawCode: null }), "pairing", "no live pairing on the claw");
  // A different code: the phone scanned an old QR, or a stranger guessed.
  await rejects(handshake({ phoneCode: crypto.randomBytes(18).toString("base64url") }), "mac", "a wrong code");
  // Pairing mode cannot be downgraded to a session without a pinned key: the claw looks the key up and finds none (src/pocket-relay.test.ts).
});

test("e2e: a tampered, replayed, reordered, dropped or reflected record is refused, and the session dies", async () => {
  const attacks: [string, (recs: string[], s: { clawSession: Session }) => string[]][] = [
    ["tampered", (r) => { const b = Buffer.from(r[0], "base64url"); b[5] ^= 1; return [b.toString("base64url")]; }],
    ["replayed", (r) => [r[0], r[0]]],
    ["reordered", (r) => [r[1], r[0]]],
    ["dropped", (r) => [r[1]]],
    ["reflected", (_r, s) => s.clawSession.seal({ t: "res", id: 9 })],
    ["truncated", (r) => [r[0].slice(0, 20)]],
  ];
  for (const [name, attack] of attacks) {
    const s = await handshake();
    const recs = [...await s.phoneSession.seal({ t: "req", id: 1 }), ...await s.phoneSession.seal({ t: "req", id: 2 })];
    let accepted = 0;
    let refused = false;
    for (const d of attack(recs, s)) {
      try {
        if (s.clawSession.open(d) !== undefined) accepted++;
      } catch (err) {
        assert.ok(err instanceof E2EError, name);
        refused = true;
        break;
      }
    }
    assert.ok(refused, `${name}: must be refused`);
    if (name !== "replayed") assert.equal(accepted, 0, `${name}: nothing before the fault may be wrong`);
    // Once a record fails, the session is dead: no resynchronising.
    assert.throws(() => s.clawSession.open(recs[0]), (e: E2EError) => e.code === "dead", `${name}: session must die`);
  }
  // And the phone's half refuses the claw's records the same way.
  const s = await handshake();
  const out = s.clawSession.seal({ t: "res", id: 1 });
  await rejects(s.phoneSession.open(out[0]).then(() => s.phoneSession.open(out[0])), "record", "a replay toward the phone");
});

test("e2e: keys that are not points on the curve, or one key used twice, are refused before any ECDH", async () => {
  const ph = await phone.generateKey();
  const start = await phone.initiate({ mode: "pair", room: ROOM, phone: ph, psk: await phone.pairingPsk(CODE), clawFingerprint: "x".repeat(43) });
  const m = JSON.parse(start.hello);
  const offCurve = Buffer.alloc(65, 7);
  offCurve[0] = 4;
  assert.throws(() => parseHello(JSON.stringify({ ...m, e: b64u(offCurve) })), (e: E2EError) => e.code === "key");
  assert.throws(() => parseHello(JSON.stringify({ ...m, s: m.e })), (e: E2EError) => e.code === "key");
  assert.throws(() => parseHello(JSON.stringify({ ...m, v: 2 })), (e: E2EError) => e.code === "version");
  const claw = generateKey();
  assert.throws(() => respond(parseHello(JSON.stringify({ ...m, s: b64u(claw.pub) })), { room: ROOM, claw, psk: pairingPsk(CODE) }), (e: E2EError) => e.code === "key");
});
