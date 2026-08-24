import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

export const WORKSPACE = path.join(ROOT, "workspace");

const CORE_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "HEARTBEAT.md", "MEMORY.md"] as const;

export type SkillMeta = { name: string; description: string; dir: string };

function readIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

export function workspaceSnapshot(maxChars = 3500): string {
  const parts: string[] = [];
  for (const name of CORE_FILES) {
    const body = readIfExists(path.join(WORKSPACE, name));
    if (!body) continue;
    const clipped = body.length > 800 ? body.slice(0, 800) + "\n…(truncated, read the file)" : body;
    parts.push(`## ${name}\n${clipped}`);
  }
  const blob = parts.join("\n\n");
  return blob.length > maxChars ? blob.slice(0, maxChars) + "\n…" : blob;
}

export function readHeartbeat(): string {
  return readIfExists(path.join(WORKSPACE, "HEARTBEAT.md")) || "(no HEARTBEAT.md)";
}

function parseFrontmatter(raw: string): { name: string; description: string; body: string } | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const name = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) return null;
  return { name, description, body: m[2].trim() };
}

export function listSkills(): SkillMeta[] {
  const root = path.join(WORKSPACE, "skills");
  if (!fs.existsSync(root)) return [];
  const skills: SkillMeta[] = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, "SKILL.md");
    const parsed = parseFrontmatter(readIfExists(file));
    if (!parsed) continue;
    skills.push({ name: parsed.name, description: parsed.description, dir: dir.name });
  }
  return skills;
}

export function skillIndex(): string {
  const skills = listSkills();
  if (!skills.length) return "(no skills installed)";
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

export function readSkill(name: string): string {
  const skill = listSkills().find((s) => s.name === name || s.dir === name);
  if (!skill) return `No skill named "${name}". Known: ${listSkills().map((s) => s.name).join(", ") || "(none)"}`;
  return readIfExists(path.join(WORKSPACE, "skills", skill.dir, "SKILL.md"));
}

export function writeSkill(name: string, description: string, body: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  if (!slug) return "Skill name is empty after sanitising.";
  const dir = path.join(WORKSPACE, "skills", slug);
  fs.mkdirSync(dir, { recursive: true });
  const md =
    `---\nname: ${slug}\ndescription: ${description.trim().slice(0, 1024)}\n---\n\n${body.trim()}\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), md);
  return `Wrote skill "${slug}" to workspace/skills/${slug}/SKILL.md`;
}

export function appendMemoryMarkdown(key: string, value: string): void {
  const file = path.join(WORKSPACE, "MEMORY.md");
  let current = readIfExists(file) || "# MEMORY\n";
  current = current.replace(/^- \(none yet\)\s*$/m, "").trimEnd();
  const line = `- ${key}: ${value}`;
  const stripped = current
    .split("\n")
    .filter((row) => !row.startsWith(`- ${key}:`))
    .join("\n");
  fs.writeFileSync(file, `${stripped}\n${line}\n`);
}
