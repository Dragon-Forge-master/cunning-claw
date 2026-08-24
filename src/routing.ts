import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { AnthropicProvider, OpenAICompatProvider, type Provider } from "./providers.js";
import { DEFAULT_MEMORY_BODY } from "./workspace.js";

/**
 * Risk-tiered model routing.
 *
 * Running everything on the most expensive model is what reviewers hate about
 * OpenClaw. But routing purely by "how big is this job" gets the safety story
 * backwards: reading an email is a *small* job and the single most dangerous
 * one, because that is where attacker-controlled text enters.
 *
 * The denylist, approval gates and allowlist are enforced in code and hold on
 * any model. Resisting a prompt injection is *behaviour*, and a cheap model is
 * measurably worse at it. So the cheap tier is only ever used for turns that
 * cannot have seen hostile input.
 *
 * Taint is sticky. History persists across turns, so an email read three turns
 * ago is still in the context window now — the cheap model would still be
 * looking straight at it. Once a session is tainted it stays on the strong
 * model until history is cleared.
 */

/** Tools whose results carry attacker-controlled bytes. */
export const UNTRUSTED_TOOLS = new Set([
  "browser_read", "check_email", "read_email", "browser_tabs",
  "http_request", "web_search", "clipboard", "read_file",
]);

/** Tools that change the world, spend money, or run code. */
export const CONSEQUENTIAL_TOOLS = new Set([
  "run_command", "write_file", "browser_click", "browser_type",
  "press_keys", "type_on_desktop", "home_assistant", "skill_write",
  "memory_save", "memory_forget", "open",
]);

export type Tier = "cheap" | "strong";

export interface RoutingDecision {
  tier: Tier;
  reason: string;
}

/**
 * Recorded memory is only a risk once something is actually recorded. The
 * <recorded> wrapper is emitted whenever MEMORY.md exists at all, so matching
 * the tag alone marks every turn tainted and the cheap tier never fires.
 * Look for real entries inside the fence instead.
 */
function hasRecordedContent(text: string): boolean {
  const start = text.indexOf("<recorded>");
  if (start === -1) return false;
  const end = text.indexOf("</recorded>", start);
  const body = text.slice(start + "<recorded>".length, end === -1 ? undefined : end);

  // Anything that is not blank and not part of the shipped template counts,
  // whatever its formatting. Erring toward "tainted" costs money; erring the
  // other way puts the weakest model in front of planted instructions.
  const boilerplate = new Set(DEFAULT_MEMORY_BODY.map((l) => l.trim()));
  return body
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !boilerplate.has(line));
}

function textIsTainted(text: string): boolean {
  // External content is hard taint. Recorded memory only counts when populated,
  // because memory_save is not approval-gated and may carry planted text.
  return text.includes("<untrusted") || hasRecordedContent(text);
}

/** Does this history already contain attacker-controlled text? */
export function historyIsTainted(messages: Anthropic.MessageParam[]): boolean {
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (textIsTainted(m.content)) return true;
      continue;
    }
    for (const block of m.content as any[]) {
      if (block.type === "tool_use" && UNTRUSTED_TOOLS.has(block.name)) return true;
      if (block.type === "tool_result") {
        const body = typeof block.content === "string"
          ? block.content
          : (block.content ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join("");
        if (textIsTainted(body)) return true;
      }
      if (block.type === "image") return true; // vision needs the strong model anyway
    }
  }
  return false;
}

/** Cheap-tier keywords are a hint, never an override. */
function looksTrivial(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t.length > config.routing.cheapMaxChars) return false;
  return config.routing.cheapPatterns.some((p) => new RegExp(p, "i").test(t));
}

export function decideTier(
  userMessage: string,
  history: Anthropic.MessageParam[],
  kind: "user" | "heartbeat",
): RoutingDecision {
  if (!config.routing.enabled) return { tier: "strong", reason: "routing disabled" };
  if (!cheapProvider()) return { tier: "strong", reason: "no cheap provider configured" };

  // Sticky taint: hostile text already in the window stays on the strong model.
  if (historyIsTainted(history)) {
    return { tier: "strong", reason: "history contains untrusted content" };
  }

  // A request that is *asking* to touch the outside world is strong-tier even
  // before any untrusted bytes arrive, because this turn will fetch them.
  if (config.routing.strongPatterns.some((p) => new RegExp(p, "i").test(userMessage))) {
    return { tier: "strong", reason: "request reaches external or consequential surface" };
  }

  // Quiet heartbeat ticks are the ideal cheap-tier turn: no user input, and
  // nothing hostile can have reached them.
  if (kind === "heartbeat") return { tier: "cheap", reason: "heartbeat tick" };

  if (looksTrivial(userMessage)) return { tier: "cheap", reason: "trivial local request" };

  return { tier: "strong", reason: "default" };
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

let strong: Provider | null = null;
let cheap: Provider | null = null;

export function strongProvider(): Provider {
  if (!strong) strong = new AnthropicProvider(config.model, config.effort, "anthropic");
  return strong;
}

export function cheapProvider(): Provider | null {
  if (cheap) return cheap;
  const c = config.routing.cheap;
  if (!c.enabled) return null;
  if (c.provider === "anthropic") {
    cheap = new AnthropicProvider(c.model, c.effort ?? "low", "anthropic-cheap");
  } else {
    if (c.apiKeyEnv && !process.env[c.apiKeyEnv] && !c.baseUrl.includes("localhost")
        && !c.baseUrl.includes("127.0.0.1")) {
      return null; // remote endpoint with no key — do not silently fail mid-turn
    }
    cheap = new OpenAICompatProvider("openai-compat", c.model, c.baseUrl, c.apiKeyEnv);
  }
  return cheap;
}

export function providerFor(tier: Tier): Provider {
  return tier === "cheap" ? (cheapProvider() ?? strongProvider()) : strongProvider();
}

/** Rough spend estimate, in USD, for the HUD. */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = config.routing.pricePerMTok as Record<string, { in: number; out: number }>;
  const rate = rates[model] ?? rates.default ?? { in: 0, out: 0 };
  return (inputTokens / 1e6) * rate.in + (outputTokens / 1e6) * rate.out;
}

export function resetProviders(): void {
  strong = null;
  cheap = null;
}
