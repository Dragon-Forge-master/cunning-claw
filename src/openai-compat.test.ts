import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { toOpenAiMessages, openAiToolSchema, completeOpenAi, isGeminiDirect, GEMINI_SKIP_SIGNATURE } from "./openai-compat.js";
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

/** A local server that answers one chat completion with Google's stream shape. */
function geminiShapedServer(chunks: unknown[]): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    }),
  );
}

test("Gemini's thought signature goes back on the call it came with", async () => {
  // Google's endpoint returned the signature on the tool call and the adapter
  // dropped it, so the request after the claw's first delegate_code was
  // refused: "Function call is missing a thought_signature" (400). Shape and
  // field names copied from a real gemini-3.6-flash stream.
  const sig = { google: { thought_signature: "c2lnLWZyb20tZ29vZ2xl" } };
  const srv = await geminiShapedServer([{
    choices: [{ delta: { role: "assistant", tool_calls: [
      { extra_content: sig, function: { arguments: "{\"project\":\"bakery\"}", name: "delegate_code" }, id: "call_sig_one", type: "function" },
      { function: { arguments: "{}", name: "jobs" }, id: "call_sig_two", type: "function" },
    ] }, index: 0 }],
  }]);
  try {
    const done = await completeOpenAi({
      spec: { id: "t", label: "t", provider: "openai", model: "gemini-3.6-flash", baseUrl: srv.url } as any,
      system: "s", history: [{ role: "user", content: "build it" }], onText: () => {},
    });
    // Both calls survive: with no `index`, they used to share slot 0 and fuse
    // into one call named "delegate_codejobs".
    assert.deepEqual(done.toolUses.map((t) => t.name), ["delegate_code", "jobs"]);
    assert.deepEqual(done.toolUses[0].input, { project: "bakery" });

    const history = [
      { role: "user", content: "build it" },
      { role: "assistant", content: done.blocks },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_sig_one", content: "started" },
        { type: "tool_result", tool_use_id: "call_sig_two", content: "one job" },
      ] },
    ] as any;
    const toGoogle = toOpenAiMessages("s", history, { gemini: true });
    const calls = toGoogle[2].tool_calls!;
    assert.deepEqual(calls[0].extra_content, sig, "the signature rides back on its own call");
    assert.equal(calls[1].extra_content, undefined, "Google signs only the first call of a step");
    // Nothing Google-specific reaches any other provider.
    const elsewhere = toOpenAiMessages("s", history);
    assert.ok(elsewhere[2].tool_calls!.every((c) => !("extra_content" in c)));
    // Anthropic-shaped history stays clean: Anthropic refuses unknown fields.
    assert.ok(done.blocks.every((b: any) => !("extra_content" in b) && !("extra" in b)));
  } finally {
    srv.close();
  }
});

test("a call Google never signed gets Google's documented skip value", () => {
  // History from before a restart, or a call another brain made, has no
  // signature to give back; without one Google refuses the turn outright.
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [
      { type: "tool_use", id: "from_another_brain", name: "run_command", input: { command: "date" } },
      { type: "tool_use", id: "from_another_brain_2", name: "jobs", input: {} },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "from_another_brain", content: "Wed" }] },
  ] as any;
  const msgs = toOpenAiMessages("s", history, { gemini: true });
  assert.deepEqual(msgs[2].tool_calls![0].extra_content, { google: { thought_signature: GEMINI_SKIP_SIGNATURE } });
  assert.equal(msgs[2].tool_calls![1].extra_content, undefined);
});

test("only Google's own endpoint is treated as Gemini direct", () => {
  assert.equal(isGeminiDirect("https://generativelanguage.googleapis.com/v1beta/openai/"), true);
  assert.equal(isGeminiDirect("https://openrouter.ai/api/v1"), false);
  assert.equal(isGeminiDirect("http://localhost:11434/v1"), false);
  assert.equal(isGeminiDirect("not a url"), false);
});
