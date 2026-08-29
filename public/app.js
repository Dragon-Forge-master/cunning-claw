/* Cunning Claw HUD client */

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
(async () => {
  let brain = "claude-opus-5";
  try {
    const s = await (await fetch("/api/status")).json();
    if (s.brains?.active) brain = `${s.brains.active.id} / ${s.brains.active.model}`;
    else if (s.brain?.model) brain = `${s.brain.provider} / ${s.brain.model}`;
  } catch { /* boot copy is cosmetic */ }
  const BOOT_LINES = [
    "Cunning Claw v0.3 — boot sequence initiated",
    `loading cognitive cores ............. ${brain}`,
    "mounting tool interface ............. tools + search + skills",
    "loading workspace ................... SOUL / HEARTBEAT / skills",
    "restoring long-term memory .......... journal + MEMORY.md",
    "establishing event stream ........... ok",
    "",
    "All systems nominal. Good day, sir.",
  ];
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
  const idle = state === "STANDBY";
  t += idle ? 0.0036 : 0.026;

  // Standby keeps a faint afterimage so the rings trail; working states snap clean.
  if (idle) {
    ctx.fillStyle = "rgba(4, 8, 15, 0.07)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  const breath = Math.sin(t * (idle ? 0.42 : 2.15));
  const pulse = 1 + breath * (idle ? 0.055 : 0.07);
  const glow = state === "LISTENING" ? "255, 84, 112" : "53, 214, 237";

  // Deep well — a second, slower breath so the core never quite sits still.
  const well = 1 + Math.sin(t * 0.19 + 1.2) * (idle ? 0.03 : 0.02);
  const coreR = 36 * pulse * well;
  const grad = ctx.createRadialGradient(CX, CY, 1, CX, CY, coreR * 3.1);
  grad.addColorStop(0, `rgba(${glow}, ${idle ? 0.55 : 0.95})`);
  grad.addColorStop(0.22, `rgba(${glow}, ${idle ? 0.22 : 0.38})`);
  grad.addColorStop(0.55, `rgba(${glow}, 0.06)`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(CX, CY, coreR * 3.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `rgba(${glow}, ${idle ? 0.55 + breath * 0.2 : 0.9})`;
  ctx.beginPath(); ctx.arc(CX, CY, coreR * 0.38, 0, Math.PI * 2); ctx.fill();
  // A still white pupil at dead centre — the fixed point an entranced eye
  // settles on while everything around it drifts.
  ctx.fillStyle = `rgba(234, 252, 255, ${idle ? 0.75 : 0.85})`;
  ctx.beginPath(); ctx.arc(CX, CY, coreR * 0.14, 0, Math.PI * 2); ctx.fill();

  // Quiet rails so the moving arcs have something to ride.
  if (idle) {
    for (const r of [56, 78, 102, 126, 150, 168]) {
      ctx.strokeStyle = `rgba(${glow}, 0.06)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(CX, CY, r * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Counter-rotating rings at incommensurate speeds — the beat is the trance.
  const rings = idle
    ? [
        { r: 56, segs: 2, w: 3, speed: 0.18, gap: 0.38 },
        { r: 78, segs: 5, w: 2, speed: -0.27, gap: 0.16 },
        { r: 102, segs: 3, w: 7, speed: 0.13, gap: 0.58 },
        { r: 126, segs: 11, w: 1.6, speed: -0.41, gap: 0.22 },
        { r: 150, segs: 4, w: 9, speed: 0.08, gap: 0.74 },
        { r: 168, segs: 48, w: 1.15, speed: -0.055, gap: 0.42 },
      ]
    : [
        { r: 70, segs: 3, w: 5, speed: 1.0, gap: 0.5 },
        { r: 98, segs: 8, w: 2.5, speed: -0.6, gap: 0.25 },
        { r: 126, segs: 4, w: 7, speed: 0.35, gap: 0.8 },
        { r: 152, segs: 24, w: 2, speed: -0.15, gap: 0.12 },
      ];
  ctx.lineCap = "round";
  for (const ring of rings) {
    const span = (Math.PI * 2) / ring.segs;
    for (let i = 0; i < ring.segs; i++) {
      const start = i * span + t * ring.speed;
      // In standby, brightness is a WAVE that travels around each ring — one
      // crest forever circling — rather than segments blinking in place.
      const mid = start + span / 2;
      const flicker = idle
        ? 0.14 + 0.42 * (0.5 + 0.5 * Math.sin(mid * 2 - t * 0.85))
        : 0.25 + 0.5 * Math.abs(Math.sin(t + i));
      ctx.strokeStyle = `rgba(${glow}, ${flicker})`;
      ctx.lineWidth = ring.w;
      ctx.beginPath();
      ctx.arc(CX, CY, ring.r * pulse, start, start + span * (1 - ring.gap));
      ctx.stroke();
    }
  }

  // Two opposing spirals — the eye follows one and loses the other.
  if (idle) {
    for (let arm = 0; arm < 2; arm++) {
      const dir = arm === 0 ? 1 : -1;
      for (let i = 0; i < 42; i++) {
        const a = dir * (t * 0.11 + i * 0.31) + arm * Math.PI;
        const r = 22 + (i / 42) * 148;
        const x = CX + Math.cos(a) * r * pulse;
        const y = CY + Math.sin(a) * r * pulse;
        ctx.fillStyle = `rgba(${glow}, ${0.04 + 0.22 * (i / 42)})`;
        ctx.beginPath();
        ctx.arc(x, y, 1.15, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  requestAnimationFrame(drawReactor);
}
drawReactor();

function setState(s) {
  state = s;
  stateLabel.textContent = s;
  const center = $("center");
  if (center) center.dataset.state = s;
  const stop = $("stop-btn");
  if (stop) stop.style.display = s === "THINKING" ? "" : "none";
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
let cunningclawVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  cunningclawVoice =
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
  if (cunningclawVoice) utter.voice = cunningclawVoice;
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
  /**
   * The mic is a dictaphone, not a trigger.
   *
   * It used to send on the browser's first result — which arrives the moment
   * you pause for breath, not when you have finished your sentence. So a
   * thought got cut in half and posted before you could see it. Now speech goes
   * into the input box, you read it, correct it if the transcription mangled a
   * word, and press SEND when you mean it.
   */
  const input = $("msg-input");
  let dictationBase = "";   // whatever was already typed before the mic opened
  let finalSpeech = "";     // utterances the recogniser has committed

  const paint = (interim) => {
    const parts = [dictationBase, finalSpeech, interim].map((s) => s.trim()).filter(Boolean);
    input.value = parts.join(" ");
  };

  const stopDictation = () => {
    recognizer = null;
    micBtn.classList.remove("listening");
    if (state === "LISTENING") setState("STANDBY");
    paint("");                 // drop any uncommitted interim text
    input.placeholder = "At your service, sir…";
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };

  micBtn.addEventListener("click", () => {
    if (recognizer) { recognizer.stop(); return; }

    dictationBase = input.value;
    finalSpeech = "";

    recognizer = new SR();
    recognizer.lang = "en-GB";
    // Keep listening through the pauses; a pause is not the end of a thought.
    recognizer.continuous = true;
    // Show the words landing, so it is obvious it is hearing you.
    recognizer.interimResults = true;

    recognizer.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalSpeech += (finalSpeech ? " " : "") + chunk.trim();
        else interim += chunk;
      }
      paint(interim);
    };

    recognizer.onend = stopDictation;
    recognizer.onerror = (e) => {
      if (e.error !== "aborted" && e.error !== "no-speech") {
        addMsg("system", `⚠ Microphone: ${e.error}`);
      }
      stopDictation();
    };

    micBtn.classList.add("listening");
    setState("LISTENING");
    input.placeholder = "listening — press the mic again when you're done";
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
    const m = text.match(/(?:cunning\s+)?claw[,.]?\s*(.*)/i);
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

/** Parse an SSE payload without letting one bad frame kill the listener. */
function sseData(e) {
  try {
    return e.data ? JSON.parse(e.data) : {};
  } catch {
    return {};
  }
}

es.addEventListener("turn_start", () => {
  setState("THINKING");
  currentBubble = null;
});

es.addEventListener("text", (e) => {
  const { delta } = sseData(e);
  if (!currentBubble) currentBubble = addMsg("cunningclaw", "");
  currentBubble.textContent += delta;
  chatLog.scrollTop = chatLog.scrollHeight;
});

es.addEventListener("tool_start", (e) => {
  const { name, input } = sseData(e);
  const summary = name === "run_command" ? input.command : JSON.stringify(input);
  addChip(`▸ ${name}: ${String(summary).slice(0, 90)}`);
  currentBubble = null; // next text goes in a fresh bubble
});

es.addEventListener("tool_result", (e) => {
  const { name } = sseData(e);
  addChip(`✓ ${name} complete`);
});

es.addEventListener("brain_guard", (e) => {
  const { forcedTo, reason } = sseData(e);
  const div = document.createElement("div");
  div.className = "guard-chip";
  div.textContent = `\u26e8 guarded \u2192 ${forcedTo} · ${reason}`;
  div.title = "This turn can see untrusted content, so a trusted brain was required.";
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

es.addEventListener("heartbeat_ok", (e) => {
  const { at } = sseData(e);
  const chip = $("hb-chip");
  if (chip && at) chip.textContent = `\u2661 ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
});

es.addEventListener("turn_done", (e) => {
  const { text } = sseData(e);
  setState("STANDBY");
  speak(text);
});

es.addEventListener("agent_error", (e) => {
  const { message } = sseData(e);
  addMsg("system", `⚠ ${message}`);
  setState("STANDBY");
});

es.addEventListener("notice", (e) => {
  const { message } = sseData(e);
  addMsg("system", message);
});

es.addEventListener("brain", (e) => {
  renderBrainPicker(sseData(e));
});

es.addEventListener("preview", (e) => {
  applyPreview(sseData(e));
});

/* ── viewport: files tab ─────────────────────────────────────────── */

const fileChanges = [];
let selectedFile = null;

function renderFileList() {
  const list = $("files-list");
  list.innerHTML = "";
  for (const c of fileChanges) {
    const row = document.createElement("div");
    row.className = "file-row" + (c.path === selectedFile ? " active" : "");
    const stat = c.action === "write"
      ? `<span class="add">new · +${Number(c.added) || 0}</span>`
      : `<span class="add">+${Number(c.added) || 0}</span> <span class="del">−${Number(c.removed) || 0}</span>`;
    const fn = document.createElement("span");
    fn.className = "fn";
    fn.textContent = c.name;
    const fp = document.createElement("span");
    fp.className = "fp";
    fp.textContent = c.path;
    const fs_ = document.createElement("span");
    fs_.className = "fs";
    fs_.innerHTML = stat;          // built from numbers above, not from disk
    row.append(fn, fp, fs_);
    row.onclick = () => { selectedFile = c.path; renderFileList(); renderDiff(c); };
    list.appendChild(row);
  }
  const count = fileChanges.length;
  $("files-count").textContent = count ? ` ${count}` : "";
}

function renderDiff(change) {
  const pane = $("files-diff");
  if (!change) {
    pane.innerHTML = '<span class="files-empty">Select a file to see what changed.</span>';
    return;
  }
  const pre = document.createElement("pre");
  for (const line of (change.diff || "").split("\n")) {
    const span = document.createElement("span");
    span.className = line.startsWith("+") ? "l-add"
      : line.startsWith("-") ? "l-del"
      : line.startsWith("@@") ? "l-hdr" : "l-ctx";
    span.textContent = line + "\n";
    pre.appendChild(span);
  }
  pane.innerHTML = "";
  pane.appendChild(pre);
}

es.addEventListener("file_change", (e) => {
  const change = sseData(e);
  if (!change || !change.path) return;
  const i = fileChanges.findIndex((c) => c.path === change.path);
  if (i >= 0) fileChanges.splice(i, 1);
  fileChanges.unshift(change);
  // Writing a file is the interesting moment — surface the panel for it.
  $("hud").classList.add("previewing");
  $("preview-toggle").classList.add("active");
  setTab("files");
  selectedFile = change.path;
  renderFileList();
  renderDiff(change);
  addChip(`✎ ${change.name}  +${change.added}${change.removed ? " −" + change.removed : ""}`);
});

function setTab(name) {
  for (const tab of document.querySelectorAll(".vp-tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  $("hud").classList.toggle("files-mode", name === "files");
}

for (const tab of document.querySelectorAll(".vp-tab")) {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
}

/* ── viewport: device widths ─────────────────────────────────────── */

function setDeviceWidth(w) {
  const frame = $("preview-frame");
  frame.style.width = w ? `${w}px` : "100%";
  for (const b of document.querySelectorAll(".ctl.dev")) {
    b.classList.toggle("active", Number(b.dataset.w) === w);
  }
  $("vp-dims").textContent = w
    ? `${w} × ${frame.clientHeight || "—"}`
    : `${frame.clientWidth || "—"} × ${frame.clientHeight || "—"}`;
}

for (const b of document.querySelectorAll(".ctl.dev")) {
  b.addEventListener("click", () => setDeviceWidth(Number(b.dataset.w)));
}

// Connection state belongs to the socket, not to the status poll — otherwise a
// real disconnect is painted over every five seconds.
let sseConnected = false;

function paintConnection() {
  $("conn-dot").classList.toggle("online", sseConnected);
  $("conn-dot").title = sseConnected ? "Connected to CUNNING CLAW" : "Disconnected — retrying";
}

es.addEventListener("hello", () => { sseConnected = true; paintConnection(); });
es.onopen = () => { sseConnected = true; paintConnection(); };
es.onerror = () => { sseConnected = false; paintConnection(); };

es.addEventListener("timer_fired", (e) => {
  const { label } = sseData(e);
  addMsg("system", `⏰ ${label}`);
  speak(`Sir, a reminder: ${label}`);
});

es.addEventListener("approval_request", (e) => {
  const { id, summary, detail } = sseData(e);
  const card = document.createElement("div");
  card.className = "approval-card";
  card.id = `approval-${id}`;
  card.innerHTML = `
    <div class="ttl">⚠ APPROVAL REQUIRED — <span class="ttl-what"></span></div>
    <pre></pre>
    <div class="btns">
      <button class="yes">EXECUTE</button>
      <button class="task">ALLOW FOR THIS TASK</button>
      <button class="no">DENY</button>
    </div>`;
  card.querySelector(".ttl-what").textContent = summary;   // text, so & and < are safe
  card.querySelector("pre").textContent = detail;
  card.querySelector(".yes").onclick = () => resolveApproval(id, true);
  // Covers the fiddly navigation for the rest of this errand. Never covers a
  // send, a payment or a delete — those ask every time.
  card.querySelector(".task").onclick = () => resolveApproval(id, true, "task");
  card.querySelector(".no").onclick = () => resolveApproval(id, false);
  $("approval-area").appendChild(card);
  speak("Requesting authorisation, sir.");
});

es.addEventListener("approval_resolved", (e) => {
  const { id } = sseData(e);
  document.getElementById(`approval-${id}`)?.remove();
});

// ---------------------------------------------------------------------------
// Input & controls
// ---------------------------------------------------------------------------
/**
 * Settle an approval card. The buttons have called this since the card was
 * added; the function was never written, so EXECUTE and DENY both threw a
 * ReferenceError and the card sat there until the server timed it out.
 */
async function resolveApproval(id, approved, scope) {
  const card = document.getElementById(`approval-${id}`);
  if (card) {
    for (const b of card.querySelectorAll("button")) b.disabled = true;
    card.querySelector(".ttl").textContent = approved ? (scope === "task" ? "▸ EXECUTING · allowed for this task" : "▸ EXECUTING…") : "▸ DENIED";
  }
  try {
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, approved, scope }),
    });
    if (!res.ok) addMsg("system", `⚠ Could not send that decision (HTTP ${res.status}).`);
  } catch (err) {
    addMsg("system", `⚠ Could not reach CUNNING CLAW to answer the approval: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Capabilities (skills) — click to arm, like Claude's skills list
// ---------------------------------------------------------------------------
const ARMED_KEY = "cunningclaw.armedSkills";
let skillCatalog = [];
let armedSkills = [];
try {
  armedSkills = JSON.parse(sessionStorage.getItem(ARMED_KEY) || "[]");
  if (!Array.isArray(armedSkills)) armedSkills = [];
} catch {
  armedSkills = [];
}

function saveArmed() {
  sessionStorage.setItem(ARMED_KEY, JSON.stringify(armedSkills));
}

function skillByName(name) {
  return skillCatalog.find((s) => s.name === name);
}

function renderArmedRow() {
  const row = $("armed-row");
  if (!row) return;
  row.innerHTML = "";
  if (!armedSkills.length) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  for (const name of armedSkills) {
    const meta = skillByName(name);
    const chip = document.createElement("span");
    chip.className = "armed-chip";
    const label = document.createElement("span");
    label.textContent = meta?.label || name;
    const x = document.createElement("button");
    x.type = "button";
    x.setAttribute("aria-label", `Disarm ${meta?.label || name}`);
    x.textContent = "×";
    x.onclick = () => toggleSkill(name, false);
    chip.append(label, x);
    row.appendChild(chip);
  }
}

function setSkillsOpen(open) {
  const overlay = $("skills-overlay");
  const btn = $("skills-toggle");
  if (!overlay || !btn) return;
  overlay.hidden = !open;
  btn.classList.toggle("active", open);
  if (open) renderSkillsList();
}

function toggleSkill(name, force) {
  const on = force ?? !armedSkills.includes(name);
  armedSkills = armedSkills.filter((n) => n !== name);
  if (on) armedSkills.push(name);
  saveArmed();
  renderArmedRow();
  renderSkillsList();
}

function renderSkillsList() {
  const root = $("skills-list");
  if (!root) return;
  root.innerHTML = "";
  if (!skillCatalog.length) {
    const empty = document.createElement("p");
    empty.className = "skills-hint";
    empty.textContent = "No skills installed. Drop a SKILL.md under workspace/skills.";
    root.appendChild(empty);
    return;
  }
  const groups = [];
  for (const s of skillCatalog) {
    let g = groups.find((x) => x.category === s.category);
    if (!g) {
      g = { category: s.category, label: s.categoryLabel || s.category, items: [] };
      groups.push(g);
    }
    g.items.push(s);
  }
  for (const g of groups) {
    const wrap = document.createElement("div");
    wrap.className = "skill-group";
    const title = document.createElement("div");
    title.className = "skill-group-title";
    title.textContent = g.label;
    wrap.appendChild(title);
    for (const s of g.items) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "skill-card" + (armedSkills.includes(s.name) ? " armed" : "");
      card.dataset.name = s.name;
      const lab = document.createElement("span");
      lab.className = "sk-label";
      lab.textContent = s.label;
      const desc = document.createElement("span");
      desc.className = "sk-desc";
      desc.textContent = s.description;
      card.append(lab, desc);
      card.onclick = async () => {
        toggleSkill(s.name);
        if (armedSkills.includes(s.name) && !card.querySelector(".sk-more")) {
          try {
            const res = await fetch(`/api/skills/${encodeURIComponent(s.name)}`);
            if (!res.ok) return;
            const detail = await res.json();
            const more = document.createElement("div");
            more.className = "sk-more";
            const body = String(detail.body || "");
            const cut = body.replace(/^---[\s\S]*?---\n*/, "");
            more.textContent = cut.slice(0, 900) + (cut.length > 900 ? "\n…" : "");
            card.appendChild(more);
          } catch { /* body is optional colour */ }
        }
      };
      wrap.appendChild(card);
    }
    root.appendChild(wrap);
  }
}

async function loadSkills() {
  try {
    const res = await fetch("/api/skills");
    if (!res.ok) return;
    const data = await res.json();
    skillCatalog = Array.isArray(data.skills) ? data.skills : [];
    armedSkills = armedSkills.filter((n) => skillCatalog.some((s) => s.name === n));
    saveArmed();
    renderArmedRow();
    if ($("skills-overlay") && !$("skills-overlay").hidden) renderSkillsList();
  } catch { /* telemetry poll will retry */ }
}

$("skills-toggle")?.addEventListener("click", () => {
  setSkillsOpen($("skills-overlay").hidden);
});
$("skills-close")?.addEventListener("click", () => setSkillsOpen(false));
$("skills-overlay")?.addEventListener("click", (e) => {
  if (e.target === $("skills-overlay")) setSkillsOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("skills-overlay") && !$("skills-overlay").hidden) {
    setSkillsOpen(false);
  }
});
loadSkills();

async function sendMessage(text) {
  addMsg("user", text);
  currentBubble = null;
  const payload = armedSkills.length
    ? `[Armed skills — call skill_read for each before improvising: ${armedSkills.join(", ")}]\n\n${text}`
    : text;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: payload }),
    });
    if (!res.ok) {
      // A silent failure here looks exactly like a slow reply. Say what happened.
      const detail = res.status === 401
        ? "not authenticated — reload this page to get a session"
        : `HTTP ${res.status}`;
      addMsg("system", `⚠ Message not delivered (${detail}).`);
      setState("STANDBY");
    }
  } catch (err) {
    addMsg("system", `⚠ CUNNING CLAW is not reachable: ${err.message}`);
    setState("STANDBY");
  }
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

$("stop-btn")?.addEventListener("click", async () => {
  const r = await fetch("/api/cancel", { method: "POST" }).then((x) => x.json()).catch(() => ({}));
  addMsg("system", r.stopped ? "Request abandoned." : "Nothing was running.");
  setState("STANDBY");
});

$("reset-btn").addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST" });
  chatLog.innerHTML = "";
  addMsg("system", "Conversation cleared.");
});

// ---------------------------------------------------------------------------
// In-HUD viewport (Claude Code-style preview pane)
// ---------------------------------------------------------------------------
let previewUrl = "";
let previewPhone = false;

function applyPreview(data) {
  if (!data) return;
  if (data.action === "close" || data.open === false) {
    $("hud").classList.remove("previewing");
    $("preview-toggle").classList.remove("active");
    return;
  }
  const url = data.url;
  if (!url) return;
  previewUrl = url;
  $("preview-url").value = url;
  const frame = $("preview-frame");
  if (data.action === "reload") {
    frame.src = url;
  } else if (frame.src !== url) {
    frame.src = url;
  }
  $("hud").classList.add("previewing");
  $("preview-toggle").classList.add("active");
}

async function postPreview(body) {
  await fetch("/api/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

$("preview-toggle").addEventListener("click", () => {
  if ($("hud").classList.contains("previewing")) {
    postPreview({ action: "close" });
    return;
  }
  const url = $("preview-url").value.trim() || previewUrl || `${location.origin}/viewport.html`;
  postPreview({ action: "open", url });
});

$("preview-bar").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("preview-url").value.trim();
  if (url) postPreview({ action: "open", url });
});

$("preview-reload").addEventListener("click", () => postPreview({ action: "reload" }));
$("preview-close").addEventListener("click", () => postPreview({ action: "close" }));
$("preview-pop").addEventListener("click", () => {
  if (previewUrl) window.open(previewUrl, "_blank", "noopener");
});
// ---------------------------------------------------------------------------
// System telemetry + history restore
// ---------------------------------------------------------------------------
function renderBrainPicker(payload) {
  const el = $("brain-picker");
  if (!el) return;
  const data = payload?.catalog ? payload : payload?.brains ? payload.brains : null;
  const catalog = data?.catalog ?? payload?.catalog;
  if (!catalog) return;
  const pin = data.pin ?? null;
  const activeId = data.active?.id;
  el.innerHTML = "";
  const make = (label, title, active, offline, onClick) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctl brain-btn" + (active ? " active" : "") + (offline ? " offline" : "");
    btn.textContent = label;
    btn.title = title;
    btn.onclick = onClick;
    el.appendChild(btn);
  };
  make("AUTO", "Automatic routing (default + fallbacks)", !pin, false, () => {
    fetch("/api/brain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "auto" }),
    });
  });
  // Cheapest first, so the ladder reads left to right and the expensive
  // choice is a deliberate one rather than the nearest button.
  const priced = [...catalog].sort((x, y) => (x.price?.in ?? 99) - (y.price?.in ?? 99));

  for (const b of priced) {
    const p = b.price;
    const cost = !p ? ""
      : p.in === 0 ? " free"
      : ` $${p.in}`;
    const tip = [
      `${b.provider} / ${b.model}`,
      p ? `$${p.in} in · $${p.out} out  (per million tokens)` : null,
      b.note || null,
      b.ready ? null : "no API key — see npm run doctor",
    ].filter(Boolean).join("\n");

    make(
      b.label.toUpperCase() + cost,
      tip,
      pin ? pin === b.id : activeId === b.id,
      !b.ready,
      () => {
        fetch("/api/brain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: b.id }),
        });
      },
    );
  }
}

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const {
      text, online, serverVoice: sv, serverVoiceAvailable: sva,
      skills, heartbeat, landscapeCount, landscapeUpdated,
      brain, brains, telegram, toolCount, preview, spend,
    } = await res.json();
    renderBrainPicker(brains);
    if (preview?.open && preview.url) {
      const showing = $("hud").classList.contains("previewing") && previewUrl === preview.url;
      if (!showing) applyPreview({ action: "open", url: preview.url, open: true });
    }
    const active = brains?.active;
    const extra = [
      "",
      `Brain: ${active ? `${active.id} / ${active.model} (${active.source})` : `${brain?.provider ?? "?"} / ${brain?.model ?? "?"}`}`,
      `Roster: ${(brains?.catalog || []).map((b) => `${b.id}${b.ready ? "" : "*"}`).join(" · ") || "—"}  (* = no key)`,
      `Heartbeat brain: ${brains?.heartbeat ?? "—"}  ·  Fallbacks: ${(brains?.fallbacks || []).join(" → ") || "none"}`,
      `Skills: ${skills ?? 0}  ·  Tools: ${toolCount ?? "?"}  ·  Heartbeat: ${heartbeat?.enabled ? `every ${heartbeat.intervalMinutes}m` : "off"}${heartbeat?.lastAt ? ` (last ${heartbeat.lastAt.slice(11, 16)}Z)` : ""}`,
      `Field map: ${landscapeCount ?? 0} systems  (${landscapeUpdated ?? "?"})`,
      `Telegram: ${telegram?.enabled ? `on (${(telegram.chats || []).join(", ")})` : "off"}`,
    ].join("\n");
    $("sys-status").textContent = text + extra;
    // The dot is connection state, owned by the SSE socket. Brain readiness is
    // a separate fact — showing it here made a keyless-but-connected CUNNING CLAW
    // look disconnected, and painted over real drops every five seconds.
    $("conn-dot").classList.toggle("nobrain", !online);
    if (spend) {
      const usd = typeof spend.usd === "number" ? spend.usd : 0;
      $("spend-chip").textContent = spend.turns
        ? `$${usd.toFixed(4)} · ${spend.turns} turn${spend.turns === 1 ? "" : "s"}`
        : "";
    }
    if (brain) {
      const b = (brains?.catalog || []).find((x) => x.model === brain.model);
      const p = b?.price;
      const rate = p ? (p.in === 0 ? " · free" : ` · $${p.in}/$${p.out} per Mtok`) : "";
      $("route-chip").textContent = `${brain.model || ""}${rate}`;
    }
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
    // A failed poll says nothing about the event stream; leave the dot alone.
  }
}
pollStatus();
setInterval(pollStatus, 5000);

(async () => {
  try {
    const history = await (await fetch("/api/history")).json();
    for (const m of history) addMsg(m.role === "user" ? "user" : "cunningclaw", m.text);
  } catch { /* fresh start */ }
})();


