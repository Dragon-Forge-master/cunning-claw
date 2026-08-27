import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, DATA_DIR, ROOT } from "./config.js";
import { expandHome, isSensitivePath } from "./paths.js";

const TODO_FILE = path.join(DATA_DIR, "todos.json");
const DEFAULT_SKIP = ["node_modules", ".git", "dist", ".venv", "voices"];
const TEXT_MAX = 400 * 1024;
const MAX_WALK = 4000;
const MAX_HITS = 60;

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoItem = { id: string; content: string; status: TodoStatus };

function skipDirs(): Set<string> {
  return new Set(config.coding?.skip ?? DEFAULT_SKIP);
}

export function codingRoot(): string {
  return path.resolve(expandHome(config.coding?.root ?? "~"));
}

/** Absolute, or relative to coding.root. `~` works. */
export function resolveWorkPath(p: string): string {
  const trimmed = (p || ".").trim() || ".";
  const expanded = expandHome(trimmed);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.normalize(path.join(codingRoot(), expanded));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0DOUBLESTAR\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0DOUBLESTAR\0/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`, "i");
}

function globMatch(rel: string, pattern: string): boolean {
  const unix = rel.replace(/\\/g, "/");
  const re = globToRegExp(pattern);
  if (re.test(unix) || re.test(path.basename(unix))) return true;
  if (pattern.startsWith("**/")) {
    const rest = globToRegExp(pattern.slice(3));
    if (rest.test(unix) || rest.test(path.basename(unix))) return true;
  }
  return false;
}

function walkFiles(root: string, acc: string[], skip: Set<string>): void {
  if (acc.length >= MAX_WALK) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (acc.length >= MAX_WALK) return;
    if (ent.name.startsWith(".") && ent.name !== ".env.example") {
      if (ent.isDirectory()) continue;
    }
    if (skip.has(ent.name)) continue;
    const full = path.join(root, ent.name);
    if (isSensitivePath(full)) continue;
    if (ent.isDirectory()) walkFiles(full, acc, skip);
    else if (ent.isFile()) acc.push(full);
  }
}

export function globFiles(pattern: string, from?: string): string {
  const root = resolveWorkPath(from || ".");
  if (isSensitivePath(root)) return "BLOCKED: that path is on the sensitive-file denylist.";
  if (!fs.existsSync(root)) return `No such path: ${root}`;
  const skip = skipDirs();
  const files: string[] = [];
  const start = fs.statSync(root).isDirectory() ? root : path.dirname(root);
  walkFiles(start, files, skip);
  const relPat = pattern.replace(/^\.\//, "");
  const hits = files.filter((f) => globMatch(path.relative(start, f), relPat));
  if (!hits.length) return `No files matching ${pattern} under ${start}.`;
  const shown = hits.slice(0, 80);
  const more = hits.length > shown.length ? `\n… ${hits.length - shown.length} more` : "";
  return shown.map((f) => path.relative(codingRoot(), f) || f).join("\n") + more;
}

export function grepFiles(opts: {
  pattern: string;
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
}): string {
  const q = opts.pattern;
  if (!q) return "Give me a search pattern.";
  let re: RegExp;
  try {
    re = new RegExp(q, opts.caseInsensitive === false ? "" : "i");
  } catch {
    return `Invalid pattern: ${q}`;
  }
  const root = resolveWorkPath(opts.path || ".");
  if (isSensitivePath(root)) return "BLOCKED: that path is on the sensitive-file denylist.";
  if (!fs.existsSync(root)) return `No such path: ${root}`;

  const skip = skipDirs();
  const files: string[] = [];
  const start = fs.statSync(root).isFile() ? path.dirname(root) : root;
  if (fs.statSync(root).isFile()) files.push(root);
  else walkFiles(start, files, skip);

  const globPat = opts.glob ? opts.glob.replace(/^\.\//, "") : null;
  const hits: string[] = [];
  let scanned = 0;
  for (const file of files) {
    if (globPat) {
      const rel = path.relative(start, file);
      if (!globMatch(rel, globPat)) continue;
    }
    scanned++;
    let body: string;
    try {
      const st = fs.statSync(file);
      if (st.size > TEXT_MAX) continue;
      body = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (body.includes("\0")) continue;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const label = path.relative(codingRoot(), file) || file;
      hits.push(`${label}:${i + 1}:${lines[i].slice(0, 240)}`);
      if (hits.length >= MAX_HITS) {
        return hits.join("\n") + `\n… stopped at ${MAX_HITS} hits (${scanned} files scanned)`;
      }
    }
  }
  if (!hits.length) return `No matches for /${q}/ under ${root} (${scanned} files).`;
  return hits.join("\n");
}

export type EditResult =
  | { ok: true; path: string; replacements: number; preview: string }
  | { ok: false; error: string };

export function planEdit(opts: {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): EditResult {
  const p = resolveWorkPath(opts.path);
  if (isSensitivePath(p)) return { ok: false, error: "BLOCKED: that path is on the sensitive-file denylist." };
  if (!opts.oldString) return { ok: false, error: "oldString is empty — use write_file to create, not edit_file to insert blindly." };
  if (opts.oldString === opts.newString) return { ok: false, error: "oldString and newString are identical." };
  if (!fs.existsSync(p)) return { ok: false, error: `No such file: ${p}` };
  const body = fs.readFileSync(p, "utf-8");
  const count = body.split(opts.oldString).length - 1;
  if (count === 0) return { ok: false, error: "oldString was not found. Read the file again — it may have changed." };
  if (count > 1 && !opts.replaceAll) {
    return {
      ok: false,
      error: `oldString matched ${count} times. Pass a larger unique snippet, or replaceAll=true if you mean every occurrence.`,
    };
  }
  const preview =
    `- ${opts.oldString.slice(0, 900).replace(/\n/g, "\n- ")}\n` +
    `+ ${opts.newString.slice(0, 900).replace(/\n/g, "\n+ ")}`;
  return { ok: true, path: p, replacements: count, preview };
}

/** Apply a unique (or replace-all) edit. Caller handles approval. */
export function commitEdit(opts: {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): string {
  const plan = planEdit(opts);
  if (!plan.ok) return plan.error;
  const body = fs.readFileSync(plan.path, "utf-8");
  const next = opts.replaceAll
    ? body.split(opts.oldString).join(opts.newString)
    : body.replace(opts.oldString, opts.newString);
  fs.writeFileSync(plan.path, next);
  return `Edited ${plan.path} (${plan.replacements} replacement${plan.replacements === 1 ? "" : "s"}).`;
}

export function readTodos(): TodoItem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TODO_FILE, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function writeTodos(items: TodoItem[]): TodoItem[] {
  const clean: TodoItem[] = [];
  for (const [i, it] of items.entries()) {
    const content = String(it.content || "").slice(0, 400);
    if (!content) continue;
    const status: TodoStatus =
      it.status === "completed" || it.status === "in_progress" ? it.status : "pending";
    clean.push({ id: String(it.id || i + 1).slice(0, 32), content, status });
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TODO_FILE, JSON.stringify(clean, null, 2));
  return clean;
}

export function formatTodos(items = readTodos()): string {
  if (!items.length) return "(no todos)";
  return items.map((t) => `- [${t.status}] ${t.id}: ${t.content}`).join("\n");
}

export function numberLines(text: string, start = 1): string {
  return text.split("\n").map((line, i) => `${String(start + i).padStart(6)}|${line}`).join("\n");
}

const REPO_SKIP = new Set([
  "node_modules", "dist", ".venv", "voices", ".cache", ".local", ".npm",
  ".steam", "snap", "proc", "sys", "Library", "AppData", "Application Support",
]);

function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

function gitOrigin(dir: string): string {
  try {
    const cfg = fs.readFileSync(path.join(dir, ".git", "config"), "utf-8");
    const m = cfg.match(/\[remote "origin"\][\s\S]*?^\s*url\s*=\s*(\S+)/m);
    return m?.[1] ?? "";
  } catch {
    return "";
  }
}

function walkRepos(dir: string, depth: number, acc: string[], seen: Set<string>): void {
  if (depth < 0 || acc.length >= 40) return;
  let resolved: string;
  try {
    resolved = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (seen.has(resolved)) return;
  seen.add(resolved);
  if (isGitRepo(dir)) {
    acc.push(dir);
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".") || REPO_SKIP.has(ent.name)) continue;
    walkRepos(path.join(dir, ent.name), depth - 1, acc, seen);
  }
}

/**
 * Find git checkouts without globbing into .git (the coding walker skips that
 * directory, which is why "where's the repo" used to return nothing).
 */
export function listLocalRepos(): string {
  const home = os.homedir();
  const roots = [
    ROOT,
    codingRoot(),
    home,
    path.join(home, "Game Dev"),
    path.join(home, "src"),
    path.join(home, "code"),
    path.join(home, "dev"),
    path.join(home, "projects"),
    path.join(home, "Documents"),
  ];
  const acc: string[] = [];
  const seen = new Set<string>();
  const uniqueRoots = [...new Set(roots.map((r) => path.resolve(r)))];
  for (const root of uniqueRoots) {
    if (!fs.existsSync(root)) continue;
    const depth = root === home ? 2 : 4;
    walkRepos(root, depth, acc, seen);
  }
  if (!acc.length) {
    return [
      `No git repositories found next to this install or under ${home}.`,
      `This Cunning Claw process is running from: ${ROOT}`,
      "That directory is the Cunning Claw / jarvis repo. Shell cwd defaults to your home folder, which is not a git repo — pass that path as cwd.",
    ].join("\n");
  }
  const lines = acc.map((dir) => {
    const origin = gitOrigin(dir);
    const tag = path.resolve(dir) === path.resolve(ROOT) ? "  ← this install (Cunning Claw / jarvis)" : "";
    return `${dir}${origin ? "  " + origin : ""}${tag}`;
  });
  return [
    `This Cunning Claw process is running from: ${ROOT}`,
    "Shell commands start in $HOME, which is usually not a git repo. Pass cwd.",
    "",
    ...lines,
  ].join("\n");
}
