import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { config, DATA_DIR } from "./config.js";

export type BrainProvider = "anthropic" | "openai";

export type BrainSpec = {
  id: string;
  label: string;
  provider: BrainProvider;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Anthropic adaptive thinking. Off for cheap/heartbeat brains. */
  thinking?: boolean;
  baseUrl?: string;
  apiKeyEnv?: string;
};

export type BrainKind = "user" | "heartbeat";

const PIN_FILE = path.join(DATA_DIR, "brain-pin.json");

let pinId: string | null = loadPin();

function loadPin(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(PIN_FILE, "utf-8"));
    return typeof raw?.id === "string" ? raw.id : null;
  } catch {
    return null;
  }
}

function savePin(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!pinId) {
    try { fs.unlinkSync(PIN_FILE); } catch { /* absent */ }
    return;
  }
  fs.writeFileSync(PIN_FILE, JSON.stringify({ id: pinId }, null, 2));
}

function normalize(raw: any, fallbackId: string): BrainSpec {
  const provider: BrainProvider = raw?.provider === "openai" ? "openai" : "anthropic";
  const id = String(raw?.id ?? fallbackId).toLowerCase().replace(/[^a-z0-9-]/g, "") || fallbackId;
  return {
    id,
    label: String(raw?.label ?? id),
    provider,
    model: String(raw?.model ?? (provider === "openai" ? "gpt-4o-mini" : config.model)),
    effort: raw?.effort,
    maxTokens: typeof raw?.maxTokens === "number" ? raw.maxTokens : undefined,
    thinking: raw?.thinking,
    baseUrl: raw?.baseUrl,
    apiKeyEnv: raw?.apiKeyEnv,
  };
}

/** Catalog from config, or a single brain synthesised from the legacy keys. */
export function catalog(): BrainSpec[] {
  const listed = config.brains?.catalog;
  if (Array.isArray(listed) && listed.length) {
    const seen = new Set<string>();
    const out: BrainSpec[] = [];
    for (const row of listed) {
      const spec = normalize(row, "brain");
      if (seen.has(spec.id)) continue;
      seen.add(spec.id);
      out.push(spec);
    }
    if (out.length) return out;
  }
  const provider: BrainProvider = config.brain?.provider === "openai" ? "openai" : "anthropic";
  return [normalize({
    id: "core",
    label: "Core",
    provider,
    model: provider === "openai" ? (config.brain?.openai?.model ?? "gpt-4o-mini") : config.model,
    effort: config.effort,
    maxTokens: config.maxTokens,
    thinking: provider === "anthropic",
    baseUrl: config.brain?.openai?.baseUrl,
    apiKeyEnv: config.brain?.openai?.apiKeyEnv,
  }, "core")];
}

export function getBrain(id: string): BrainSpec | undefined {
  const want = id.trim().toLowerCase();
  return catalog().find((b) => b.id === want || b.label.toLowerCase() === want);
}

export function defaultBrainId(): string {
  return config.brains?.default ?? catalog()[0]?.id ?? "core";
}

export function heartbeatBrainId(): string {
  return config.brains?.heartbeat ?? defaultBrainId();
}

export function fallbackIds(): string[] {
  return config.brains?.fallbacks ?? [];
}

export function pinnedBrainId(): string | null {
  return pinId && getBrain(pinId) ? pinId : null;
}

export function pinBrain(id: string | null): string {
  if (!id) {
    pinId = null;
    savePin();
    return "Brain pin cleared. Routing is automatic again.";
  }
  const spec = getBrain(id);
  if (!spec) {
    return `No brain named "${id}". Known: ${catalog().map((b) => b.id).join(", ")}.`;
  }
  pinId = spec.id;
  savePin();
  return `Pinned to ${spec.label} (${spec.provider} / ${spec.model}). Heartbeat still uses ${heartbeatBrainId()}. Fallbacks will not fire while pinned.`;
}

export function brainHasKey(spec: BrainSpec): boolean {
  if (spec.provider === "openai") {
    return Boolean(process.env[spec.apiKeyEnv ?? "OPENAI_API_KEY"]);
  }
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function openAiEndpoint(spec: BrainSpec): { baseUrl: string; model: string; apiKeyEnv: string } {
  const envUrl = process.env.OPENAI_BASE_URL?.trim();
  return {
    baseUrl: (spec.baseUrl || envUrl || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: spec.model,
    apiKeyEnv: spec.apiKeyEnv ?? "OPENAI_API_KEY",
  };
}

function uniqueSpecs(ids: string[]): BrainSpec[] {
  const seen = new Set<string>();
  const out: BrainSpec[] = [];
  for (const id of ids) {
    const spec = getBrain(id);
    if (!spec || seen.has(spec.id)) continue;
    seen.add(spec.id);
    out.push(spec);
  }
  return out;
}

/**
 * Ordered brains for a turn.
 * Heartbeat ignores the conversation pin (OpenClaw heartbeatModel).
 * A user pin is strict — no silent fallback.
 */
export function brainChain(kind: BrainKind): BrainSpec[] {
  if (kind === "user" && pinnedBrainId()) {
    return uniqueSpecs([pinnedBrainId()!]);
  }
  const primary = kind === "heartbeat" ? heartbeatBrainId() : defaultBrainId();
  return uniqueSpecs([primary, ...fallbackIds(), defaultBrainId()]);
}

export function pickBrain(kind: BrainKind): BrainSpec {
  const chain = brainChain(kind);
  const ready = chain.filter(brainHasKey);
  if (ready.length) return ready[0];
  if (chain.length) return chain[0];
  return catalog()[0];
}

export function nextBrain(current: BrainSpec, kind: BrainKind): BrainSpec | null {
  if (kind === "user" && pinnedBrainId()) return null;
  const chain = brainChain(kind).filter(brainHasKey);
  const idx = chain.findIndex((b) => b.id === current.id);
  if (idx < 0) return chain[0] ?? null;
  return chain[idx + 1] ?? null;
}

export function isFailoverError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIError) {
    const s = err.status ?? 0;
    return s === 401 || s === 403 || s === 408 || s === 429 || s >= 500;
  }
  if (err instanceof Error) {
    const m = err.message;
    if (/rate limit|overloaded|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(m)) return true;
    if (/OpenAI-compatible API (401|402|403|408|429|5\d\d)/.test(m)) return true;
    if (/Missing \S+ for the OpenAI/.test(m)) return true;
    if (/authentication method|invalid.*api.?key/i.test(m)) return true;
  }
  return false;
}

export function describeBrain(spec: BrainSpec): string {
  return `${spec.label} (${spec.provider} / ${spec.model})`;
}

export function catalogStatus() {
  const active = pickBrain("user");
  return {
    pin: pinnedBrainId(),
    default: defaultBrainId(),
    heartbeat: heartbeatBrainId(),
    fallbacks: fallbackIds(),
    active: {
      id: active.id,
      label: active.label,
      provider: active.provider,
      model: active.model,
      ready: brainHasKey(active),
      source: pinnedBrainId() ? "pin" : "auto",
    },
    catalog: catalog().map((b) => ({
      id: b.id,
      label: b.label,
      provider: b.provider,
      model: b.model,
      ready: brainHasKey(b),
    })),
  };
}

export function formatCatalog(): string {
  const pin = pinnedBrainId();
  const lines = catalog().map((b) => {
    const tags = [
      b.id === defaultBrainId() ? "default" : "",
      b.id === heartbeatBrainId() ? "heartbeat" : "",
      pin === b.id ? "PINNED" : "",
      brainHasKey(b) ? "key" : "NO KEY",
    ].filter(Boolean);
    return `- ${b.id}: ${describeBrain(b)} [${tags.join(", ")}]`;
  });
  return `Brains (same tools, different models):\n${lines.join("\n")}\n/brain <id> pins a conversation brain. /brain auto clears the pin. Heartbeat always uses ${heartbeatBrainId()}.`;
}

/** Intercept /brain commands so they never spend a model call. */
export function applyBrainCommand(text: string): string | null {
  const trimmed = text.trim();
  const m = /^\/brain(?:\s+(\S+))?$/i.exec(trimmed);
  if (!m) return null;
  const arg = (m[1] ?? "").toLowerCase();
  if (!arg || arg === "list" || arg === "status") return formatCatalog();
  if (arg === "auto" || arg === "clear" || arg === "off") return pinBrain(null);
  return pinBrain(arg);
}

export function bootBrainLines(): string[] {
  return catalog().map((b) => {
    const role = [
      b.id === defaultBrainId() ? "default" : "",
      b.id === heartbeatBrainId() ? "heartbeat" : "",
    ].filter(Boolean).join("+") || "standby";
    return `  Brain ${b.id}: ${describeBrain(b)} — ${role} — ${brainHasKey(b) ? "key present" : "NO KEY"}`;
  });
}

// ---------------------------------------------------------------------------
// Back-compat shims used by older call sites / tests
// ---------------------------------------------------------------------------

export function activeProvider(): BrainProvider {
  return pickBrain("user").provider;
}

export function brainLabel(): string {
  return pickBrain("user").model;
}

export function brainReady(): boolean {
  return catalog().some(brainHasKey);
}

export function missingKeyHint(): string {
  const missing = catalog().filter((b) => !brainHasKey(b));
  if (!missing.length) return "A key is present but the provider refused it.";
  return missing.map((b) => {
    const env = b.provider === "openai" ? (b.apiKeyEnv ?? "OPENAI_API_KEY") : "ANTHROPIC_API_KEY";
    return `${b.id} needs ${env}`;
  }).join("; ") + ". Copy .env.example to .env.";
}

/** @deprecated use openAiEndpoint(spec) */
export function openAiBrain() {
  const spec = catalog().find((b) => b.provider === "openai") ?? pickBrain("user");
  return openAiEndpoint(spec);
}
