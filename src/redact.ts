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
 *
 * It is also where the operator's home directory collapses to "~", because
 * this is the one function every sink already calls — broadcast, the phone
 * lines, the journal, history.json. This module stays a leaf: it reads the
 * home from node:os, never from config.ts.
 */

import os from "node:os";

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
  // Replicate tokens sailed straight through this list once — into a config
  // file, the history, and a day's journal. Never again.
  { name: "replicate", re: /\br8_[A-Za-z0-9]{16,}/g, replace: (m) => stub("replicate-token", m, 3) },
  { name: "huggingface", re: /\bhf_[A-Za-z0-9]{16,}/g, replace: (m) => stub("huggingface-token", m, 3) },
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

  // Passwords said in words. The operator typed a sudo password into the chat
  // because the assistant asked for it, and it went into the journal and the
  // model history verbatim: env-assign above wants capitals, "=" or ":" and 12
  // characters, and a human says "my password is hunter2x".
  ...passwordRules(),
];

/**
 * Natural-language password disclosures.
 *
 * The trade-off: "password" is an ordinary English word, and the same text
 * that carries a disclosure also carries "reset my password", "the password
 * field", "sudo: a password is required". Over-redaction is the safe failure —
 * a lost word in a transcript costs nothing, a leaked password costs the
 * machine — but a rule that fires on every mention of the word makes the
 * transcript unreadable and trains the operator to ignore the marker. So each
 * shape demands evidence in proportion to how weak its grammar is:
 *
 *  - "password: X", "pw = X", "--password=X", `"password": "X"` — a separator
 *    straight after the word is a strong signal; any value is taken unless it
 *    is a common word ("Password: required") or a placeholder ("${DB_PASS}",
 *    "****"), which must pass so an env reference is never refused as a secret.
 *  - "my/the/sudo password is X" — "is" is weak on its own ("a strong password
 *    is important"), so an owner or system word must come first, and X must
 *    not be a common word ("the password is incorrect").
 *  - "sudo password X" — no verb at all, so X must also look like a secret:
 *    four or more characters with a digit or symbol in it. "the password
 *    field" and "the password manager" stay; "root password hunter2x" goes.
 *
 * Knowingly missed: an all-letters password with no verb ("my password
 * sunshine"), a password that is itself one of the common words below, and a
 * password sent as a whole message with no words round it — that last one is
 * only recognisable from the question before it, which this function cannot
 * see. The whole token is replaced, trailing punctuation included, because a
 * full stop might be part of the password and a lost one costs nothing.
 */
function passwordRules(): Rule[] {
  const KW = String.raw`(?:pass(?:word|wd|phrase)|pw)`;
  const OWNER = String.raw`(?:my|your|our|his|her|their|the|this|that|sudo|root|admin|administrator|` +
    String.raw`wifi|wi-fi|login|user|account|new|old|current|temporary|temp|default|master|ssh|db|database)`;
  const FOR = String.raw`(?:[ \t]+for[ \t]+[\w.@-]+)?`;
  // A quoted value may hold spaces; a bare one ends at whitespace. Never
  // re-match a marker, so a second pass changes nothing.
  const VALUE = String.raw`(?!["'\x60]?\[[^\]\s]*REDACTED\])("[^"\n]+"|'[^'\n]+'|\x60[^\x60\n]+\x60|[^\s"'\x60]+)`;

  const replaceWith = (strict: boolean) => (m: string, lead: string, value: string) => {
    const quoted = /^["'\x60]/.test(value);
    const core = value.replace(/^[(\["'\x60]+|[.,;:!?)\]"'\x60]+$/g, "");
    if (!core || COMMON.has(core.toLowerCase()) || PLACEHOLDER.test(core)) return m;
    if (strict && !(core.length >= 4 && /[^A-Za-z]/.test(core))) return m;
    return quoted ? `${lead}${value[0]}[REDACTED]${value[0]}` : `${lead}[REDACTED]`;
  };

  return [
    { name: "password-assign",
      // Not after "/" or ".", so "/etc/passwd: Permission denied" is a path,
      // not a disclosure. [ \t] rather than \s: a "Password:" label must not
      // reach across a newline and take the next line's first word.
      re: new RegExp(String.raw`(?<![\w./\\])((?:[A-Za-z0-9]+[_-])*${KW}${FOR}["']?[ \t]*[=:][ \t]*)${VALUE}`, "gi"),
      replace: replaceWith(false) as Rule["replace"] },
    { name: "password-said",
      re: new RegExp(String.raw`(\b${OWNER}[ \t]+(?:${OWNER}[ \t]+)*${KW}${FOR}[ \t]+(?:is|was)[ \t]*:?[ \t]*)${VALUE}`, "gi"),
      replace: replaceWith(false) as Rule["replace"] },
    { name: "password-bare",
      re: new RegExp(String.raw`(\b${OWNER}[ \t]+${KW}[ \t]+)${VALUE}`, "gi"),
      replace: replaceWith(true) as Rule["replace"] },
  ];
}

/** Env references, masks and angle-bracket placeholders are not secrets. */
const PLACEHOLDER = /^(?:\$\{?\w+\}?|%\w+%|<[^>]*>|[*•]+|x{3,})$/i;

/**
 * Words that follow "password is" / "password:" in ordinary prose and tool
 * output. A Set so a new false positive from the field is a one-word fix.
 */
const COMMON = new Set([
  "a", "an", "the", "is", "was", "not", "no", "none", "null", "nil", "undefined", "true", "false",
  "required", "needed", "incorrect", "wrong", "invalid", "correct", "right", "too", "set", "unset",
  "expired", "empty", "blank", "missing", "still", "now", "being", "been", "stored", "saved",
  "changed", "reset", "weak", "strong", "secure", "insecure", "important", "same", "different",
  "in", "on", "at", "for", "to", "of", "what", "that", "this", "it", "also", "only", "very", "just",
  "hidden", "encrypted", "hashed", "sent", "visible", "shown", "ok", "okay", "fine", "good", "bad",
  "long", "short", "unknown", "sorry", "authentication", "updated", "protected", "prompt", "please",
  "and", "or", "but", "here", "there", "below", "above", "optional", "mandatory", "case-sensitive",
  "password", "passwd", "manager", "field", "should", "must", "will", "can", "cannot", "never",
]);

/**
 * The home directory, collapsed to "~" wherever it starts a path.
 *
 * CLAUDE.md's rule is that the home directory never reaches the glass, but only
 * one tool result applied it, so the assistant's own replies and every other
 * tool result carried full home paths — and the username in them — to the HUD,
 * the voice, both phones and the journal. Doing it here covers every sink.
 *
 * Only a path *start* is taken: not after a name character, "." or a
 * separator, so /mnt/backup/home/<user> is left alone, and file:// is the one
 * prefix allowed through. Not before a name character either, so a lookalike
 * such as /home/<user>x or /home/<user>.bak is someone else's directory.
 * Windows homes match either separator (and the doubled backslash of JSON
 * inside text), case-insensitively, because Windows paths are.
 */
function homePattern(home: string): RegExp | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const trimmed = home.replace(/[\\/]+$/, "");
  const lead = String.raw`(?:(?<=file:\/\/\/?)|(?<![\p{L}\p{N}_.\/\\~]))`;
  const tail = String.raw`(?![\p{L}\p{N}_\-]|\.[\p{L}\p{N}_\-])`;
  const drive = /^([A-Za-z]):[\\/]/.exec(trimmed);
  if (drive) {
    const parts = trimmed.slice(3).split(/[\\/]+/).filter(Boolean);
    // A bare drive root as "home" would collapse every path on the disk.
    if (!parts.length) return null;
    const sep = String.raw`(?:\\{1,2}|\/)`;
    return new RegExp(`${lead}${drive[1]}:${sep}${parts.map(esc).join(sep)}${tail}`, "giu");
  }
  // "/" or "" is a service account with no real home; collapsing it would
  // turn every absolute path into "~".
  if (!trimmed.startsWith("/") || trimmed.split("/").filter(Boolean).length === 0) return null;
  return new RegExp(`${lead}${esc(trimmed)}${tail}`, "gu");
}

function currentHome(): string {
  try {
    return os.homedir();
  } catch {
    // No HOME and no passwd entry: nothing to collapse, and redact must never throw.
    return "";
  }
}

const HOME = currentHome();
const homePatterns = new Map<string, RegExp | null>();

/** Collapse `home` to "~" at every path start in `text`. */
export function collapseHomeIn(text: string, home: string = HOME): string {
  if (!text || !home) return text;
  if (!homePatterns.has(home)) homePatterns.set(home, homePattern(home));
  const re = homePatterns.get(home);
  return re ? text.replace(re, "~") : text;
}

function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, rule.replace as any);
  return out;
}

/**
 * Redact credentials from free text and collapse the home directory. Safe to
 * run repeatedly. `home` is a parameter so tests can stand in for the
 * operator's; every caller in the product takes the default.
 */
export function redact(text: string, home: string = HOME): string {
  if (!text) return text;
  return collapseHomeIn(redactSecrets(text), home);
}

/**
 * True if the text holds a credential — used to warn the operator and to
 * refuse an mcp.json snippet. Deliberately blind to the home collapse: a path
 * under ~ is private, not secret, and an MCP entry naming one is correct.
 */
export function containsSecret(text: string): boolean {
  return Boolean(text) && redactSecrets(text) !== text;
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

export function redactDeep<T>(value: T, home: string = HOME): T {
  if (typeof value === "string") return redact(value, home) as unknown as T;
  // Not .map(redactDeep): map would hand the array index in as `home`.
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, home)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = BINARY_FIELDS.has(k) ? v : redactDeep(v, home);
    }
    return out as T;
  }
  return value;
}

/** Would this survive the API's ASCII check on base64 payloads? */
export function isCleanBase64(s: unknown): boolean {
  return typeof s === "string" && /^[A-Za-z0-9+/=\r\n]*$/.test(s);
}

/**
 * A password typed as the whole answer to a question about one. On 8 Sept
 * the claw asked for the operator's sudo password and the reply was the
 * password alone: no words around it, so no pattern above could know it was
 * a secret. Only the question gives it away. When the last thing the claw
 * said asks for a password (or passphrase, PIN, passcode) and the reply is a
 * single short token that is not an ordinary answer, the reply is treated as
 * the secret. The doctrine forbids asking in the first place; this is for
 * when a weak brain asks anyway.
 */
const ASKS_FOR_SECRET = /\b(password|passphrase|passcode|pin code|pin|sudo)\b/i;
const ORDINARY_ANSWER = /^(y|n|yes|no|nope|ok|okay|sure|done|cancel|stop|skip|later|thanks|cheers|continue|go|carry on|and|what|why|how|sorry)[.!?]*$/i;

export function isSecretReply(previousAssistant: string, reply: string): boolean {
  const r = reply.trim();
  if (!ASKS_FOR_SECRET.test(previousAssistant)) return false;
  if (!r || /\s/.test(r) || r.length < 4 || r.length > 128) return false;
  if (ORDINARY_ANSWER.test(r)) return false;
  return true;
}
