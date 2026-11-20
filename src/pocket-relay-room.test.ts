import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLOSE, LIMITS, relayHash, roomIdFor } from "../relay/pocket/src/room.js";
import { FakeRelayNet, type FakeSocket } from "./relay-fake.js";

/**
 * The relay's own rules, on the relay's own code (relay/pocket/src/room.js,
 * what the Durable Object runs). These are not what keeps the conversation
 * safe — the end-to-end channel does that (src/pocket-e2e.test.ts) — but
 * they decide who can occupy a room and how much a stranger can cost.
 */

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function rig() {
  const clock = { t: Date.UTC(2026, 10, 20, 12) };
  const net = new FakeRelayNet(() => clock.t);
  const secret = crypto.randomBytes(32);
  const room = await roomIdFor(new Uint8Array(secret));
  const url = `wss://relay.test/v1/room/${room}`;
  const closed = new Map<FakeSocket, { code?: number; reason?: string }>();
  const open = (who: "claw" | "phone", u = url) => {
    const s = net.open(u, who);
    s.onclose = (e) => closed.set(s, e);
    return s;
  };
  const say = async (s: FakeSocket, obj: unknown) => {
    await net.settle();
    s.send(typeof obj === "string" ? obj : JSON.stringify(obj));
    await net.settle();
  };
  const claw = async () => {
    const c = open("claw");
    await say(c, { t: "hello", role: "claw", secret: b64u(secret) });
    assert.deepEqual(JSON.parse(c.got[0]), { t: "ready" });
    return c;
  };
  return { clock, net, secret, room, url, closed, open, say, claw };
}

test("relay: a room belongs to the secret it is a hash of; a stranger who knows the room id cannot squat or take it", async () => {
  const r = await rig();
  // Before the claw arrives: a stranger tries to claim the room.
  const squatter = r.open("claw");
  await r.say(squatter, { t: "hello", role: "claw", secret: b64u(crypto.randomBytes(32)) });
  assert.equal(r.closed.get(squatter)?.code, CLOSE.denied);
  const c = await r.claw();
  // After: the same, and the claw keeps its room.
  const hijack = r.open("claw");
  await r.say(hijack, { t: "hello", role: "claw", secret: b64u(crypto.randomBytes(32)) });
  assert.equal(r.closed.get(hijack)?.code, CLOSE.denied);
  assert.equal(r.closed.has(c), false, "the real claw is still connected");
  // The real secret again (the claw restarted): the newer connection wins.
  const again = await r.claw();
  assert.equal(r.closed.get(c)?.code, CLOSE.replaced);
  assert.equal(r.closed.has(again), false);
});

test("relay: a phone gets in only with a token the claw listed, and leaves the moment the claw unlists it", async () => {
  const r = await rig();
  const token = b64u(crypto.randomBytes(32));
  // No claw: the phone is told the claw is offline, not let in.
  const early = r.open("phone");
  await r.say(early, { t: "hello", role: "phone", token });
  assert.equal(r.closed.get(early)?.code, CLOSE.offline);
  const c = await r.claw();
  const before = r.open("phone");
  await r.say(before, { t: "hello", role: "phone", token });
  assert.equal(r.closed.get(before)?.code, CLOSE.denied);
  await r.say(c, { t: "allow", tokens: [await relayHash(token)] });
  const p = r.open("phone");
  await r.say(p, { t: "hello", role: "phone", token });
  assert.deepEqual(JSON.parse(p.got[0]), { t: "ready" });
  const open = JSON.parse(c.got.at(-1)!);
  assert.equal(open.t, "open");
  assert.equal(open.via, "token");
  // Frames go through as opaque strings, tagged with the connection, nothing else.
  await r.say(p, { t: "m", d: "opaque-1" });
  assert.deepEqual(JSON.parse(c.got.at(-1)!), { t: "from", c: open.c, d: "opaque-1" });
  await r.say(c, { t: "to", c: open.c, d: "opaque-2" });
  assert.deepEqual(JSON.parse(p.got.at(-1)!), { t: "m", d: "opaque-2" });
  // Revoked on the claw: the list no longer has it, and the phone is closed now.
  await r.say(c, { t: "allow", tokens: [] });
  assert.equal(r.closed.get(p)?.code, CLOSE.denied);
  assert.deepEqual(JSON.parse(c.got.at(-1)!), { t: "gone", c: open.c }, "the claw hears it went");
});

test("relay: a pairing ticket is single-use and expires", async () => {
  const r = await rig();
  const c = await r.claw();
  const ticket = b64u(crypto.randomBytes(32));
  await r.say(c, { t: "ticket", hash: await relayHash(ticket), ttl: 300 });
  const first = r.open("phone");
  await r.say(first, { t: "hello", role: "phone", ticket });
  assert.deepEqual(JSON.parse(first.got[0]), { t: "ready" });
  assert.equal(JSON.parse(c.got.at(-1)!).via, "ticket");
  const second = r.open("phone");
  await r.say(second, { t: "hello", role: "phone", ticket });
  assert.equal(r.closed.get(second)?.code, CLOSE.denied, "used");
  const late = b64u(crypto.randomBytes(32));
  await r.say(c, { t: "ticket", hash: await relayHash(late), ttl: 300 });
  r.clock.t += 301_000;
  const tooLate = r.open("phone");
  await r.say(tooLate, { t: "hello", role: "phone", ticket: late });
  assert.equal(r.closed.get(tooLate)?.code, CLOSE.denied, "expired");
  // A claw cannot make one live longer than the cap.
  const long = b64u(crypto.randomBytes(32));
  await r.say(c, { t: "ticket", hash: await relayHash(long), ttl: 10 ** 9 });
  r.clock.t += (LIMITS.maxTicketSeconds + 1) * 1000;
  const capped = r.open("phone");
  await r.say(capped, { t: "hello", role: "phone", ticket: long });
  assert.equal(r.closed.get(capped)?.code, CLOSE.denied, "capped at fifteen minutes");
});

test("relay: frames are capped in size and rate, phones and waiting sockets in number", async () => {
  const r = await rig();
  const c = await r.claw();
  const tokens = Array.from({ length: LIMITS.maxPhones + 1 }, () => b64u(crypto.randomBytes(32)));
  await r.say(c, { t: "allow", tokens: await Promise.all(tokens.map((t) => relayHash(t))) });
  const phones: FakeSocket[] = [];
  for (const token of tokens) {
    const p = r.open("phone");
    await r.say(p, { t: "hello", role: "phone", token });
    phones.push(p);
  }
  assert.equal(r.closed.get(phones.at(-1)!)?.code, CLOSE.tooMuch, "one phone too many");
  // Too big a frame.
  await r.say(phones[0], JSON.stringify({ t: "m", d: "x".repeat(LIMITS.maxFrame) }));
  assert.equal(r.closed.get(phones[0])?.code, CLOSE.bad);
  // Too many frames in a minute.
  const p = phones[1];
  for (let i = 0; i <= LIMITS.phoneFramesPerMinute && !r.closed.has(p); i++) p.send(JSON.stringify({ t: "m", d: "x" }));
  await r.net.settle(5);
  assert.equal(r.closed.get(p)?.code, CLOSE.tooMuch);
  // Binary frames are not something either end sends.
  phones[2].send(new Uint8Array([1, 2, 3]) as unknown as string);
  await r.net.settle();
  assert.equal(r.closed.get(phones[2])?.code, CLOSE.bad);
  // Sockets that never say hello: the room stops taking more, and culls the slow ones.
  const idle = Array.from({ length: LIMITS.maxPending + 1 }, () => r.open("phone"));
  await r.net.settle();
  assert.equal(r.closed.get(idle.at(-1)!)?.code, CLOSE.tooMuch);
  r.clock.t += LIMITS.helloMs + 1;
  r.open("phone");
  await r.net.settle();
  assert.equal(r.closed.get(idle[0])?.code, CLOSE.slow);
});

test("relay: a room that keeps failing hellos stops listening to strangers for a while, never to its claw or its phones", async () => {
  const r = await rig();
  const c = await r.claw();
  const token = b64u(crypto.randomBytes(32));
  await r.say(c, { t: "allow", tokens: [await relayHash(token)] });
  for (let i = 0; i < LIMITS.failures; i++) {
    const p = r.open("phone");
    await r.say(p, { t: "hello", role: "phone", token: b64u(crypto.randomBytes(32)) });
  }
  const next = r.open("phone");
  await r.say(next, { t: "hello", role: "phone", token: b64u(crypto.randomBytes(32)) });
  assert.equal(r.closed.get(next)?.code, CLOSE.tooMuch, "the next guess is not even checked");
  const ticket = r.open("phone");
  await r.say(ticket, { t: "hello", role: "phone", ticket: b64u(crypto.randomBytes(32)) });
  assert.equal(r.closed.get(ticket)?.code, CLOSE.tooMuch, "nor is a pairing ticket");
  // The lockout cannot be used to keep the owner out: a listed phone still
  // gets in, and the claw itself can still reconnect.
  const mine = r.open("phone");
  await r.say(mine, { t: "hello", role: "phone", token });
  assert.equal(r.closed.has(mine), false, "a phone the claw lists is never locked out");
  assert.deepEqual(JSON.parse(mine.got[0]), { t: "ready" });
  await r.claw();
  r.clock.t += LIMITS.failureWindowMs + 1;
  await r.claw();
  const later = r.open("phone");
  await r.say(later, { t: "hello", role: "phone", token: b64u(crypto.randomBytes(32)) });
  assert.equal(r.closed.get(later)?.code, CLOSE.denied, "the window passes: guesses are checked (and refused) again");
});

test("relay: when the claw goes, its phones are told it is offline", async () => {
  const r = await rig();
  const c = await r.claw();
  const token = b64u(crypto.randomBytes(32));
  await r.say(c, { t: "allow", tokens: [await relayHash(token)] });
  const p = r.open("phone");
  await r.say(p, { t: "hello", role: "phone", token });
  c.close();
  await r.net.settle();
  assert.equal(r.closed.get(p)?.code, CLOSE.offline);
});

test("relay: the code Cloudflare runs logs nothing and stores nothing", () => {
  for (const f of ["room.js", "worker.js"]) {
    const src = fs.readFileSync(path.join(HERE, "..", "relay", "pocket", "src", f), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /console\./, `${f} must not log`);
    assert.doesNotMatch(src, /storage\.(put|sql|setAlarm)|\.storage\b/, `${f} must not write Durable Object storage`);
  }
  const toml = fs.readFileSync(path.join(HERE, "..", "relay", "pocket", "wrangler.toml"), "utf8");
  assert.match(toml, /\[observability\]\s*\nenabled = false/, "Workers Logs off");
  assert.match(toml, /invocation_logs = false/, "invocation logs off by name");
  assert.match(toml, /\[exports\.PocketRoom\]\s*\ntype = "durable-object"\s*\nstorage = "sqlite"/, "the room class is declared");
  assert.doesNotMatch(toml, /^\[\[migrations\]\]/m, "exports and migrations cannot be mixed");
});
