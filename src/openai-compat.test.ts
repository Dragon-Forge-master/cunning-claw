import assert from "node:assert/strict";
import test from "node:test";
import { toOpenAiMessages, openAiToolSchema } from "./openai-compat.js";
import { activeProvider } from "./brain.js";

test("the default brain is one that can actually run", () => {
  // The default is config and may be any provider — what matters is that it
  // names something real rather than a typo nothing will match.
  assert.ok(["anthropic", "openai"].includes(activeProvider()));
});

test("converts Anthropic history into OpenAI chat messages", () => {
  const msgs = toOpenAiMessages("sys", [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "one moment" },
        { type: "tool_use", id: "t1", name: "run_command", input: { command: "date" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "Wed" }],
    },
  ] as any);

  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "sys");
  assert.equal(msgs[1].role, "user");
  assert.equal(msgs[1].content, "hello");
  assert.equal(msgs[2].role, "assistant");
  assert.equal(msgs[2].content, "one moment");
  assert.equal(msgs[2].tool_calls?.[0].function.name, "run_command");
  assert.equal(JSON.parse(msgs[2].tool_calls![0].function.arguments).command, "date");
  assert.equal(msgs[3].role, "tool");
  assert.equal(msgs[3].tool_call_id, "t1");
  assert.equal(msgs[3].content, "Wed");
});

test("flattens vision blocks instead of forwarding them to OpenAI-compatible brains", () => {
  const msgs = toOpenAiMessages("s", [
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "img",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "xxx" } }],
      }],
    },
  ] as any);
  assert.equal(msgs[1].role, "tool");
  assert.match(String(msgs[1].content), /not forwarded/);
});

test("OpenAI tool schema wraps every CUNNING CLAW tool as a function", () => {
  const schema = openAiToolSchema();
  assert.ok(schema.length >= 25);
  assert.equal(schema[0].type, "function");
  assert.ok(schema.some((t) => t.function.name === "memory_search"));
  assert.ok(schema.some((t) => t.function.name === "skill_read"));
});
