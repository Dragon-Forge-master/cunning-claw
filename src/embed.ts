import { redact } from "./redact.js";

/**
 * Embeddings — the half of memory search that understands meaning.
 *
 * Keyword search cannot find "mobile paint repair in Pontypridd" from "the car
 * spraying job"; a vector can. This module turns text into vectors over plain
 * fetch (no SDK: two runtime dependencies is a rule) for whichever provider the
 * operator has keyed, and knows nothing about memory itself — memory.ts owns
 * the cache and the ranking. It imports only redact.ts and stays a leaf, so
 * the live wiring (config, the brain catalog, keys) is passed in, not imported.
 *
 * Privacy: memory text leaves the machine only for a provider the operator has
 * keyed (Gemini, OpenRouter); with Ollama nothing leaves the machine.
 */

export type EmbedProvider = "gemini" | "openrouter" | "ollama";
export type EmbedSetting = "auto" | EmbedProvider | "off";
/** Retrieval models embed a question and a stored fact differently. */
export type EmbedKind = "document" | "query";

export interface EmbedSpec {
  provider: EmbedProvider;
  model: string;
  /** Required for the cloud providers; ignored by Ollama. */
  apiKey?: string;
  /** Ollama's server root, e.g. http://127.0.0.1:11434 (no /v1). */
  baseUrl?: string;
  /** Whole-call deadline, every batch included. */
  timeoutMs?: number;
}

export interface Embedder {
  provider: EmbedProvider;
  model: string;
  /**
   * Cache identity. A vector is only comparable with vectors from the same
   * model at the same size, so a change here invalidates every stored vector.
   */
  id: string;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

export const DEFAULT_MODELS: Record<EmbedProvider, string> = {
  // text-embedding-004 was retired; gemini-embedding-001 is the current one.
  gemini: "gemini-embedding-001",
  // OpenRouter does serve embeddings (OpenAI-shaped, /api/v1/embeddings).
  openrouter: "openai/text-embedding-3-small",
  ollama: "nomic-embed-text",
};

/** Gemini can truncate its 3072 dimensions; 768 keeps the cache file small. */
const GEMINI_DIMENSIONS = 768;
/** batchEmbedContents refuses more than 100 requests. */
const BATCH = { gemini: 100, openrouter: 100, ollama: 64 } as const;
const DEFAULT_TIMEOUT_MS = 8000;
/**
 * After a failure, fail fast for a while. A stopped Ollama or a revoked key
 * would otherwise add the whole timeout to every memory search; keyword search
 * carries on alone until the cooldown lapses.
 */
export const FAILURE_COOLDOWN_MS = 60_000;

/**
 * Where "related" starts, per provider. Cosine scales differ by model — Gemini
 * scores unrelated sentences near 0.5, OpenAI's small model near 0.1 — so one
 * number cannot serve all three. Rough starting points, not measurements of
 * this operator's memories; `memory.minSimilarity` overrides them.
 */
export const DEFAULT_MIN_SIMILARITY: Record<EmbedProvider, number> = {
  gemini: 0.6,
  openrouter: 0.3,
  ollama: 0.5,
};

/** Thrown inside the cooldown, so callers can log the failure once and not every search after it. */
export class EmbedCooldownError extends Error {}

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const OLLAMA_BASE = "http://127.0.0.1:11434";

export interface ChooseFacts {
  geminiKey?: string;
  openrouterKey?: string;
  /** An Ollama the operator has pointed a brain at, or set under memory. */
  ollamaUrl?: string;
  /** The default brain runs locally: an offline install should stay offline. */
  preferLocal?: boolean;
  model?: string;
  timeoutMs?: number;
}

/**
 * Which provider, if any. Explicit settings are obeyed but never invented — a
 * cloud provider without a key is no provider. "auto" keeps an install whose
 * default brain is local on Ollama, and otherwise uses the first keyed cloud
 * provider (memory already rides to that provider in every system prompt, so
 * embedding it there exposes nothing new), then a configured Ollama.
 */
export function chooseEmbedding(setting: EmbedSetting | undefined, facts: ChooseFacts): EmbedSpec | null {
  const want = setting ?? "auto";
  if (want === "off") return null;
  const gemini = (): EmbedSpec | null => facts.geminiKey ? { provider: "gemini", model: "", apiKey: facts.geminiKey } : null;
  const openrouter = (): EmbedSpec | null => facts.openrouterKey ? { provider: "openrouter", model: "", apiKey: facts.openrouterKey } : null;
  const ollama = (): EmbedSpec => ({ provider: "ollama", model: "", baseUrl: facts.ollamaUrl || OLLAMA_BASE });

  let spec: EmbedSpec | null;
  if (want === "gemini") spec = gemini();
  else if (want === "openrouter") spec = openrouter();
  else if (want === "ollama") spec = ollama();
  else if (facts.preferLocal) spec = ollama();
  else spec = gemini() ?? openrouter() ?? (facts.ollamaUrl ? ollama() : null);
  if (!spec) return null;
  spec.model = facts.model || DEFAULT_MODELS[spec.provider];
  if (facts.timeoutMs) spec.timeoutMs = facts.timeoutMs;
  return spec;
}

/** An OpenAI-compatible brain URL (…:11434/v1) to Ollama's native root. */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function embedderId(spec: EmbedSpec): string {
  const dims = spec.provider === "gemini" ? `@${GEMINI_DIMENSIONS}` : "";
  return `${spec.provider}:${spec.model}${dims}`;
}

/** nomic-embed-text was trained with task prefixes and is noticeably worse without them. */
function ollamaPrefix(model: string, kind: EmbedKind): string {
  if (!/nomic/i.test(model)) return "";
  return kind === "query" ? "search_query: " : "search_document: ";
}

function vectors(raw: unknown, want: number): number[][] {
  if (!Array.isArray(raw) || raw.length !== want) {
    throw new Error(`expected ${want} vectors, got ${Array.isArray(raw) ? raw.length : typeof raw}`);
  }
  for (const v of raw) {
    if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
      throw new Error("a returned vector was not a list of numbers");
    }
  }
  return raw as number[][];
}

async function postJson(doFetch: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<any> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* body unreadable */ }
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

/**
 * One provider, batched, under one deadline, with a failure cooldown. Throws on
 * any failure — the caller decides what "fall back" means. Text bound for a
 * cloud provider goes through redact() first: this is a place text leaves the
 * machine, and a pasted key in a memory has no business in an embeddings log.
 */
export function makeEmbedder(spec: EmbedSpec, doFetch: typeof fetch = fetch, now: () => number = Date.now): Embedder {
  let coolUntil = 0;
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function batch(texts: string[], kind: EmbedKind, signal: AbortSignal): Promise<number[][]> {
    if (spec.provider === "gemini") {
      const url = `${GEMINI_BASE}/models/${encodeURIComponent(spec.model)}:batchEmbedContents`;
      const json = await postJson(doFetch, url, { "x-goog-api-key": spec.apiKey ?? "" }, {
        requests: texts.map((text) => ({
          model: `models/${spec.model}`,
          content: { parts: [{ text: redact(text) }] },
          taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          outputDimensionality: GEMINI_DIMENSIONS,
        })),
      }, signal);
      return vectors(Array.isArray(json?.embeddings) ? json.embeddings.map((e: any) => e?.values) : json?.embeddings, texts.length);
    }
    if (spec.provider === "openrouter") {
      const json = await postJson(doFetch, `${OPENROUTER_BASE}/embeddings`, { Authorization: `Bearer ${spec.apiKey ?? ""}` }, {
        model: spec.model,
        input: texts.map((t) => redact(t)),
      }, signal);
      const rows = Array.isArray(json?.data) ? [...json.data].sort((a: any, b: any) => (a?.index ?? 0) - (b?.index ?? 0)) : json?.data;
      return vectors(Array.isArray(rows) ? rows.map((r: any) => r?.embedding) : rows, texts.length);
    }
    // Ollama is on this machine (or the operator's own network), so the text
    // is sent as written — nothing to redact it from.
    const prefix = ollamaPrefix(spec.model, kind);
    const json = await postJson(doFetch, `${ollamaRoot(spec.baseUrl || OLLAMA_BASE)}/api/embed`, {}, {
      model: spec.model,
      input: texts.map((t) => prefix + t),
    }, signal);
    return vectors(json?.embeddings, texts.length);
  }

  return {
    provider: spec.provider,
    model: spec.model,
    id: embedderId(spec),
    async embed(texts, kind) {
      if (!texts.length) return [];
      if (now() < coolUntil) throw new EmbedCooldownError(`${spec.provider} embeddings cooling down after a failure`);
      const signal = AbortSignal.timeout(timeoutMs);
      const size = BATCH[spec.provider];
      const out: number[][] = [];
      try {
        for (let i = 0; i < texts.length; i += size) out.push(...await batch(texts.slice(i, i + size), kind, signal));
      } catch (err) {
        coolUntil = now() + FAILURE_COOLDOWN_MS;
        throw err;
      }
      return out;
    },
  };
}

/** Plain cosine similarity. Zero for mismatched or empty vectors rather than NaN. */
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
