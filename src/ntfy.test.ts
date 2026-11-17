import assert from "node:assert/strict";
import os from "node:os";
import test, { afterEach } from "node:test";
import { config } from "./config.js";
import {
  approvalSettled,
  armNtfy,
  GUESSABLE_BELOW,
  headerSafe,
  MAX_BODY_CHARS,
  notifyPhone,
  ntfyDoctorLine,
  ntfyRequest,
  ntfyStatus,
  phoneNotifyTool,
  phoneText,
  resolveNtfy,
  sendApprovalAlert,
  startNtfy,
  suggestTopic,
  type Armed,
  type NtfyIO,
} from "./ntfy.js";

/**
 * ntfy is the one phone line with no account behind it: on public ntfy.sh the
 * topic's name is the whole lock, and anyone who guesses it reads what was
 * sent. So what leaves has to be minimal and scrubbed, the name must never be
 * shown whole, and a push that fails must never take a turn down with it.
 *
 * Fixtures are synthetic, matching the real shapes, per redact.test.ts.
 */

const TOPIC = "claw-SyntheticTopic0000111122223333";
const ANTHROPIC = "sk-ant-api03-EXAMPLEfakeKEY0000111122223333444455556666777788889999aa";

interface Sent { url: string; init: RequestInit }

function fakeIO(respond: (n: number) => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const io: NtfyIO = {
    fetch: (async (url: any, init: any) => {
      sent.push({ url: String(url), init });
      return respond(sent.length);
    }) as typeof fetch,
    timeout: () => new AbortController().signal,
    later: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
    log: (line) => logs.push(line),
  };
  return { io, sent, logs, timers };
}

function settings(over: Partial<Armed> = {}): Armed {
  return { server: "https://ntfy.sh", topic: TOPIC, token: null, priority: 3, approvalDelayMs: 0, ...over };
}

function headersOf(s: Sent): Record<string, string> {
  return { ...(s.init.headers as Record<string, string>) };
}

afterEach(() => armNtfy(null));

test("disabled in config means no fetch, even with a topic in .env", async () => {
  const saved = config.ntfy;
  process.env.NTFY_TOPIC = TOPIC;
  try {
    config.ntfy = { enabled: false };
    const { io, sent } = fakeIO();
    startNtfy(io);
    assert.equal(ntfyStatus().enabled, false);
    assert.equal(await notifyPhone({ kind: "schedule", title: "briefing", body: "Two unread." }), false);
    sendApprovalAlert("req-1", "Run shell command", []);
    assert.equal(sent.length, 0, "nothing went out");
  } finally {
    config.ntfy = saved;
    delete process.env.NTFY_TOPIC;
  }
});

test("no topic in .env means off, and nothing is sent", async () => {
  assert.equal(resolveNtfy({ enabled: true }, {}).ok, false);
  const { io, sent } = fakeIO();
  armNtfy(null, io);
  assert.equal(await notifyPhone({ kind: "heartbeat", title: "Heartbeat", body: "Disk at 97%." }), false);
  assert.equal(sent.length, 0);
});

test("a body is redacted before it is cut, so a key straddling the cut is caught", async () => {
  const { io, sent } = fakeIO();
  armNtfy(settings(), io);
  // The cut lands twenty characters into the key: cutting first would leave
  // "sk-ant-api03-EXAMPLE", too short for redact to know it as a key.
  await notifyPhone({ kind: "schedule", title: "briefing", body: `${"x".repeat(MAX_BODY_CHARS - 22)} ${ANTHROPIC}` });
  const body = String(sent[0].init.body);
  assert.doesNotMatch(body, /sk-ant-api03|EXAMPLE/);
  assert.ok(Array.from(body).length <= MAX_BODY_CHARS, "still capped");
});

test("the machine, the LAN and other people's addresses stay off the topic", () => {
  const host = os.hostname();
  const raw = `Saved /home/owner/notes/plan.md on ${host} (192.168.1.20); mail from jane.doe@example.co.uk`;
  const out = phoneText(raw);
  const leaks = ["/home/owner", "192.168.1.20", "jane.doe@example.co.uk"];
  if (host.length >= 3) leaks.push(host);
  for (const leak of leaks) {
    assert.ok(!out.includes(leak), `${leak} stays off the topic`);
  }
  assert.match(out, /\[path\]/);
  assert.match(out, /\[local address\]/);
  assert.match(out, /\[email\]/);
});

test("the topic is masked in the status and in failure logs", async () => {
  const { io, logs } = fakeIO(() => Promise.reject(new Error("fetch failed")));
  armNtfy(settings(), io);
  const status = ntfyStatus();
  assert.equal(status.topic, `…${TOPIC.slice(-4)}`);
  assert.equal(status.server, "ntfy.sh");
  assert.ok(!JSON.stringify(status).includes(TOPIC), "the whole name never reaches the glass");
  await notifyPhone({ kind: "job", title: "Remote job", body: "Job finished, exit 0." });
  assert.ok(logs.length > 0);
  for (const line of logs) assert.ok(!line.includes(TOPIC), "nor the journal");
});

test("a self-hosted server is not named on the glass", () => {
  armNtfy(settings({ server: "https://push.owner-family.example" }));
  assert.equal(ntfyStatus().server, "self-hosted");
  assert.ok(!JSON.stringify(ntfyStatus()).includes("owner-family"));
});

test("the request carries Title, Priority and Tags as plain headers, and the token when there is one", async () => {
  const { io, sent } = fakeIO();
  armNtfy(settings({ token: "tk_EXAMPLEfakeNtfyToken0000", priority: 2 }), io);
  await notifyPhone({ kind: "schedule", title: "briefing", body: "Two unread, nothing overdue." });
  assert.equal(sent[0].url, `https://ntfy.sh/${TOPIC}`);
  assert.equal(sent[0].init.method, "POST");
  const h = headersOf(sent[0]);
  assert.equal(h.Title, "briefing");
  assert.equal(h.Priority, "2");
  assert.equal(h.Tags, "spiral_calendar");
  assert.equal(h.Authorization, "Bearer tk_EXAMPLEfakeNtfyToken0000");
  assert.equal(String(sent[0].init.body), "Two unread, nothing overdue.");
  // Markdown is off by being absent: ntfy renders plain text unless asked.
  assert.ok(!Object.keys(h).some((k) => /markdown|^md$/i.test(k)), "no markdown header");
});

test("a title cannot inject a header or carry what fetch would refuse", () => {
  // A schedule target and a tool's title are model-written, so this is the
  // shape a hostile one would take.
  const hostile = "Bore Da — Dŵr\r\nActions: http, Approve, http://127.0.0.1:3900/api/approve";
  const t = (ntfyRequest({ kind: "tool", title: hostile, body: "b" }, settings()).init.headers as Record<string, string>).Title;
  assert.equal(t, headerSafe(hostile), "the request goes through the same gate");
  assert.doesNotMatch(t, /[\r\n]/);
  assert.match(t, /^[\x20-\x7e]+$/);
  assert.match(t, /Dwr/, "accents fold to their letters");
});

test("no push ever carries an action button, a click URL or an attachment", async () => {
  const { io, sent } = fakeIO();
  armNtfy(settings(), io);
  sendApprovalAlert("req-2", "Run shell command", ["Telegram"]);
  for (const kind of ["schedule", "heartbeat", "job", "tool"] as const) {
    await notifyPhone({ kind, title: "t", body: "b" });
  }
  assert.equal(sent.length, 5);
  for (const s of sent) {
    for (const k of Object.keys(headersOf(s))) {
      assert.doesNotMatch(k, /^(x-)?(actions?|click|attach|filename|icon|email|call)$/i, `${k} is not sent`);
    }
    assert.doesNotMatch(s.url, /[?&](actions?|click|attach)=/i);
  }
});

test("an approval alert names the action and where to answer — not the command", async () => {
  const { io, sent } = fakeIO();
  armNtfy(settings(), io);
  sendApprovalAlert("req-3", "Run shell command in /home/owner/secret-project", ["Telegram", "Discord"]);
  const body = String(sent[0].init.body);
  assert.match(body, /is waiting for your approval: Run shell command in \[path\]\./);
  assert.match(body, /Open the HUD or reply on Telegram\/Discord\./);
  assert.doesNotMatch(body, /secret-project/);
  assert.ok(Number(headersOf(sent[0]).Priority) >= 4, "an alert with a timeout outranks a briefing");
  assert.equal(headersOf(sent[0]).Tags, "warning");

  sendApprovalAlert("req-4", "Write file", []);
  assert.match(String(sent[1].init.body), /Open the HUD to answer\.$/, "no phone line is offered that is not running");
});

test("an approval answered within the grace period never reaches the phone", async () => {
  const { io, sent, timers } = fakeIO();
  armNtfy(settings({ approvalDelayMs: 15_000 }), io);
  sendApprovalAlert("req-5", "Run shell command", []);
  assert.equal(sent.length, 0, "nothing at once");
  approvalSettled("req-5");
  assert.equal(timers[0].cancelled, true, "answered at the HUD: the alert is dropped");

  sendApprovalAlert("req-6", "Run shell command", []);
  timers[1].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1, "unanswered: the phone is told");
});

test("a failing push resolves false, never throws, and is logged once per change", async () => {
  const { io, logs } = fakeIO(() => new Response("{}", { status: 403 }));
  armNtfy(settings(), io);
  assert.equal(await notifyPhone({ kind: "schedule", title: "briefing", body: "a" }), false);
  assert.equal(await notifyPhone({ kind: "schedule", title: "briefing", body: "b" }), false);
  assert.equal(logs.length, 1, "the same failure is not logged twice");
  assert.match(logs[0], /HTTP 403.*NTFY_TOKEN/);
  assert.equal(ntfyStatus().delivery, "failing");
});

test("the phone channel of notify asks first in a tainted turn, and a no sends nothing", async () => {
  const { io, sent } = fakeIO();
  armNtfy(settings(), io);
  const asked: string[] = [];
  const declined = await phoneNotifyTool("Build", "Done.", {
    tainted: () => true,
    requestApproval: async (summary, detail) => { asked.push(`${summary}\n${detail}`); return false; },
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Done\./, "the card shows what would be sent");
  assert.match(declined, /declined/);
  assert.equal(sent.length, 0);

  const clean = await phoneNotifyTool("Build", "Done.", {
    requestApproval: async () => { throw new Error("a clean turn should not ask"); },
  });
  assert.match(clean, /Sent/);
  assert.equal(sent.length, 1);
});

test("the phone channel says how to switch it on when it is off", async () => {
  const out = await phoneNotifyTool("t", "b", { requestApproval: async () => true });
  assert.match(out, /NTFY_TOPIC/);
});

test("the doctor suggests a strong topic and warns about a guessable one", () => {
  const s = suggestTopic();
  assert.match(s, /^[-_A-Za-z0-9]{1,64}$/, "a name ntfy accepts");
  assert.ok(s.length >= GUESSABLE_BELOW);
  assert.notEqual(suggestTopic(), s, "random each time");

  const off = ntfyDoctorLine({}, {});
  assert.equal(off.status, "ok");
  assert.match(off.text, /NTFY_TOPIC=claw-/);

  const weak = ntfyDoctorLine({}, { NTFY_TOPIC: "alerts" });
  assert.equal(weak.status, "warn");
  assert.match(weak.text, /guess/);

  const on = ntfyDoctorLine({}, { NTFY_TOPIC: TOPIC });
  assert.equal(on.status, "ok");
  assert.ok(!on.text.includes(TOPIC), "the doctor masks it too");

  assert.equal(ntfyDoctorLine({}, { NTFY_TOPIC: "has spaces/and slashes" }).status, "warn");
  assert.equal(ntfyDoctorLine({ server: "https://user:pw@ntfy.example" }, { NTFY_TOPIC: TOPIC }).status, "warn");
});

test("the request is built from config alone; the server keeps a sub-path and loses a trailing slash", () => {
  const r = resolveNtfy({ server: "https://push.example/ntfy/", priority: 9 }, { NTFY_TOPIC: TOPIC });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.armed.priority, 5, "clamped to ntfy's range");
  assert.equal(ntfyRequest({ kind: "tool", title: "t", body: "b" }, r.armed).url, `https://push.example/ntfy/${TOPIC}`);
});

test("the notify tool reaches the phone with to: phone, and through the taint gate", async () => {
  const { executeTool } = await import("./tools.js");
  const { io, sent } = fakeIO();
  armNtfy(settings(), io);
  const ctx = { requestApproval: async () => false, emit: () => {}, tainted: () => false };
  const out = String(await executeTool("notify", { title: "Build", body: "Done.", to: "phone" }, ctx));
  assert.match(out, /Sent to the operator's phone/);
  assert.equal(sent.length, 1);
  assert.equal(String(sent[0].init.body), "Done.");

  const refused = String(await executeTool("notify", { title: "Build", body: "Done.", to: "phone" }, { ...ctx, tainted: () => true }));
  assert.match(refused, /declined/);
  assert.equal(sent.length, 1, "a tainted turn that is told no sends nothing");
});
