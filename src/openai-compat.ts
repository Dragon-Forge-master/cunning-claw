import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { openAiEndpoint, type BrainSpec } from "./brain.js";
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
      if (block?.type === "image") return "[image — not forwarded on the OpenAI-compatible provider; use Anthropic for vision]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
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
};

export async function completeOpenAi(opts: {
  spec: BrainSpec;
  system: string;
  history: Anthropic.MessageParam[];
  onText: (delta: string) => void;
}): Promise<OpenAiCompletion> {
  const brain = openAiEndpoint(opts.spec);
  const key = process.env[brain.apiKeyEnv];
  if (!key) {
    throw new Error(`Missing ${brain.apiKeyEnv} for the OpenAI-compatible provider.`);
  }

  const payload = {
    model: brain.model,
    max_tokens: opts.spec.maxTokens ?? config.maxTokens,
    tools: openAiToolSchema(),
    messages: toOpenAiMessages(opts.system, opts.history),
  };

  const headers = {
    Authorization: `Bearer ${key}`,
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
    }
  }

  return assemble(text, [...calls.values()].map((c, i) => ({
    id: c.id || `call_${i}`,
    name: c.name,
    arguments: c.arguments,
  })));
}

function parseToolArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { _raw: raw };
  }
}

function assemble(
  text: string,
  calls: { id: string; name: string; arguments: string }[],
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
  return { text, blocks, toolUses };
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
  return assemble(text, calls);
}
