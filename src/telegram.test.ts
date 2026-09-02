import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import { approvalCardText, maskChatId, outboundText, parseChatAllowlist, startTelegram, telegramStatus } from "./telegram.js";

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
