import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "./config.js";
import {
  REGISTER_TEMPLATE, checkConsent, classifyMcpTool, guardGmailSend, hasUnsubscribeRoute,
  newlyPermitted, normaliseEmail, parseRegister, recipientsIn, trimRecipients,
} from "./marketing.js";

// Synthetic customers on example domains (RFC 2606) — no real person is here.
const REGISTER = `${REGISTER_TEMPLATE}| ann@example.com | Ann | consent | booking form tick box | 2026-02-01 | | |
| bob@example.com | Bob | soft-opt-in | invoice 1042, MOT | 2026-03-14 | | |
| cat@example.com | Cat | none | walk-in | | | |
| dan@example.com | Dan | consent | newsletter form | 2025-11-02 | 2026-06-30 | asked by phone |
| eve@example.com | Eve | soft-opt-in | | | | |
| fay@example.com | Fay | legitimate interest | quote 77 | | | |
| gus@example.com | Gus | consent | shop sign-up | | no | |
| hal@example.com | Hal | consent | old list | | | |
| HAL@example.com | Hal | consent | old list | | 2026-01-01 | second copy from the other sheet |
`;

const rows = () => parseRegister(REGISTER).rows;
const reasonOf = (v: ReturnType<typeof checkConsent>, email: string) => v.refused.find((r) => r.email === email)?.reason;

test("consent check: consent and soft opt-in pass, every other basis is refused with its reason", () => {
  const v = checkConsent(
    ["ann@example.com", "bob@example.com", "cat@example.com", "eve@example.com", "fay@example.com", "nobody@example.com", "not an address"],
    rows(),
  );
  assert.deepEqual(v.allowed.map((a) => `${a.email}:${a.basis}`).sort(), ["ann@example.com:consent", "bob@example.com:soft-opt-in"]);
  assert.equal(reasonOf(v, "cat@example.com"), "no-basis");
  assert.equal(reasonOf(v, "fay@example.com"), "no-basis", "legitimate interests is not a basis for marketing email");
  assert.equal(reasonOf(v, "eve@example.com"), "no-source", "a soft opt-in needs the sale it rests on");
  assert.equal(reasonOf(v, "nobody@example.com"), "unknown");
  assert.equal(reasonOf(v, "not an address"), "not-an-address");
});

test("consent check: an opt-out is final, and wins over a basis on another row for the same person", () => {
  const v = checkConsent(["dan@example.com", "hal@example.com", "gus@example.com"], rows());
  assert.equal(reasonOf(v, "dan@example.com"), "opted-out");
  assert.equal(reasonOf(v, "hal@example.com"), "opted-out", "the duplicate row's opt-out counts");
  assert.ok(v.allowed.some((a) => a.email === "gus@example.com"), "\"no\" in Opted out is not an opt-out");
});

test("consent check matches trimmed and case-insensitive, and counts a person once", () => {
  assert.equal(normaliseEmail('  "Ann" <Ann@Example.COM> '), "ann@example.com");
  assert.equal(normaliseEmail("mailto:BOB@example.com"), "bob@example.com");
  const v = checkConsent([" ANN@example.com ", "Ann <ann@example.com>", "mailto:Bob@Example.com"], rows());
  assert.equal(v.allowed.length, 2);
  assert.equal(v.refused.length, 0);
});

test("the register is read by its headers, in any order, and an unreadable row is counted, not guessed", () => {
  const md = "| Notes | Basis | E-mail | Source | Opted-out |\n|---|---|---|---|---|\n| x | consent | Zed@example.com | form | |\n| y | consent | zed at example | form | |\n";
  const r = parseRegister(md);
  assert.equal(r.found, true);
  assert.equal(r.rows[0]?.email, "zed@example.com");
  assert.equal(r.rows[0]?.basis, "consent");
  assert.equal(r.bad, 1);
  const empty = parseRegister(REGISTER_TEMPLATE);
  assert.equal(empty.found, true);
  assert.equal(empty.rows.length, 0);
  assert.equal(parseRegister("# notes\nno table here").found, false);
});

test("unsubscribe check: a line, a merge tag or a reply-STOP passes; a body with none does not", () => {
  for (const ok of [
    "Thanks for coming in.\n\nUnsubscribe: https://example.com/u/1",
    "<a href=\"{{{RESEND_UNSUBSCRIBE_URL}}}\">Stop these emails</a>",
    "Footer *|UNSUB|*",
    "{% unsubscribe %}",
    "<a href='{$unsubscribe}'>here</a>",
    "Reply STOP and we will not email you again.",
    "To opt out, reply to this email.",
    "Manage your preferences",
  ]) assert.equal(hasUnsubscribeRoute(ok), true, ok);
  for (const bad of ["Your car is due its MOT on 3 March. Book on 029 2000 0000.", "That claim was unsubstantiated.", ""]) {
    assert.equal(hasUnsubscribeRoute(bad), false, bad);
  }
});

test("a register write that widens the audience is detected; one that shrinks it is not", () => {
  const head = REGISTER_TEMPLATE;
  const one = `${head}| ann@example.com | Ann | consent | form | | | |\n`;
  assert.deepEqual(newlyPermitted(head, one), ["ann@example.com"], "a new row with a basis");
  assert.deepEqual(newlyPermitted(one, `${head}| ann@example.com | Ann | consent | form | | 2026-11-20 | |\n`), [], "recording an opt-out");
  assert.deepEqual(newlyPermitted(one, head), [], "deleting a row");
  assert.deepEqual(newlyPermitted(`${head}| ann@example.com | Ann | consent | form | | 2026-11-20 | |\n`, one), ["ann@example.com"], "clearing an opt-out");
  assert.deepEqual(newlyPermitted(`${head}| bo@example.com | Bo | none | job 9 | | | |\n`, `${head}| bo@example.com | Bo | soft-opt-in | job 9 | | | |\n`), ["bo@example.com"], "upgrading a basis");
  assert.deepEqual(newlyPermitted(one, one.replace("| |\n", "| regular |\n")), [], "editing notes");
});

test("which MCP calls are marketing: vendor sends, campaign bodies and audience adds — never replies or opt-outs", () => {
  assert.equal(classifyMcpTool("mcp__resend__send_broadcast")?.kind, "send");
  assert.equal(classifyMcpTool("mcp__resend__send-email")?.kind, "send");
  assert.equal(classifyMcpTool("mcp__klaviyo__create_campaign_send_job")?.kind, "send");
  assert.equal(classifyMcpTool("mcp__mailerlite__schedule_campaign")?.kind, "send");
  assert.equal(classifyMcpTool("mcp__resend__create_broadcast")?.kind, "compose");
  assert.equal(classifyMcpTool("mcp__klaviyo__create_template")?.kind, "compose");
  assert.equal(classifyMcpTool("mcp__resend__create_template"), null, "a Resend template is as often a receipt");
  assert.equal(classifyMcpTool("mcp__resend__create_contact")?.kind, "audience");
  assert.equal(classifyMcpTool("mcp__mailerlite__add_subscriber")?.kind, "audience");
  assert.equal(classifyMcpTool("mcp__hubspot__create_contact"), null, "a HubSpot contact is a CRM record");
  assert.equal(classifyMcpTool("mcp__hubspot__send_marketing_email")?.kind, "send");
  assert.equal(classifyMcpTool("mcp__resend__reply_to_inbox_thread_email"), null);
  assert.equal(classifyMcpTool("mcp__mailerlite__send_reply"), null, "a reply is correspondence even with a send verb");
  assert.equal(classifyMcpTool("mcp__resend__add_suppression"), null);
  assert.equal(classifyMcpTool("mcp__klaviyo__unsubscribe_profiles"), null);
  assert.equal(classifyMcpTool("mcp__resend__get_email_metrics"), null);
  assert.deepEqual(classifyMcpTool("mcp__gmail__send_message"), { kind: "send", vendor: null });
  assert.equal(classifyMcpTool("mcp__github__create_issue"), null);
});

test("recipients are read from recipient fields only, and trimmed without touching the rest", () => {
  const input = {
    from: "shop@example.com",
    to: ["ann@example.com", "dan@example.com"],
    cc: "bob@example.com, nobody@example.com",
    html: "Questions? Write to help@example.com. Unsubscribe here.",
  };
  assert.deepEqual(recipientsIn(input).sort(), ["ann@example.com", "bob@example.com", "dan@example.com", "nobody@example.com"]);
  const t = trimRecipients(input, new Set(["dan@example.com", "nobody@example.com"]));
  assert.equal(t.whole, false);
  assert.deepEqual(t.value, { from: "shop@example.com", to: ["ann@example.com"], cc: "bob@example.com", html: input.html });
  const batch = trimRecipients({ emails: [{ to: "ann@example.com", text: "hi" }, { to: "dan@example.com", text: "hi" }] }, new Set(["dan@example.com"]));
  assert.deepEqual(batch.value, { emails: [{ to: "ann@example.com", text: "hi" }] }, "one email of a batch is dropped whole");
  assert.equal(trimRecipients({ to: "dan@example.com", cc: ["ann@example.com"] }, new Set(["dan@example.com"])).whole, true);
});

test("Gmail: correspondence passes untouched, marketing needs consent for every recipient and a way out", () => {
  const opts = { threshold: 5, where: "~/Documents/CunningClaw/Marketing consent.md" };
  const reply = { to: "dan@example.com", subject: "Re: please unsubscribe me", body: "Done — I've unsubscribed you. Sorry to see you go." };
  assert.deepEqual(guardGmailSend(reply, undefined, rows(), opts), { verdict: "pass" }, "a reply to an opted-out customer is correspondence");
  const offer = { to: "ann@example.com, bob@example.com", subject: "Winter check £29", body: "Book now.\nReply STOP to hear no more." };
  const ok = guardGmailSend(offer, true, rows(), opts);
  assert.equal(ok.verdict, "card");
  assert.match((ok as any).title, /2 recipients \(consent 1, soft opt-in 1\); unsubscribe route present/);
  assert.equal(guardGmailSend({ ...offer, body: "Book now." }, true, rows(), opts).verdict, "refuse");
  const many = { to: Array.from({ length: 6 }, (_, i) => `c${i}@example.com`).join(", "), subject: "Party", body: "Come along" };
  const bulk = guardGmailSend(many, false, rows(), opts);
  assert.equal(bulk.verdict, "refuse", "more than the threshold is marketing whatever the model said");
  assert.match((bulk as any).message, /6 of 6 recipients may not be sent marketing \(6 not in the consent register\)/);
  assert.doesNotMatch((bulk as any).message, /c0@example\.com/, "refusals carry counts, never addresses");
});

// ---------------------------------------------------------------------------
// Through the chokepoints, with a register on disk
// ---------------------------------------------------------------------------

function withRegister(text: string | null): { file: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-consent-"));
  const file = path.join(dir, "Marketing consent.md");
  if (text !== null) fs.writeFileSync(file, text);
  const saved = config.marketing;
  config.marketing = { register: file };
  return {
    file,
    restore: () => {
      config.marketing = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function recorder(answer = false) {
  const cards: { summary: string; detail: string }[] = [];
  const ctx = {
    requestApproval: async (summary: string, detail: string) => { cards.push({ summary, detail }); return answer; },
    emit: () => {},
  } as any;
  return { cards, ctx };
}

test("an MCP marketing send has refused recipients removed, and its card states count, basis and unsubscribe", async () => {
  const { executeTool } = await import("./tools.js");
  const reg = withRegister(REGISTER);
  try {
    const { cards, ctx } = recorder(false);
    const out = String(await executeTool("mcp__resend__send_email", {
      from: "shop@example.com",
      to: ["ann@example.com", "bob@example.com", "dan@example.com", "nobody@example.com"],
      subject: "Winter check",
      html: "<p>Book your winter check.</p><a href=\"{{{RESEND_UNSUBSCRIBE_URL}}}\">Unsubscribe</a>",
    }, ctx));
    assert.match(out, /declined/);
    assert.equal(cards.length, 1);
    assert.equal(
      cards[0].summary,
      "MCP tool: mcp__resend__send_email — marketing to 2 recipients (consent 1, soft opt-in 1); " +
        "unsubscribe route present; 2 refused by the consent register and removed",
    );
    assert.match(cards[0].detail, /ann@example\.com/);
    assert.doesNotMatch(cards[0].detail, /dan@example\.com|nobody@example\.com/, "what is approved is what is sent");
  } finally { reg.restore(); }
});

test("an MCP marketing send with no unsubscribe route, or nobody allowed, is refused before any card", async () => {
  const { executeTool } = await import("./tools.js");
  const reg = withRegister(REGISTER);
  try {
    const { cards, ctx } = recorder(true);
    const noRoute = String(await executeTool("mcp__resend__create_broadcast", {
      segmentId: "seg_1", subject: "News", html: "<p>Our winter news.</p>",
    }, ctx));
    assert.match(noRoute, /^Refused: this is a marketing email and its body has no unsubscribe route/);
    const nobody = String(await executeTool("mcp__mailerlite__send_campaign_email", {
      to: ["dan@example.com", "cat@example.com"], text: "Offer. Unsubscribe: link",
    }, ctx));
    assert.match(nobody, /^Refused: none of the 2 recipient\(s\) may be sent marketing — /);
    assert.match(nobody, /1 opted out/);
    assert.match(nobody, /1 no basis recorded/);
    const imported = String(await executeTool("mcp__resend__create_contact_import", { filePath: "/tmp/everyone.csv" }, ctx));
    assert.match(imported, /^Refused: an import into Resend from a file is a list the consent register cannot read/);
    assert.equal(cards.length, 0, "a refusal raises no card to be clicked through");
  } finally { reg.restore(); }
});

test("a send to a vendor-held audience says so on the card: consent there is the vendor's list", async () => {
  const { executeTool } = await import("./tools.js");
  const reg = withRegister(REGISTER);
  try {
    const { cards, ctx } = recorder(false);
    await executeTool("mcp__resend__send_broadcast", { broadcastId: "b_123" }, ctx);
    assert.equal(
      cards[0]?.summary,
      "MCP tool: mcp__resend__send_broadcast — marketing — audience held at Resend; consent there is the vendor's list; " +
        "content held at Resend — no unsubscribe route visible here, its footer must carry one",
    );
    assert.match(cards[0]?.detail ?? "", /names no addresses, so the register could not check it/);
  } finally { reg.restore(); }
});

test("one-to-one mail through a connector is untouched: the ordinary MCP card, nothing removed", async () => {
  const { executeTool } = await import("./tools.js");
  const reg = withRegister(REGISTER);
  try {
    const { cards, ctx } = recorder(false);
    const reply = { emailId: "r_1", text: "Thanks Dan, you're off the list." };
    await executeTool("mcp__resend__reply_to_inbox_thread_email", reply, ctx);
    await executeTool("mcp__gmail__send_message", { to: "dan@example.com", body: "Your car is ready." }, ctx);
    assert.deepEqual(cards.map((c) => c.summary), [
      "MCP tool: mcp__resend__reply_to_inbox_thread_email",
      "MCP tool: mcp__gmail__send_message",
    ]);
    assert.match(cards[1].detail, /dan@example\.com/);
  } finally { reg.restore(); }
});

test("marketing_audience returns only who may be mailed, with counts for the rest", async () => {
  const { executeTool, toolDefinitions } = await import("./tools.js");
  assert.ok(toolDefinitions.some((t) => t.name === "marketing_audience"));
  const reg = withRegister(REGISTER);
  try {
    const { ctx } = recorder();
    const all = String(await executeTool("marketing_audience", { campaign: "Winter check" }, ctx));
    assert.match(all, /^Audience for "Winter check": 3 may be sent marketing \(consent 2, soft opt-in 1\)\./);
    assert.match(all, /ann@example\.com \(consent\)/);
    assert.match(all, /bob@example\.com \(soft-opt-in\)/);
    for (const refused of ["cat@", "dan@", "eve@", "fay@", "hal@"]) assert.ok(!all.includes(refused), `${refused} must not be listed`);
    const some = String(await executeTool("marketing_audience", { recipients: ["Ann@Example.com", "zed@example.com"] }, ctx));
    assert.match(some, /1 may be sent marketing/);
    assert.match(some, /Refused 1: 1 not in the consent register/);
  } finally { reg.restore(); }
  const none = withRegister(null);
  try {
    const out = String(await executeTool("marketing_audience", {}, recorder().ctx));
    assert.match(out, /^No consent register at .*every marketing send is refused/s);
    assert.match(out, /\| Email \| Name \| Basis \| Source \| Since \| Opted out \| Notes \|/);
  } finally { none.restore(); }
});

test("send_email: marketing is checked before the card; a reply to a customer is not", async () => {
  const { sendEmailStep } = await import("./tools.js");
  const reg = withRegister(REGISTER);
  try {
    let sent = 0;
    const io = (preview: { to: string; subject: string; body: string }) => ({
      peek: async () => ({ open: true, ...preview }),
      send: async () => { sent++; return "Sent."; },
    });

    const refused = recorder(true);
    const out = await sendEmailStep({ marketing: true }, refused.ctx,
      io({ to: "ann@example.com, dan@example.com", subject: "Offer", body: "Book. Unsubscribe: reply STOP" }));
    assert.match(out, /^Refused: 1 of 2 recipients may not be sent marketing \(1 opted out/);
    assert.equal(refused.cards.length, 0);
    assert.equal(sent, 0);

    const ok = recorder(true);
    await sendEmailStep({ marketing: true }, ok.ctx, io({ to: "bob@example.com", subject: "MOT due", body: "Your MOT is due.\nReply STOP to opt out." }));
    assert.equal(ok.cards[0]?.summary, "Send this marketing email — 1 recipient (consent 0, soft opt-in 1); unsubscribe route present");
    assert.equal(sent, 1);

    const reply = recorder(true);
    await sendEmailStep(undefined, reply.ctx, io({ to: "dan@example.com", subject: "Re: stop emailing me", body: "Done — you are unsubscribed." }));
    assert.equal(reply.cards[0]?.summary, "Send this email", "correspondence keeps the ordinary card");
    assert.equal(sent, 2);
  } finally { reg.restore(); }
});

test("writing the register: widening it always asks, recording an opt-out does not", async () => {
  const { executeTool } = await import("./tools.js");
  const reg = withRegister(REGISTER_TEMPLATE);
  try {
    const declined = recorder(false);
    const widened = `${REGISTER_TEMPLATE}| ann@example.com | Ann | consent | form | | | |\n| bob@example.com | Bob | soft-opt-in | job 4 | | | |\n`;
    const out = String(await executeTool("write_file", { path: reg.file, content: widened }, declined.ctx));
    assert.match(out, /declined widening the marketing consent register/);
    assert.match(declined.cards[0]?.summary ?? "", /lets 2 more addresses receive marketing \(consent 1, soft opt-in 1\)/);
    assert.equal(fs.readFileSync(reg.file, "utf-8"), REGISTER_TEMPLATE, "nothing written on a no");

    fs.writeFileSync(reg.file, widened);
    const free = recorder(false);
    await executeTool("edit_file", { path: reg.file, oldString: "| ann@example.com | Ann | consent | form | | |", newString: "| ann@example.com | Ann | consent | form | | 2026-11-20 |" }, free.ctx);
    assert.equal(free.cards.length, 0, "an opt-out never asks");
    assert.match(fs.readFileSync(reg.file, "utf-8"), /2026-11-20/);

    const back = recorder(false);
    await executeTool("edit_file", { path: reg.file, oldString: "| 2026-11-20 |", newString: "| |" }, back.ctx);
    assert.match(back.cards[0]?.summary ?? "", /lets 1 more address receive marketing/, "clearing an opt-out asks");
    assert.match(fs.readFileSync(reg.file, "utf-8"), /2026-11-20/);
  } finally { reg.restore(); }
});

test("a box can never be the source of the register: a pull onto it is blocked before any card", async () => {
  const { executeTool } = await import("./tools.js");
  const reg = withRegister(REGISTER_TEMPLATE);
  const savedRemote = config.remote;
  config.remote = { enabled: true, boxes: [{ id: "forge", host: "forge.example", user: "claw", workdir: "/home/claw/work" }] };
  try {
    const { cards, ctx } = recorder(true);
    const out = String(await executeTool("remote_copy", {
      box: "forge", direction: "pull", local: reg.file, remote: "/home/claw/work/list.md",
    }, ctx));
    assert.match(out, /^BLOCKED: the marketing consent register/);
    assert.equal(cards.length, 0);
  } finally {
    config.remote = savedRemote;
    reg.restore();
  }
});

test("Resend signs in through the browser on its own hosted server; a key, when set, is the headless road", async () => {
  const { catalogueById } = await import("./mcp-catalog.js");
  const { signInKind } = await import("./connector-guide.js");
  const { claudeEntryToConfig } = await import("./mcp-config.js");
  const { KEY_ROSTER } = await import("./keys.js");
  const r = catalogueById("resend");
  assert.ok(r);
  assert.equal(r.entry.url, "https://mcp.resend.com/mcp");
  // Resend's OAuth accepts self-registered clients, so a tokenEnv would make
  // the guide call a working sign-in impossible.
  assert.equal(r.tokenEnv, undefined);
  assert.equal(signInKind(r), "browser");
  const saved = process.env.RESEND_API_KEY;
  try {
    delete process.env.RESEND_API_KEY;
    assert.equal(claudeEntryToConfig("resend", r.entry).headers?.Authorization, undefined, "no key: the 401 leads to sign-in");
    process.env.RESEND_API_KEY = "re_EXAMPLEfake";
    assert.equal(claudeEntryToConfig("resend", r.entry).headers?.Authorization, "Bearer re_EXAMPLEfake");
  } finally {
    if (saved === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved;
  }
  assert.ok(KEY_ROSTER.some((k) => k.name === "RESEND_API_KEY"));
});

test("the desk-marketer skill's standing orders are lines the scheduler actually parses", async () => {
  const { parseSchedule } = await import("./schedule-format.js");
  const skill = fs.readFileSync(new URL("../workspace/skills/desk-marketer/SKILL.md", import.meta.url), "utf-8");
  const lines = skill.split("\n").filter((l) => /^- \[x\] schedule:/.test(l));
  assert.ok(lines.length >= 3);
  const { entries, bad } = parseSchedule(lines.join("\n"));
  assert.deepEqual(bad, []);
  assert.equal(entries.length, lines.length);
  assert.ok(entries.some((e) => e.date), "an annual campaign date");
});
