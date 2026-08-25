import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import { config, ROOT } from "./config.js";
import { getHistory, resetHistory, runTurn, cancelTurn, turnInFlight, CONTEXT_END, type AgentEvents } from "./agent.js";
import { systemStatusText, toolDefinitions } from "./tools.js";
import * as voice from "./voice.js";
import { redactDeep } from "./redact.js";
import { banner } from "./banner.js";
import { grantForTask } from "./consequence.js";
import { ensureToken, currentToken, requireAuth, issueSession } from "./auth.js";
import { connectAll as connectMcp, listMcpTools, shutdown as shutdownMcp } from "./mcp.js";
import { startHeartbeat, heartbeatStatus } from "./heartbeat.js";
import { listSkills, readSkill, skillCatalog } from "./workspace.js";
import { loadLandscape } from "./landscape.js";
import { brainLabel, brainReady, activeProvider, applyBrainCommand, catalogStatus, bootBrainLines, missingKeyHint, sessionSpend, lastTurnCost } from "./brain.js";
import { createRequire } from "node:module";
import { startTelegram, sendApprovalCard, approvalSettled, telegramStatus } from "./telegram.js";
import { openPreview, closePreview, reloadPreview, previewState } from "./preview.js";

// An assistant that is meant to be always-on must survive a stray stream or
// socket error. Log loudly, keep serving.
process.on("exit", () => shutdownMcp());
process.on("uncaughtException", (err) => {
  console.error("[cunningclaw] uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[cunningclaw] unhandled rejection:", err);
});

const VERSION: string = (() => {
  try {
    return createRequire(import.meta.url)("../package.json").version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
})();

const app = express();
// Established before any route is registered — issueSession and requireAuth
// both read it, and a request can arrive the instant listen() resolves.
const { generated: tokenGenerated } = ensureToken();

app.use(express.json({ limit: "1mb" }));

// Loading the HUD hands the browser its session, so EventSource — which cannot
// set headers — can authenticate on the stream that follows.
app.get(["/", "/index.html"], (_req, res) => {
  issueSession(res);
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

// The static assets are the same files any visitor to the page would fetch;
// nothing behind them is sensitive. Everything under /api is.
app.use(express.static(path.join(ROOT, "public")));
app.use("/api", requireAuth);

// --- SSE event bus (single-user app: broadcast to all connected clients) ---
const sseClients = new Set<express.Response>();

function broadcast(event: string, data: unknown): void {
  // Single choke point for everything the HUD, Telegram and the voice see.
  // Redacting here covers every event without each emitter having to remember.
  const payload = `event: ${event}\ndata: ${JSON.stringify(redactDeep(data))}\n\n`;
  for (const res of sseClients) res.write(payload);

  // Server-side voice: the server runs on the user's machine, so speaking
  // here comes out of their speakers regardless of browser TTS support.
  const d = data as any;
  if (event === "turn_done" && d?.text) void voice.speak(d.text);
  else if (event === "timer_fired") void voice.speak(`Sir, a reminder: ${d?.label ?? ""}`);
  else if (event === "approval_request") void voice.speak("Requesting authorisation, sir.");
  else if (event === "turn_start") voice.cancel();
  else if (event === "agent_error" && d?.message) void voice.speak(d.message);
  else if (event === "preview" && d?.action === "open") void voice.speak("Preview on the glass, sir.");
  // heartbeat_ok is silent on purpose — OpenClaw-style.
}

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: hello\ndata: {}\n\n");
  sseClients.add(res);
  const keepalive = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

// --- Approval flow ----------------------------------------------------------
const pendingApprovals = new Map<string, (approved: boolean, timedOut?: boolean) => void>();

function settleApproval(id: string, approved: boolean, timedOut = false): boolean {
  const resolver = pendingApprovals.get(id);
  if (!resolver) return false;
  resolver(approved, timedOut);
  return true;
}

/**
 * Deny everything currently awaiting a click.
 *
 * A turn parked on an approval holds the agent. If the user is right there
 * typing a new instruction, that instruction is the answer — waiting out the
 * timeout serves nobody. Denying is the safe resolution: the stalled tool does
 * not run, and its turn unwinds.
 */
function cancelPendingApprovals(reason: string): number {
  const ids = [...pendingApprovals.keys()];
  for (const id of ids) settleApproval(id, false);
  if (ids.length) broadcast("notice", { message: `${ids.length} pending approval(s) cancelled — ${reason}` });
  return ids.length;
}

function requestApproval(summary: string, detail: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    let timer: NodeJS.Timeout;
    const finish = (approved: boolean, timedOut = false) => {
      if (!pendingApprovals.has(id)) return;
      pendingApprovals.delete(id);
      clearTimeout(timer);
      broadcast("approval_resolved", { id, approved, timedOut });
      approvalSettled(id, approved);
      resolve(approved);
    };
    timer = setTimeout(() => finish(false, true), config.commandPolicy.approvalTimeoutMs);
    pendingApprovals.set(id, finish);
    broadcast("approval_request", { id, summary, detail });
    void sendApprovalCard(id, summary, detail);
  });
}

app.post("/api/approve", (req, res) => {
  // "approve for this task" is an approval that also widens scope until the
  // turn ends. It never covers an irreversible action.
  if (req.body?.scope === "task") grantForTask();
  const { id, approved } = req.body ?? {};
  if (!settleApproval(id, Boolean(approved))) {
    return res.status(404).json({ error: "No such pending approval" });
  }
  res.json({ ok: true });
});

// --- Chat -------------------------------------------------------------------
const agentEvents: AgentEvents = { emit: broadcast, requestApproval };

app.post("/api/cancel", (_req, res) => {
  const { forMs } = turnInFlight();
  const stopped = cancelTurn("operator asked to stop");
  if (stopped) {
    broadcast("notice", { message: `Abandoned the request after ${Math.round(forMs / 1000)}s.` });
    broadcast("turn_done", { text: "" });
  }
  res.json({ ok: true, stopped });
});

/** Said out loud or typed, "stop" should stop him — not queue behind the thing it wants stopped. */
const STOP_WORDS = /^\s*(stop|cancel|abort|halt|never ?mind|forget it|leave it)\b[\s.!]*$/i;

app.post("/api/chat", (req, res) => {
  // A new instruction outranks a turn parked on an unanswered approval.
  if (pendingApprovals.size > 0) cancelPendingApprovals("superseded by a new instruction");
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Empty message" });

  if (STOP_WORDS.test(message)) {
    const { forMs } = turnInFlight();
    const stopped = cancelTurn("operator said stop");
    broadcast("notice", {
      message: stopped
        ? `Stopped, sir — abandoned after ${Math.round(forMs / 1000)}s.`
        : "Nothing was running, sir.",
    });
    broadcast("turn_done", { text: "" });
    return res.json({ ok: true, stopped });
  }
  const brainReply = applyBrainCommand(message);
  if (brainReply !== null) {
    res.json({ ok: true, command: true });
    broadcast("notice", { message: brainReply });
    broadcast("brain", catalogStatus());
    return;
  }
  res.json({ ok: true });
  void runTurn(message, agentEvents);
});

app.get("/api/history", (_req, res) => {
  // Return only displayable turns: plain user text + assistant text blocks.
  const display: { role: string; text: string }[] = [];
  for (const m of getHistory()) {
    if (m.role === "user" && typeof m.content === "string") {
      // Split on the explicit marker; fall back to the old shape so history
      // written before the marker existed still renders.
      const marker = m.content.indexOf(CONTEXT_END);
      const text = marker >= 0
        ? m.content.slice(marker + CONTEXT_END.length).replace(/^\n+/, "")
        : m.content.replace(/^\[context[\s\S]*\]\n\n/, "");
      if (text.startsWith("[heartbeat]")) continue;
      const armed = text.replace(/^\[Armed skills[^\]]*\]\s*/, "");
      display.push({ role: "user", text: armed });
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (text && text.trim() !== "HEARTBEAT_OK") display.push({ role: "assistant", text });
    }
  }
  res.json(display);
});

app.post("/api/reset", (_req, res) => {
  resetHistory();
  res.json({ ok: true });
});

app.get("/api/status", async (_req, res) => {
  const hb = heartbeatStatus();
  const landscape = loadLandscape();
  res.json({
    text: await systemStatusText(),
    online: brainReady(),
    brain: { provider: activeProvider(), model: brainLabel() },
    brains: catalogStatus(),
    serverVoice: (await voice.isAvailable()) && voice.isEnabled(),
    serverVoiceAvailable: await voice.isAvailable(),
    voiceEngine: (await voice.detect()).engine,
    voiceDetail: (await voice.detect()).detail,
    skills: listSkills().length,
    skillCatalog: skillCatalog(),
    heartbeat: hb,
    landscapeUpdated: landscape.updated,
    landscapeCount: landscape.systems.length,
    telegram: telegramStatus(),
    toolCount: toolDefinitions.length,
    spend: sessionSpend(),
    turn: turnInFlight(),
    lastTurn: lastTurnCost(),
    preview: previewState(),
  });
});

app.post("/api/preview", (req, res) => {
  const action = String(req.body?.action ?? "open");
  if (action === "close") {
    const st = closePreview();
    broadcast("preview", { action: "close", ...st });
    return res.json({ ok: true, ...st });
  }
  if (action === "reload") {
    const st = reloadPreview();
    broadcast("preview", { action: "reload", ...st });
    return res.json({ ok: true, ...st });
  }
  const opened = openPreview(String(req.body?.url ?? ""));
  if (!opened.ok) return res.status(400).json({ error: opened.error });
  broadcast("preview", { action: "open", open: true, url: opened.url });
  res.json({ ok: true, open: true, url: opened.url });
});

app.post("/api/brain", (req, res) => {
  const id = req.body?.id;
  const reply = id == null || id === "" || id === "auto"
    ? applyBrainCommand("/brain auto")
    : applyBrainCommand(`/brain ${String(id)}`);
  broadcast("notice", { message: reply });
  broadcast("brain", catalogStatus());
  res.json({ ok: true, message: reply, brains: catalogStatus() });
});

app.get("/api/landscape", (_req, res) => {
  res.json(loadLandscape());
});

app.get("/api/skills", (_req, res) => {
  res.json({ skills: skillCatalog() });
});

app.get("/api/skills/:name", (req, res) => {
  const name = String(req.params.name ?? "").trim();
  const known = listSkills().find((s) => s.name === name || s.dir === name);
  if (!known) return res.status(404).json({ error: `No skill named "${name}"` });
  res.json({
    name: known.name,
    label: known.label,
    category: known.category,
    description: known.description,
    body: readSkill(known.name),
  });
});

// --- Voice control ----------------------------------------------------------
app.post("/api/voice", (req, res) => {
  const { enabled } = req.body ?? {};
  voice.setEnabled(Boolean(enabled));
  res.json({ ok: true, enabled: voice.isEnabled() });
});

app.get("/api/voices", (_req, res) => {
  res.json({ piper: voice.listPiperVoices(), active: config.voice.piper.model });
});

app.post("/api/voice/sample", async (req, res) => {
  const { model, voiceName, text } = req.body ?? {};
  await voice.sample({
    model: model ? String(model) : undefined,
    voiceName: voiceName ? String(voiceName) : undefined,
    text: String(text || "Good evening, sir. All systems are nominal."),
  });
  res.json({ ok: true });
});

// --- Boot -------------------------------------------------------------------
const { port, host } = config.server;
app.listen(port, host, async () => {
  const hb = heartbeatStatus();
  const v = await voice.detect();
  const active = catalogStatus();

  console.log(banner({
    version: VERSION,
    url: `http://${host}:${port}`,
    brain: `${active.default} · ${brainLabel()}`,
    voice: v.engine === "none" ? "none — run ./setup-voice.sh" : `${v.engine} · ${v.detail}`,
    heartbeat: hb.enabled ? `every ${hb.intervalMinutes}m` : "off",
    tools: toolDefinitions.length,
  }));

  await connectMcp((line) => console.log(line));
  const mcpCount = listMcpTools().length;
  if (mcpCount) console.log(`  MCP: ${mcpCount} tool(s) registered\n`);

  if (tokenGenerated) {
    console.log("  A CLAW_TOKEN was generated and written to .env (mode 600).");
    console.log("  Scripts authenticate with:  Authorization: Bearer $CLAW_TOKEN\n");
  }

  startHeartbeat(agentEvents);
  startTelegram(agentEvents, { resolveApproval: settleApproval });
  for (const line of bootBrainLines()) console.log(line);
  if (!brainReady()) {
    console.warn(`  ⚠ No brain has an API key. ${missingKeyHint()}\n`);
  }
});
