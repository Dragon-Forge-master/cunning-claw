// Shared MCP stdio plumbing for the senses — zero dependencies, Node 22.
//
// The wire format is dictated by the claw's own client (src/mcp.ts): JSON-RPC
// 2.0, one JSON object per line, on stdin/stdout. The client splits the
// stream on "\n", trims each line, and matches replies to pending requests by
// id — an unmatched or multi-line reply is silently dropped, so every response
// here is exactly one line. Notifications (no id) get silence: the client
// never awaits them, and answering one would put an unmatchable line on the
// pipe.
//
// Everything in this file is pure or takes its streams as parameters, so
// senses/test.mjs can drive the framing without spawning a process.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Incremental newline-delimited JSON parser — the mirror image of onData() in
 * src/mcp.ts. Garbage lines are skipped, not fatal: a stray diagnostic on the
 * pipe must not wedge the whole server.
 */
export function createLineParser(onMessage) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      onMessage(msg);
    }
  };
}

/** MCP success payload: business results are text blocks, not raw JSON-RPC. */
export function textResult(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

/**
 * MCP business failure: isError, not a protocol error. The claw formats these
 * into `ok: false` for the model; a protocol error would read as a broken
 * server rather than a fixable condition (missing key, no mic, dead API).
 */
export function errorResult(text) {
  return { content: [{ type: "text", text: String(text) }], isError: true };
}

/** Clamp a possibly-absent, possibly-garbage numeric argument into a range. */
export function clampNumber(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Handle one parsed JSON-RPC message; returns the response object, or null
 * for anything that must get silence (notifications, non-objects). Async
 * because tools/call runs a handler that may record audio or sweep a LAN.
 */
export async function handleMessage(msg, server) {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
  // No id means a notification (notifications/initialized among them) — the
  // stdio equivalent of a 202: acknowledged by doing nothing.
  if (msg.id === undefined || msg.id === null) return null;

  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return reply({
        // Echo the client's protocolVersion rather than pinning our own — the
        // claw records whatever the server answers (src/mcp.ts start()).
        protocolVersion: String(msg.params?.protocolVersion ?? "2025-03-26"),
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: server.version },
      });
    case "tools/list":
      return reply({
        tools: server.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const tool = server.tools.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(msg.params?.name)}`);
      try {
        return reply(await tool.handler(msg.params?.arguments ?? {}));
      } catch (err) {
        // A thrown handler is still a business failure — surface it as
        // isError so the model can read the reason instead of a dead call.
        return reply(errorResult(`${tool.name} failed: ${err?.message ?? err}`));
      }
    }
    case "ping":
      return reply({});
    default:
      return fail(-32601, `Method not found: ${String(msg.method)}`);
  }
}

/** Wire a server definition to real stdin/stdout and start listening. */
export function serve(server, input = process.stdin, output = process.stdout) {
  input.on("data", createLineParser(async (msg) => {
    const res = await handleMessage(msg, server);
    if (res) output.write(JSON.stringify(res) + "\n");
  }));
  // The claw kills the child on shutdown; ending stdin is the polite version.
  input.on("end", () => process.exit(0));
}

// ---------------------------------------------------------------------------
// Shared side-effect helpers (not used by the framing tests)
// ---------------------------------------------------------------------------

/**
 * Where the senses keep their memory. The claw spawns stdio servers with
 * cwd = ROOT and CUNNINGCLAW_ROOT in the env (src/mcp.ts), so both roads lead
 * to <repo>/workspace/senses.
 */
export function sensesDataDir() {
  const root = process.env.CUNNINGCLAW_ROOT || process.cwd();
  const dir = path.join(root, "workspace", "senses");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read a JSON file that may not exist yet; null instead of a throw. */
export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** Append one record to a JSONL log — one line per event, like the journal. */
export function appendJsonl(file, record) {
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

/** Last n parsed records of a JSONL file, oldest first. */
export function tailJsonl(file, n) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      /* a torn write is not a reason to lose the rest */
    }
  }
  return out.slice(-n);
}

/**
 * Run one command to completion. `missing: true` when the binary is not
 * installed (ENOENT), which each sense turns into an install hint rather
 * than a stack trace.
 */
export function runCommand(cmd, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += c.toString("utf-8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf-8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err?.message ?? err), missing: err?.code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, missing: false });
    });
  });
}
