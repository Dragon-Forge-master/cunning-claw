/**
 * HUD connectors — Claude's Customize → Connectors page, for this machine.
 * Reads the same mcpServers files, writes only ~/.config/cunningclaw/mcp.json.
 */
import { config } from "./config.js";
import { MCP_CATALOGUE, MCP_CATEGORIES, catalogueById } from "./mcp-catalog.js";
import {
  claudeEntryToConfig,
  cunningclawMcpPath,
  inferTransport,
  loadAllMcpServers,
  parseMcpServersBlock,
  removeUserMcpServer,
  upsertUserMcpServer,
  type ClaudeMcpEntry,
  type McpServerConfig,
} from "./mcp-config.js";
import {
  connectOne,
  disconnectOne,
  listMcpStates,
  listMcpTools,
  loginMcp,
  type McpServerState,
} from "./mcp.js";

export type ConnectorRow = {
  id: string;
  label: string;
  blurb: string;
  category: string;
  transport: string;
  typeLabel: "Web" | "Local";
  url?: string;
  command?: string;
  status: McpServerState["status"] | "not_connected";
  detail: string;
  tools: number;
  toolNames: string[];
  source: string | null;
  owned: boolean;
  popular: boolean;
  configured: boolean;
};

function mcpEnabled(): boolean {
  return config.mcp?.enabled !== false;
}

function typeLabel(transport: string): "Web" | "Local" {
  return transport === "stdio" ? "Local" : "Web";
}

function userFile(): string {
  return cunningclawMcpPath();
}

export function connectorSnapshot(): {
  enabled: boolean;
  path: string;
  sources: Array<{ file: string; count: number }>;
  connectors: ConnectorRow[];
  categories: string[];
  catalogueSize: number;
  needsAuth: number;
  connected: number;
} {
  const { servers, sources } = loadAllMcpServers(config.mcp?.servers ?? []);
  const states = listMcpStates();
  const tools = listMcpTools();
  const configured = new Set(servers.map((s) => s.id));
  const rows: ConnectorRow[] = [];

  for (const s of servers) {
    const cat = catalogueById(s.id);
    const st = states.find((x) => x.id === s.id);
    const mine = tools.filter((t) => t.serverId === s.id);
    rows.push({
      id: s.id,
      label: cat?.label ?? s.id,
      blurb: cat?.blurb ?? (s.url ?? (s.command ? `${s.command} ${(s.args ?? []).join(" ")}`.trim() : "")),
      category: cat?.category ?? "Custom",
      transport: s.transport,
      typeLabel: typeLabel(s.transport),
      url: s.url,
      command: s.command,
      status: st?.status ?? (mcpEnabled() ? "not_connected" : "disabled"),
      detail: st?.detail ?? "",
      tools: mine.length,
      toolNames: mine.map((t) => t.remoteName).slice(0, 12),
      source: s.source ?? null,
      owned: s.source === userFile(),
      popular: Boolean(cat?.popular),
      configured: true,
    });
  }

  for (const cat of MCP_CATALOGUE) {
    if (configured.has(cat.id)) continue;
    const transport = inferTransport(cat.entry);
    rows.push({
      id: cat.id,
      label: cat.label,
      blurb: cat.blurb,
      category: cat.category,
      transport,
      typeLabel: typeLabel(transport),
      url: cat.entry.url,
      command: cat.entry.command,
      status: "not_connected",
      detail: "",
      tools: 0,
      toolNames: [],
      source: null,
      owned: false,
      popular: cat.popular,
      configured: false,
    });
  }

  const rank = (s: ConnectorRow["status"]) =>
    s === "needs_auth" ? 0 : s === "failed" ? 1 : s === "connected" ? 2 : 3;
  rows.sort((a, b) => rank(a.status) - rank(b.status) || a.label.localeCompare(b.label));

  const seen = new Set(rows.map((r) => r.category));
  const known = MCP_CATEGORIES as readonly string[];
  const categories = [
    ...known.filter((c) => seen.has(c)),
    ...[...seen].filter((c) => !known.includes(c) && c !== "Custom"),
    ...(seen.has("Custom") ? ["Custom"] : []),
  ];

  return {
    enabled: mcpEnabled(),
    path: userFile(),
    sources,
    connectors: rows,
    categories,
    catalogueSize: MCP_CATALOGUE.length,
    needsAuth: rows.filter((r) => r.status === "needs_auth").length,
    connected: rows.filter((r) => r.status === "connected").length,
  };
}

function existingById(id: string): McpServerConfig | undefined {
  return loadAllMcpServers(config.mcp?.servers ?? []).servers.find((s) => s.id === id);
}

async function attach(cfg: McpServerConfig): Promise<ConnectorRow | undefined> {
  await connectOne(cfg);
  return connectorSnapshot().connectors.find((c) => c.id === cfg.id);
}

export async function addConnector(entry: {
  id?: string;
  catalogId?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  mcpServers?: unknown;
}): Promise<{ ok: boolean; message: string; snapshot: ReturnType<typeof connectorSnapshot> }> {
  if (!mcpEnabled()) {
    return { ok: false, message: "MCP is disabled in claw.config.json (mcp.enabled).", snapshot: connectorSnapshot() };
  }

  const toAdd: McpServerConfig[] = [];
  if (entry.mcpServers) {
    toAdd.push(...parseMcpServersBlock(entry));
  } else if ((entry as { servers?: unknown }).servers) {
    toAdd.push(...parseMcpServersBlock({ mcpServers: (entry as { servers: unknown }).servers }));
  } else if (entry.catalogId) {
    const cat = catalogueById(String(entry.catalogId));
    if (!cat) return { ok: false, message: `Unknown connector "${entry.catalogId}".`, snapshot: connectorSnapshot() };
    toAdd.push(claudeEntryToConfig(cat.id, cat.entry));
  } else {
    const id = String(entry.id ?? "").trim();
    const raw: ClaudeMcpEntry = {
      url: entry.url,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      headers: entry.headers,
    };
    const cfg = claudeEntryToConfig(id, raw);
    if (!cfg.id) return { ok: false, message: "Give the connector a short id (e.g. canva).", snapshot: connectorSnapshot() };
    if (cfg.transport === "stdio" && !cfg.command) {
      return { ok: false, message: "Local connectors need a command.", snapshot: connectorSnapshot() };
    }
    if ((cfg.transport === "http" || cfg.transport === "sse") && !cfg.url) {
      return { ok: false, message: "Web connectors need a URL.", snapshot: connectorSnapshot() };
    }
    toAdd.push(cfg);
  }

  if (!toAdd.length) return { ok: false, message: "Nothing to add.", snapshot: connectorSnapshot() };

  const notes: string[] = [];
  for (const cfg of toAdd) {
    const already = existingById(cfg.id);
    if (already?.source && already.source !== userFile() && already.source === "claw.config.json") {
      notes.push(`${cfg.id} already lives in claw.config.json — connecting that copy.`);
      await attach(already);
      continue;
    }
    const cat = catalogueById(cfg.id);
    const raw: ClaudeMcpEntry = cat && !cfg.command && cfg.url === cat.entry.url
      ? cat.entry
      : {
          type: cfg.transport,
          url: cfg.url,
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
          headers: cfg.headers,
        };
    upsertUserMcpServer(cfg.id, raw);
    await attach({ ...cfg, source: userFile() });
    notes.push(`Added ${cfg.id}.`);
  }
  return { ok: true, message: notes.join(" "), snapshot: connectorSnapshot() };
}

export async function removeConnector(id: string): Promise<{ ok: boolean; message: string; snapshot: ReturnType<typeof connectorSnapshot> }> {
  const already = existingById(id);
  if (!already) return { ok: false, message: `No connector named "${id}".`, snapshot: connectorSnapshot() };
  if (already.source !== userFile()) {
    return {
      ok: false,
      message: `${id} is configured in ${already.source ?? "another file"} — edit that file, or copy it into ${userFile()} first.`,
      snapshot: connectorSnapshot(),
    };
  }
  removeUserMcpServer(id);
  disconnectOne(id);
  return { ok: true, message: `Removed ${id}.`, snapshot: connectorSnapshot() };
}

export async function loginConnector(id: string): Promise<{ ok: boolean; message: string; snapshot: ReturnType<typeof connectorSnapshot> }> {
  const already = existingById(id);
  if (!already) {
    const cat = catalogueById(id);
    if (cat) {
      const added = await addConnector({ catalogId: id });
      if (!added.ok) return added;
    }
  }
  const cfg = existingById(id);
  if (!cfg?.url) {
    if (cfg) {
      await attach(cfg);
      const row = connectorSnapshot().connectors.find((c) => c.id === id);
      return {
        ok: row?.status === "connected",
        message: row?.status === "connected" ? `Connected ${id}.` : `Could not connect ${id}: ${row?.detail ?? "unknown"}`,
        snapshot: connectorSnapshot(),
      };
    }
    return { ok: false, message: `No remote MCP server named "${id}".`, snapshot: connectorSnapshot() };
  }
  const message = await loginMcp(id);
  const row = connectorSnapshot().connectors.find((c) => c.id === id);
  return { ok: row?.status === "connected", message, snapshot: connectorSnapshot() };
}

export async function retryConnector(id: string): Promise<{ ok: boolean; message: string; snapshot: ReturnType<typeof connectorSnapshot> }> {
  let cfg = existingById(id);
  if (!cfg) {
    const cat = catalogueById(id);
    if (!cat) return { ok: false, message: `No connector named "${id}".`, snapshot: connectorSnapshot() };
    return addConnector({ catalogId: id });
  }
  await attach(cfg);
  const row = connectorSnapshot().connectors.find((c) => c.id === id);
  return {
    ok: row?.status === "connected" || row?.status === "needs_auth",
    message: row?.status === "needs_auth"
      ? `${id} needs sign-in.`
      : row?.status === "connected"
        ? `Connected ${id} — ${row.tools} tool(s).`
        : `Could not connect ${id}: ${row?.detail ?? "unknown"}`,
    snapshot: connectorSnapshot(),
  };
}
