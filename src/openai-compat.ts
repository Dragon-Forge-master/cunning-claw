import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { openAiEndpoint, isLocalEndpoint, type BrainSpec } from "./brain.js";
import { toolDefinitions } from "./tools.js";

export type OpenAiChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
};

function flattenToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((block: any) => {
      if (block?.type === "text") return block.text;
      // Images are lifted out of the tool result and sent as a separate user
      // message — see imagesFromToolContent. A `tool` message may only carry
      // text, so this is the note left in its place.
      if (block?.type === "image") return "[screenshot attached below]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Pull image blocks out of a tool result.
 *
 * Gemini Flash, Gemini Pro and gpt-4.1-nano all take image input, but the
 * OpenAI chat schema will not carry an image inside a `tool` message. So the
 * screenshot travels as a `user` message immediately after the tool result,
 * which is where the model expects to find it.
 *
 * This was dropping every screenshot on the floor: the adapter replaced them
 * with a "no vision on this provider" note, which was true of the placeholder
 * and false of the models. Removing Anthropic therefore blinded the assistant,
 * and it noticed before we did.
 */
function imagesFromToolContent(content: unknown): OpenAiChatMessage[] {
  if (!Array.isArray(content)) return [];
  const parts = content
    .filter((b: any) => b?.type === "image" && b?.source?.type === "base64" && b.source.data)
    .map((b: any) => ({
      type: "image_url" as const,
      image_url: { url: `data:${b.source.media_type || "image/png"};base64,${b.source.data}` },
    }));
  if (!parts.length) return [];
  return [{
    role: "user",
    content: [{ type: "text" as const, text: "Screenshot from the tool call above." }, ...parts] as any,
  }];
}

/** Convert stored Anthropic-shaped history into OpenAI chat messages. */
export function toOpenAiMessages(
  system: string,
  history: Anthropic.MessageParam[],
): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = [{ role: "system", content: system }];
  for (const m of history) {
    if (m.role === "user" && typeof m.content === "string") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content as any[]) {
        if (block.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: flattenToolContent(block.content),
          });
          // The image cannot ride inside the tool message, so it follows it.
          out.push(...imagesFromToolContent(block.content));
        }
      }
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = (m.content as any[])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const tool_calls = (m.content as any[])
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(tool_calls.length ? { tool_calls } : {}),
      });
    }
  }
  return out;
}

export function openAiToolSchema() {
  return toolDefinitions.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export type OpenAiCompletion = {
  text: string;
  blocks: Anthropic.ContentBlock[];
  toolUses: { id: string; name: string; input: unknown }[];
  usage?: { inputTokens: number; outputTokens: number };
};

export async function completeOpenAi(opts: {
  spec: BrainSpec;
  system: string;
  history: Anthropic.MessageParam[];
  onText: (delta: string) => void;
}): Promise<OpenAiCompletion> {
  const brain = openAiEndpoint(opts.spec);
  const key = process.env[brain.apiKeyEnv];
  // A local runtime (Ollama, llama.cpp, LM Studio) serves the same API with no
  // auth. Demanding a key there would block offline use for no reason.
  if (!key && !isLocalEndpoint(brain.baseUrl)) {
    throw new Error(`Missing ${brain.apiKeyEnv} for the OpenAI-compatible provider.`);
  }

  const payload = {
    model: brain.model,
    max_tokens: opts.spec.maxTokens ?? config.maxTokens,
    tools: openAiToolSchema(),
    messages: toOpenAiMessages(opts.system, opts.history),
  };

  const headers = {
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    "Content-Type": "application/json",
  };

  let res = await fetch(`${brain.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, stream: true }),
  });

  if (!res.ok) {
    const detail = await res.text();
    // Some local servers refuse stream+tools. Fall back once, non-streaming.
    if (res.status === 400 || res.status === 422) {
      res = await fetch(`${brain.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...payload, stream: false }),
      });
      if (!res.ok) {
        const again = await res.text();
        throw new Error(`OpenAI-compatible API ${res.status}: ${again.slice(0, 400)}`);
      }
      return fromNonStream(await res.json(), opts.onText);
    }
    throw new Error(`OpenAI-compatible API ${res.status}: ${detail.slice(0, 400)}`);
  }

  if (!res.body) {
    throw new Error("OpenAI-compatible API returned an empty body.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: { inputTokens: number; outputTokens: number } | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        opts.onText(delta.content);
      }
      for (const part of delta.tool_calls ?? []) {
        const idx = part.index ?? 0;
        const cur = calls.get(idx) ?? { id: "", name: "", arguments: "" };
        if (part.id) cur.id = part.id;
        if (part.function?.name) cur.name += part.function.name;
        if (part.function?.arguments) cur.arguments += part.function.arguments;
        calls.set(idx, cur);
      }
      if (json.usage) usage = parseUsage(json.usage);
    }
  }

  return assemble(text, [...calls.values()].map((c, i) => ({
    id: c.id || `call_${i}`,
    name: c.name,
    arguments: c.arguments,
  })), usage);
}

function parseToolArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { _raw: raw };
  }
}

function parseUsage(raw: any): { inputTokens: number; outputTokens: number } | undefined {
  const input = Number(raw?.prompt_tokens ?? raw?.input_tokens ?? 0);
  const output = Number(raw?.completion_tokens ?? raw?.output_tokens ?? 0);
  if (!input && !output) return undefined;
  return { inputTokens: input, outputTokens: output };
}

function assemble(
  text: string,
  calls: { id: string; name: string; arguments: string }[],
  usage?: { inputTokens: number; outputTokens: number },
): OpenAiCompletion {
  const toolUses = calls
    .filter((c) => c.name)
    .map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.name,
      input: parseToolArgs(c.arguments),
    }));
  const blocks: any[] = [];
  if (text) blocks.push({ type: "text", text });
  for (const tu of toolUses) {
    blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
  }
  return { text, blocks, toolUses, usage };
}

function fromNonStream(json: any, onText: (delta: string) => void): OpenAiCompletion {
  const msg = json.choices?.[0]?.message ?? {};
  const text = typeof msg.content === "string" ? msg.content : "";
  if (text) onText(text);
  const calls = (msg.tool_calls ?? []).map((c: any, i: number) => ({
    id: c.id || `call_${i}`,
    name: c.function?.name ?? "",
    arguments: c.function?.arguments ?? "",
  }));
  return assemble(text, calls, parseUsage(json.usage));
}
