import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import {
  Gateway,
  INTENTS,
  MESSAGE_LIMIT,
  approvalCardPayload,
  armDiscord,
  channelText,
  discordStatus,
  handleInteraction,
  handleMessage,
  sendAlert,
  sendApprovalCard,
  maskUserId,
  onlineText,
  outboundChunks,
  parseInteraction,
  parseUserAllowlist,
  startDiscord,
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

test("discord.enabled=false in config beats the env token — the Gateway must not arm", () => {
  // Same rule as Telegram: a second claw sharing .env must be able to decline
  // the bot without editing secrets. startDiscord has to return before it
  // stores the token or reaches for the gateway; discordStatus() staying dark
  // is the observable, because enabled is Boolean(botToken && allowed.size).
  const savedCfg = config.discord;
  const savedToken = process.env.DISCORD_BOT_TOKEN;
  const savedUsers = process.env.DISCORD_ALLOWED_USER_ID;
  try {
    config.discord = { enabled: false };
    process.env.DISCORD_BOT_TOKEN = TOKEN; // synthetic, as everywhere in this file
    process.env.DISCORD_ALLOWED_USER_ID = "819273645501";
    startDiscord(
      { emit: () => {}, requestApproval: async () => false },
      { resolveApproval: () => false },
    );
    assert.equal(discordStatus().enabled, false, "disabled in config — the token must be ignored");
    assert.deepEqual(discordStatus().users, [], "no allowlist armed");
  } finally {
    config.discord = savedCfg;
    if (savedToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = savedToken;
    if (savedUsers === undefined) delete process.env.DISCORD_ALLOWED_USER_ID;
    else process.env.DISCORD_ALLOWED_USER_ID = savedUsers;
  }
});

test("a renamed claw greets under its own name, not the brand", () => {
  // Sibling of the Telegram test: the boot greeting is the butler speaking,
  // so it follows persona.name. Renaming first is what makes a hardcoded
  // CUNNING CLAW visible — the default name is the brand, so a default-config
  // assertion would pass either way.
  const saved = config.persona.name;
  try {
    config.persona.name = "Vera";
    assert.match(onlineText(), /^Vera online\./);
    assert.doesNotMatch(onlineText(), /CUNNING CLAW/i);
  } finally {
    config.persona.name = saved;
  }
});

// ── Rooms are not people ────────────────────────────────────────────────────
// The rule telegram.ts learnt for groups. Cards went to the last channel the
// operator spoke in — a public server channel as easily as a DM — so the
// command, the path and the EXECUTE button sat in front of everyone there.

const OP_A = "819273645501";
const OP_B = "819273645502";

/** A fake Discord REST API: records every call, opens a DM per user, numbers messages. */
function fakeRest() {
  const calls: { method: string; path: string; body: any }[] = [];
  let n = 0;
  const fetchFn = (async (url: string, init: any) => {
    const p = String(url).replace("https://discord.com/api/v10", "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method, path: p, body });
    if (p === "/users/@me/channels") return new Response(JSON.stringify({ id: `dm-${body.recipient_id}`, type: 1 }), { status: 200 });
    if (/\/callback$/.test(p)) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ id: `msg-${++n}` }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const quiet = { emit: () => {}, requestApproval: async () => false } as any;

test("approval cards go only to each operator's DM, never the server channel they last spoke in", async () => {
  const net = fakeRest();
  try {
    armDiscord(TOKEN, new Set([OP_A, OP_B]), () => true, net.fetchFn);
    // The operator speaks in a server channel first: under the old rule this
    // made it the place the next card landed.
    await handleMessage({ id: "m1", channelId: "guild-chan", guildId: "g1", userId: OP_A, bot: false, content: "/help" }, quiet);
    net.calls.length = 0;
    await sendApprovalCard("req-1", "Run shell command", "ls ~/projects");
    const opened = net.calls.filter((c) => c.path === "/users/@me/channels").map((c) => c.body.recipient_id);
    assert.deepEqual(opened.sort(), [OP_A, OP_B], "a DM is opened by user id for each operator");
    const cards = net.calls.filter((c) => /\/messages$/.test(c.path));
    assert.deepEqual(cards.map((c) => c.path).sort(), [`/channels/dm-${OP_A}/messages`, `/channels/dm-${OP_B}/messages`]);
    assert.ok(!net.calls.some((c) => c.path.includes("guild-chan")), "nothing went to the server channel");
  } finally {
    armDiscord(null, new Set(), null);
  }
});

test("a button pressed in a server channel settles nothing, even the operator's; in a DM it settles", async () => {
  const net = fakeRest();
  let settled = 0;
  try {
    armDiscord(TOKEN, new Set([OP_A]), () => { settled++; return true; }, net.fetchFn);
    const press = { id: "i1", token: "itok", userId: OP_A, messageContent: "⚠ card", approvalId: "req-2", approved: true };
    await handleInteraction({ ...press, channelId: "guild-chan", guildId: "g1" });
    assert.equal(settled, 0, "a room is not the place to approve");
    const refusal = net.calls.find((c) => c.path.endsWith("/callback"));
    assert.equal(refusal?.body.type, 4);
    assert.equal(refusal?.body.data.flags, 64, "told privately");
    assert.match(refusal?.body.data.content, /DM/);

    await handleInteraction({ ...press, id: "i2", channelId: `dm-${OP_A}`, guildId: null });
    assert.equal(settled, 1, "the same press from a DM counts");
  } finally {
    armDiscord(null, new Set(), null);
  }
});

test("text bound for a server channel has the machine taken out; a DM keeps it", async () => {
  const line = `Saved to /home/sam/notes.md on forgebox, HUD at 192.168.1.20, key ${ANTHROPIC}`;
  const room = channelText(line, false, "forgebox");
  assert.doesNotMatch(room, /\/home\/sam|forgebox|192\.168/);
  assert.doesNotMatch(room, /sk-ant-api03-EXAMPLEfake/);
  const dm = channelText(line, true, "forgebox");
  assert.match(dm, /\/home\/sam\/notes\.md/);
  assert.doesNotMatch(dm, /sk-ant-api03-EXAMPLEfake/, "redacted everywhere");

  // And /status in a server channel says to ask in a DM rather than send it.
  const net = fakeRest();
  try {
    armDiscord(TOKEN, new Set([OP_A]), () => true, net.fetchFn);
    await handleMessage({ id: "m2", channelId: "guild-chan", guildId: "g1", userId: OP_A, bot: false, content: "/status" }, quiet);
    const sent = net.calls.filter((c) => c.path === "/channels/guild-chan/messages").map((c) => c.body.content);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Ask me for \/status in a DM/);
  } finally {
    armDiscord(null, new Set(), null);
  }
});

test("a house alert goes to each operator's DM and nowhere else", async () => {
  const net = fakeRest();
  try {
    armDiscord(TOKEN, new Set([OP_A, OP_B]), () => true, net.fetchFn);
    await handleMessage({ id: "m9", channelId: "guild-chan", guildId: "g1", userId: OP_A, bot: false, content: "/help" }, quiet);
    net.calls.length = 0;
    assert.equal(await sendAlert(`Front door — doorbell pressed at 14:32. ${ANTHROPIC}`), 2);
    const posts = net.calls.filter((c) => /\/messages$/.test(c.path));
    assert.deepEqual(posts.map((c) => c.path).sort(), [`/channels/dm-${OP_A}/messages`, `/channels/dm-${OP_B}/messages`]);
    assert.ok(!net.calls.some((c) => c.path.includes("guild-chan")));
    assert.ok(posts.every((c) => !String(c.body.content).includes(ANTHROPIC)), "redacted");
  } finally {
    armDiscord(null, new Set(), null);
  }
});
