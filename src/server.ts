import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import { config, ROOT } from "./config.js";
import { getHistory, resetHistory, runTurn, type AgentEvents } from "./agent.js";
import { systemStatusText } from "./tools.js";
import * as voice from "./voice.js";

// An assistant that is meant to be always-on must survive a stray stream or
// socket error. Log loudly, keep serving.
process.on("uncaughtException", (err) => {
  console.error("[jarvis] uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[jarvis] unhandled rejection:", err);
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

// --- SSE event bus (single-user app: broadcast to all connected clients) ---
const sseClients = new Set<express.Response>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);

  // Server-side voice: the server runs on the user's machine, so speaking
  // here comes out of their speakers regardless of browser TTS support.
  const d = data as any;
  if (event === "turn_done" && d?.text) void voice.speak(d.text);
  else if (event === "timer_fired") void voice.speak(`Sir, a reminder: ${d?.label ?? ""}`);
  else if (event === "approval_request") void voice.speak("Requesting authorisation, sir.");
  else if (event === "turn_start") voice.cancel();
  else if (event === "error" && d?.message) void voice.speak(d.message);
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
const pendingApprovals = new Map<string, (approved: boolean) => void>();

function requestApproval(summary: string, detail: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      broadcast("approval_resolved", { id, approved: false, timedOut: true });
      resolve(false);
    }, config.commandPolicy.approvalTimeoutMs);
    pendingApprovals.set(id, (approved) => {
      clearTimeout(timer);
      pendingApprovals.delete(id);
      broadcast("approval_resolved", { id, approved });
      resolve(approved);
    });
    broadcast("approval_request", { id, summary, detail });
  });
}

app.post("/api/approve", (req, res) => {
  const { id, approved } = req.body ?? {};
  const resolver = pendingApprovals.get(id);
  if (!resolver) return res.status(404).json({ error: "No such pending approval" });
  resolver(Boolean(approved));
  res.json({ ok: true });
});

// --- Chat -------------------------------------------------------------------
const agentEvents: AgentEvents = { emit: broadcast, requestApproval };

app.post("/api/chat", (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Empty message" });
  res.json({ ok: true });
  void runTurn(message, agentEvents);
});

app.get("/api/history", (_req, res) => {
  // Return only displayable turns: plain user text + assistant text blocks.
  const display: { role: string; text: string }[] = [];
  for (const m of getHistory()) {
    if (m.role === "user" && typeof m.content === "string") {
      display.push({ role: "user", text: m.content.replace(/^\[context[\s\S]*?\]\n\n/, "") });
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (text) display.push({ role: "assistant", text });
    }
  }
  res.json(display);
});

app.post("/api/reset", (_req, res) => {
  resetHistory();
  res.json({ ok: true });
});

app.get("/api/status", async (_req, res) => {
  res.json({
    text: await systemStatusText(),
    online: Boolean(process.env.ANTHROPIC_API_KEY),
    serverVoice: (await voice.isAvailable()) && voice.isEnabled(),
    serverVoiceAvailable: await voice.isAvailable(),
    voiceEngine: (await voice.detect()).engine,
    voiceDetail: (await voice.detect()).detail,
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
app.listen(port, host, () => {
  console.log(`\n  J.A.R.V.I.S. online → http://${host}:${port}\n`);
  void voice.detect().then(({ engine, detail }) => {
    console.log(engine === "none"
      ? "  ⚠ No TTS engine found — install speech-dispatcher, or run the Piper setup."
      : `  Voice: ${engine} (${detail})`);
  });
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("  ⚠ ANTHROPIC_API_KEY not set — copy .env.example to .env and add your key.\n");
  }
});
