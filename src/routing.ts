import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { DEFAULT_MEMORY_BODY } from "./workspace.js";
import { catalog, defaultBrainId, type BrainSpec } from "./brain.js";

/**
 * Risk gate over brain selection.
 *
 * brain.ts decides which model to use from pins, defaults and failover — all
 * questions of preference and availability. None of them ask the question that
 * matters for safety: *can this turn see attacker-controlled text?*
 *
 * The denylist, approval gates and host allowlist are enforced in code and hold
 * on any model. Resisting a prompt injection is behaviour, and a smaller model
 * is measurably worse at it. So a turn that can see hostile text must not be
 * handed to a brain that was chosen for being cheap — whether by a pin, by
 * config, or by a failover firing during a rate limit.
 *
 * Taint is sticky. History persists across turns, so an email read three turns
 * ago is still in the context window now.
 */

/** Tool results that carry bytes an attacker may control. */
export const UNTRUSTED_TOOLS = new Set([
  "browser_read", "check_email", "read_email", "browser_tabs",
  "http_request", "web_search", "clipboard", "read_file", "landscape",
]);

/**
 * Any tool from a third-party MCP server returns bytes that server controls,
 * so every one of them taints the turn — the guard cannot know which are safe.
 */
function isUntrustedToolName(name: string): boolean {
  return UNTRUSTED_TOOLS.has(name) || name.startsWith("mcp__");
}

/** Phrases whose turn will reach outside before it finishes. */
const REACHES_OUT = [
  /email|inbox|gmail|mail/i,
  /browse|website|web page|url|http|search|look up|google/i,
  /screenshot|read the (page|screen)|what.*on (my |the )?screen/i,
  /clipboard|download|fetch/i,
];

function hasRecordedContent(text: string): boolean {
  const start = text.indexOf("<recorded>");
  if (start === -1) return false;
  const end = text.indexOf("</recorded>", start);
  const body = text.slice(start + "<recorded>".length, end === -1 ? undefined : end);
  // Anything not blank and not part of the shipped template counts, whatever
  // its formatting — a format heuristic is trivially evaded by planted text.
  const boilerplate = new Set(DEFAULT_MEMORY_BODY.map((l) => l.trim()));
  return body
    .split("\n")
    .map((l) => l.trim())
    .some((l) => l.length > 0 && !boilerplate.has(l));
}

function textIsTainted(text: string): boolean {
  return text.includes("<untrusted") || hasRecordedContent(text);
}

/** Is attacker-controlled text already sitting in this context window? */
export function historyIsTainted(messages: Anthropic.MessageParam[]): boolean {
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (textIsTainted(m.content)) return true;
      continue;
    }
    for (const block of m.content as any[]) {
      if (block.type === "tool_use" && isUntrustedToolName(block.name)) return true;
      if (block.type === "image") return true; // vision needs a capable brain anyway
      if (block.type === "tool_result") {
        const body = typeof block.content === "string"
          ? block.content
          : (block.content ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join("");
        if (textIsTainted(body)) return true;
      }
    }
  }
  return false;
}

export interface Guard {
  required: boolean;
  reason: string;
}

/** Does this turn require a trusted-tier brain regardless of pins and failover? */
export function requiresTrustedBrain(
  userMessage: string,
  history: Anthropic.MessageParam[],
): Guard {
  if (config.routing?.enforceTrustedBrain === false) {
    return { required: false, reason: "guard disabled" };
  }
  if (historyIsTainted(history)) {
    return { required: true, reason: "history contains untrusted content" };
  }
  if (REACHES_OUT.some((re) => re.test(userMessage))) {
    return { required: true, reason: "this turn will read external content" };
  }
  return { required: false, reason: "no untrusted content in play" };
}

/** Brains cleared to handle hostile input. Defaults to the configured default brain. */
export function trustedBrainIds(): string[] {
  const listed = config.routing?.trustedBrains;
  if (Array.isArray(listed) && listed.length) return listed;
  return [defaultBrainId()];
}

export function isTrustedBrain(spec: BrainSpec): boolean {
  return trustedBrainIds().includes(spec.id);
}

/**
 * Apply the guard. Returns the brain that must actually be used, plus a note
 * when the choice was overridden so the HUD can say why.
 */
export function enforceGuard(
  chosen: BrainSpec,
  guard: Guard,
): { spec: BrainSpec; overridden: boolean } {
  if (!guard.required || isTrustedBrain(chosen)) return { spec: chosen, overridden: false };
  const all = catalog();
  const trusted = trustedBrainIds()
    .map((id) => all.find((b) => b.id === id))
    .find((b): b is BrainSpec => Boolean(b));
  if (!trusted) return { spec: chosen, overridden: false }; // nothing better available
  return { spec: trusted, overridden: true };
}
