import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { DEFAULT_MEMORY_BODY } from "./workspace.js";
import { catalog, defaultBrainId, brainHasKey, type BrainSpec } from "./brain.js";

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
  "check_email", "read_email",
  "check_whatsapp", "read_chat", "draft_chat", "send_chat",
  "http_request", "web_search", "clipboard", "read_file", "landscape",
  "look",
]);

/**
 * Any tool from a third-party MCP server returns bytes that server controls,
 * so every one of them taints the turn — the guard cannot know which are safe.
 * Every browser_* result is page content (snapshots included), so they all taint.
 */
function isUntrustedToolName(name: string): boolean {
  return (
    UNTRUSTED_TOOLS.has(name) ||
    name.startsWith("mcp__") ||
    name.startsWith("browser_") ||
    // Anything a second machine prints is a build log, a fetched repo, or some
    // package's README — other people's words, arriving on our machine. The
    // fence on the output taints the turn that READS it; this taints the turn
    // that calls, which is the one that can still be steered.
    name.startsWith("remote_")
  );
}

/**
 * Phrases whose turn will reach outside before it finishes.
 *
 * These fire *before* anything untrusted has arrived, so they have to catch the
 * request rather than the result. "open example.co.uk" matched none of the first
 * draft — no "http", no "browse" — and went to the cheap brain, which is the
 * exact turn the guard exists for.
 */
const REACHES_OUT = [
  /email|inbox|gmail|mail\b/i,
  /whatsapp|\bwa web\b/i,
  /browse|website|web ?page|url|https?:|search|look up|google/i,
  /screenshot|read the (page|screen)|what.*on (my |the )?screen/i,
  /webcam|how do I look|how(?:'s| is) the room|look at me\b|glance at (?:me|the room|the desk)/i,
  /clipboard|download|fetch\b/i,
  // A bare domain is a request to go and look at something.
  /\b[a-z0-9-]+\.(com|co\.uk|org|net|io|dev|ai|app|cloud|uk|me|xyz|pages\.dev|workers\.dev)\b/i,
  // Opening or visiting a named thing generally means the outside world.
  /\b(open|visit|go to|load|pull up|check)\b.{0,24}\b(site|page|link|tab|browser)\b/i,
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

/** Turns that cannot need a frontier model: no tools, no outside world. */
const TRIVIAL = [
  /^(what('s| is) the )?(time|date|day)\b/i,
  /^(hello|hi|hey|good (morning|afternoon|evening|night))\b/i,
  /^(thanks|thank you|cheers|ta)\b/i,
  /^(are you (there|awake|alive)|you there)\b/i,
  /^(set|start) a (timer|reminder)\b/i,
  /^(volume|mute|unmute|louder|quieter)\b/i,
  /^(system )?(status|telemetry|health)\b/i,
];

/**
 * Route down to the cheap brain when a turn plainly cannot need more.
 *
 * The guard above only ever forces *up*. Without this, a cheap brain is
 * configured, paid for, and never used — every "what's the time" costs the same
 * as hard reasoning. Deliberately conservative: only turns matching a known
 * trivial shape, on a clean history, and never the tainted ones.
 */
export function suggestCheapBrain(
  userMessage: string,
  history: Anthropic.MessageParam[],
  kind: "user" | "heartbeat",
): BrainSpec | null {
  if (kind === "heartbeat") return null;              // heartbeat has its own brain
  if (config.routing?.cheapWhenTrivial === false) return null;
  if (historyIsTainted(history)) return null;         // hostile text in the window
  if (userMessage.length > 120) return null;          // long asks are rarely trivial
  if (!TRIVIAL.some((re) => re.test(userMessage.trim()))) return null;

  const id = config.routing?.cheapBrain ?? "cheap";
  const spec = catalog().find((b) => b.id === id);
  if (!spec || !brainHasKey(spec)) return null;       // not configured — stay put
  return spec;
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
