import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import {
  approvalCardText,
  approvalSettled,
  armTelegram,
  CARD_ATTEMPTS,
  handleCallback,
  isConflict,
  maskChatId,
  onlineText,
  outboundText,
  parseChatAllowlist,
  pollLoop,
  sendApprovalCard,
  startTelegram,
  telegramStatus,
  TelegramError,
  type TelegramIO,
} from "./telegram.js";

/**
 * Telegram is the one surface that leaves the machine entirely.
 *
 * The HUD's SSE stream goes through redactDeep and history.json is redacted
 * before it is written, but this module imported no redaction at all — so the
 * same approval card that read [REDACTED] on the glass arrived on the phone,
 * via a third-party cloud, with the key in it.
 *
 * Fixtures are synthetic, matching the real shapes, per redact.test.ts.
 */

const ANTHROPIC = "sk-ant-api03-EXAMPLEfakeKEY0000111122223333444455556666777788889999aa";
const AWS = "AKIAIOSFODNN7EXAMPLE";

test("an approval card does not carry a credential to Telegram's servers", () => {
  const card = approvalCardText("Run shell command", `deploy --token=${ANTHROPIC}`);
  assert.doesNotMatch(card, /sk-ant-api03-EXAMPLEfake/);
  assert.match(card, /REDACTED/);
  // The card must still be readable, or the human cannot judge what they are
  // approving — which is the entire point of the card.
  assert.match(card, /deploy --token=/);
  assert.match(card, /⚠ APPROVAL REQUIRED/);
  assert.match(card, /Run shell command/);
});

test("a file-write preview of .env is redacted before it is sent", () => {
  const card = approvalCardText(
    "Write file /home/owner/project/.env",
    `AWS_ACCESS_KEY_ID=${AWS}\nOPENROUTER_API_KEY=sk-or-v1-EXAMPLEfake0000111122223333`,
  );
  assert.doesNotMatch(card, new RegExp(AWS));
  assert.doesNotMatch(card, /sk-or-v1-EXAMPLEfake/);
});

test("redaction happens before truncation, so a key straddling the cut is caught", () => {
  // Truncating first would leave the tail of a key unmatched and ship it.
  const padded = "x".repeat(3880) + ANTHROPIC;
  const out = outboundText(padded);
  assert.doesNotMatch(out, /sk-ant-api03-EXAMPLEfake/);
  assert.ok(out.length <= 3900, "still truncated to Telegram's limit");
});

test("a private key in a model reply never reaches the phone", () => {
  const reply = [
    "Here is the file you asked for:",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  assert.doesNotMatch(outboundText(reply), /BEGIN OPENSSH PRIVATE KEY/);
});

test("ordinary text goes through untouched", () => {
  const plain = "Morning briefing: two unread, nothing overdue, disk at 41%.";
  assert.equal(outboundText(plain), plain);
});

test("the chat allowlist ignores blanks and whitespace", () => {
  assert.deepEqual([...parseChatAllowlist(" 123 , 456,, ")], ["123", "456"]);
});

test("the HUD sees only the last four digits of a chat id", () => {
  // The telemetry panel is filmed for the launch video; a chat id is a
  // personal identifier and the full one was on screen.
  assert.equal(maskChatId("5550001234"), "…1234");
  assert.doesNotMatch(maskChatId("5550001234"), /5550001234/);
  for (const c of telegramStatus().chats) assert.match(c, /^…\d{0,4}$/);
});

test("telegram.enabled=false in config beats the env token — the poller must not arm", () => {
  // A second claw on the same machine shares .env via the repo, so the token
  // is present; but Telegram allows one getUpdates poller per token, and two
  // claws polling means both go deaf. The config switch must win outright:
  // startTelegram returns before touching the token, the allowlist, or the
  // network. Observable here: telegramStatus() stays dark.
  const savedCfg = config.telegram;
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedChat = process.env.TELEGRAM_CHAT_ID;
  try {
    config.telegram = { enabled: false };
    process.env.TELEGRAM_BOT_TOKEN = "123456789:EXAMPLEfakeTELEGRAMtoken00000000000";
    process.env.TELEGRAM_CHAT_ID = "5550001234";
    startTelegram(
      { emit: () => {}, requestApproval: async () => false },
      { resolveApproval: () => false },
    );
    assert.equal(telegramStatus().enabled, false, "disabled in config — the token must be ignored");
    assert.deepEqual(telegramStatus().chats, [], "no allowlist armed, so no chat can be messaged");
  } finally {
    config.telegram = savedCfg;
    if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = savedChat;
  }
});

test("a renamed claw greets under its own name, not the brand", () => {
  // "Name your claw": persona.name in claw.config.json renames the individual
  // butler, and the boot greeting is the butler speaking. Hardcoding CUNNING
  // CLAW here is invisible on a default install (the default name IS Cunning
  // Claw), so the test renames first — reverting the fix fails it.
  const saved = config.persona.name;
  try {
    config.persona.name = "Vera";
    assert.match(onlineText(), /^Vera online\./);
    assert.doesNotMatch(onlineText(), /CUNNING CLAW/i);
  } finally {
    config.persona.name = saved;
  }
});

// ── Reliability ─────────────────────────────────────────────────────────────
//
// From the live server log: ~1,586 "fetch failed" lines (1,082 on one day)
// from a loop that retried every 4 s and logged every miss, fetches with no
// timeout, an unhandled rejection out of fetch, and three approval cards that
// failed once and were never sent. The network and the clock are stood in, so
// none of this touches api.telegram.org or waits in real time.

// Only ever lands in a fake URL, so it need not look like a real token.
const TOKEN = "test-token";
const CHAT = "5550001234";
const fetchFailed = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
const conflict = () =>
  new TelegramError("Conflict: terminated by other getUpdates request; make sure that only one bot instance is running", 409);

/** Drive pollLoop through a scripted run of poll outcomes, then stop. */
async function runPolls(script: Array<"fail" | "conflict" | unknown[]>) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const handled: unknown[] = [];
  let clock = 0;
  let i = 0;
  await pollLoop({
    getUpdates: async () => {
      const step = script[i++];
      if (step === "fail") throw fetchFailed();
      if (step === "conflict") throw conflict();
      return step;
    },
    handle: async (u) => { handled.push(u); },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    log: (l) => logs.push(l),
    running: () => i < script.length,
  });
  return { sleeps, logs, handled };
}

test("a dead network backs polling off from 4 s to a five-minute cap, and success resets it", async () => {
  const { sleeps } = await runPolls([...Array(10).fill("fail"), [], "fail"]);
  assert.deepEqual(sleeps, [
    4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000,
    4000, // one good poll and the next miss starts again from the bottom
  ]);
});

test("an outage is logged once going down and once coming back, not once per miss", async () => {
  const { logs } = await runPolls([...Array(200).fill("fail"), []]);
  assert.equal(logs.length, 2, `two lines for 200 failures, got: ${logs.join(" | ")}`);
  assert.match(logs[0], /polling down — fetch failed \(ENOTFOUND\)/);
  assert.match(logs[1], /recovered after 200 failed attempt\(s\)/);
});

test("a 409 Conflict is called out once, as a second claw on the same bot", async () => {
  const { logs } = await runPolls(["fail", "conflict", "conflict", "conflict", [], "conflict", []]);
  const conflictLines = logs.filter((l) => /Conflict/.test(l));
  // Once per outage, however many 409s — and a second outage says it again.
  assert.equal(conflictLines.length, 2);
  assert.match(conflictLines[0], /second copy of the claw is polling the same bot/);
  assert.doesNotMatch(logs[0], /second copy/, "the network outage is its own line");
  // A webhook left set also answers 409, and blaming a second claw would send
  // the operator hunting for a process that does not exist.
  assert.equal(isConflict(new TelegramError("Conflict: can't use getUpdates method while webhook is active", 409)), false);
});

test("a failing update handler is not a poll failure and does not lose the next update", async () => {
  const sleeps: number[] = [];
  const handled: number[] = [];
  const offsets: number[] = [];
  let polls = 0;
  await pollLoop({
    getUpdates: async (offset) => {
      offsets.push(offset);
      polls++;
      return polls === 1 ? [{ update_id: 41 }, { update_id: 42 }] : [];
    },
    handle: async (u) => {
      handled.push(u.update_id);
      if (u.update_id === 41) throw fetchFailed(); // e.g. the "already settled" reply failed
    },
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => 0,
    log: () => {},
    running: () => polls < 2,
  });
  assert.deepEqual(handled, [41, 42], "the second update is still handled");
  assert.deepEqual(sleeps, [], "a send failing is not the poll failing");
  assert.equal(offsets[1], 43, "both updates acknowledged");
});

/** A response that never comes: the half-open socket after the laptop wakes. */
const HANG = Symbol("hang");

/** A fake network that answers per Telegram method and remembers every call. */
function fakeIO(respond: (method: string, body: any) => unknown) {
  const timeouts = new Map<AbortSignal, number>();
  const calls: { method: string; body: any; timeoutMs: number | undefined }[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const io: TelegramIO = {
    fetch: (async (url: unknown, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, body, timeoutMs: init?.signal ? timeouts.get(init.signal) : undefined });
      const out = respond(method, body);
      if (out === HANG) return new Promise<Response>(() => {});
      if (out instanceof Error) throw out;
      return new Response(JSON.stringify(out));
    }) as typeof fetch,
    timeout: (ms) => {
      const signal = new AbortController().signal;
      timeouts.set(signal, ms);
      return signal;
    },
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => 0,
    log: (l) => logs.push(l),
  };
  return { io, calls, sleeps, logs };
}

const ok = (result: unknown) => ({ ok: true, result });

test("every request carries a timeout, and the long poll's outlasts its own wait", async () => {
  const savedCfg = config.telegram;
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedChat = process.env.TELEGRAM_CHAT_ID;
  // getUpdates never answers — exactly the hang an un-timed fetch could not escape.
  const net = fakeIO((method) => (method === "getUpdates" ? HANG : ok({ message_id: 1 })));
  try {
    config.telegram = { enabled: true };
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_CHAT_ID = CHAT;
    startTelegram({ emit: () => {}, requestApproval: async () => false }, { resolveApproval: () => false }, net.io);
    await new Promise((r) => setImmediate(r));
    const poll = net.calls.find((c) => c.method === "getUpdates");
    assert.ok(poll, "the poller started");
    assert.ok(poll.timeoutMs, "the long poll has a timeout");
    assert.ok(poll.timeoutMs > poll.body.timeout * 1000, "longer than the wait it asked Telegram for");
    const hello = net.calls.find((c) => c.method === "sendMessage");
    assert.ok(hello?.timeoutMs, "an ordinary send has one too");
  } finally {
    armTelegram(null, new Set(), null);
    config.telegram = savedCfg;
    if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = savedChat;
  }
});

test("a failed approval card is retried a bounded number of times, with backoff", async () => {
  try {
    // Two network misses, then through.
    let n = 0;
    const flaky = fakeIO(() => (++n <= 2 ? fetchFailed() : ok({ message_id: 7 })));
    armTelegram(TOKEN, new Set([CHAT]), () => true, flaky.io);
    await sendApprovalCard("req-1", "Run shell command", "ls");
    assert.equal(flaky.calls.filter((c) => c.method === "sendMessage").length, 3, "delivered on the third try");
    assert.deepEqual(flaky.sleeps, [2000, 4000]);

    // Down for good: it gives up after CARD_ATTEMPTS and says so, masked.
    const dead = fakeIO(() => fetchFailed());
    armTelegram(TOKEN, new Set([CHAT]), () => true, dead.io);
    await sendApprovalCard("req-2", "Run shell command", "ls");
    assert.equal(dead.calls.length, CARD_ATTEMPTS);
    assert.equal(dead.logs.length, 1);
    assert.match(dead.logs[0], /not sent after 3 attempt/);
    assert.doesNotMatch(dead.logs[0], new RegExp(CHAT));

    // A refusal that will not change is not retried.
    const refused = fakeIO(() => ({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }));
    armTelegram(TOKEN, new Set([CHAT]), () => true, refused.io);
    await sendApprovalCard("req-3", "Run shell command", "ls");
    assert.equal(refused.calls.length, 1);

    // Settled on the HUD mid-retry: the stale card is not sent again.
    const settling = fakeIO(() => fetchFailed());
    settling.io.sleep = async () => { approvalSettled("req-4", true); };
    armTelegram(TOKEN, new Set([CHAT]), () => true, settling.io);
    await sendApprovalCard("req-4", "Run shell command", "ls");
    assert.equal(settling.calls.length, 1);
  } finally {
    armTelegram(null, new Set(), null);
  }
});

test("the verdict line after an approval cannot escape as an unhandled rejection", async () => {
  const escaped: unknown[] = [];
  const onUnhandled = (err: unknown) => escaped.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    let down = false;
    const net = fakeIO(() => (down ? fetchFailed() : ok({ message_id: 7 })));
    armTelegram(TOKEN, new Set([CHAT]), () => true, net.io);
    await sendApprovalCard("req-5", "Run shell command", "ls");
    down = true; // the network goes before the operator presses the button on the HUD
    approvalSettled("req-5", true);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(escaped, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    armTelegram(null, new Set(), null);
  }
});

test("a button press is logged with the chat id masked", async () => {
  try {
    const net = fakeIO(() => ok(true));
    armTelegram(TOKEN, new Set([CHAT]), () => true, net.io);
    await handleCallback({ id: "cb-1", data: "yes:req-6", message: { chat: { id: Number(CHAT) } } });
    const line = net.logs.find((l) => /callback/.test(l));
    assert.ok(line, "the press is still visible in the journal");
    assert.match(line, /…1234/);
    assert.doesNotMatch(line, new RegExp(CHAT));
  } finally {
    armTelegram(null, new Set(), null);
  }
});
