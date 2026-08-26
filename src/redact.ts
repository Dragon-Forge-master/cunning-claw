/**
 * Credential redaction.
 *
 * CUNNING CLAW writes every turn to data/history.json and broadcasts it over SSE.
 * Anything a user types, or that a tool returns, lands in both. Secrets reach
 * that path constantly in ordinary use — a pasted key, a config file read, an
 * `env` in a shell result, an Authorization header in an HTTP response.
 *
 * Patterns are matched by shape, not by knowing the issuer, so unfamiliar
 * formats still get caught by the generic assignment rules at the end.
 */

interface Rule {
  name: string;
  re: RegExp;
  replace: (m: string, ...groups: string[]) => string;
}

/** Keep a short prefix so a redaction is still identifiable in a transcript. */
function stub(label: string, sample: string, keep = 6): string {
  return `[${label}:${sample.slice(0, keep)}...REDACTED]`;
}

const RULES: Rule[] = [
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: (m) => stub("anthropic-key", m, 10) },
  { name: "openai", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replace: (m) => stub("openai-key", m, 6) },
  { name: "openrouter", re: /\bsk-or-v1-[A-Za-z0-9]{16,}/g, replace: (m) => stub("openrouter-key", m, 9) },
  { name: "github", re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: (m) => stub("github-token", m, 4) },
  { name: "github-fine", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: (m) => stub("github-pat", m, 11) },
  { name: "google-oauth", re: /\bAQ\.[A-Za-z0-9_-]{20,}/g, replace: (m) => stub("google-token", m, 6) },
  { name: "google-refresh", re: /\b1\/\/[A-Za-z0-9_-]{20,}/g, replace: (m) => stub("google-refresh", m, 4) },
  { name: "google-api", re: /\bAIza[A-Za-z0-9_-]{30,}/g, replace: (m) => stub("google-api-key", m, 4) },
  { name: "aws", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: (m) => stub("aws-key", m, 4) },
  { name: "slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: (m) => stub("slack-token", m, 5) },
  { name: "stripe", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: (m) => stub("stripe-key", m, 8) },
  { name: "telegram-bot", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, replace: (m) => stub("telegram-token", m, 6) },
  { name: "jwt", re: /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: (m) => stub("jwt", m, 6) },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => "[private-key:REDACTED]" },

  // Generic shapes, so an unrecognised provider is not simply missed.
  { name: "bearer", re: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/gi, replace: (_m, p) => `${p}[REDACTED]` },
  { name: "env-assign",
    re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"'`,;]{12,})\3/g,
    replace: (_m, k, sep, q) => `${k}${sep}${q}[REDACTED]${q}` },
  { name: "json-field",
    re: /("(?:[a-z_]*(?:api[_-]?key|token|secret|password|authorization)[a-z_]*)"\s*:\s*")([^"]{12,})(")/gi,
    replace: (_m, a, _b, c) => `${a}[REDACTED]${c}` },
];

/** Redact credentials from free text. Safe to run repeatedly. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, rule.replace as any);
  return out;
}

/** True if redaction would change anything — used to warn the operator. */
export function containsSecret(text: string): boolean {
  return Boolean(text) && redact(text) !== text;
}

/** Recursively redact any string inside a structure (message content blocks). */
/**
 * Fields holding binary payloads rather than prose. Redacting one corrupts it:
 * a screenshot's base64 will eventually contain a run that looks like a token,
 * and replacing part of it produces an image the API rejects — poisoning every
 * subsequent turn in that conversation, permanently. Base64 cannot meaningfully
 * hide a credential from a reader anyway.
 */
const BINARY_FIELDS = new Set(["data", "base64", "bytes", "buffer"]);

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = BINARY_FIELDS.has(k) ? v : redactDeep(v);
    }
    return out as T;
  }
  return value;
}

/** Would this survive the API's ASCII check on base64 payloads? */
export function isCleanBase64(s: unknown): boolean {
  return typeof s === "string" && /^[A-Za-z0-9+/=\r\n]*$/.test(s);
}
