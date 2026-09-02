import assert from "node:assert/strict";
import test from "node:test";
import {
  Gateway,
  INTENTS,
  MESSAGE_LIMIT,
  approvalCardPayload,
  discordStatus,
  maskUserId,
  outboundChunks,
  parseInteraction,
  parseUserAllowlist,
  type GatewayDeps,
  type SocketLike,
} from "./discord.js";

/**
 * No token, no network. The Gateway takes its sockets and timers by injection,
 * so the whole handshake — HELLO, IDENTIFY, heartbeat, READY, RESUME, the
 * fatal close codes — runs against a fake socket fed synthetic frames.
 */

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.EXAMPLE.fakeTOKENfakeTOKENfakeTOKENfake";
const ANTHROPIC = "sk-ant-api03-EXAMPLEfakeKEY0000111122223333444455556666777788889999aa";

class FakeSocket implements SocketLike {
  sent: any[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {}
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code = 1000) { this.closedWith = code; this.onclose?.({ code }); }
  /** A frame from Discord's side. */
  frame(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const seen = { messages: [] as any[], interactions: [] as any[], fatal: [] as string[], logs: [] as string[], ready: 0 };
  const deps: GatewayDeps = {
    connect: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (h) => { const i = timers.indexOf(h as any); if (i >= 0) timers.splice(i, 1); },
    log: (l) => seen.logs.push(l),
    onReady: () => { seen.ready++; },
    onMessage: (m) => seen.messages.push(m),
    onInteraction: (i) => seen.interactions.push(i),
    onFatal: (r) => seen.fatal.push(r),
  };
  const gw = new Gateway(TOKEN, "wss://gateway.discord.gg", deps);
  gw.start();
  return { gw, sockets, timers, seen, sock: () => sockets[sockets.length - 1] };
}

const HELLO = { op: 10, d: { heartbeat_interval: 41250 } };
const READY = { op: 0, s: 1, t: "READY", d: { session_id: "sess-1", resume_gateway_url: "wss://resume.discord.gg" } };

test("HELLO is answered with IDENTIFY carrying the token and the intents the bot needs", () => {
  const h = harness();
  assert.match(h.sock().url, /v=10&encoding=json$/);
  h.sock().frame(HELLO);
  const identify = h.sock().sent.find((f) => f.op === 2);
  assert.ok(identify, "IDENTIFY sent");
  assert.equal(identify.d.token, TOKEN);
  assert.equal(identify.d.intents, INTENTS);
  assert.ok(INTENTS & (1 << 15), "MESSAGE_CONTENT is requested — without it every guild message arrives empty");
});

test("heartbeats carry the last sequence, and one that goes unanswered forces a resume", () => {
  const h = harness();
  h.sock().frame(HELLO);
  h.sock().frame(READY);
  h.sock().frame({ op: 0, s: 7, t: "PRESENCE_UPDATE", d: {} });
  assert.equal(h.seen.ready, 1);

  const first = h.timers[0]; // the jittered first beat
  first.fn();
  const beat = h.sock().sent.filter((f) => f.op === 1).pop();
  assert.deepEqual(beat, { op: 1, d: 7 }, "heartbeat carries the last seq");

  // No ACK arrives. The next beat must treat the socket as dead.
  const second = h.timers[h.timers.length - 1];
  const before = h.sock();
  second.fn();
  assert.equal(before.closedWith, 4000, "zombie socket closed");
  assert.match(h.seen.logs.join("\n"), /unanswered/);

  // Reconnect goes to the resume url and RESUMEs with the session and seq.
  const reconnect = h.timers[h.timers.length - 1];
  reconnect.fn();
  assert.equal(h.sockets.length, 2);
  assert.match(h.sock().url, /^wss:\/\/resume\.discord\.gg/);
  h.sock().frame(HELLO);
  const resume = h.sock().sent.find((f) => f.op === 6);
  assert.ok(resume, "RESUME sent rather than a fresh IDENTIFY");
  assert.equal(resume.d.session_id, "sess-1");
  assert.equal(resume.d.seq, 7);
  assert.ok(!h.sock().sent.some((f) => f.op === 2), "no IDENTIFY on a resumable reconnect");
});

test("a non-resumable INVALID_SESSION identifies fresh on the original url", () => {
  const h = harness();
  h.sock().frame(HELLO);
  h.sock().frame(READY);
  h.sock().frame({ op: 9, d: false });
  h.timers[h.timers.length - 1].fn();
  assert.match(h.sock().url, /^wss:\/\/gateway\.discord\.gg/);
  h.sock().frame(HELLO);
  assert.ok(h.sock().sent.some((f) => f.op === 2), "IDENTIFY");
  assert.ok(!h.sock().sent.some((f) => f.op === 6), "no RESUME without a session");
});

test("close 4014 names the privileged intent and never reconnects", () => {
  const h = harness();
  h.sock().frame(HELLO);
  const timersBefore = h.timers.length;
  h.sock().close(4014);
  assert.equal(h.seen.fatal.length, 1);
  assert.match(h.seen.fatal[0], /MESSAGE CONTENT/);
  assert.match(h.seen.fatal[0], /Developer Portal/);
  assert.equal(h.sockets.length, 1, "no new socket");
  assert.ok(h.timers.length < timersBefore, "heartbeat cleared, nothing scheduled");
});

test("a rejected token is fatal and points at .env", () => {
  const h = harness();
  h.sock().close(4004);
  assert.match(h.seen.fatal[0], /DISCORD_BOT_TOKEN/);
  assert.equal(h.sockets.length, 1);
});

test("an ordinary close reconnects with backoff, and the token never appears in a log line", () => {
  const h = harness();
  h.sock().frame(HELLO);
  h.sock().close(1006);
  const t1 = h.timers[h.timers.length - 1];
  t1.fn();
  h.sock().close(1006);
  const t2 = h.timers[h.timers.length - 1];
  assert.ok(t2.ms > t1.ms, `backoff grows: ${t1.ms} then ${t2.ms}`);
  for (const l of h.seen.logs) assert.doesNotMatch(l, new RegExp(TOKEN.slice(0, 20)));
});

test("a message is handed over with its author, so the allowlist can judge it", () => {
  const h = harness();
  h.sock().frame(HELLO);
  h.sock().frame({
    op: 0, s: 2, t: "MESSAGE_CREATE",
    d: { id: "m1", channel_id: "c1", guild_id: "g1", author: { id: "u-stranger", bot: false }, content: "rm -rf /" },
  });
  assert.equal(h.seen.messages.length, 1);
  assert.equal(h.seen.messages[0].userId, "u-stranger");
  assert.equal(h.seen.messages[0].guildId, "g1");
  assert.equal(h.seen.messages[0].content, "rm -rf /");
  assert.equal(h.seen.messages[0].bot, false);
});

test("a button press becomes an approval decision; anything else is not", () => {
  const h = harness();
  h.sock().frame(HELLO);
  h.sock().frame({
    op: 0, s: 3, t: "INTERACTION_CREATE",
    d: { id: "i1", token: "itok", type: 3, channel_id: "c1", member: { user: { id: "u1" } }, data: { custom_id: "approve:abc-123" }, message: { content: "⚠ card" } },
  });
  assert.equal(h.seen.interactions.length, 1);
  assert.equal(h.seen.interactions[0].approvalId, "abc-123");
  assert.equal(h.seen.interactions[0].approved, true);
  assert.equal(h.seen.interactions[0].userId, "u1");

  assert.equal(parseInteraction({ id: "i2", token: "t", type: 2, data: { name: "slash" } }), null, "a slash command is not a button");
  assert.equal(parseInteraction({ id: "i3", token: "t", type: 3, data: { custom_id: "other:1" }, user: { id: "u" } }), null, "not our button");
  assert.equal(parseInteraction({ type: 3, data: { custom_id: "deny:1" }, user: { id: "u" } }), null, "no id/token — cannot be answered");
  const dm = parseInteraction({ id: "i4", token: "t", type: 3, data: { custom_id: "deny:zz" }, user: { id: "u9" } });
  assert.equal(dm?.approved, false);
  assert.equal(dm?.userId, "u9", "a DM interaction carries user, not member");
});

test("the approval card carries no credential and both buttons", () => {
  const p = approvalCardPayload("id-1", "Run shell command", `deploy --token=${ANTHROPIC}`);
  assert.doesNotMatch(p.content, /sk-ant-api03-EXAMPLEfake/);
  assert.match(p.content, /REDACTED/);
  assert.match(p.content, /deploy --token=/, "still readable, or the human cannot judge it");
  assert.ok(p.content.length <= MESSAGE_LIMIT);
  const ids = p.components[0].components.map((b) => b.custom_id);
  assert.deepEqual(ids, ["approve:id-1", "deny:id-1"]);
});

test("a fence inside the detail cannot close the card's code block", () => {
  const p = approvalCardPayload("x", "Write file", "```\nevil markdown\n```");
  const fences = p.content.match(/```/g) ?? [];
  assert.equal(fences.length, 2, "exactly our opening and closing fence");
});

test("a reply is redacted before it is chunked, and chunks respect Discord's limit", () => {
  const padded = "x".repeat(MESSAGE_LIMIT - 20) + ANTHROPIC + "\n" + "y".repeat(100);
  const chunks = outboundChunks(padded);
  for (const c of chunks) {
    assert.ok(c.length <= MESSAGE_LIMIT, `chunk of ${c.length}`);
    assert.doesNotMatch(c, /sk-ant-api03-EXAMPLEfake/);
  }
  assert.ok(chunks.length >= 2);
});

test("chunks break on a newline where one is near, and a wall of text is capped", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${"-".repeat(50)}`).join("\n");
  const chunks = outboundChunks(lines);
  assert.ok(chunks.length >= 2, "long enough to need splitting");
  for (const c of chunks) {
    for (const line of c.split("\n")) assert.match(line, /^line \d+ -{50}$/, `a line was cut: "${line}"`);
  }
  const wall = "z".repeat(MESSAGE_LIMIT * 10);
  const capped = outboundChunks(wall);
  assert.ok(capped.length <= 4);
  assert.match(capped[capped.length - 1], /…$/);
  assert.deepEqual(outboundChunks("   "), []);
});

test("the allowlist ignores blanks, and the HUD sees only the last four digits of a user id", () => {
  assert.deepEqual([...parseUserAllowlist(" 123 , 456,, ")], ["123", "456"]);
  assert.equal(maskUserId("819273645501"), "…5501");
  assert.equal(discordStatus().enabled, false, "nothing configured in tests");
  for (const u of discordStatus().users) assert.match(u, /^…\d{0,4}$/);
});
