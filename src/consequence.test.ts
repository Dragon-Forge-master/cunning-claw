import assert from "node:assert/strict";
import test from "node:test";
import { classifyBrowserAction, needsApproval } from "./consequence.js";

/**
 * Sending one WhatsApp message took six approvals, of which one mattered. Five
 * unnecessary cards do not make the sixth safer — they train the operator to
 * click through it. These tests pin the boundary at reversibility.
 */

test("the WhatsApp journey asks twice, not six times", () => {
  const steps: [string, boolean][] = [
    ["search",              false],  // opening search changes nothing
    ["Ffion",               true ],  // a bare name is unreadable — ask once, then grant
    ["Type a message",      false],  // focusing the box changes nothing
    ["send",                true ],  // this one leaves the machine
  ];
  for (const [target, shouldAsk] of steps) {
    assert.equal(needsApproval("click", target), shouldAsk, `click "${target}"`);
  }
  const asked = steps.filter(([, s]) => s).length;
  assert.equal(asked, 2, "two decisions, not six — and one of them can be granted away");
});

test("a task grant covers unreadable targets but never a send", async () => {
  const { grantForTask, clearTaskGrant } = await import("./consequence.js");
  clearTaskGrant();
  assert.equal(needsApproval("click", "Ffion"), true, "asks the first time");

  grantForTask();
  assert.equal(needsApproval("click", "Ffion"), false, "granted for the errand");
  assert.equal(needsApproval("click", "div.x7f2"), false, "and for other unreadable targets");
  assert.equal(needsApproval("click", "Send"), true, "but never for a send");
  assert.equal(needsApproval("click", "Pay now"), true, "never for a payment");
  assert.equal(needsApproval("click", "Delete account"), true, "never for a delete");
  assert.equal(needsApproval("type", "#msg", { submit: true }), true, "never for enter-to-send");

  clearTaskGrant();
  assert.equal(needsApproval("click", "Ffion"), true, "and it dies with the turn");
});

test("typing is free; typing-and-pressing-Enter is not", () => {
  assert.equal(needsApproval("type", "#message", { submit: false }), false);
  assert.equal(needsApproval("type", "#message", { submit: true }), true);
});

test("irreversible verbs always stop", () => {
  for (const t of ["Send", "Submit", "Post", "Publish", "Pay now", "Buy it now",
                   "Place order", "Confirm", "Delete account", "Transfer funds",
                   "Unsubscribe", "Continue to payment", "Book now"]) {
    assert.equal(needsApproval("click", t), true, `"${t}" must ask`);
  }
});

test("navigation does not", () => {
  for (const t of ["Search", "Next page", "Show more", "Close", "Cancel",
                   "Back", "Open inbox", "Settings", "New message"]) {
    assert.equal(needsApproval("click", t), false, `"${t}" should not ask`);
  }
});

test("an unreadable target asks rather than guesses", () => {
  // A bare selector carries no intent, and an unknown label could be anything.
  assert.equal(needsApproval("click", "div.x7f2 > button:nth-child(3)"), true);
  assert.equal(needsApproval("click", "Æ"), true);
  assert.match(classifyBrowserAction("click", "div.x7f2").why, /unrecognised/);
});

test("Cancel is navigation, not consent", () => {
  // "Cancel" backs out; it must not be mistaken for "Confirm".
  assert.equal(needsApproval("click", "Cancel"), false);
  assert.equal(needsApproval("click", "Confirm"), true);
});

test("paranoid mode gates everything", async () => {
  const { config } = await import("./config.js");
  config.browser.approveEveryAction = true;
  assert.equal(needsApproval("click", "Search"), true, "opt-in mode gates navigation too");
  assert.equal(needsApproval("type", "#msg", { submit: false }), true);
  config.browser.approveEveryAction = false;
});
