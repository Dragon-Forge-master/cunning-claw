import { config } from "./config.js";

export type BrainProvider = "anthropic" | "openai";

export type OpenAiBrain = {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
};

export function activeProvider(): BrainProvider {
  return config.brain?.provider === "openai" ? "openai" : "anthropic";
}

export function openAiBrain(): OpenAiBrain {
  const fromEnv = process.env.OPENAI_BASE_URL?.trim();
  const fromCfg = config.brain?.openai?.baseUrl;
  return {
    baseUrl: (fromEnv || fromCfg || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: config.brain?.openai?.model ?? "gpt-4o-mini",
    apiKeyEnv: config.brain?.openai?.apiKeyEnv ?? "OPENAI_API_KEY",
  };
}

export function brainLabel(): string {
  if (activeProvider() === "openai") {
    const o = openAiBrain();
    return `${o.model}`;
  }
  return config.model;
}

export function brainReady(): boolean {
  if (activeProvider() === "openai") {
    return Boolean(process.env[openAiBrain().apiKeyEnv]);
  }
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function missingKeyHint(): string {
  if (activeProvider() === "openai") {
    const env = openAiBrain().apiKeyEnv;
    return `No ${env} in .env. Set brain.provider to "openai" and add that key, or switch back to anthropic.`;
  }
  return "Copy .env.example to .env and add ANTHROPIC_API_KEY.";
}
