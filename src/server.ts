import path from "node:path";
import express from "express";
import { addressed, config, CONFIG_FILE, DATA_DIR, ROOT } from "./config.js";
import { getHistory, resetHistory, runTurn, cancelTurn, turnInFlight, CONTEXT_END, setAsideHistory, restoreHistory, onOperatorTurn, setLearnContext, type AgentEvents } from "./agent.js";
import { freeWriteZone, setPracticeSimulator, systemStatusText, toolDefinitions } from "./tools.js";
import { createApprovals } from "./approvals.js";
import { createLearn } from "./learn.js";
import { clearInjectionAlarm } from "./injection.js";
import { DESK_DIR, exportPdf } from "./export-pdf.js";
import { embeddingProvider } from "./memory.js";
import { entryKey, parseSchedule, SCHEDULE_FILE } from "./schedule-format.js";
import { isLocalEndpoint, pickBrain } from "./brain.js";
import * as voice from "./voice.js";
import * as ears from "./ears.js";
import { redact, redactDeep } from "./redact.js";
import { banner } from "./banner.js";
import { board } from "./board.js";
import { grantForTask } from "./consequence.js";
import { ensureToken, currentToken, requireAuth, issueSession } from "./auth.js";
import { loadPrefs, savePrefs } from "./hud-prefs.js";
import { displayHistory } from "./history-view.js";
import { connectAll as connectMcp, listMcpTools, listMcpStates, loginMcp, shutdown as shutdownMcp } from "./mcp.js";
import { addMcpServerSnippet } from "./mcp-config.js";
import {
  addConnector,
  connectorSnapshot,
  loginConnector,
  removeConnector,
  retryConnector,
} from "./connectors.js";
import { startHeartbeat, heartbeatStatus } from "./heartbeat.js";
import { startSchedule, scheduleStatus } from "./schedule.js";
import { startRemoteWatch } from "./remote-watch.js";
import { listSkills, readSkill, skillCatalog } from "./workspace.js";
import { loadLandscape } from "./landscape.js";
import { brainLabel, brainReady, activeProvider, applyBrainCommand, catalogStatus, bootBrainLines, bannerBrain, missingKeyHint, sessionSpend, lastTurnCost } from "./brain.js";
import { createRequire } from "node:module";
import { startTelegram, sendApprovalCard, approvalSettled, telegramStatus, sendAlert as telegramAlert } from "./telegram.js";
import { startDiscord, sendApprovalCard as sendDiscordCard, approvalSettled as discordSettled, discordStatus, sendAlert as discordAlert } from "./discord.js";
import { startNtfy, sendApprovalAlert, approvalSettled as ntfySettled, ntfyStatus, notifyPhone } from "./ntfy.js";
import { startHomeWatch, homeWatchStatus } from "./home-events.js";
import { describeVisitor } from "./home-vision.js";
import { inRange as receiptsInRange, loadLedger as loadReceipts, toCsv as receiptsCsv } from "./receipts.js";
import { openPreview, closePreview, reloadPreview, previewState, servedDir } from "./preview.js";
import fs from "node:fs";
import { collapseHome, isSensitivePath } from "./paths.js";
import { listKeys, setKey, deleteKey, checkKey } from "./keys.js";
import { setupNeeded, markLocalReady, localRuntimeReachable, openInBrowser, hasUsableCloudKey } from "./first-run.js";
import { saveOwner, applyOwner } from "./owner.js";
import { pinBrain, catalog as brainCatalog } from "./brain.js";
import { dietStatus } from "./tool-diet.js";
import { jobs, TERMINAL_STATES } from "./jobs.js";
import { foreman, reportText, startForeman } from "./foreman.js";
import { hostGate } from "./pocket-host.js";
import { createPocket, POCKET_LARGE_BODIES } from "./pocket.js";
import { createUpdates, feedUrl } from "./updates.js";
import { installKind } from "./home-root.js";
import { IDENTITY_PATH, identityRoute, portClashMessage, probePort } from "./port-clash.js";
import { createBridge } from "./pocket-bridge.js";
import { createRelayTransport, loadRelayIdentity, relayConfig } from "./pocket-relay.js";

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

// Pocket Claw, the phone app (src/pocket.ts). Made before the gate, which
// asks it for the operator's tailnet name. What it is handed are hoisted
// declarations further down; none of them runs until a request arrives.
const pocket = createPocket({
  dataDir: DATA_DIR,
  uploadsDir: path.join(os.homedir(), "Documents", "CunningClaw", "uploads"),
  configuredHosts: () => config.pocket?.hosts ?? [],
  // A phone is a phone: Pocket settles as one, so a Learn mode practice card
  // can never be answered from it (approvals.ts refuses "phone" on those).
  settleApproval: (id, approved) => settleFromPhone(id, approved),
  chat: (message) => acceptChat(message),
  history: () => displayHistory(getHistory(), CONTEXT_END),
  listen: (wav) => ears.listen(wav, { settings: ears.earsSettings() }),
  readBody: (req, max) => ears.readCapped(req, Math.min(max, ears.earsSettings().maxBytes), Number(req.headers["content-length"])),
  notice: (message) => broadcast("notice", { message }),
  clawName: () => config.persona.name,
  unlockMinutes: config.pocket?.unlockMinutes,
  pairingMinutes: config.pocket?.pairingMinutes,
  vapidSubject: config.pocket?.vapidSubject,
  staticDir: path.join(ROOT, "public", "pocket"),
  jobs,
  relay: () => pocketRelay,
});

// The update check (src/updates.ts): off until the owner answers, one small
// GET a day after a yes. Made here, before the routes, so /api/status can
// read it; armed at boot, after the phone lines it may tell.
const updates = createUpdates({
  dataDir: DATA_DIR,
  current: VERSION,
  url: feedUrl(config.updates?.url),
  fetch,
  now: Date.now,
  install: installKind({ codeRoot: ROOT, exists: fs.existsSync, readFile: (p) => fs.readFileSync(p, "utf-8") }),
  platform: process.platform,
  arch: process.arch,
  emit: (status) => broadcast("updates", status),
  // One fixed line with a version number in it, to each phone line that is
  // set up — each of which redacts in its own send(). Never the summary.
  notify: (text) => {
    void telegramAlert(text).catch(() => 0);
    void discordAlert(text).catch(() => 0);
    void notifyPhone({ kind: "update", title: "Cunning Claw", body: text });
    void pocket.pushNote(text).catch(() => 0);
  },
  phones: () => telegramStatus().enabled || discordStatus().enabled || ntfyStatus().enabled || pocket.canPush(),
  log: (line) => console.log(`  ${line}`),
});
// Pocket through Dragon Forge's relay (src/pocket-relay.ts): a second way in
// to the same router, never a second Pocket. The bridge dispatches what
// arrives on an end-to-end channel into pocket.phone in-process, so no port
// is opened for it. Null when pocket.relay is switched off or has no URL.
const relaySettings = relayConfig(config.pocket?.relay);
const pocketRelay = relaySettings
  ? createRelayTransport({
    config: relaySettings,
    identity: loadRelayIdentity(DATA_DIR),
    pocket,
    dispatch: createBridge(pocket.phone, { largeBodies: POCKET_LARGE_BODIES, host: new URL(relaySettings.appOrigin).host, origin: relaySettings.appOrigin }).dispatch,
    notice: (message) => broadcast("notice", { message }),
  })
  : null;

// Before every route: a request must name this claw. Loopback names get the
// HUD; the operator's tailnet name gets /pocket/ and nothing else; any other
// name — a DNS-rebinding page, a stray proxy — is refused before GET / can
// hand it the session cookie (src/pocket-host.ts).
app.use(hostGate(() => ({ bindHost: config.server.host, pocketHosts: pocket.hosts() })));

// 1MB is right for chat and control traffic. The paperclip route is not:
// it carries a base64 file. body-parser sets req._body after the FIRST parse,
// so the route-level express.json({limit:"30mb"}) on /api/upload was a silent
// no-op — every upload over 1MB died here instead, answering with
// body-parser's HTML error page (absolute node_modules paths and all) rather
// than the route's own JSON. Skip the global parser for that one path and let
// the route's larger one actually run.
const smallJson = express.json({ limit: "1mb" });
app.use((req, res, next) =>
  req.path === "/api/upload" || POCKET_LARGE_BODIES.has(req.path) ? next() : smallJson(req, res, next),
);

// Who is on this port: a second copy, started while this one runs, asks it
// before saying anything (src/port-clash.ts). Behind the host gate, needs no
// session, and says only that it is Cunning Claw and which version.
app.get(IDENTITY_PATH, identityRoute(VERSION));

// Loading the HUD hands the browser its session, so EventSource — which cannot
// set headers — can authenticate on the stream that follows.
app.get(["/board", "/board.html"], (_req, res) => {
  issueSession(res);
  res.sendFile(path.join(ROOT, "public", "board.html"));
});

app.get(["/docs", "/docs.html"], (_req, res) => {
  issueSession(res);
  res.sendFile(path.join(ROOT, "public", "docs.html"));
});

app.get(["/keys", "/keys.html"], (_req, res) => {
  issueSession(res);
  res.sendFile(path.join(ROOT, "public", "keys.html"));
});

app.get(["/welcome", "/welcome.html"], (_req, res) => {
  issueSession(res);
  res.sendFile(path.join(ROOT, "public", "welcome.html"));
});

app.get(["/", "/index.html"], (req, res) => {
  issueSession(res);
  // With no brain able to run, the HUD would only answer "no key". Send a new
  // owner to the page that fixes that; ?hud opens the HUD regardless.
  if (setupNeeded() && req.query.hud === undefined) return res.redirect(302, "/welcome");
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

// The static assets are the same files any visitor to the page would fetch;
// nothing behind them is sensitive. Everything under /api is.
// The phone's routes come first: they authenticate by device token, not the HUD session.
app.use(pocket.phone);
app.use(express.static(path.join(ROOT, "public")));
app.use("/api", requireAuth);
app.use("/api/pocket", pocket.admin);

// --- SSE event bus (single-user app: broadcast to all connected clients) ---
const sseClients = new Set<express.Response>();

function broadcast(event: string, data: unknown): void {
  // Single choke point for everything the HUD, Telegram and the voice see.
  // Redacting here covers every event without each emitter having to remember.
  const clean = redactDeep(data);
  const payload = `event: ${event}\ndata: ${JSON.stringify(clean)}\n\n`;
  for (const res of sseClients) res.write(payload);
  // The phone gets the redacted copy, filtered further by its own rules.
  pocket.onEvent(event, clean);

  // Server-side voice: which events speak, which stop it, and why a heartbeat
  // waits its turn, live in voice.react() where they are tested.
  voice.react(event, data);
}

// Mission control: every change to a job reaches the HUD through the one
// redacted chokepoint, never a side channel.
jobs.setEmitter((job) => broadcast("job", job));

// The HUD's mic must know when the speakers are talking, or it hears the claw
// and posts the reply back as the operator's words (24 Oct). The spoken text
// rides along so the HUD can also recognise an echo that slips past the pause.
voice.onSpeaking((state) => broadcast("speaking", state));

// Pressing the mic while the claw is talking means "stop, I'm speaking".
// Behind requireAuth like the rest of /api.
app.post("/api/voice/stop", (_req, res) => {
  voice.cancel();
  res.json({ ok: true });
});

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("event: hello\ndata: {}\n\n");
  // A HUD that (re)connects mid-sentence would otherwise open its mic into it.
  if (voice.isSpeaking()) res.write(`event: speaking\ndata: ${JSON.stringify({ on: true })}\n\n`);
  sseClients.add(res);
  const keepalive = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

// --- Approval flow ----------------------------------------------------------
// The registry lives in src/approvals.ts, where it is tested: which card goes
// to which phone, the timeout, and the practice cards Learn mode raises.
const approvals = createApprovals({
  broadcast,
  // The operator's spoken passphrase for SAY, from .env; read at each use so
  // a change in .env needs no restart of this registry. Never broadcast.
  passphrase: () => process.env.CLAW_SAY_PASSPHRASE ?? null,
  listening: () => sayListening(),
  phones: [
    { sendCard: sendApprovalCard, settled: approvalSettled },
    { sendCard: sendDiscordCard, settled: discordSettled },
  ],
  alert: {
    // ntfy cannot carry the verdict back, so it says where to give it.
    send: (id, summary) => sendApprovalAlert(id, summary, [
      ...(telegramStatus().enabled ? ["Telegram"] : []),
      ...(discordStatus().enabled ? ["Discord"] : []),
    ]),
    settled: ntfySettled,
  },
  timeoutMs: () => config.commandPolicy.approvalTimeoutMs,
  grantForTask,
});

/** A phone line may answer only real cards; practice ones never left the HUD. */
const settleFromPhone = (id: string, approved: boolean) => approvals.settle(id, approved, { by: "phone" });

/**
 * Deny everything currently awaiting a click.
 *
 * A turn parked on an approval holds the agent. If the user is right there
 * typing a new instruction, that instruction is the answer — waiting out the
 * timeout serves nobody. Denying is the safe resolution: the stalled tool does
 * not run, and its turn unwinds.
 */
function cancelPendingApprovals(reason: string): number {
  const n = approvals.cancelAll();
  if (n) broadcast("notice", { message: `${n} pending approval(s) cancelled — ${reason}` });
  return n;
}

// An answer to a card, heard by the HUD's microphone and transcribed on this
// machine (src/ears.ts). Only the HUD reaches /api (the host gate gives Pocket
// /pocket/ alone), and only a code shown on the HUD's card can approve; see
// settleSpoken in src/approvals.ts. Not an instruction, so it does not cancel
// pending cards the way a chat message does.
// SAY's microphone lives in the HUD, so the HUD says when it is listening
// (on load, on the switch, and every 30 s while on). A HUD closed without
// saying goodbye lapses after 90 s rather than staying "listening" for ever.
let sayHeardFrom = 0;
function sayListening(now = Date.now()): boolean {
  return now - sayHeardFrom < 90_000;
}
app.post("/api/say/listening", (req, res) => {
  sayHeardFrom = req.body?.on === true ? Date.now() : 0;
  res.json({ listening: sayListening() });
});
app.post("/api/say/missed", (_req, res) => {
  // The HUD tried and heard no answer it could use; the operator, who may
  // not be looking, is told out loud (voice.ts) that the card still waits.
  broadcast("say_missed", {});
  res.json({ ok: true });
});

app.post("/api/approve/spoken", (req, res) => {
  const text = String(req.body?.text ?? "").slice(0, 200);
  const result = approvals.settleSpoken(text);
  if (result.outcome === "wrong-code") {
    broadcast("notice", { message: `That code did not match, ${addressed()}. ${result.count} card(s) denied, to be safe.` });
  } else if (result.outcome === "denied") {
    broadcast("notice", { message: `Denied by voice, ${addressed()}.` });
  } else if (result.outcome === "ambiguous") {
    broadcast("notice", { message: `${result.count} cards are waiting, ${addressed()}, so the passphrase cannot say which. Say "approve" and the two words on the card you mean.` });
  } else if (result.outcome === "code-only") {
    // The card's own text holds the passphrase (approvals.ts says why).
    broadcast("notice", { message: `That card's own words contain your passphrase, ${addressed()}, so it cannot answer it. Say "approve" and the two words on the card.` });
  }
  res.json(result);
});

app.post("/api/approve", (req, res) => {
  // "approve for this task" widens scope until the turn ends, on a real card
  // only, and never covers an irreversible action (approvals.ts, consequence.ts).
  const { id, approved } = req.body ?? {};
  if (!approvals.settle(String(id ?? ""), Boolean(approved), { by: "hud", scope: req.body?.scope === "task" ? "task" : undefined })) {
    return res.status(404).json({ error: "No such pending approval" });
  }
  res.json({ ok: true });
});

// --- Chat -------------------------------------------------------------------
const agentEvents: AgentEvents = { emit: broadcast, requestApproval: (summary, detail) => approvals.request(summary, detail) };

// --- Learn mode (src/learn.ts) ------------------------------------------------
// Every route below is the operator's own HUD, behind requireAuth. Nothing else
// can start a lesson or open the practice ground: no tool, no tool result, no
// phone line. That is T15 in docs/LEARN-MODE.md, and it is why a page cannot
// make a real card look like practice.
const learn = createLearn({
  root: path.join(ROOT, "learn"),
  dataDir: DATA_DIR,
  now: () => new Date(),
  emit: broadcast,
  agent: {
    busy: () => turnInFlight().busy,
    setAside: setAsideHistory,
    restore: restoreHistory,
    runPracticeTurn: (message) => runTurn(message, agentEvents, { kind: "user", practice: true }),
  },
  setSimulator: setPracticeSimulator,
  requestPractice: approvals.requestPractice,
  cancelPracticeCards: approvals.cancelPractice,
  clearAlarm: clearInjectionAlarm,
  redact: (text) => redact(text),
  facts: () => {
    const brain = pickBrain("user");
    const embed = embeddingProvider();
    return {
      cloudBrain: brain.provider === "anthropic" || !isLocalEndpoint(brain.baseUrl),
      cloudEmbeddings: embed === "gemini" || embed === "openrouter",
      telegram: telegramStatus().enabled,
      discord: discordStatus().enabled,
      ntfy: ntfyStatus().enabled,
      mcp: connectorSnapshot().connected > 0,
    };
  },
  armedOrders: () => {
    try {
      return parseSchedule(fs.readFileSync(SCHEDULE_FILE, "utf-8")).entries.filter((e) => e.enabled).map(entryKey);
    } catch {
      return [];
    }
  },
  // The operator pressed the button, so the click is the consent; a Desk PDF
  // is a new file in the claw's own ground, which write_file's rule frees anyway.
  exportPdf: (file) => exportPdf({ source: file }, { approve: async () => true, freeWriteZone, taskGrant: () => false }),
  deskDir: DESK_DIR,
});
onOperatorTurn(() => learn.operatorTurn());
setLearnContext(() => learn.contextLine());

const learnBody = (req: express.Request) => (req.body ?? {}) as Record<string, any>;
const learnReply = (res: express.Response, out: { ok: boolean; error?: string }) =>
  res.status(out.ok ? 200 : 400).json(out);

app.get("/api/learn", (_req, res) => res.json(learn.catalogue()));
app.post("/api/learn/start", (req, res) => learnReply(res, learn.start(String(learnBody(req).lesson ?? ""))));
app.post("/api/learn/next", (_req, res) => learnReply(res, learn.advance()));
app.post("/api/learn/stop", (_req, res) => learnReply(res, learn.stop()));
app.post("/api/learn/answer", (req, res) => {
  const b = learnBody(req);
  learnReply(res, learn.answer({
    text: typeof b.text === "string" ? b.text : undefined,
    choice: Array.isArray(b.choice) ? b.choice.map(Number) : undefined,
    confidence: typeof b.confidence === "string" ? b.confidence : undefined,
  }));
});
app.post("/api/learn/real", (req, res) => learnReply(res, learn.setRealTask(String(learnBody(req).task ?? ""))));
app.post("/api/learn/done", (_req, res) => learnReply(res, learn.verifyReal()));
app.post("/api/learn/again", (_req, res) => learnReply(res, learn.practiseAgain()));
app.post("/api/learn/practice/start", (_req, res) => learnReply(res, learn.startPractice()));
app.post("/api/learn/practice/end", (_req, res) => learnReply(res, learn.endPractice("the operator left the practice ground")));
app.post("/api/learn/practice/predict", (req, res) => learnReply(res, learn.predict(String(learnBody(req).choice ?? ""))));
app.post("/api/learn/practice/report", (req, res) => {
  const i = learnBody(req).index;
  learnReply(res, learn.report(i === null || i === undefined ? null : Number(i)));
});
app.post("/api/learn/practice/say", (req, res) => learnReply(res, learn.practiceSay(String(learnBody(req).message ?? ""))));
app.get("/api/learn/review", (_req, res) => res.json(learn.review()));
app.post("/api/learn/review", (req, res) => {
  const b = learnBody(req);
  learnReply(res, learn.reviewAnswer(String(b.key ?? ""), {
    text: typeof b.text === "string" ? b.text : undefined,
    choice: Array.isArray(b.choice) ? b.choice.map(Number) : undefined,
    confidence: typeof b.confidence === "string" ? b.confidence : undefined,
  }));
});
app.post("/api/learn/prefs", (req, res) => {
  const b = learnBody(req);
  if (typeof b.nudges === "boolean") learn.setNudges(b.nudges);
  if (typeof b.lang === "string") learn.setLang(b.lang);
  res.json(learn.catalogue());
});
app.post("/api/learn/record", async (_req, res) => {
  try {
    const out = await learn.recordOfLearning();
    // The glass is screenshotted and filmed: home collapses to ~ (CLAUDE.md).
    // export_pdf's last line is advice for the model, not for the operator.
    res.json({
      ...out,
      markdown: collapseHome(out.markdown),
      message: out.message.split("\n").filter((l) => !l.startsWith("Check it with read_document")).join(" "),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

app.post("/api/cancel", (_req, res) => {
  const { forMs } = turnInFlight();
  const stopped = cancelTurn("operator asked to stop");
  if (stopped) {
    broadcast("notice", { message: `Abandoned the request after ${Math.round(forMs / 1000)}s.` });
    // stopped: true is what silences the voice (voice.react) and browser TTS.
    broadcast("turn_done", { text: "", stopped: true });
  } else {
    // No turn running, but the last reply may still be being read aloud.
    voice.cancel();
  }
  res.json({ ok: true, stopped });
});

/** Said out loud or typed, "stop" should stop him — not queue behind the thing it wants stopped. */
const STOP_WORDS = /^\s*(stop|cancel|abort|halt|never ?mind|forget it|leave it)\b[\s.!]*$/i;

app.post("/api/chat", (req, res) => {
  const out = acceptChat(String(req.body?.message ?? ""));
  res.status(out.status).json(out.body);
});

/**
 * An operator instruction, from the HUD or from Pocket Claw: the same stop
 * words, brain commands and approval-cancelling rule whichever glass it came
 * from. Answers at once; the turn itself streams over the event bus.
 */
function acceptChat(raw: string): { status: number; body: unknown } {
  // A real message from the operator ends practice first — stop words and
  // brain commands included — so nothing typed here runs on the practice ground.
  learn.operatorTurn();
  // A new instruction outranks a turn parked on an unanswered approval.
  if (approvals.pendingCount() > 0) cancelPendingApprovals("superseded by a new instruction");
  const message = raw.trim();
  if (!message) return { status: 400, body: { error: "Empty message" } };

  if (STOP_WORDS.test(message)) {
    const { forMs } = turnInFlight();
    const stopped = cancelTurn("operator said stop");
    broadcast("notice", {
      message: stopped
        ? `Stopped, ${addressed()} — abandoned after ${Math.round(forMs / 1000)}s.`
        : `Nothing was running, ${addressed()}.`,
    });
    // Also when nothing was running: "stop" while he is reading a reply out
    // means stop reading. stopped: true is what voice.react() cancels on.
    broadcast("turn_done", { text: "", stopped: true });
    return { status: 200, body: { ok: true, stopped } };
  }
  const brainReply = applyBrainCommand(message);
  if (brainReply !== null) {
    broadcast("notice", { message: brainReply });
    broadcast("brain", catalogStatus());
    return { status: 200, body: { ok: true, command: true } };
  }
  void runTurn(message, agentEvents);
  return { status: 200, body: { ok: true } };
}

// --- Mission control ----------------------------------------------------------
// The list, a cancel, and a foreman job's report. Behind requireAuth like the
// rest of /api; redacted like everything else that reaches the glass.
app.get("/api/jobs", (_req, res) => {
  res.json(redactDeep({ jobs: jobs.list().map((j) => ({ ...j, cancellable: jobs.canCancel(j.id) })) }));
});

app.post("/api/jobs/:id/cancel", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "No such job" });
  const r = await jobs.cancel(job.id);
  res.status(r.ok ? 200 : 409).json({ ...r, job: redactDeep(jobs.get(job.id)) });
});

app.get("/api/jobs/:id/review", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "No such job" });
  if (job.kind !== "foreman" || !TERMINAL_STATES.includes(job.state)) {
    return res.status(409).json({ error: "Only a finished coding job has a report to review" });
  }
  const record = foreman().get(job.id);
  if (!record) return res.status(404).json({ error: "The report for that job is gone" });
  // The same text the model reads: our facts plain, Claude Code's words
  // inside the fence. The HUD renders it with textContent.
  res.json(redactDeep({ id: job.id, text: reportText(record) }));
});

// --- The Keys page: the easy-secrets place -----------------------------------
// Values are WRITE-ONLY through this API: set/unset and a four-character tail
// go out, never a value. The roster in src/keys.ts is the whole attack surface.
app.get("/api/keys", (_req, res) => {
  res.json(listKeys());
});

app.post("/api/keys", (req, res) => {
  const out = setKey(String(req.body?.name ?? ""), String(req.body?.value ?? ""));
  if (!out.ok) return res.status(400).json(out);
  broadcast("notice", { message: out.message });
  res.json(out);
});

app.delete("/api/keys/:name", (req, res) => {
  const out = deleteKey(String(req.params.name ?? ""));
  if (!out.ok) return res.status(400).json(out);
  broadcast("notice", { message: out.message });
  res.json(out);
});

// --- Setup: the first-run page -----------------------------------------------
// Three narrow writes and nothing else: one brain key (checked for free before
// it is saved), the offline brain, and the owner's name and town.
const SETUP_KEYS = new Set(["OPENROUTER_API_KEY", "GEMINI_API_KEY"]);

app.get("/api/welcome", async (_req, res) => {
  res.json({
    needed: setupNeeded(),
    cloudKey: hasUsableCloudKey(),
    ollama: await localRuntimeReachable(),
    owner: { userName: config.persona.userName, addressUserAs: config.persona.addressUserAs, weatherPlace: config.board?.weatherPlace ?? "" },
    claw: config.persona.name,
    updates: updates.status().consent,
  });
});

app.post("/api/welcome/key", async (req, res) => {
  const name = String(req.body?.name ?? "");
  const value = String(req.body?.value ?? "").trim();
  if (!SETUP_KEYS.has(name)) return res.status(400).json({ ok: false, message: "Setup takes an OpenRouter or a Google Gemini key." });
  if (!value) return res.status(400).json({ ok: false, message: "Paste the key first." });
  const check = await checkKey(name, value);
  if (check.status === "invalid") return res.status(400).json({ ok: false, message: check.message });
  const saved = setKey(name, value);
  if (!saved.ok) return res.status(400).json(saved);
  // The default roster runs on OpenRouter. With only a Google key, AUTO would
  // keep choosing brains that cannot run; pin the one that can, and say so.
  let pinned = "";
  if (name === "GEMINI_API_KEY" && !process.env.OPENROUTER_API_KEY?.trim() && brainCatalog().some((b) => b.id === "google")) {
    pinBrain("google");
    pinned = "google";
  }
  res.json({ ok: true, message: check.message, pinned });
});

app.post("/api/welcome/local", async (_req, res) => {
  if (!(await localRuntimeReachable())) {
    return res.status(400).json({
      ok: false,
      message: "Nothing answered on this machine's Ollama port. Install Ollama from ollama.com, run `ollama pull llama3.2`, then press this again.",
    });
  }
  if (!brainCatalog().some((b) => b.id === "local")) return res.status(400).json({ ok: false, message: "No local brain is in this install's roster." });
  markLocalReady();
  pinBrain("local");
  res.json({ ok: true, message: "Ollama answered. The offline brain is chosen — nothing you say leaves this machine." });
});

app.post("/api/welcome/owner", (req, res) => {
  const saved = saveOwner(DATA_DIR, req.body ?? {});
  applyOwner(config, saved);
  res.json({ ok: true, owner: saved });
});

// --- The update check ---------------------------------------------------------
// The HUD's chip and panel, and the setup page's question. The model has no
// route here and no tool for it: what the feed says is display text only.
app.get("/api/updates", (_req, res) => {
  res.json(updates.status());
});

app.post("/api/updates/settings", async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.check !== "boolean" && typeof b.phoneNote !== "boolean") {
    return res.status(400).json({ error: "Send check and/or phoneNote, true or false." });
  }
  if (typeof b.phoneNote === "boolean") updates.setPhoneNote(b.phoneNote);
  const now = typeof b.check === "boolean" ? updates.setConsent(b.check) : updates.status();
  // A yes starts a check. Answer with its result, not the "checking" from
  // before it: a reply that raced the event stream used to land last and
  // leave the HUD saying CHECKING… for good. The check is bounded by its
  // own timeout.
  res.json(now.checking ? await updates.checkNow() : now);
});

app.post("/api/updates/check", async (_req, res) => {
  res.json(await updates.checkNow());
});

app.get("/api/history", (_req, res) => {
  res.json(displayHistory(getHistory(), CONTEXT_END));
});

app.post("/api/reset", (_req, res) => {
  // Reset clears the real conversation, so practice must hand it back first.
  learn.operatorTurn();
  resetHistory();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// The Desk — local documents, shared ground between the operator and the claw.
//
// Plain markdown files in ~/Documents/CunningClaw: the HUD's Docs page edits
// them, and the assistant reads and drafts the very same files with its file
// tools. A local Google-Docs feeling with the AI as co-author — no cloud.
// Names are jailed hard; deletion is a move to .trash, never destruction.
// ---------------------------------------------------------------------------

import os from "node:os";

const DOCS_DIR = path.join(os.homedir(), "Documents", "CunningClaw");

function docPath(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _'()&-]{0,80}$/.test(name)) return null;
  const p = path.join(DOCS_DIR, `${name}.md`);
  return p.startsWith(DOCS_DIR + path.sep) ? p : null;
}

/**
 * The chat paperclip. Files land in the Desk's uploads folder, where both
 * the operator and the assistant can reach them; the chat message carries the path.
 */
app.post("/api/upload", express.json({ limit: "30mb" }), (req, res) => {
  const name = String(req.body?.name ?? "").replace(/[^A-Za-z0-9 ._()-]/g, "_").slice(0, 100);
  const data = String(req.body?.data ?? "");
  if (!name || !data) return res.status(400).json({ error: "name and data required" });
  if (data.length > 28_000_000) return res.status(413).json({ error: "file too large (20MB cap)" });
  let buf: Buffer;
  try {
    buf = Buffer.from(data, "base64");
  } catch {
    return res.status(400).json({ error: "data must be base64" });
  }
  const dir = path.join(DOCS_DIR, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, name);
  if (fs.existsSync(target)) {
    const ext = path.extname(name);
    target = path.join(dir, `${path.basename(name, ext)}-${Date.now()}${ext}`);
  }
  fs.writeFileSync(target, buf);
  res.json({ ok: true, path: target, bytes: buf.length });
});

app.get("/api/docs", (_req, res) => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const items = fs.readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const st = fs.statSync(path.join(DOCS_DIR, f));
      return { name: f.slice(0, -3), modified: st.mtime.toISOString(), bytes: st.size };
    })
    .sort((a, b) => (a.modified < b.modified ? 1 : -1));
  res.json({ dir: DOCS_DIR, items });
});

app.get("/api/docs/:name", (req, res) => {
  const p = docPath(String(req.params.name ?? ""));
  if (!p) return res.status(400).json({ error: "bad document name" });
  if (!fs.existsSync(p)) return res.status(404).json({ error: "no such document" });
  res.json({ name: req.params.name, content: fs.readFileSync(p, "utf-8") });
});

app.put("/api/docs/:name", (req, res) => {
  const p = docPath(String(req.params.name ?? ""));
  if (!p) return res.status(400).json({ error: "bad document name" });
  const content = String(req.body?.content ?? "");
  if (content.length > 2_000_000) return res.status(413).json({ error: "document too large" });
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
  res.json({ ok: true, saved: new Date().toISOString() });
});

app.delete("/api/docs/:name", (req, res) => {
  const p = docPath(String(req.params.name ?? ""));
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "no such document" });
  const trash = path.join(DOCS_DIR, ".trash");
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(p, path.join(trash, `${Date.now()}-${path.basename(p)}`));
  res.json({ ok: true, note: "moved to .trash, not destroyed" });
});

/**
 * The receipts ledger as a download, for the operator or their accountant.
 * The same rows the receipts tool exports; dates are the receipts' own.
 * Read-only, and behind requireAuth like the rest of /api.
 */
app.get("/api/receipts", (req, res) => {
  const day = (v: unknown) => {
    const s = String(v ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
  };
  const from = day(req.query.from);
  const to = day(req.query.to);
  const rows = receiptsInRange(loadReceipts(), from, to, req.query.void === "1");
  const name = `receipts_${from || "start"}_${to || "end"}`;
  if (req.query.format === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="${name}.json"`);
    return res.json(rows);
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
  res.send(receiptsCsv(rows));
});

app.get("/api/board", async (_req, res) => {
  try {
    res.json(await board());
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── MCP: the servers panel in the HUD ──────────────────────────────────────
app.get("/api/mcp", (_req, res) => {
  const snap = connectorSnapshot();
  res.json({
    ...snap,
    servers: listMcpStates(),
    toolCount: listMcpTools().length,
  });
});

/** Reconnect all servers — after adding one, or to retry a failed one. */
app.post("/api/mcp/reconnect", async (_req, res) => {
  await connectMcp((line) => broadcast("notice", { message: line.trim() }));
  res.json({ ok: true, servers: listMcpStates() });
});

/** Start the OAuth flow for a hosted server. Opens the system browser. */
app.post("/api/mcp/login", async (req, res) => {
  const id = String(req.body?.id ?? "");
  if (!id) return res.status(400).json({ error: "server id required" });
  try {
    const msg = await loginMcp(id, (line) => broadcast("notice", { message: line.trim() }));
    await connectMcp(() => {});
    res.json({ ok: true, message: msg, servers: listMcpStates() });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

/**
 * Add a server from a pasted Claude-Code snippet — the same
 * { "mcpServers": { … } } JSON people already copy from vendor docs. Written
 * to the user's own config file, then connected. Servers still come only from
 * files the user owns; this is a convenience over hand-editing, not discovery.
 */
app.post("/api/mcp/add", async (req, res) => {
  try {
    const added = addMcpServerSnippet(req.body?.snippet ?? req.body ?? {});
    await connectMcp((line) => broadcast("notice", { message: line.trim() }));
    res.json({ ok: true, added, servers: listMcpStates() });
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message ?? err) });
  }
});

app.get("/api/status", async (_req, res) => {
  const hb = heartbeatStatus();
  const landscape = loadLandscape();
  res.json({
    // The HUD shows it beside the logo, so an operator can see an update took.
    version: VERSION,
    // The chip's light. Not in `text`, which the model also reads.
    updates: updates.status(),
    text: await systemStatusText(),
    online: brainReady(),
    brain: { provider: activeProvider(), model: brainLabel() },
    brains: catalogStatus(),
    serverVoice: (await voice.isAvailable()) && voice.isEnabled(),
    serverVoiceAvailable: await voice.isAvailable(),
    voiceEngine: (await voice.detect()).engine,
    voiceDetail: (await voice.detect()).detail,
    ears: ears.earsStatus(await ears.detectEars()),
    skills: listSkills().length,
    skillCatalog: skillCatalog(),
    heartbeat: hb,
    schedule: scheduleStatus(),
    landscapeUpdated: landscape.updated,
    landscapeCount: landscape.systems.length,
    telegram: telegramStatus(),
    discord: discordStatus(),
    ntfy: ntfyStatus(),
    home: homeWatchStatus(),
    toolCount: toolDefinitions.length,
    addressAs: addressed(),
    spend: sessionSpend(),
    turn: turnInFlight(),
    lastTurn: lastTurnCost(),
    // What the last request's tool schemas cost against sending every one.
    toolDiet: dietStatus(),
    preview: previewState(),
    mcp: (() => {
      const snap = connectorSnapshot();
      return {
        enabled: snap.enabled,
        connected: snap.connected,
        needsAuth: snap.needsAuth,
        total: snap.connectors.filter((c) => c.configured).length,
      };
    })(),
  });
});

/**
 * Read-only static serving for the viewport — only directories the preview
 * tool explicitly registered, loopback-only like everything else, no auth
 * because the viewport iframe cannot send headers. Traversal is walled and
 * the sensitive-path denylist applies file by file.
 */
app.get("/served/:token/*", (req, res) => {
  const dir = servedDir(String(req.params.token ?? ""));
  if (!dir) return res.status(404).send("Nothing is served under that token.");
  const rel = String((req.params as Record<string, string>)[0] ?? "") || "index.html";
  const target = path.resolve(dir, rel);
  if (target !== dir && !target.startsWith(dir + path.sep)) {
    return res.status(403).send("Path escapes the served folder.");
  }
  if (isSensitivePath(target)) return res.status(403).send("Not serving that file.");
  if (!fs.existsSync(target)) return res.status(404).send("Not found.");
  if (fs.statSync(target).isDirectory()) {
    const index = path.join(target, "index.html");
    if (fs.existsSync(index)) return res.sendFile(index);
    return res.status(404).send("No index.html in that folder.");
  }
  res.sendFile(target);
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

app.post("/api/mcp", async (req, res) => {
  const result = await addConnector(req.body ?? {});
  res.status(result.ok ? 200 : 400).json(result);
});

app.delete("/api/mcp/:id", async (req, res) => {
  const result = await removeConnector(String(req.params.id ?? ""));
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/mcp/:id/login", async (req, res) => {
  // The HUD presses this one, not /api/mcp/login — so this is the route that
  // has to narrate the flow. Without the callback the sign-in URL and the
  // three-minute wait were invisible, and the button looked broken.
  const result = await loginConnector(String(req.params.id ?? ""), (line) =>
    broadcast("notice", { message: line.trim() }),
  );
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/mcp/:id/connect", async (req, res) => {
  const result = await retryConnector(String(req.params.id ?? ""));
  res.status(result.ok ? 200 : 400).json(result);
});

// --- Voice control ----------------------------------------------------------
app.post("/api/voice", (req, res) => {
  const { enabled } = req.body ?? {};
  voice.setEnabled(Boolean(enabled));
  res.json({ ok: true, enabled: voice.isEnabled() });
});

// Reading preferences (the typeface, for now). Stored in the data dir so the
// choice follows the install into every browser that opens the HUD.
app.get("/api/hud-prefs", (_req, res) => {
  res.json(loadPrefs(DATA_DIR));
});

app.post("/api/hud-prefs", (req, res) => {
  res.json(savePrefs(DATA_DIR, req.body));
});

// --- Ears: the mic, transcribed on this machine (src/ears.ts) ---------------
// Behind requireAuth and its Origin check like the rest of /api. The body is
// raw WAV, read with a hard cap; the client chooses nothing but the audio.
app.get("/api/listen", async (_req, res) => {
  // Fresh on every HUD load, so a whisper installed while running is picked up.
  res.json(ears.earsStatus(await ears.detectEars(undefined, undefined, true)));
});

app.post("/api/listen", async (req, res) => {
  const s = ears.earsSettings();
  try {
    const body = await ears.readCapped(req, s.maxBytes, Number(req.headers["content-length"]));
    if (!body) {
      // The rest of an oversize body is not worth reading; close the socket.
      res.set("Connection", "close");
      return res.status(413).json({ error: `audio too large (cap ${Math.round(s.maxBytes / 1e6)} MB)` });
    }
    const heard = await ears.listen(body, { settings: s });
    res.json({ ...heard, engine: "whisper" });
  } catch (err) {
    const status = err instanceof ears.EarsError ? err.status : 500;
    res.status(status).json({ error: String((err as Error)?.message ?? err) });
  }
});

app.get("/api/voices", (_req, res) => {
  res.json({ piper: voice.listPiperVoices(), active: config.voice.piper.model });
});

app.post("/api/voice/sample", async (req, res) => {
  const { model, voiceName, text } = req.body ?? {};
  await voice.sample({
    model: model ? String(model) : undefined,
    voiceName: voiceName ? String(voiceName) : undefined,
    text: String(text || `Good evening, ${addressed()}. All systems are nominal.`),
  });
  res.json({ ok: true });
});

// --- Boot -------------------------------------------------------------------
const { port, host } = config.server;
const httpServer = app.listen(port, host, async () => {
  const hb = heartbeatStatus();
  const v = await voice.detect();
  const active = catalogStatus();

  console.log(banner({
    version: VERSION,
    url: `http://${host}:${port}`,
    brain: bannerBrain(),
    voice: v.engine === "none" ? "none — run ./setup-voice.sh" : `${v.engine} · ${v.detail}`,
    heartbeat: hb.enabled ? `every ${hb.intervalMinutes}m` : "off",
    tools: toolDefinitions.length,
    addressAs: addressed(),
  }));

  const heard = ears.earsStatus(await ears.detectEars());
  console.log(`  Ears: ${heard.label} · ${heard.detail}\n`);

  await connectMcp((line) => console.log(line));
  const mcpCount = listMcpTools().length;
  if (mcpCount) console.log(`  MCP: ${mcpCount} tool(s) registered\n`);

  if (tokenGenerated) {
    console.log("  A CLAW_TOKEN was generated and written to .env (mode 600).");
    console.log("  Scripts authenticate with:  Authorization: Bearer $CLAW_TOKEN\n");
  }

  // Armed before anything that can push: the late briefing fires at boot.
  startNtfy();
  // Back on the relay if a phone was paired through it; otherwise this does nothing.
  pocketRelay?.ensure();
  // Learn mode's review offer rides the heartbeat: silent unless the operator
  // turned reminders on and something is due, and once a day at most.
  startHeartbeat(agentEvents, { onBeat: () => { learn.nudgeTick(); } });
  startSchedule(agentEvents);
  startRemoteWatch(agentEvents);
  // A coding job that lands is told like a remote job is: a notice, the phone,
  // and a heartbeat-authority turn when the claw is free. Injected here so
  // foreman.ts never imports agent.ts.
  startForeman(agentEvents, {
    runTurn: (message, events, opts) => runTurn(message, events, opts),
    busy: () => turnInFlight().busy,
    push: (text) => void notifyPhone({ kind: "job", title: "Coding job", body: text }),
  });
  startTelegram(agentEvents, { resolveApproval: settleFromPhone });
  startDiscord(agentEvents, { resolveApproval: settleFromPhone });
  // After the phone lines, which it pushes through. It is given emit and the
  // senders, not runTurn: an event is told to the operator, never acted on.
  startHomeWatch(agentEvents, {
    phone: [telegramAlert, discordAlert],
    push: (text) => notifyPhone({ kind: "home", title: "Home", body: text }),
    describe: describeVisitor,
  });
  // After the phone lines, which a new version is told through.
  updates.start();
  for (const line of bootBrainLines()) console.log(line);
  if (setupNeeded()) {
    const url = `http://${host}:${port}/welcome`;
    console.warn(`  ⚠ No brain can run yet. Setup is waiting at ${url}\n`);
    openInBrowser(url);
  } else {
    if (!brainReady()) console.warn(`  ⚠ No brain has an API key. ${missingKeyHint()}\n`);
    // Started from the double-click launcher: nobody is at a terminal to read
    // the address, so take them to the glass.
    if (process.env.CLAW_OPEN_HUD) openInBrowser(`http://${host}:${port}/`);
  }
});

// A port clash is the boot failure a first run is most likely to hit — a claw
// from an earlier terminal still running, or a second install on the same
// machine — and the raw EADDRINUSE stack the uncaughtException handler prints
// says nothing about what to do.
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  void explainPortClash();
});

/**
 * A second double-click is the commonest way here, and so is a git install
 * already running as a service when a download is opened — the founder's
 * case, 20 Nov, where "Something is already running on port 3900 — opening
 * it. If that is not Cunning Claw…" left him guessing about his own claw. So
 * the port is asked what it is first (src/port-clash.ts): another Cunning
 * Claw is named, with its version, and opened when a double-click launcher
 * started us; anything else gets how to pick another port.
 */
async function explainPortClash(): Promise<void> {
  const probeHost = ["0.0.0.0", "::", ""].includes(host) ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const base = `http://${probeHost}:${port}`;
  const occupant = await probePort(base);
  const opened = occupant.kind === "claw" && !!process.env.CLAW_OPEN_HUD;
  const lines = portClashMessage({
    occupant, port, url: `${base}/`, ourVersion: VERSION, platform: process.platform, configFile: collapseHome(CONFIG_FILE), opened,
  });
  (occupant.kind === "claw" ? console.log : console.error)(`\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
  if (opened) {
    openInBrowser(`${base}/`);
    // Long enough for the browser to be handed the address before we go.
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  process.exit(1);
}
