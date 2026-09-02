import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { repairHistory } from "./agent.js";

/**
 * A tool_use with no tool_result in the next message is a 400 — and once it is
 * in history, every later turn fails identically. This bricked a live session
 * during development, so the invariant is pinned here.
 */

const use = (id: string): Anthropic.MessageParam => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "run_command", input: {} }],
});

function danglingIds(messages: Anthropic.MessageParam[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b.type !== "tool_use") continue;
      const next = messages[i + 1];
      const answered = next && Array.isArray(next.content)
        ? (next.content as any[]).some((r) => r.type === "tool_result" && r.tool_use_id === b.id)
        : false;
      if (!answered) bad.push(b.id);
    }
  }
  return bad;
}

test("an interrupted tool call is answered rather than dropped", () => {
  const broken: Anthropic.MessageParam[] = [{ role: "user", content: "hi" }, use("toolu_1")];
  const fixed = repairHistory(broken);
  assert.deepEqual(danglingIds(fixed), [], "no tool_use may be left unanswered");
  assert.ok(fixed.length > broken.length, "a result message was added");
  const last = fixed[fixed.length - 1];
  assert.equal(last.role, "user");
  assert.match(JSON.stringify(last.content), /interrupted/);
});

test("the assistant's turn survives the repair", () => {
  const fixed = repairHistory([{ role: "user", content: "hi" }, use("toolu_1")]);
  assert.ok(fixed.some((m) => m.role === "assistant"), "reasoning must not be discarded");
});

test("a partially answered turn gets only the missing results", () => {
  const broken: Anthropic.MessageParam[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: [
      { type: "tool_use", id: "a", name: "run_command", input: {} },
      { type: "tool_use", id: "b", name: "read_file", input: {} },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
  ];
  const fixed = repairHistory(broken);
  assert.deepEqual(danglingIds(fixed), []);
  const results = (fixed[2].content as any[]).filter((b) => b.type === "tool_result");
  assert.equal(results.length, 2, "both calls answered");
  assert.ok(results.some((r) => r.tool_use_id === "a" && r.content === "ok"), "real result preserved");
});

test("a healthy conversation is left untouched", () => {
  const healthy: Anthropic.MessageParam[] = [
    { role: "user", content: "go" },
    use("toolu_1"),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] },
  ];
  assert.deepEqual(repairHistory([...healthy]), healthy);
});
