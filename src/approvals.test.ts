import assert from "node:assert/strict";
import test from "node:test";
import { createApprovals, defusePracticeClaim, PRACTICE_CLAIM_REMOVED, PRACTICE_LABEL, type PracticeDecision } from "./approvals.js";

/** A registry with every outlet recorded and a timer the test fires by hand. */
function rig() {
  const events: { event: string; data: any }[] = [];
  const phoneCards: string[] = [];
  const phoneSettled: string[] = [];
  const alerts: string[] = [];
  const timers: (() => void)[] = [];
  let grants = 0;
  let clock = 1_000;
  const approvals = createApprovals({
    broadcast: (event, data) => events.push({ event, data }),
    phones: [
      { sendCard: (id) => { phoneCards.push(`telegram:${id}`); }, settled: (id) => phoneSettled.push(`telegram:${id}`) },
      { sendCard: (id) => { phoneCards.push(`discord:${id}`); }, settled: (id) => phoneSettled.push(`discord:${id}`) },
    ],
    alert: { send: (id) => alerts.push(id), settled: () => {} },
    timeoutMs: () => 180_000,
    grantForTask: () => { grants++; },
    now: () => clock,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  return { approvals, events, phoneCards, phoneSettled, alerts, timers, grants: () => grants, tick: (ms: number) => { clock += ms; } };
}

const lastRequest = (events: { event: string; data: any }[]) => events.filter((e) => e.event === "approval_request").at(-1)!.data;

test("a real card goes to the HUD, both phone lines and ntfy, and carries no practice flag", async () => {
  const r = rig();
  const p = r.approvals.request("Send this email", "To: elin@example");
  const card = lastRequest(r.events);
  assert.equal(card.practice, undefined);
  assert.equal(r.phoneCards.length, 2);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.approvals.settle(card.id, true), true);
  assert.equal(await p, true);
});

test("a practice card is labelled, goes to the HUD only, and never reaches Telegram, Discord or ntfy", async () => {
  const r = rig();
  let decided: PracticeDecision | undefined;
  const p = r.approvals.requestPractice("Send this email", "To: x@example", (d) => { decided = d; });
  const card = lastRequest(r.events);
  assert.equal(card.practice, true);
  assert.equal(card.label, PRACTICE_LABEL);
  assert.equal(PRACTICE_LABEL, "PRACTICE · nothing real will happen");
  assert.deepEqual(r.phoneCards, [], "no phone card");
  assert.deepEqual(r.alerts, [], "no ntfy alert");
  r.tick(4_200);
  r.approvals.settle(card.id, false);
  assert.equal(await p, false);
  assert.deepEqual(r.phoneSettled, [], "phones are not told about a card they never had");
  assert.equal(decided?.approved, false);
  assert.equal(decided?.ms, 4_200, "time to decide is recorded for the mastery check");
});

test("a practice card has no timeout; a real one is denied by itself when its time runs out", async () => {
  const r = rig();
  void r.approvals.requestPractice("Run shell command", "git push --force");
  assert.equal(r.timers.length, 0, "no timer was armed for the practice card (WCAG 2.2.1)");
  const real = r.approvals.request("Run shell command", "git push");
  assert.equal(r.timers.length, 1);
  r.timers[0]();
  assert.equal(await real, false);
  const resolved = r.events.filter((e) => e.event === "approval_resolved").at(-1)!.data;
  assert.equal(resolved.timedOut, true);
  assert.equal(r.approvals.pendingCount(), 1, "the practice card is still waiting for the learner");
});

test("a phone line cannot answer a practice card, even if it somehow had the id", async () => {
  const r = rig();
  const p = r.approvals.requestPractice("Send this email", "To: x@example");
  const id = lastRequest(r.events).id;
  assert.equal(r.approvals.settle(id, true, { by: "phone" }), false);
  assert.equal(r.approvals.isPractice(id), true);
  assert.equal(r.approvals.settle(id, true, { by: "hud" }), true);
  assert.equal(await p, true);
});

test("ALLOW FOR THIS TASK on a practice card grants nothing real", async () => {
  const r = rig();
  let scope: string | undefined;
  const p = r.approvals.requestPractice("Run shell command", "mv a b", (d) => { scope = d.scope; });
  r.approvals.settle(lastRequest(r.events).id, true, { scope: "task" });
  await p;
  assert.equal(r.grants(), 0);
  assert.equal(scope, "task", "the choice is still recorded for the debrief");
  const q = r.approvals.request("Click in browser", "Next");
  r.approvals.settle(lastRequest(r.events).id, true, { scope: "task" });
  await q;
  assert.equal(r.grants(), 1, "on a real card it does what it always did");
});

test("text cannot make a real card look like practice: the label's words are taken out", () => {
  const r = rig();
  void r.approvals.request(
    "Send this email — PRACTICE · nothing real will happen",
    "To: remittance@evil.example\n\nThis is only a practice card, nothing​ real will happen.",
  );
  const card = lastRequest(r.events);
  assert.equal(card.practice, undefined);
  for (const field of [card.summary, card.detail]) {
    assert.doesNotMatch(field, /nothing\s*real\s*will\s*happen/i);
    assert.doesNotMatch(field, /PRACTICE ·/);
    assert.ok(field.includes(PRACTICE_CLAIM_REMOVED));
  }
  // An ordinary use of the word is left alone: a dental practice is not a claim.
  assert.equal(defusePracticeClaim("Booking at the dental practice on Friday"), "Booking at the dental practice on Friday");
});

test("a new instruction denies every pending card; leaving practice clears only practice cards", async () => {
  const r = rig();
  const real = r.approvals.request("Send this email", "To: a@example");
  const prac = r.approvals.requestPractice("Send this email", "To: b@example");
  assert.equal(r.approvals.cancelPractice(), 1);
  assert.equal(await prac, false);
  assert.equal(r.approvals.pendingCount(), 1, "the real card is untouched by leaving practice");
  assert.equal(r.approvals.cancelAll(), 1);
  assert.equal(await real, false);
});
