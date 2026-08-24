import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

/**
 * Provider abstraction.
 *
 * Everything is normalised to Anthropic's content-block shape internally,
 * because that is what the agent loop, the tool layer and the HUD already
 * speak. OpenAI-compatible endpoints (OpenRouter, Gemini's compat layer,
 * llama.cpp, Ollama, LM Studio) are translated in and out at the edge.
 */

export interface TurnRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.ToolUnion[];
  maxTokens: number;
}

export interface TurnResult {
  content: Anthropic.ContentBlockParam[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface Provider {
  id: string;
  model: string;
  /** Supports image content blocks (vision). */
  vision: boolean;
  run(req: TurnRequest, onText: (delta: string) => void): Promise<TurnResult>;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const anthropic = new Anthropic();

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly vision = true;

  constructor(readonly model: string, private readonly effort: string, id = "anthropic") {
    this.id = id;
  }

  async run(req: TurnRequest, onText: (delta: string) => void): Promise<TurnResult> {
    const stream = anthropic.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort as any },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools: req.tools,
      messages: req.messages,
    });
    stream.on("text", onText);
    const message = await stream.finalMessage();
    return {
      content: message.content as Anthropic.ContentBlockParam[],
      stopReason: message.stop_reason,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
      model: message.model,
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenRouter, Gemini compat, Ollama, llama.cpp, LM Studio)
// ---------------------------------------------------------------------------

function toOpenAITools(tools: Anthropic.ToolUnion[]): any[] {
  return tools
    // Server-side Anthropic tools have no equivalent; drop them for other providers.
    .filter((t: any) => typeof t.input_schema === "object")
    .map((t: any) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
}

function blockText(block: any): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") return "[image omitted — this provider has no vision]";
  return "";
}

/** Anthropic message list → OpenAI chat messages. */
function toOpenAIMessages(system: string, messages: Anthropic.MessageParam[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as any[];

    if (m.role === "user") {
      // tool_result blocks become separate `tool` messages; text stays a user turn.
      const results = blocks.filter((b) => b.type === "tool_result");
      for (const r of results) {
        const body = typeof r.content === "string"
          ? r.content
          : (r.content ?? []).map(blockText).join("\n");
        out.push({ role: "tool", tool_call_id: r.tool_use_id, content: body || "(no output)" });
      }
      const text = blocks.filter((b) => b.type === "text").map(blockText).join("\n");
      if (text) out.push({ role: "user", content: text });
      continue;
    }

    const text = blocks.filter((b) => b.type === "text").map(blockText).join("\n");
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    const msg: any = { role: "assistant", content: text || null };
    if (toolUses.length) {
      msg.tool_calls = toolUses.map((t) => ({
        id: t.id,
        type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
      }));
    }
    out.push(msg);
  }
  return out;
}

export class OpenAICompatProvider implements Provider {
  readonly vision = false;

  constructor(
    readonly id: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKeyEnv: string,
  ) {}

  async run(req: TurnRequest, onText: (delta: string) => void): Promise<TurnResult> {
    const key = process.env[this.apiKeyEnv];
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: toOpenAIMessages(req.system, req.messages),
        ...(req.tools.length ? { tools: toOpenAITools(req.tools) } : {}),
      }),
      signal: AbortSignal.timeout(config.routing.timeoutMs),
    });
    if (!res.ok || !res.body) {
      throw new Error(`${this.id} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = line.trim();
        if (!payload.startsWith("data:")) continue;
        const data = payload.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let evt: any;
        try { evt = JSON.parse(data); } catch { continue; }

        if (evt.usage) {
          usage = {
            inputTokens: evt.usage.prompt_tokens ?? 0,
            outputTokens: evt.usage.completion_tokens ?? 0,
          };
        }
        const choice = evt.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) stopReason = choice.finish_reason;

        const delta = choice.delta ?? {};
        if (delta.content) {
          text += delta.content;
          onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const slot = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          calls.set(tc.index, slot);
        }
      }
    }

    const content: Anthropic.ContentBlockParam[] = [];
    if (text) content.push({ type: "text", text });
    for (const [i, c] of calls) {
      let parsed: unknown = {};
      try { parsed = JSON.parse(c.args || "{}"); } catch { parsed = {}; }
      content.push({
        type: "tool_use",
        id: c.id || `call_${i}`,
        name: c.name,
        input: parsed as Record<string, unknown>,
      });
    }

    return {
      content,
      // Normalise to the Anthropic vocabulary the agent loop already branches on.
      stopReason: calls.size ? "tool_use" : stopReason === "length" ? "max_tokens" : "end_turn",
      usage,
      model: this.model,
    };
  }
}
