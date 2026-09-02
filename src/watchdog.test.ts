import assert from "node:assert/strict";
import test from "node:test";
import { turnInFlight, cancelTurn } from "./agent.js";

/**
 * A turn is a chain of awaits — an API stream, a tool, a browser call. Any one
 * of them stalling with no timeout used to leave `busy` true forever, and every
 * later message was answered with "still working on the previous request".
 * From the outside that is indistinguishable from the assistant being dead.
 */

test("nothing in flight reports nothing in flight", () => {
  const t = turnInFlight();
  assert.equal(typeof t.busy, "boolean");
  assert.equal(typeof t.forMs, "number");
  if (!t.busy) assert.equal(t.forMs, 0, "an idle agent has no elapsed time");
});

test("cancelling when idle is a no-op, not an error", () => {
  if (!turnInFlight().busy) {
    assert.equal(cancelTurn("test"), false, "returns false rather than throwing");
  }
});

test("stop words are recognised as commands, not conversation", () => {
  const STOP = /^\s*(stop|cancel|abort|halt|never ?mind|forget it|leave it)\b[\s.!]*$/i;
  for (const s of ["stop", "Stop.", "cancel", "ABORT", "never mind", "nevermind", "forget it", "leave it"]) {
    assert.ok(STOP.test(s), `"${s}" should stop the turn`);
  }
  // These are instructions that happen to contain the word.
  for (const s of ["stop the server", "cancel my subscription", "stop and then check email"]) {
    assert.equal(STOP.test(s), false, `"${s}" is a request, not a stop`);
  }
});
