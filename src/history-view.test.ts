import assert from "node:assert/strict";
import test from "node:test";
import { displayHistory } from "./history-view.js";
import { stampUserMessage, unstampUserMessage } from "./when.js";

const END = "[/context]";
const user = (text: string) => ({ role: "user", content: text });
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

test("a stamped heartbeat turn never reaches the transcript", () => {
  // The live shape: when.ts stamps every stored user turn, heartbeats
  // included, so the old startsWith("[heartbeat]") check never matched and
  // the whole HEARTBEAT.md checklist rendered as an operator bubble.
  const shown = displayHistory([
    user("[10:33] [heartbeat]\nFollow HEARTBEAT.md. Checklist:\n# HEARTBEAT"),
    reply("HEARTBEAT_OK"),
    user("[10:42] can you check the grid repo"),
    reply("Looked, sir."),
  ], END);
  assert.equal(shown.some((t) => /HEARTBEAT/.test(t.text)), false);
  assert.deepEqual(shown.map((t) => t.text), ["can you check the grid repo", "Looked, sir."]);
});

test("the armed-skills preamble and the gap note come off, behind a context block too", () => {
  const stamped = stampUserMessage("[Armed skills — call skill_read first: desk]\nfile the invoice", new Date(2026, 8, 25, 9, 5), Date.now() - 5 * 3600_000);
  assert.match(stamped, /since the previous message\] \[09:05\] /);
  const shown = displayHistory([user(`[context]\nclock etc\n${END}\n\n${stamped}`)], END);
  assert.deepEqual(shown, [{ role: "user", text: "file the invoice" }]);
});

test("a heartbeat that found something to say is kept: it was meant for the operator", () => {
  const shown = displayHistory([user("[08:00] [heartbeat]\nchecklist"), reply("Sir, the MOT reminder is due today.")], END);
  assert.deepEqual(shown, [{ role: "assistant", text: "Sir, the MOT reminder is due today." }]);
});

test("unstamp leaves text that merely starts with a bracket alone", () => {
  assert.equal(unstampUserMessage("[note] not a stamp"), "[note] not a stamp");
  assert.equal(unstampUserMessage("[10:42] hello"), "hello");
  assert.equal(unstampUserMessage("[3h 5m since the previous message] [10:42] hello"), "hello");
});
