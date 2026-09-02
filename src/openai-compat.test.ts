import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { toOpenAiMessages, openAiToolSchema, completeOpenAi } from "./openai-compat.js";
import { activeProvider, isFailoverError } from "./brain.js";

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

test("the tool message notes the screenshot rather than carrying it", () => {
  // This previously asserted images were *not* forwarded — codifying the
  // limitation as if it were the intent, so the suite stayed green while the
  // assistant could not see. A tool message may only hold text; the note points
  // at the image that follows.
  const msgs = toOpenAiMessages("s", [
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "img",
        // A real 1x1 PNG: the guard verifies magic bytes now, so the fixture
        // must be a decodable image, exactly as production frames are.
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" } }],
      }],
    },
  ] as any);
  assert.equal(msgs[1].role, "tool");
  assert.match(String(msgs[1].content), /screenshot attached below/);
  assert.equal(msgs[2].role, "user", "and the image itself follows it");
});

test("OpenAI tool schema wraps every CUNNING CLAW tool as a function", () => {
  const schema = openAiToolSchema();
  assert.ok(schema.length >= 25);
  assert.equal(schema[0].type, "function");
  assert.ok(schema.some((t) => t.function.name === "memory_search"));
  assert.ok(schema.some((t) => t.function.name === "skill_read"));
  assert.ok(schema.some((t) => t.function.name === "mcp_schema"));
  assert.ok(schema.some((t) => t.function.name === "mcp_describe"));
});

test("screenshots reach vision-capable models instead of being dropped", () => {
  // Gemini Flash, Gemini Pro and gpt-4.1-nano all take image input. The adapter
  // used to replace every screenshot with a "no vision on this provider" note,
  // which was true of the placeholder and false of the models — so removing
  // Anthropic silently blinded the assistant.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
  const msgs = toOpenAiMessages("sys", [
    { role: "user", content: "what's on my screen?" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "take_screenshot", input: {} }] },
    { role: "user", content: [{
      type: "tool_result", tool_use_id: "t1",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        { type: "text", text: "[screenshot of the screen, 120KB]" },
      ],
    }] },
  ] as any);

  const withImage = msgs.find((m) => Array.isArray(m.content) &&
    (m.content as any[]).some((p) => p.type === "image_url"));
  assert.ok(withImage, "the screenshot must reach the model");
  assert.equal(withImage!.role, "user", "an image cannot ride inside a tool message");

  const part = (withImage!.content as any[]).find((p) => p.type === "image_url");
  assert.match(part.image_url.url, /^data:image\/png;base64,/, "sent as a data URI");
  assert.ok(part.image_url.url.includes(png), "the payload must be intact");

  // The tool message itself still exists and is answered.
  const toolMsg = msgs.find((m) => m.role === "tool");
  assert.ok(toolMsg, "the tool_result must still be answered");
  assert.equal(toolMsg!.tool_call_id, "t1");
});

test("a tool result with no image adds no stray user message", () => {
  const msgs = toOpenAiMessages("sys", [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "system_status", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "load 0.4" }] },
  ] as any);
  assert.equal(msgs.filter((m) => m.role === "user").length, 0, "no phantom image message");
});

test("stopping a turn actually reaches the model request", { timeout: 10_000 }, () => {
  // cancelTurn() built an AbortController and aborted it, but the signal was
  // never handed to the request — so "stop" freed the agent to take new work
  // while the abandoned turn kept streaming underneath and could still write
  // to history beneath the next one.
  const server = http.createServer(() => {
    // Accept the request and never answer: exactly the stall this guards.
  });
  return new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address() as AddressInfo;
      const controller = new AbortController();
      const call = completeOpenAi({
        spec: {
          id: "test",
          label: "test",
          provider: "openai",
          model: "test-model",
          baseUrl: `http://127.0.0.1:${port}/v1`,
        } as any,
        system: "system",
        history: [{ role: "user", content: "hello" }],
        onText: () => {},
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      try {
        await call;
        reject(new Error("the request should have been aborted"));
      } catch (err) {
        assert.match(String((err as Error).name + (err as Error).message), /abort/i);
        resolve();
      } finally {
        server.close();
      }
    });
  });
});

test("a local runtime that is not running is named, not 'fetch failed'", async () => {
  // Pinned to Local with Ollama down, the HUD said "⚠ fetch failed" — undici's
  // wording, which names neither the endpoint nor the fix. Nothing listens on
  // this port: a fresh server bound to 0 gives one that is then closed.
  const probe = http.createServer();
  const port = await new Promise<number>((resolve) =>
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    }),
  );
  const spec = {
    id: "local", label: "Local", provider: "openai", model: "llama3.2:latest",
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "OLLAMA_NO_KEY",
  } as any;
  await assert.rejects(
    completeOpenAi({ spec, system: "sys", history: [{ role: "user", content: "hi" }], onText: () => {} }),
    (err: any) => {
      assert.match(err.message, new RegExp(`^Nothing answered at http://127\\.0\\.0\\.1:${port}/v1`));
      assert.match(err.message, /ollama serve/);
      assert.equal(isFailoverError(err), true, "auto routing must still move on to the next brain");
      return true;
    },
  );
});
