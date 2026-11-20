import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createPocket, POCKET_LARGE_BODIES } from "./pocket.js";
import { fileURLToPath } from "node:url";
import { hostGate, pocketDoctorLine } from "./pocket-host.js";
import { createBridge, refuseRequest } from "./pocket-bridge.js";
import { createRelayTransport, loadRelayIdentity, relayConfig, relayDoctorLine, siteAppDoctorLine } from "./pocket-relay.js";
import { softAuthenticator, softCreate, softGet, type SoftAuthenticator } from "./webauthn-soft.js";
import { decryptPayload } from "./webpush.js";
import { FakeRelayNet } from "./relay-fake.js";
// The phone's own transport and crypto, exactly as the browser loads them.
import { createRelayLink, parsePairLink } from "../public/pocket/relay.js";

/**
 * Pocket through the relay, end to end, with nothing stood in for that
 * matters: the claw's real Pocket, bridge and transport; the relay's real
 * room logic (relay/pocket/src/room.js) on in-memory sockets; the phone's
 * real relay.js and e2e.js; a software passkey for the fingerprint. Then a
 * relay that turns hostile, a revoked phone, spent and stale codes, and the
 * two paths kept apart.
 */

const APP = "https://cunningclaw.com";
const RP = "cunningclaw.com";
const TAILNET = "claw-desk.tail1a2b3c.ts.net";
const TS = { "x-forwarded-host": TAILNET, "x-forwarded-for": "100.101.102.103", "x-forwarded-proto": "https" };

function memStore() {
  let v: unknown = null;
  return { get: async () => v, set: async (x: unknown) => { v = x; }, clear: async () => { v = null; }, peek: () => v };
}

async function rig(opts: { relay?: boolean } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cunningclaw-relay-"));
  const clock = { t: Date.UTC(2026, 10, 20, 12) };
  const settled: [string, boolean][] = [];
  const chats: string[] = [];
  const pushes: { url: string; body: Buffer }[] = [];
  const notices: string[] = [];
  const net = new FakeRelayNet(() => clock.t);
  const links: { close(): void }[] = [];
  let transport: ReturnType<typeof createRelayTransport> | null = null;
  const pocket = createPocket({
    dataDir,
    uploadsDir: path.join(dataDir, "uploads"),
    configuredHosts: () => [TAILNET],
    settleApproval: (id, approved) => {
      settled.push([id, approved]);
      pocket.onEvent("approval_resolved", { id, approved });
      return true;
    },
    chat: (m) => { chats.push(m); return { status: 200, body: { ok: true } }; },
    history: () => [{ role: "user", text: "earlier" }],
    notice: (m) => { notices.push(m); },
    now: () => clock.t,
    fetchImpl: (async (url: string, init: RequestInit) => {
      pushes.push({ url, body: Buffer.from(init.body as Buffer) });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch,
    relay: () => transport,
  });
  const config = relayConfig({ url: "wss://relay.test", appOrigin: APP })!;
  const bridge = createBridge(pocket.phone, { largeBodies: POCKET_LARGE_BODIES, host: new URL(APP).host, origin: APP });
  if (opts.relay !== false) {
    transport = createRelayTransport({
      config,
      identity: loadRelayIdentity(dataDir),
      pocket,
      dispatch: bridge.dispatch,
      connect: net.connector("claw") as never,
      now: () => clock.t,
      notice: (m) => { notices.push(m); },
    });
    transport.ensure();
  }
  // The tailnet path and the HUD's routes, on a real socket as server.ts serves them.
  const app = express();
  app.use(hostGate(() => ({ bindHost: "127.0.0.1", pocketHosts: pocket.hosts() })));
  const small = express.json({ limit: "1mb" });
  app.use((req, res, next) => (POCKET_LARGE_BODIES.has(req.path) ? next() : small(req, res, next)));
  app.use(pocket.phone);
  app.use("/api/pocket", (req, res, next) => (req.headers["x-test-master"] === "yes" ? next() : res.status(401).end()), pocket.admin);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  return {
    dataDir, clock, settled, chats, pushes, notices, net, pocket, transport, port, links, bridge,
    close: async () => {
      // The phones first, as a page being closed would: a link left open retries.
      for (const l of links) l.close();
      transport?.stop();
      await net.settle(3);
      await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    },
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

function call(r: Rig, method: string, p: string, o: { host?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  const body = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: r.port, path: p, method,
      headers: { host: o.host ?? "127.0.0.1:3900", ...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}), ...o.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const admin = (r: Rig, method: string, p: string, body?: unknown) => call(r, method, `/api/pocket${p}`, { headers: { "x-test-master": "yes" }, body });

interface RelayPhone {
  link: ReturnType<typeof createRelayLink>;
  store: ReturnType<typeof memStore>;
  auth: SoftAuthenticator;
  states: { state: string; text: string }[];
  id: string;
  api: (method: string, p: string, body?: unknown) => Promise<{ status: number; json: any }>;
}

function newLink(r: Rig, store = memStore()) {
  const states: { state: string; text: string }[] = [];
  const link = createRelayLink({ store, connect: r.net.connector("phone") as never, onState: (s: { state: string; text: string }) => states.push(s), retryMs: 60_000 });
  r.links.push(link);
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await link.request(method, `/pocket/api${p}`, body === undefined ? {} : { body });
    let json: any = null;
    try { json = JSON.parse(res.body); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  return { link, store, states, api };
}

async function mintRelay(r: Rig) {
  const minted = await admin(r, "POST", "/pair", { mode: "relay" });
  assert.equal(minted.status, 200, JSON.stringify(minted.json));
  await r.net.settle();
  return minted;
}

/** The whole of "scan, touch the sensor": what a phone does with the HUD's QR. */
async function pairPhone(r: Rig, name = "Pixel 7"): Promise<RelayPhone> {
  const minted = await mintRelay(r);
  const info = parsePairLink(new URL(minted.json.url).hash);
  assert.ok(info, "the QR's link parses");
  const { link, store, states, api } = newLink(r);
  await link.beginPairing(info);
  const opts = await api("POST", "/pair/options", { code: info.code });
  assert.equal(opts.status, 200, JSON.stringify(opts.json));
  assert.equal(opts.json.publicKey.rp.id, RP, "the passkey belongs to cunningclaw.com");
  assert.equal(opts.json.publicKey.authenticatorSelection.userVerification, "required");
  const auth = softAuthenticator();
  const credential = softCreate(auth, opts.json.publicKey.challenge, { origin: APP, rpId: RP });
  const done = await api("POST", "/pair/finish", { enrolment: opts.json.enrolment, name, credential });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.match(done.json.relayToken, /^[A-Za-z0-9_-]{43}$/);
  await link.finishPairing(done.json.relayToken);
  await r.net.settle();
  return { link, store, auth, states, id: done.json.device.id, api };
}

async function assertion(ph: RelayPhone, purpose: string, subject: { approvalId?: string } = {}, knobs: { origin?: string; rpId?: string } = {}) {
  const c = await ph.api("POST", "/challenge", { purpose, ...subject });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  return softGet(ph.auth, c.json.publicKey.challenge, { origin: knobs.origin ?? APP, rpId: knobs.rpId ?? RP });
}

/** Everything the relay carried, both ways, as one string. */
const relaySaw = (r: Rig) => r.net.sockets.flatMap((s) => [...s.sent, ...s.got]).join("\n");

test("relay pairing: the QR names the app, the room, the claw's key and the relay, and the code stays in the fragment", async () => {
  const r = await rig();
  try {
    const minted = await mintRelay(r);
    assert.equal(minted.json.mode, "relay");
    const u = new URL(minted.json.url);
    assert.equal(u.origin + u.pathname, `${APP}/pocket/`);
    assert.equal(u.search, "", "nothing secret in the part of a URL that reaches a server");
    const info = parsePairLink(u.hash)!;
    assert.equal(info.room, loadRelayIdentity(r.dataDir).room);
    assert.equal(info.relay, "wss://relay.test");
    assert.ok(Array.isArray(minted.json.qr) && minted.json.qr.length <= 69, `the QR stays scannable (${minted.json.qr.length} modules)`);
    const ph = await pairPhone(r);
    const list = await admin(r, "GET", "/");
    assert.equal(list.json.devices[0].via, "relay");
    assert.equal(list.json.relay.state, "connected");
    const me = await ph.api("GET", "/me");
    assert.equal(me.status, 200);
    assert.equal(me.json.name, "Pixel 7");
    assert.equal(me.json.unlocked, true, "the enrolling fingerprint counts as an unlock, as on the tailnet");
    // A relay phone has no token: it is its key. The file says so, mode 600.
    const stored = JSON.parse(fs.readFileSync(path.join(r.dataDir, "pocket", "devices.json"), "utf8")).devices[0];
    assert.equal(stored.tokenHash, "");
    assert.match(stored.relayKey, /^[A-Za-z0-9_-]{87}$/);
    assert.equal(fs.statSync(path.join(r.dataDir, "pocket", "relay.json")).mode & 0o077, 0, "relay.json must be mode 600");
    // The relay never saw the code: not in a hello, not in a frame.
    assert.ok(!relaySaw(r).includes(info.code), "the pairing code never crosses the relay");
  } finally { await r.close(); }
});

test("relay: the claw does not dial out until a phone is paired the easy way, and hangs up when none is", async () => {
  const r = await rig();
  try {
    await r.net.settle();
    assert.equal(r.net.sockets.length, 0, "a claw that never pairs through the relay never contacts it");
    assert.equal((await admin(r, "GET", "/")).json.relay.state, "idle");
    await mintRelay(r);
    assert.equal(r.net.sockets.filter((s) => s.who === "claw").length, 1);
    assert.equal(r.transport!.state(), "connected");
    await admin(r, "DELETE", "/pair");
    await r.net.settle();
    assert.equal(r.transport!.state(), "idle", "the QR was closed and nothing is paired: off the line again");
  } finally { await r.close(); }
});

test("relay: talk, the event stream, and an approval with a fresh assertion bound to the card at cunningclaw.com's origin", async () => {
  const r = await rig();
  try {
    const ph = await pairPhone(r);
    const events: string[] = [];
    await ph.link.stream("/pocket/api/events", (s: string) => events.push(s), () => {});
    assert.equal((await ph.api("POST", "/chat", { message: "Book the van in for Tuesday" })).status, 200);
    assert.deepEqual(r.chats, ["Book the van in for Tuesday"]);
    assert.equal((await ph.api("GET", "/history")).json.turns[0].text, "earlier");
    r.pocket.onEvent("approval_request", { id: "ap-1", summary: "Run: rm -rf ./build", detail: "in ~/projects/site" });
    await r.net.settle();
    assert.match(events.join(""), /event: approval_request\ndata: .*ap-1/);
    // An assertion from another origin (the tailnet's, a phishing page's) is refused.
    for (const origin of [`https://${TAILNET}`, "https://cunningclaw.com.evil.example"]) {
      const bad = await assertion(ph, "approve", { approvalId: "ap-1" }, { origin });
      assert.equal((await ph.api("POST", "/approvals/ap-1", { approved: true, assertion: bad })).status, 401, origin);
    }
    const a = await assertion(ph, "approve", { approvalId: "ap-1" });
    assert.equal((await ph.api("POST", "/approvals/ap-1", { approved: true, assertion: a })).status, 200);
    assert.deepEqual(r.settled, [["ap-1", true]], "settled through the same settleApproval as the HUD and the phone lines");
    // Replayed: the challenge was spent.
    r.pocket.onEvent("approval_request", { id: "ap-2", summary: "Send email", detail: "" });
    assert.equal((await ph.api("POST", "/approvals/ap-2", { approved: true, assertion: a })).status, 401);
    // A deny's fingerprint cannot approve.
    const deny = await assertion(ph, "deny", { approvalId: "ap-2" });
    assert.equal((await ph.api("POST", "/approvals/ap-2", { approved: true, assertion: deny })).status, 401);
    assert.equal(r.settled.length, 1);
    // What the relay carried: ciphertext. Not the message, not the card, not the history.
    const saw = relaySaw(r);
    for (const secret of ["Book the van", "rm -rf", "ap-1", "earlier", "approval_request", "/pocket/api"]) {
      assert.ok(!saw.includes(secret), `the relay must not see ${JSON.stringify(secret)}`);
    }
  } finally { await r.close(); }
});

test("relay: the lock levels hold through the relay exactly as on the tailnet", async () => {
  const r = await rig();
  try {
    const ph = await pairPhone(r);
    assert.equal((await ph.api("POST", "/lock", {})).status, 200);
    assert.equal((await ph.api("GET", "/history")).status, 423, "locked: no conversation");
    assert.equal((await ph.api("POST", "/chat", { message: "hello" })).status, 423);
    assert.equal((await ph.api("GET", "/approvals")).status, 200, "locked: the cards are still listed");
    const u = await assertion(ph, "unlock");
    assert.equal((await ph.api("POST", "/unlock", { assertion: u })).status, 200);
    assert.equal((await ph.api("GET", "/history")).status, 200);
    r.clock.t += 11 * 60_000;
    assert.equal((await ph.api("GET", "/history")).status, 423, "idle minutes lapse it");
  } finally { await r.close(); }
});

test("relay: a revoked phone is refused — its channel is closed, the relay drops it, and it cannot come back", async () => {
  const r = await rig();
  try {
    const keeper = await pairPhone(r, "Kept phone");
    const ph = await pairPhone(r);
    let ended: unknown = "open";
    await ph.link.stream("/pocket/api/events", () => {}, (err: unknown) => { ended = err; });
    assert.equal((await admin(r, "DELETE", `/devices/${ph.id}`)).status, 200);
    await r.net.settle();
    assert.notEqual(ended, "open", "its event stream was ended");
    assert.equal(ph.states.at(-1)?.state, "gone", `the phone is told it was unpaired: ${JSON.stringify(ph.states)}`);
    // Coming back with the same pairing: the relay no longer lists its token.
    const again = newLink(r, ph.store);
    assert.equal(await again.link.load(), true);
    await assert.rejects(again.api("GET", "/me"));
    assert.equal(again.states.at(-1)?.state, "gone");
    assert.equal((await keeper.api("GET", "/me")).status, 200, "the other phone is untouched");
    // The last relay phone revoked: nothing left to keep the line up for.
    assert.equal((await admin(r, "DELETE", `/devices/${keeper.id}`)).status, 200);
    await r.net.settle();
    assert.equal(r.transport!.state(), "idle");
  } finally { await r.close(); }
});

test("relay: a revoked phone's key is refused by the claw even if a dishonest relay lets it in", async () => {
  const r = await rig();
  try {
    const ph = await pairPhone(r);
    const keeper = await pairPhone(r, "Second phone");
    const tokenOf = (s: { store: ReturnType<typeof memStore> }) => (s.store.peek() as { token: string }).token;
    assert.equal((await admin(r, "DELETE", `/devices/${ph.id}`)).status, 200);
    await r.net.settle();
    // The relay admits the revoked phone under the remaining phone's token
    // (as a relay that kept old tokens, or lied, could)…
    const sneaky = newLink(r);
    await sneaky.store.set({ ...(ph.store.peek() as Record<string, unknown>), token: tokenOf(keeper) });
    await sneaky.link.load();
    await assert.rejects(sneaky.api("GET", "/me"));
    // …and the claw, finding no paired phone with that key, refused the handshake.
    await r.net.settle();
    assert.deepEqual(r.transport!.channels().map((c) => c.deviceId), [keeper.id], "only the kept phone has a channel");
    assert.equal((await keeper.api("GET", "/me")).status, 200);
    // Pocket checks the binding again itself: a request naming a device must
    // come on a channel that proved that device's own key.
    const reply = await new Promise<{ status: number }>((res) => {
      r.bridge.dispatch({ id: 1, method: "GET", path: "/pocket/api/me" },
        { deviceId: keeper.id, peerKey: Buffer.from((ph.store.peek() as { phone: { pub: Uint8Array } }).phone.pub).toString("base64url"), pairing: false, bind: () => {}, client: "test" },
        (m) => { if (m.t === "res") res(m); });
    });
    assert.equal(reply.status, 401, "another phone's key cannot speak for this device");
  } finally { await r.close(); }
});

test("relay pairing: an expired or used code fails, and a code cannot cross from one path to the other", async () => {
  const r = await rig();
  try {
    // Expired: the relay has dropped the ticket and the claw the psk.
    const stale = parsePairLink(new URL((await mintRelay(r)).json.url).hash)!;
    r.clock.t += 6 * 60_000;
    const late = newLink(r);
    await assert.rejects(late.link.beginPairing(stale));
    // Used: one phone pairs; a second with the same QR is refused at the relay and at the claw.
    const minted = await mintRelay(r);
    const info = parsePairLink(new URL(minted.json.url).hash)!;
    const first = newLink(r);
    await first.link.beginPairing(info);
    const second = newLink(r);
    await assert.rejects(second.link.beginPairing(info));
    assert.equal((await first.api("POST", "/pair/options", { code: info.code })).status, 200);
    assert.equal((await first.api("POST", "/pair/options", { code: info.code })).status, 401, "spent");
    // A paired phone's ordinary channel cannot spend a relay code, even the
    // right one: only a channel that proved the code's psk in its handshake may.
    const other = await pairPhone(r, "Other");
    const live = parsePairLink(new URL((await mintRelay(r)).json.url).hash)!;
    assert.equal((await other.api("POST", "/pair/options", { code: live.code })).status, 401);
    // An enrolment is finished by the channel that started it, or not at all.
    const fresh = newLink(r);
    await fresh.link.beginPairing(live);
    const o = await fresh.api("POST", "/pair/options", { code: live.code });
    assert.equal(o.status, 200, "the code was right, and still unspent");
    const credential = softCreate(softAuthenticator(), o.json.publicKey.challenge, { origin: APP, rpId: RP });
    const stolen = await other.api("POST", "/pair/finish", { enrolment: o.json.enrolment, credential });
    assert.equal(stolen.status, 401, "another channel cannot finish this enrolment");
    // A relay code spent on the tailnet name: refused, though the code is right.
    const third = parsePairLink(new URL((await mintRelay(r)).json.url).hash)!;
    const viaTailnet = await call(r, "POST", "/pocket/api/pair/options", { host: TAILNET, headers: { ...TS, origin: `https://${TAILNET}` }, body: { code: third.code } });
    assert.equal(viaTailnet.status, 401);
    // And a tailnet code cannot pair through the relay: there is no ticket or psk for it.
    const tail = await admin(r, "POST", "/pair");
    assert.equal(tail.json.mode, "tailnet");
    const tailCode = new URL(tail.json.url).hash.replace("#pair=", "");
    const cross = newLink(r);
    await assert.rejects(cross.link.beginPairing({ ...third, code: tailCode }));
  } finally { await r.close(); }
});

test("relay: a relay phone cannot be used on the tailnet name, and a tailnet phone cannot be used through the relay", async () => {
  const r = await rig();
  try {
    const ph = await pairPhone(r);
    // Whatever cookie a page presents on the tailnet name, a relay device is not reachable there.
    const cookie = `cc_pocket=${ph.id}.${crypto.randomBytes(32).toString("base64url")}`;
    const tail = await call(r, "GET", "/pocket/api/me", { host: TAILNET, headers: { ...TS, cookie, origin: `https://${TAILNET}` } });
    assert.equal(tail.status, 401);
    // A tailnet phone's passkey cannot answer through the relay: its record is not a relay device,
    // so no channel can be authenticated as it; and the relay device's assertions are checked
    // against cunningclaw.com only (above). The bridge reaches /pocket/api/ and nothing else.
    // Even a relay record that somehow carries a real token's hash (an edited
    // or migrated file) is not reachable by that token: via relay is decisive.
    const file = path.join(r.dataDir, "pocket", "devices.json");
    const secret = crypto.randomBytes(32).toString("base64url");
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    j.devices[0].tokenHash = crypto.createHash("sha256").update(secret).digest("hex");
    fs.writeFileSync(file, JSON.stringify(j));
    const r2 = createPocket({ dataDir: r.dataDir, uploadsDir: r.dataDir, configuredHosts: () => [TAILNET], settleApproval: () => true, chat: () => ({ status: 200, body: {} }), history: () => [] });
    const app2 = express();
    app2.use(hostGate(() => ({ bindHost: "127.0.0.1", pocketHosts: r2.hosts() })));
    app2.use(r2.phone);
    const srv = app2.listen(0, "127.0.0.1");
    await new Promise((res) => srv.once("listening", res));
    try {
      const status = await new Promise<number>((res, rej) => {
        http.get({ host: "127.0.0.1", port: (srv.address() as { port: number }).port, path: "/pocket/api/me", headers: { host: TAILNET, ...TS, cookie: `cc_pocket=${ph.id}.${secret}` } }, (x) => { x.resume(); res(x.statusCode ?? 0); }).on("error", rej);
      });
      assert.equal(status, 401, "a relay phone is reachable through its channel and nowhere else");
    } finally {
      await new Promise<void>((res) => { srv.closeAllConnections(); srv.close(() => res()); });
    }
    assert.equal(refuseRequest({ id: 1, method: "GET", path: "/api/pocket" }), "only /pocket/api/ paths");
    assert.equal(refuseRequest({ id: 1, method: "GET", path: "/pocket/api/../../api/keys" }), "only /pocket/api/ paths");
    assert.equal(refuseRequest({ id: 1, method: "PUT", path: "/pocket/api/me" }), "method must be GET, POST or DELETE");
    const hud = await ph.link.request("GET", "/api/pocket");
    assert.equal(hud.status, 400);
  } finally { await r.close(); }
});

test("relay: a tampering relay is caught end to end, and nothing it altered or replayed is acted on", async () => {
  const r = await rig();
  try {
    const ph = await pairPhone(r);
    // Flip one bit in what the phone sends.
    r.net.tamper = (frame, to) => {
      const m = JSON.parse(frame);
      if (to !== "claw" || m.t !== "from") return frame;
      const b = Buffer.from(m.d, "base64url");
      b[b.length - 1] ^= 1;
      return JSON.stringify({ ...m, d: b.toString("base64url") });
    };
    await assert.rejects(ph.api("POST", "/chat", { message: "tampered" }));
    assert.deepEqual(r.chats, [], "an altered request is never dispatched");
    r.net.tamper = null;
    // Replay: the relay delivers each record twice. The first is acted on once; the copy kills the channel.
    const ph2 = await pairPhone(r, "Second");
    r.net.tamper = (frame, to) => (to === "claw" && JSON.parse(frame).t === "from" ? [frame, frame] : frame);
    await ph2.api("POST", "/chat", { message: "once" }).catch(() => {});
    await r.net.settle();
    assert.deepEqual(r.chats, ["once"], "a replayed request is not run twice");
    r.net.tamper = null;
    // Key substitution on reconnect: the relay answers the session handshake with a key of its own.
    const evil = crypto.createECDH("prime256v1");
    evil.generateKeys();
    r.net.tamper = (frame, to) => {
      const m = JSON.parse(frame);
      if (to === "phone" && m.t === "m" && m.d.startsWith("{")) {
        const hs = JSON.parse(m.d);
        if (hs.t === "hs2") return JSON.stringify({ t: "m", d: JSON.stringify({ ...hs, ck: evil.getPublicKey().toString("base64url") }) });
      }
      return frame;
    };
    const back = newLink(r, ph.store);
    await back.link.load();
    await assert.rejects(back.api("GET", "/me"), /substituted/);
  } finally { await r.close(); }
});

test("relay: a relay that sends a phone to another claw's room cannot pair it there", async () => {
  const a = await rig();
  const b = await rig();
  try {
    // Both claws are pairing; the relay routes A's phone into B's room.
    const fromA = parsePairLink(new URL((await mintRelay(a)).json.url).hash)!;
    await mintRelay(b);
    const bRoom = loadRelayIdentity(b.dataDir).room;
    // One relay serves both: share B's network with A's phone.
    b.net.reroute = (room) => (room === fromA.room ? bRoom : room);
    const { link } = newLink(b);
    await assert.rejects(link.beginPairing(fromA));
    assert.equal((await admin(b, "GET", "/")).json.devices.length, 0);
    assert.equal((await admin(a, "GET", "/")).json.devices.length, 0);
  } finally { await a.close(); await b.close(); }
});

test("relay: push for a relay phone is sent by the claw itself, and says how many, never what", async () => {
  const r = await rig();
  try {
    const ph = await pairPhone(r);
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/relay-phone", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
    assert.equal((await ph.api("POST", "/push", { subscription })).status, 200);
    r.pocket.onEvent("approval_request", { id: "ap-9", summary: "Pay invoice 1142", detail: "£1,240 to Caffi Bach" });
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(r.pushes.length, 1);
    assert.equal(r.pushes[0].url, subscription.endpoint, "straight to the push service, not via the relay");
    const opened = JSON.parse(decryptPayload(r.pushes[0].body, ua.getPrivateKey(), auth).toString());
    assert.equal(opened.body, "1 approval waiting");
    assert.ok(!JSON.stringify(opened).includes("invoice"));
    assert.ok(!relaySaw(r).includes("fcm.googleapis.com"), "the relay never learns the phone's push endpoint");
  } finally { await r.close(); }
});

test("relay: switched off, or with no URL, there is no relay pairing and no dialling out", async () => {
  assert.equal(relayConfig(undefined), null);
  assert.equal(relayConfig({ url: "" }), null);
  assert.equal(relayConfig({ enabled: false, url: "wss://relay.example" }), null);
  assert.equal(relayConfig({ url: "ws://relay.example" }), null, "plain ws only for this machine's own names");
  assert.equal(relayConfig({ url: "wss://relay.example", appOrigin: "http://cunningclaw.com" }), null);
  assert.deepEqual(relayConfig({ url: "ws://127.0.0.1:8787/" }), { url: "ws://127.0.0.1:8787", appOrigin: APP });
  const r = await rig({ relay: false });
  try {
    const minted = await admin(r, "POST", "/pair", { mode: "relay" });
    assert.equal(minted.status, 409);
    assert.match(minted.json.error, /switched off/);
    assert.equal((await admin(r, "GET", "/")).json.relay, null);
    assert.equal(r.net.sockets.length, 0);
  } finally { await r.close(); }
});

test("relay: a dial that never gets an answer is given up and tried again, not left connecting for ever", () => {
  // Node's WebSocket has no connect timeout. Found driving the real Worker:
  // a relay restarted mid-handshake left the claw "connecting…" for good.
  const timers: { fn: () => void; ms: number; at: number }[] = [];
  let t = 0;
  const dials: { closed: boolean }[] = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cunningclaw-relay-dial-"));
  const transport = createRelayTransport({
    config: relayConfig({ url: "wss://relay.test" })!,
    identity: loadRelayIdentity(dataDir),
    pocket: { relayDevices: () => [{ id: "d1", relayKey: "k", relayTokenHash: "h" }], relayPairingLive: () => false },
    dispatch: () => ({ abort() {} }),
    // A socket that is never opened and never closed: the hung handshake.
    connect: () => {
      const d = { closed: false };
      dials.push(d);
      return { readyState: 0, send() {}, close() { d.closed = true; }, onopen: null, onmessage: null, onclose: null, onerror: null };
    },
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, ms, at: t + ms }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x as never); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms: number) => {
    t += ms;
    for (let due = timers.filter((x) => x.at <= t); due.length; due = timers.filter((x) => x.at <= t)) {
      for (const x of due) { timers.splice(timers.indexOf(x), 1); x.fn(); }
    }
  };
  transport.ensure();
  assert.equal(transport.state(), "connecting");
  assert.equal(dials.length, 1);
  advance(16_000);
  assert.equal(transport.state(), "unreachable", "the hung dial is given up");
  assert.equal(dials[0].closed, true, "and its socket closed");
  assert.match(transport.status().message, /did not answer/);
  advance(2_000);
  assert.equal(dials.length, 2, "and the claw dials again by itself");
  transport.stop();
});

test("relay, the phone's side: a dial that never gets an answer fails with a sentence and is tried again", async () => {
  let dials = 0;
  const states: { state: string; text: string }[] = [];
  const store = memStore();
  await store.set({ relay: "wss://relay.test", room: "r".repeat(43), clawKey: new Uint8Array(65), phone: null, token: "t".repeat(43) });
  const link = createRelayLink({
    store,
    connect: () => { dials++; return { readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as never; },
    onState: (st: { state: string; text: string }) => states.push(st),
    retryMs: 30,
    readyMs: 40,
  });
  try {
    assert.equal(await link.load(), true);
    // Bounded: without the deadline the request would simply hang.
    const hung = new Promise((r) => { const t = setTimeout(() => r("still waiting after a second"), 1000); t.unref(); });
    await assert.rejects(Promise.race([link.request("GET", "/pocket/api/me"), hung.then((v) => { throw new Error(String(v)); })]), /relay cannot be reached/);
    assert.equal(states.at(-1)?.state, "offline");
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(dials >= 2, `the link dials again by itself (${dials} dials)`);
  } finally {
    link.close();
  }
});

test("doctor: says whether the relay is reachable, and what to do when it is not", async () => {
  const cfg = relayConfig({ url: "wss://pocket-relay.example" })!;
  const seen: string[] = [];
  const up = (async (url: string) => { seen.push(url); return new Response(JSON.stringify({ ok: true, service: "cunning-claw pocket relay", protocol: 1 })); }) as unknown as typeof fetch;
  assert.equal((await relayDoctorLine(cfg, up)).status, "ok");
  assert.deepEqual(seen, ["https://pocket-relay.example/healthz"], "the health check, over https, and nothing else");
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const bad = await relayDoctorLine(cfg, down);
  assert.equal(bad.status, "warn");
  assert.match(bad.text, /not deployed it yet/);
  assert.match(bad.text, /private network/, "a warned line names its fix");
  const parked = (async () => new Response("<html>parked</html>", { status: 200 })) as unknown as typeof fetch;
  assert.match((await relayDoctorLine(cfg, parked)).text, /not as the Pocket relay/);
  assert.equal((await relayDoctorLine(null, down)).status, "ok", "off is not a fault");
  // Without Tailscale, the relay means a phone can still pair: the Pocket line is not a warning.
  assert.equal(pocketDoctorLine(false, [], true).status, "ok");
  assert.equal(pocketDoctorLine(false, [], false).status, "warn");
});

test("doctor: says whether the website serves this claw's own phone app, file by file", async () => {
  const cfg = relayConfig({ url: "wss://pocket-relay.example", appOrigin: APP })!;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "pocket");
  const serve = (change?: string) => (async (url: string) => {
    const f = new URL(url).pathname.replace("/pocket/", "");
    const bytes = fs.readFileSync(path.join(dir, f));
    return new Response(f === change ? Buffer.concat([bytes, Buffer.from("\n// one more line")]) : bytes);
  }) as unknown as typeof fetch;
  assert.equal((await siteAppDoctorLine(cfg, dir, serve()))!.status, "ok");
  const changed = (await siteAppDoctorLine(cfg, dir, serve("e2e.js")))!;
  assert.equal(changed.status, "warn");
  assert.match(changed.text, /e2e\.js/);
  assert.equal(await siteAppDoctorLine(null, dir, serve()), null);
});
