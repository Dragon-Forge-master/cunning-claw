import assert from "node:assert/strict";
import test from "node:test";
import { beatDue, CREDIT_FAILURE, freshBackoff, recordBeat } from "./heartbeat-backoff.js";

const H = 3600_000;

test("a credit failure pauses the heartbeat, doubling to a cap, and one good beat resets it", () => {
  // October: a 402 every thirty minutes for three weeks, each one a ⚠ in the
  // HUD and a journal line. Fails if recordBeat stops pausing.
  const b = freshBackoff();
  const t0 = Date.UTC(2026, 9, 7, 0, 28);
  assert.equal(beatDue(b, t0), true);

  const first = recordBeat(b, { creditFailure: true }, t0);
  assert.match(first ?? "", /paused for 2h.*out of credit/);
  assert.equal(beatDue(b, t0 + 30 * 60_000), false, "the next half-hourly beat is skipped");
  assert.equal(beatDue(b, t0 + 2 * H), true);

  recordBeat(b, { creditFailure: true }, t0 + 2 * H);
  assert.equal(beatDue(b, t0 + 5 * H), false, "second pause is four hours");
  recordBeat(b, { creditFailure: true }, t0 + 6 * H);
  recordBeat(b, { creditFailure: true }, t0 + 14 * H);
  recordBeat(b, { creditFailure: true }, t0 + 30 * H);
  assert.equal(beatDue(b, t0 + 30 * H + 12 * H), true, "never longer than twelve hours");

  assert.match(recordBeat(b, { creditFailure: false }, t0 + 43 * H) ?? "", /back to normal/);
  assert.equal(recordBeat(b, { creditFailure: false }, t0 + 44 * H), null, "quiet when nothing changed");
  assert.match(recordBeat(b, { creditFailure: true }, t0 + 45 * H) ?? "", /paused for 2h/, "the ladder starts again");
});

test("the credit pattern matches the claw's own message and the raw provider error", () => {
  assert.ok(CREDIT_FAILURE.test("The Lite brain's account is out of credit for a request this size, sir."));
  assert.ok(CREDIT_FAILURE.test('OpenAI-compatible API 402: {"error":{"message":"Prompt tokens limit exceeded: 62596 > 42503. To increase, visit https://openrouter.ai/settings/credits and add more credits"}}'));
  assert.equal(CREDIT_FAILURE.test("API error 429: rate limited"), false);
});
