/* J.A.R.V.I.S. HUD client */

const $ = (id) => document.getElementById(id);
const chatLog = $("chat-log");
const stateLabel = $("state-label");

let state = "STANDBY"; // STANDBY | THINKING | SPEAKING | LISTENING
let currentBubble = null;
let ttsEnabled = true;
let wakeEnabled = false;
let serverVoice = false;   // server-side TTS active (Linux/spd-say)
let serverVoiceAvailable = false;

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------
const BOOT_LINES = [
  "J.A.R.V.I.S. v0.1 — boot sequence initiated",
  "loading cognitive core .............. claude-opus-5",
  "mounting tool interface ............. 28 tools + web search + skills",
  "loading workspace ................... SOUL / HEARTBEAT / skills",
  "restoring long-term memory .......... ok",
  "establishing event stream ........... ok",
  "",
  "All systems nominal. Good day, sir.",
];
(async () => {
  const el = $("boot-text");
  for (const line of BOOT_LINES) {
    el.textContent += line + "\n";
    await new Promise((r) => setTimeout(r, 170));
  }
  await new Promise((r) => setTimeout(r, 500));
  $("boot-overlay").classList.add("done");
})();

// ---------------------------------------------------------------------------
// Arc reactor
// ---------------------------------------------------------------------------
const canvas = $("reactor");
const ctx = canvas.getContext("2d");
const CX = canvas.width / 2, CY = canvas.height / 2;
let t = 0;

function drawReactor() {
  t += state === "STANDBY" ? 0.008 : 0.03;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const pulse = 1 + Math.sin(t * 2.2) * (state === "STANDBY" ? 0.02 : 0.06);
  const glow = state === "LISTENING" ? "255, 84, 112" : "53, 214, 237";

  // Core
  const coreR = 34 * pulse;
  const grad = ctx.createRadialGradient(CX, CY, 2, CX, CY, coreR * 2.6);
  grad.addColorStop(0, `rgba(${glow}, 0.95)`);
  grad.addColorStop(0.35, `rgba(${glow}, 0.35)`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(CX, CY, coreR * 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `rgba(${glow}, 0.9)`;
  ctx.beginPath(); ctx.arc(CX, CY, coreR * 0.5, 0, Math.PI * 2); ctx.fill();

  // Rotating arc rings
  const rings = [
    { r: 70, segs: 3, w: 5, speed: 1.0, gap: 0.5 },
    { r: 98, segs: 8, w: 2.5, speed: -0.6, gap: 0.25 },
    { r: 126, segs: 4, w: 7, speed: 0.35, gap: 0.8 },
    { r: 152, segs: 24, w: 2, speed: -0.15, gap: 0.12 },
  ];
  for (const ring of rings) {
    const span = (Math.PI * 2) / ring.segs;
    for (let i = 0; i < ring.segs; i++) {
      const start = i * span + t * ring.speed;
      ctx.strokeStyle = `rgba(${glow}, ${0.25 + 0.5 * Math.abs(Math.sin(t + i))})`;
      ctx.lineWidth = ring.w;
      ctx.beginPath();
      ctx.arc(CX, CY, ring.r * pulse, start, start + span * (1 - ring.gap));
      ctx.stroke();
    }
  }
  requestAnimationFrame(drawReactor);
}
drawReactor();

function setState(s) {
  state = s;
  stateLabel.textContent = s;
}

// ---------------------------------------------------------------------------
// Chat rendering
// ---------------------------------------------------------------------------
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function addChip(text) {
  const div = document.createElement("div");
  div.className = "action-chip";
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---------------------------------------------------------------------------
// Text-to-speech
// ---------------------------------------------------------------------------
let jarvisVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  jarvisVoice =
    voices.find((v) => /en-GB/i.test(v.lang) && /male|daniel|arthur/i.test(v.name)) ||
    voices.find((v) => /en-GB/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) || null;
}
speechSynthesis.onvoiceschanged = pickVoice;
pickVoice();

function speak(text) {
  // When the server has a real TTS engine it speaks for us — don't double up.
  if (serverVoiceAvailable) return;
  if (!ttsEnabled || !("speechSynthesis" in window) || !text) return;
  if (speechSynthesis.getVoices().length === 0) return; // Chrome/Linux ships none
  speechSynthesis.cancel();
  // Strip markdown-ish noise for cleaner speech
  const clean = text.replace(/[*_`#]/g, "").replace(/\[.*?\]\(.*?\)/g, "");
  const utter = new SpeechSynthesisUtterance(clean);
  if (jarvisVoice) utter.voice = jarvisVoice;
  utter.rate = 1.05;
  utter.pitch = 0.9;
  utter.onstart = () => setState("SPEAKING");
  utter.onend = () => setState("STANDBY");
  speechSynthesis.speak(utter);
}

// ---------------------------------------------------------------------------
// Speech recognition (push-to-talk + wake word)
// ---------------------------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $("mic-btn");
let recognizer = null;
let wakeRecognizer = null;

if (!SR) {
  micBtn.classList.add("unsupported");
  micBtn.title = "Speech recognition not supported in this browser";
  $("wake-toggle").classList.add("unsupported");
} else {
  micBtn.addEventListener("click", () => {
    if (recognizer) { recognizer.stop(); return; }
    recognizer = new SR();
    recognizer.lang = "en-GB";
    recognizer.interimResults = false;
    recognizer.onresult = (e) => {
      const text = e.results[0][0].transcript.trim();
      if (text) sendMessage(text);
    };
    recognizer.onend = () => {
      recognizer = null;
      micBtn.classList.remove("listening");
      if (state === "LISTENING") setState("STANDBY");
    };
    recognizer.onerror = () => {};
    micBtn.classList.add("listening");
    setState("LISTENING");
    recognizer.start();
  });
}

function startWakeLoop() {
  if (!SR || !wakeEnabled) return;
  wakeRecognizer = new SR();
  wakeRecognizer.lang = "en-GB";
  wakeRecognizer.continuous = true;
  wakeRecognizer.interimResults = false;
  wakeRecognizer.onresult = (e) => {
    const text = e.results[e.results.length - 1][0].transcript.trim();
    const m = text.match(/jarvis[,.]?\s*(.*)/i);
    if (m) {
      const cmd = m[1].trim();
      if (cmd) sendMessage(cmd);
      else speak("Yes, sir?");
    }
  };
  wakeRecognizer.onend = () => { if (wakeEnabled) setTimeout(startWakeLoop, 400); };
  wakeRecognizer.onerror = () => {};
  try { wakeRecognizer.start(); } catch { /* already running */ }
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------
const es = new EventSource("/api/events");

es.addEventListener("turn_start", () => {
  setState("THINKING");
  currentBubble = null;
});

es.addEventListener("text", (e) => {
  const { delta } = JSON.parse(e.data);
  if (!currentBubble) currentBubble = addMsg("jarvis", "");
  currentBubble.textContent += delta;
  chatLog.scrollTop = chatLog.scrollHeight;
});

es.addEventListener("tool_start", (e) => {
  const { name, input } = JSON.parse(e.data);
  const summary = name === "run_command" ? input.command : JSON.stringify(input);
  addChip(`▸ ${name}: ${String(summary).slice(0, 90)}`);
  currentBubble = null; // next text goes in a fresh bubble
});

es.addEventListener("tool_result", (e) => {
  const { name } = JSON.parse(e.data);
  addChip(`✓ ${name} complete`);
});

es.addEventListener("turn_done", (e) => {
  const { text } = JSON.parse(e.data);
  setState("STANDBY");
  speak(text);
});

es.addEventListener("agent_error", (e) => {
  const { message } = JSON.parse(e.data);
  addMsg("system", `⚠ ${message}`);
  setState("STANDBY");
});

es.addEventListener("heartbeat_ok", () => {
  setState("STANDBY");
});

es.onerror = () => {
  $("conn-dot").classList.remove("online");
};

es.addEventListener("timer_fired", (e) => {
  const { label } = JSON.parse(e.data);
  addMsg("system", `⏰ ${label}`);
  speak(`Sir, a reminder: ${label}`);
});

es.addEventListener("approval_request", (e) => {
  const { id, summary, detail } = JSON.parse(e.data);
  const card = document.createElement("div");
  card.className = "approval-card";
  card.id = `approval-${id}`;
  card.innerHTML = `
    <div class="ttl">⚠ APPROVAL REQUIRED — ${summary.replace(/</g, "&lt;")}</div>
    <pre></pre>
    <div class="btns">
      <button class="yes">EXECUTE</button>
      <button class="no">DENY</button>
    </div>`;
  card.querySelector("pre").textContent = detail;
  card.querySelector(".yes").onclick = () => resolveApproval(id, true);
  card.querySelector(".no").onclick = () => resolveApproval(id, false);
  $("approval-area").appendChild(card);
  speak("Requesting authorisation, sir.");
});

es.addEventListener("approval_resolved", (e) => {
  const { id } = JSON.parse(e.data);
  document.getElementById(`approval-${id}`)?.remove();
});

// ---------------------------------------------------------------------------
// Input & controls
// ---------------------------------------------------------------------------
async function sendMessage(text) {
  addMsg("user", text);
  currentBubble = null;
  await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
  });
}

$("input-bar").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("msg-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  sendMessage(text);
});

$("tts-toggle").addEventListener("click", async (e) => {
  ttsEnabled = !ttsEnabled;
  e.target.classList.toggle("active", ttsEnabled);
  if (!ttsEnabled) speechSynthesis.cancel();
  // Mirror the toggle to the server-side voice engine.
  await fetch("/api/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: ttsEnabled }),
  }).catch(() => {});
});

$("wake-toggle").addEventListener("click", (e) => {
  if (!SR) return;
  wakeEnabled = !wakeEnabled;
  e.target.classList.toggle("active", wakeEnabled);
  if (wakeEnabled) startWakeLoop();
  else wakeRecognizer?.stop();
});

$("reset-btn").addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST" });
  chatLog.innerHTML = "";
  addMsg("system", "Conversation cleared.");
});

// ---------------------------------------------------------------------------
// System telemetry + history restore
// ---------------------------------------------------------------------------
async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const {
      text, online, serverVoice: sv, serverVoiceAvailable: sva,
      skills, heartbeat, landscapeCount, landscapeUpdated,
    } = await res.json();
    const extra = [
      "",
      `Skills: ${skills ?? 0}  ·  Heartbeat: ${heartbeat?.enabled ? `every ${heartbeat.intervalMinutes}m` : "off"}${heartbeat?.lastAt ? ` (last ${heartbeat.lastAt.slice(11, 16)}Z)` : ""}`,
      `Field map: ${landscapeCount ?? 0} systems  (${landscapeUpdated ?? "?"})`,
    ].join("\n");
    $("sys-status").textContent = text + extra;
    $("conn-dot").classList.toggle("online", online);
    serverVoice = Boolean(sv);
    serverVoiceAvailable = Boolean(sva);
    const btn = $("tts-toggle");
    if (serverVoiceAvailable) {
      btn.title = "Voice output (server-side TTS)";
    } else if (!("speechSynthesis" in window) || speechSynthesis.getVoices().length === 0) {
      btn.title = "No TTS engine available — install speech-dispatcher";
      btn.classList.add("unsupported");
    }
  } catch {
    $("conn-dot").classList.remove("online");
  }
}
pollStatus();
setInterval(pollStatus, 5000);

(async () => {
  try {
    const history = await (await fetch("/api/history")).json();
    for (const m of history) addMsg(m.role === "user" ? "user" : "jarvis", m.text);
  } catch { /* fresh start */ }
})();
