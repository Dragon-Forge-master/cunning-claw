// Pure helpers for the Dragon Forge relay. No Worker APIs in here on purpose:
// everything in this file is a plain function of its arguments, which is what
// lets test.mjs exercise it under bare Node (type stripping, no build step) —
// the same trick the main codebase uses of injecting dependencies rather than
// importing them. Keep this file erasable-syntax only (no enums, no
// namespaces) or Node's strip-types loader will refuse it.

/** What we store in KV under `tok:<token>`. Minted by hand for now — see provision.md. */
export interface TokenRecord {
  plan: string;
  monthlyBudgetTokens: number;
  disabled?: boolean;
}

/**
 * Pull the token out of an Authorization header. Strict on the scheme but
 * case-insensitive, because OpenAI-compatible clients disagree on "Bearer"
 * vs "bearer" and rejecting the lowercase form is a support ticket, not a
 * security win.
 */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/**
 * Parse and validate a KV token record. Malformed JSON is treated the same as
 * a missing token: a record we cannot trust the shape of must not authorise
 * spend on the house key.
 */
export function parseTokenRecord(raw: string | null): TokenRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.plan !== "string") return null;
  if (typeof rec.monthlyBudgetTokens !== "number" || !Number.isFinite(rec.monthlyBudgetTokens)) {
    return null;
  }
  return {
    plan: rec.plan,
    monthlyBudgetTokens: rec.monthlyBudgetTokens,
    disabled: rec.disabled === true,
  };
}

/** "YYYY-MM" in UTC. UTC so the month rolls at the same instant for every customer. */
export function monthKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** KV key for a customer's usage counter this month. */
export function usageKey(token: string, now: Date): string {
  return `use:${token}:${monthKey(now)}`;
}

export const DEFAULT_MODELS = "google/gemini-3.5-flash-lite";

/**
 * The model allowlist from the MODELS env var (comma-separated). The default
 * is a cheap model on purpose: the relay spends the house OpenRouter key, so
 * an unlisted model is a customer running frontier-model bills on our card.
 */
export function parseModels(env: string | undefined): string[] {
  const raw = env && env.trim() ? env : DEFAULT_MODELS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isModelAllowed(model: unknown, allowed: string[]): boolean {
  return typeof model === "string" && allowed.includes(model);
}

/**
 * A request is refused once the counter has reached the budget. The check is
 * before the request, not after, so a customer can overshoot by at most one
 * request — acceptable for v1, and kinder than killing a stream mid-answer.
 */
export function isOverBudget(usedTokens: number, budgetTokens: number): boolean {
  return usedTokens >= budgetTokens;
}

/**
 * For streamed responses OpenRouter's usage object is buried in the SSE frames
 * and reading it would mean parsing message content, which the privacy
 * invariant forbids. Byte length / 4 is the standard rough tokens-per-byte
 * heuristic for English text; it overcounts SSE framing overhead, which errs
 * on the side of the house rather than the customer.
 */
export function estimateStreamedTokens(requestBytes: number, responseBytes: number): number {
  return Math.ceil((requestBytes + responseBytes) / 4);
}

/** Uniform short JSON error body, so the claw can show something human. */
export function errorBody(message: string): string {
  return JSON.stringify({ error: { message } });
}
