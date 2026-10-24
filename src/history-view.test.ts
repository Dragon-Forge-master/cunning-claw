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
  const at = new Date(2026, 8, 25, 9, 5);
  const stamped = stampUserMessage("[Armed skills — call skill_read first: desk]\nfile the invoice", at, at.getTime() - 5 * 3600_000);
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

test("a heartbeat's window is recent and always opens on an operator message", async () => {
  const { recentWindow } = await import("./history-view.js");
  const msgs: { role: string; content: unknown }[] = [];
  for (let i = 0; i < 20; i++) {
    msgs.push(user(`[10:${String(i).padStart(2, "0")}] message ${i}`));
    msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "x", input: {} }] });
    msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }] });
    msgs.push(reply(`done ${i}`));
  }
  const w = recentWindow(msgs, 12);
  assert.ok(w.length <= 12);
  assert.equal(w[0].role, "user");
  assert.equal(typeof w[0].content, "string", "never opens on a tool result");
  assert.equal(w[w.length - 1], msgs[msgs.length - 1]);
  // A window with no operator message inside it widens back to the nearest one.
  const long = [user("start"), ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: String(i) }] }))];
  assert.equal(recentWindow(long, 5)[0], long[0]);
  assert.equal(recentWindow(msgs.slice(0, 4), 12).length, 4, "short histories are untouched");
});
