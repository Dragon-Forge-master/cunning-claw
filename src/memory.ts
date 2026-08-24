import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { appendMemoryMarkdown } from "./workspace.js";

const MEMORY_FILE = path.join(DATA_DIR, "memory.json");

export interface MemoryEntry {
  key: string;
  value: string;
  savedAt: string;
}

function load(): MemoryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function save(entries: MemoryEntry[]): void {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(entries, null, 2));
}

export function remember(key: string, value: string): string {
  const entries = load().filter((e) => e.key !== key);
  entries.push({ key, value, savedAt: new Date().toISOString() });
  save(entries);
  try {
    appendMemoryMarkdown(key, value);
  } catch { /* workspace file is best-effort */ }
  return `Stored memory "${key}".`;
}

export function forget(key: string): string {
  const entries = load();
  const next = entries.filter((e) => e.key !== key);
  if (next.length === entries.length) return `No memory found with key "${key}".`;
  save(next);
  return `Forgot memory "${key}".`;
}

export function recallAll(): MemoryEntry[] {
  return load();
}

export function memorySnapshot(): string {
  const entries = load();
  if (entries.length === 0) return "(no long-term memories stored yet)";
  return entries.map((e) => `- ${e.key}: ${e.value}`).join("\n");
}
