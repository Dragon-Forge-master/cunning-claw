import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

// Load .env before anything else reads process.env (the Anthropic client is
// constructed at module import time, so this must happen first).
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let value = m[2];
    const quoted = value.startsWith('"') || value.startsWith("'");
    if (!quoted) value = value.replace(/\s+#.*$/, "");
    process.env[m[1]] = value.replace(/^["']|["']$/g, "");
  }
}
export const DATA_DIR = path.join(ROOT, "data");

export interface JarvisConfig {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  persona: { name: string; addressUserAs: string; userName: string };
  history: { maxMessages: number; persist: boolean };
  webSearch: { enabled: boolean; maxUses: number };
  commandPolicy: {
    autoApprovePatterns: string[];
    denyPatterns: string[];
    timeoutMs: number;
    approvalTimeoutMs: number;
  };
  voice: {
    enabled: boolean;
    engine: "auto" | "piper" | "spd-say";
    maxChars: number;
    piper: {
      model: string;
      player: string;
      sampleRate: number;
      lengthScale: number;
      noiseScale: number;
      noiseWScale: number;
      sentenceSilence: number;
      volume: number;
    };
    spd: {
      language: string;
      voiceName: string;
      rate: number;
      pitch: number;
      volume: number;
    };
  };
  browser: {
    enabled: boolean;
    binary: string;
    debugPort: number;
    timeoutMs: number;
    extraFlags: string[];
    requireApprovalFor: string[];
  };
  desktop: {
    enabled: boolean;
    maxImageWidth: number;
    requireApprovalFor: string[];
  };
  http: { allowlist: string[]; timeoutMs: number; maxResponseChars: number };
  homeAssistant: { enabled: boolean; baseUrl: string; tokenEnv: string };
  coherence: { ouroborosLimit: number; maxIterations: number };
  server: { port: number; host: string };
}

export const config: JarvisConfig = JSON.parse(
  fs.readFileSync(path.join(ROOT, "jarvis.config.json"), "utf-8"),
);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
