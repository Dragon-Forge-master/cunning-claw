/**
 * Claude Code / Cursor speak `mcpServers`. We speak the same file so a Canva
 * (or Notion, Figma, GitHub) snippet copied from their docs actually loads.
 *
 * Sources, first id wins:
 *   1. claw.config.json  mcp.servers
 *   2. ~/.config/cunningclaw/mcp.json  (Linux) / equivalent
 *   3. <install>/.mcp.json
 *   4. ~/.claude.json  (user-scope Claude Code)
 *   5. ~/.cursor/mcp.json
 *
 * A stdio entry is still a subprocess. These files are ones Chris already
 * trusted to another client, or wrote himself — not discovery from the web.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./config.js";

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  id: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Tools allowed from this server. Empty means all, up to maxTools. */
  allow?: string[];
  /** Tools that change state and therefore need approval. */
  writeTools?: string[];
  /** Tools known read-only, so they never raise a card even if the name is unusual. */
  readTools?: string[];
  /** Config file this entry was loaded from. HUD may only edit the user file. */
  source?: string;
}

export type ClaudeMcpEntry = {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  /** Older Claude Code / some snippets. */
  httpUrl?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  allow?: string[];
  writeTools?: string[];
  readTools?: string[];
};

export function expandEnvVars(raw: string): string {
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
    const v = process.env[name];
    if (v != null && v !== "") return v;
    if (fallback != null) return fallback;
    return "";
  });
}

function expandRecord(rec?: Record<string, string>): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expandEnvVars(String(v));
  return out;
}

export function inferTransport(entry: ClaudeMcpEntry): McpServerConfig["transport"] {
  const t = (entry.type ?? "").toLowerCase().replace(/_/g, "-");
  if (t === "sse") return "sse";
  if (t === "http" || t === "streamable-http" || t === "streamablehttp") return "http";
  if (t === "stdio") return "stdio";
  if (entry.url || entry.httpUrl) return "http";
  return "stdio";
}

export function claudeEntryToConfig(id: string, entry: ClaudeMcpEntry): McpServerConfig {
  const transport = inferTransport(entry);
  const rawUrl = entry.url ?? entry.httpUrl;
  return {
    id: String(id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40),
    transport,
    command: entry.command ? expandEnvVars(entry.command) : undefined,
    args: entry.args?.map((a) => expandEnvVars(String(a))),
    url: rawUrl ? expandEnvVars(rawUrl) : undefined,
    env: expandRecord(entry.env),
    headers: expandRecord(entry.headers),
    allow: entry.allow,
    writeTools: entry.writeTools,
    readTools: entry.readTools,
  };
}

export function parseMcpServersBlock(raw: unknown): McpServerConfig[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const block = (obj.mcpServers ?? obj) as Record<string, unknown>;
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];
  const out: McpServerConfig[] = [];
  for (const [id, entry] of Object.entries(block)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const cfg = claudeEntryToConfig(id, entry as ClaudeMcpEntry);
    if (cfg.transport === "stdio" && !cfg.command) continue;
    if ((cfg.transport === "http" || cfg.transport === "sse") && !cfg.url) continue;
    out.push(cfg);
  }
  return out;
}

function readJson(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function cunningclawMcpPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "cunningclaw", "mcp.json");
  }
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "cunningclaw", "mcp.json");
  }
  return path.join(os.homedir(), ".config", "cunningclaw", "mcp.json");
}

export function extraMcpConfigFiles(): string[] {
  return [
    cunningclawMcpPath(),
    path.join(ROOT, ".mcp.json"),
    path.join(os.homedir(), ".claude.json"),
    path.join(os.homedir(), ".cursor", "mcp.json"),
  ];
}

/**
 * ~/.claude.json is a whole user config. User-scope mcpServers plus any
 * project block whose path is this install (or a parent/child of it).
 */
export function serversFromClaudeJson(json: unknown, projectRoot: string): McpServerConfig[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  const take = (list: McpServerConfig[]) => {
    for (const s of list) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  };
  take(parseMcpServersBlock(obj));
  const projects = obj.projects;
  if (projects && typeof projects === "object" && !Array.isArray(projects)) {
    const root = projectRoot.replace(/\/+$/, "");
    for (const [p, val] of Object.entries(projects as Record<string, unknown>)) {
      const key = String(p).replace(/\/+$/, "");
      if (key === root || root.startsWith(key + "/") || key.startsWith(root + "/")) {
        take(parseMcpServersBlock(val));
      }
    }
  }
  return out;
}

function serversFromFile(file: string, json: unknown): McpServerConfig[] {
  if (file.endsWith(`${path.sep}.claude.json`) || file.endsWith("/.claude.json")) {
    return serversFromClaudeJson(json, ROOT);
  }
  return parseMcpServersBlock(json);
}

/** Merge Claw's own list with Claude/Cursor files. First id wins. */
export function loadAllMcpServers(fromClaw: McpServerConfig[]): {
  servers: McpServerConfig[];
  sources: Array<{ file: string; count: number }>;
} {
  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];
  const sources: Array<{ file: string; count: number }> = [];

  const take = (list: McpServerConfig[], file: string) => {
    let count = 0;
    for (const s of list) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      servers.push({ ...s, source: s.source ?? file });
      count++;
    }
    if (count) sources.push({ file, count });
  };

  take(fromClaw, "claw.config.json");
  for (const file of extraMcpConfigFiles()) {
    const json = readJson(file);
    if (!json) continue;
    take(serversFromFile(file, json), file);
  }
  return { servers, sources };
}

function asMcpServersObject(json: unknown): { wrap: Record<string, unknown>; block: Record<string, unknown> } {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { wrap: { mcpServers: {} }, block: {} };
  }
  const wrap = json as Record<string, unknown>;
  if (wrap.mcpServers && typeof wrap.mcpServers === "object" && !Array.isArray(wrap.mcpServers)) {
    return { wrap, block: wrap.mcpServers as Record<string, unknown> };
  }
  return { wrap: { mcpServers: wrap }, block: wrap };
}

export function readUserMcpServers(file = cunningclawMcpPath()): Record<string, ClaudeMcpEntry> {
  const json = readJson(file);
  if (!json) return {};
  const { block } = asMcpServersObject(json);
  const out: Record<string, ClaudeMcpEntry> = {};
  for (const [id, entry] of Object.entries(block)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) out[id] = entry as ClaudeMcpEntry;
  }
  return out;
}

export function writeUserMcpServers(servers: Record<string, ClaudeMcpEntry>, file = cunningclawMcpPath()): string {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = readJson(file);
  let wrap: Record<string, unknown> = { mcpServers: servers };
  if (existing && typeof existing === "object" && !Array.isArray(existing) && "mcpServers" in (existing as object)) {
    wrap = { ...(existing as Record<string, unknown>), mcpServers: servers };
  }
  fs.writeFileSync(file, JSON.stringify(wrap, null, 2) + "\n", { mode: 0o600 });
  return file;
}

export function upsertUserMcpServer(id: string, entry: ClaudeMcpEntry, file = cunningclawMcpPath()): string {
  const servers = readUserMcpServers(file);
  servers[id] = entry;
  return writeUserMcpServers(servers, file);
}

export function removeUserMcpServer(id: string, file = cunningclawMcpPath()): boolean {
  const servers = readUserMcpServers(file);
  if (!(id in servers)) return false;
  delete servers[id];
  writeUserMcpServers(servers, file);
  return true;
}

/**
 * Add server(s) from a pasted snippet to the user's own MCP config file, then
 * return the ids added. Accepts the full `{ "mcpServers": { … } }` shape people
 * copy from vendor docs, or a bare `{ "<id>": { … } }`. Merges into whatever is
 * already there rather than overwriting.
 */
export function addMcpServerSnippet(input: unknown): string[] {
  let obj: any = input;
  if (typeof input === "string") {
    try { obj = JSON.parse(input); } catch { throw new Error("That is not valid JSON."); }
  }
  const incoming: Record<string, unknown> =
    obj && typeof obj === "object" && obj.mcpServers && typeof obj.mcpServers === "object"
      ? obj.mcpServers
      : (obj && typeof obj === "object" ? obj : {});

  const ids = Object.keys(incoming);
  if (ids.length === 0) throw new Error('No servers found. Expected { "mcpServers": { "name": { … } } }.');

  for (const id of ids) {
    const cfg = claudeEntryToConfig(id, incoming[id] as ClaudeMcpEntry);
    if (cfg.transport === "stdio" && !cfg.command) throw new Error(`"${id}" is stdio but has no command.`);
    if ((cfg.transport === "http" || cfg.transport === "sse") && !cfg.url) throw new Error(`"${id}" is remote but has no url.`);
  }

  for (const id of ids) {
    upsertUserMcpServer(id, incoming[id] as ClaudeMcpEntry);
  }
  return ids;
}
