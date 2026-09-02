import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

/**
 * The Keys page's engine — the easy-secrets place.
 *
 * Not everyone can open a terminal, and the retail tier depends on that being
 * fine: paste a key into a masked box on the HUD, it lands in .env, and the
 * machine uses it. The rules that make this safe rather than a hole:
 *
 *   - Only names on the roster below can be written. This endpoint must never
 *     become "set any environment variable" — PATH, LD_PRELOAD and NODE_OPTIONS
 *     are attack surface, not settings.
 *   - Values are one line, trimmed, quotes stripped, newlines refused — a value
 *     cannot smuggle a second .env entry in on its back.
 *   - Values are WRITE-ONLY. The API reports set/unset and the last four
 *     characters for recognition, never the value. The HUD shows "•••• 1234".
 *   - The write also lands in process.env, so anything that reads its key at
 *     call time (the brains do) works immediately. Things that listen from
 *     boot (the phone lines) are honest about needing a relight.
 */

export interface KeySpec {
  name: string;
  label: string;
  hint: string;
  /** "live" applies the moment it is saved; "restart" needs the claw relit. */
  applies: "live" | "restart";
}

export const KEY_ROSTER: KeySpec[] = [
  { name: "OPENROUTER_API_KEY", label: "OpenRouter key", applies: "live",
    hint: "One key, many models (Gemini and friends). Get one at openrouter.ai — starts sk-or-." },
  { name: "DRAGONFORGE_TOKEN", label: "Dragon Forge token", applies: "live",
    hint: "The Just Works subscription token — one token, no other setup." },
  { name: "GEMINI_API_KEY", label: "Google Gemini key", applies: "live",
    hint: "Straight from Google AI Studio (aistudio.google.com), no broker. Starts AIza." },
  { name: "OPENAI_API_KEY", label: "OpenAI key", applies: "live",
    hint: "Straight from platform.openai.com. Starts sk-." },
  { name: "ANTHROPIC_API_KEY", label: "Anthropic key", applies: "live",
    hint: "Straight from console.anthropic.com. Starts sk-ant-." },
  { name: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", applies: "restart",
    hint: "From @BotFather. Pair with the chat id below." },
  { name: "TELEGRAM_CHAT_ID", label: "Telegram chat id", applies: "restart",
    hint: "Message your bot /whoami and it tells you this number." },
  { name: "DISCORD_BOT_TOKEN", label: "Discord bot token", applies: "restart",
    hint: "From the Discord Developer Portal (Bot → Reset Token)." },
  { name: "DISCORD_ALLOWED_USER_ID", label: "Discord user id", applies: "restart",
    hint: "Your own Discord id — the only user the bot will obey." },
  { name: "REPLICATE_API_TOKEN", label: "Replicate token", applies: "live",
    hint: "For image, video and music generation. Starts r8_." },
  { name: "GITHUB_TOKEN", label: "GitHub token", applies: "live",
    hint: "A fine-grained PAT if you want the GitHub connector." },
];

const rosterByName = new Map(KEY_ROSTER.map((k) => [k.name, k]));

export function envPath(): string {
  return path.join(ROOT, ".env");
}

/** One value, one line: trims, strips wrapping quotes, refuses anything sneaky. */
export function cleanValue(raw: string): { ok: true; value: string } | { ok: false; why: string } {
  const v = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
  if (!v) return { ok: false, why: "The value is empty." };
  if (/[\r\n]/.test(v)) return { ok: false, why: "A key is one line — this has line breaks in it." };
  if (v.length > 512) return { ok: false, why: "That is far longer than any real key." };
  return { ok: true, value: v };
}

/** Pure: replace or append NAME=value in .env text, preserving everything else. */
export function upsertEnvLine(envText: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  if (re.test(envText)) return envText.replace(re, line);
  const sep = envText.length === 0 || envText.endsWith("\n") ? "" : "\n";
  return `${envText}${sep}${line}\n`;
}

/** Pure: drop NAME= from .env text. */
export function removeEnvLine(envText: string, name: string): string {
  return envText
    .split("\n")
    .filter((l) => !l.startsWith(`${name}=`))
    .join("\n");
}

export function listKeys(): Array<KeySpec & { set: boolean; tail: string }> {
  return KEY_ROSTER.map((spec) => {
    const v = process.env[spec.name]?.trim() ?? "";
    const looksReal = v.length > 0 && !/your-?key|placeholder|changeme|\.\.\.$/.test(v);
    return {
      ...spec,
      set: looksReal,
      tail: looksReal ? v.slice(-4) : "",
    };
  });
}

export function setKey(name: string, rawValue: string): { ok: boolean; message: string; applies?: "live" | "restart" } {
  const spec = rosterByName.get(name);
  if (!spec) return { ok: false, message: "That name is not on the key roster." };
  const cleaned = cleanValue(rawValue);
  if (!cleaned.ok) return { ok: false, message: cleaned.why };

  const p = envPath();
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  fs.writeFileSync(p, upsertEnvLine(existing, name, cleaned.value), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* windows */ }
  process.env[name] = cleaned.value;

  return {
    ok: true,
    applies: spec.applies,
    message: spec.applies === "live"
      ? `${spec.label} saved — working immediately.`
      : `${spec.label} saved — relight the claw to apply (restart the service or npm run dev).`,
  };
}

export function deleteKey(name: string): { ok: boolean; message: string } {
  const spec = rosterByName.get(name);
  if (!spec) return { ok: false, message: "That name is not on the key roster." };
  const p = envPath();
  if (fs.existsSync(p)) {
    fs.writeFileSync(p, removeEnvLine(fs.readFileSync(p, "utf-8"), name), { mode: 0o600 });
  }
  delete process.env[name];
  return { ok: true, message: `${spec.label} removed.` };
}
