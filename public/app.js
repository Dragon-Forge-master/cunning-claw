/* Cunning Claw HUD client */

const $ = (id) => document.getElementById(id);
const chatLog = $("chat-log");
const stateLabel = $("state-label");

let state = "STANDBY"; // STANDBY | THINKING | SPEAKING | LISTENING
let resetDictation = () => {}; // reassigned by the mic block when supported
let currentBubble = null;
// How the fixed lines address the operator — "sir", "madam" or their name, as
// chosen at setup. The server says so in /api/status; "sir" only until it does.
let addressAs = "sir";
const sir = (start) => (start ? addressAs.charAt(0).toUpperCase() + addressAs.slice(1) : addressAs);
const servicePlaceholder = () => `At your service, ${sir()}…`;
function learnAddress(s) {
  if (typeof s?.addressAs !== "string" || !s.addressAs.trim()) return;
  addressAs = s.addressAs.trim();
  const input = $("msg-input");
  if (input && input.placeholder.startsWith("At your service")) input.placeholder = servicePlaceholder();
}
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
    learnAddress(s);
    if (s.brains?.active) brain = `${s.brains.active.id} / ${s.brains.active.model}`;
    else if (s.brain?.model) brain = `${s.brain.provider} / ${s.brain.model}`;
  } catch { /* boot copy is cosmetic */ }
  const BOOT_LINES = [
    "Cunning Claw — boot sequence initiated",
    `loading cognitive cores ............. ${brain}`,
    "mounting tool interface ............. tools + search + skills",
    "loading workspace ................... SOUL / HEARTBEAT / skills",
    "restoring long-term memory .......... journal + MEMORY.md",
    "establishing event stream ........... ok",
    "",
    `All systems nominal. Good day, ${sir()}.`,
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
  const disk = Math.min(CX, CY) - 1;

  // Clip to a circle so the canvas never paints a square. Standby fades
  // existing pixels (destination-out) instead of laying down a dark rect.
  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, disk, 0, Math.PI * 2);
  ctx.clip();

  if (idle) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    ctx.beginPath();
    ctx.arc(CX, CY, disk, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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

  ctx.restore();
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
  // The practice claw's words, said while the practice ground was open:
  // marked, so a transcript read later never mistakes them for real work.
  // Only the claw's: anything typed in the main bar is real by definition —
  // sending it is what ends practice — and its bubble is drawn a moment
  // before the server says so, which once labelled a real question PRACTICE.
  if (role === "cunningclaw" && document.body.dataset.practice === "on") div.classList.add("practice");
  // Text lives in its own span so streaming appends and the hover-tools can
  // coexist — and so "copy" grabs the words, never the button glyphs.
  const span = document.createElement("span");
  span.className = "msg-text";
  span.textContent = text;
  div.appendChild(span);
  if (role === "cunningclaw") attachMsgTools(div, span);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return span;
}

function attachMsgTools(div, span) {
  const tools = document.createElement("div");
  tools.className = "msg-tools";
  const mk = (label, title, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.onclick = fn;
    tools.appendChild(b);
    return b;
  };
  const copyBtn = mk("⧉", "Copy this reply", async () => {
    try {
      await navigator.clipboard.writeText(span.textContent);
      copyBtn.textContent = "✓";
      setTimeout(() => { copyBtn.textContent = "⧉"; }, 1200);
    } catch { /* clipboard blocked — nothing to say */ }
  });
  mk("🔊", "Speak this reply", () => {
    fetch("/api/voice/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: span.textContent.slice(0, 1100) }),
    }).catch(() => {});
  });
  div.appendChild(tools);
}

function addChip(text) {
  const div = document.createElement("div");
  div.className = "action-chip";
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
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

// speech-clean:begin — a copy of cleanForSpeech in src/voice.ts, for the
// browser's own voice; src/voice.test.ts runs this exact block against it.
// Colour codes, hashes and long ids are dropped and a URL is said as its site,
// or "#35d6ed" is read out as "hash three five d six e d".
const LOCAL_HOST = /^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|10(?:\.\d+){3}|192\.168(?:\.\d+){2})$/i;
function speechText(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " — code omitted — ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?:\/\/|www\.)(?:www\.)?([^\s/?#:]+)\S*?([.,;:!?)]*)(?=\s|$)/gi, (_m, host, tail) =>
      (LOCAL_HOST.test(host.replace(/\.$/, "")) ? "a local address" : host) + tail)
    .replace(/(^|[^\w&])#(?:[0-9a-f]{6}(?:[0-9a-f]{2})?|(?=[0-9]*[a-f])[0-9a-f]{3,4})\b/gi, "$1")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, "")
    .replace(/\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{16,}\b/gi, "")
    .replace(/\b\d{12,}\b/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[*_~`>|#]/g, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
// speech-clean:end

function speak(text, { after = false } = {}) {
  // When the server has a real TTS engine it speaks for us — don't double up.
  if (serverVoiceAvailable) return;
  if (!ttsEnabled || !("speechSynthesis" in window) || !text) return;
  if (speechSynthesis.getVoices().length === 0) return; // Chrome/Linux ships none
  // speechSynthesis queues by itself; letting a heartbeat wait is just not
  // cancelling what is already being read.
  if (!after) speechSynthesis.cancel();
  const clean = speechText(text);
  const utter = new SpeechSynthesisUtterance(clean);
  if (cunningclawVoice) utter.voice = cunningclawVoice;
  utter.rate = 1.05;
  utter.pitch = 0.9;
  // The browser's own voice reaches the mic just as the server's does.
  // Chrome ends a cancelled utterance with "error" (interrupted), not "end".
  utter.onstart = () => clawSpeaking("browser", true, clean);
  utter.onend = () => clawSpeaking("browser", false);
  utter.onerror = () => clawSpeaking("browser", false);
  speechSynthesis.speak(utter);
}

// ---------------------------------------------------------------------------
// The mic must not hear the claw
// ---------------------------------------------------------------------------
// On 24 Oct an operator message shared 35 five-word runs with the claw's
// previous reply: the mic had heard the speakers and posted the claw's words
// back as the operator's. Nothing told the HUD when the server was talking.
// Now the server says so ("speaking"), browser TTS says so, and while either
// is talking every recogniser is paused and its results thrown away. The
// echo check below is the second guard, for whatever slips past the first.
let serverSpeaking = false;
let browserSpeaking = false;
let lastSpoken = "";       // what the speakers said last, for the echo check
let resumeTimer = null;    // the quiet tail after speech, before the mic reopens
// Room echo and the audio buffer outlast the process by a beat; reopening the
// instant speech "ends" caught the last words.
const RESUME_AFTER_SPEECH_MS = 600;
// Reassigned by the mic block when recognition is supported.
let pauseDictation = () => {};
let resumeDictation = () => {};

const isClawSpeaking = () => serverSpeaking || browserSpeaking;
/** True while anything the mic hears is likely the claw's own voice. */
const mustNotHear = () => isClawSpeaking() || resumeTimer !== null;

function clawSpeaking(source, on, text) {
  if (source === "server") serverSpeaking = on;
  else browserSpeaking = on;
  if (on && text) lastSpoken = text;
  clearTimeout(resumeTimer);
  resumeTimer = null;
  if (isClawSpeaking()) {
    if (state !== "THINKING") setState("SPEAKING");
    pauseHearing();
    return;
  }
  if (state === "SPEAKING") setState(recognizer || localRecording() ? "LISTENING" : "STANDBY");
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    if (!isClawSpeaking()) resumeHearing();
  }, RESUME_AFTER_SPEECH_MS);
}

function pauseHearing() {
  pauseDictation();
  // abort(), not stop(): stop() still delivers what it already heard, which
  // is exactly the claw's voice.
  try { wakeRecognizer?.abort(); } catch { /* not running */ }
}

function resumeHearing() {
  resumeDictation();
  startWakeLoop();
}

/** The operator talking over the claw: stop the voice, wherever it comes from. */
function silenceClaw() {
  fetch("/api/voice/stop", { method: "POST" }).catch(() => {});
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  serverSpeaking = false;
  browserSpeaking = false;
  clearTimeout(resumeTimer);
  resumeTimer = null;
  if (state === "SPEAKING") setState("STANDBY");
  resumeHearing();
}

function noteEchoDropped() {
  addMsg("system", "The mic heard my own reply — left it out.");
}

// echo-guard:begin — src/voice.test.ts runs this exact block, so keep it
// self-contained: no globals, no DOM.
/**
 * Is what the mic heard mostly the claw's last spoken reply?
 * Compares five-word runs (shingles): more than 60% of the heard text's runs
 * appearing in the reply is an echo. Under five words cannot be judged and is
 * let through — short commands ("stop", "yes, do it") must never be eaten.
 */
function isOwnEcho(heard, spoken) {
  const words = (s) => String(s || "").toLowerCase()
    .replace(/['’]/g, "")             // "I'll" and "I’ll" are the same word
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ").filter(Boolean);
  const runs = (w) => {
    const out = [];
    for (let i = 0; i + 5 <= w.length; i++) out.push(w.slice(i, i + 5).join(" "));
    return out;
  };
  const heardRuns = runs(words(heard));
  if (heardRuns.length === 0) return false;
  const spokenRuns = new Set(runs(words(spoken)));
  const shared = heardRuns.filter((r) => spokenRuns.has(r)).length;
  return shared / heardRuns.length > 0.6;
}
// echo-guard:end

// ---------------------------------------------------------------------------
// Speech recognition (push-to-talk + wake word)
// ---------------------------------------------------------------------------
// The browser's recogniser is the FALLBACK ears: in Chrome it streams the
// operator's voice to Google (Safari: Apple, Edge: Microsoft). Local ears —
// whisper.cpp on this machine, further down — are used whenever the server
// has them, and the chip under the reactor says which is listening.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $("mic-btn");
let recognizer = null;
let wakeRecognizer = null;
let browserMicClick = null;  // set below when the browser has a recogniser

if (SR) {
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
  // The red mic's second press means "done — send it". Only the operator's
  // press sets this; a natural end (silence timeout, error) never sends, so
  // the original sin — the browser posting half a thought on its own — stays
  // impossible. What was two presses (stop, then SEND on the same spot of
  // screen) is one.
  let sendOnStop = false;

  // Sending must wipe the dictaphone's memory too. It used to clear only the
  // box — then the next repaint (another word, or just switching the mic off)
  // resurrected the sent message, and the operator had to delete it by hand. Again.
  resetDictation = () => { dictationBase = ""; finalSpeech = ""; };

  const paint = (interim) => {
    const parts = [dictationBase, finalSpeech, interim].map((s) => s.trim()).filter(Boolean);
    input.value = parts.join(" ");
  };

  // Paused while the claw speaks: the dictation stays open (the button stays
  // red, the words so far stay in the box), only the recogniser is stopped.
  let dictationPaused = false;

  const stopDictation = () => {
    recognizer = null;
    dictationPaused = false;
    micBtn.classList.remove("listening");
    if (state === "LISTENING") setState("STANDBY");
    paint("");                 // drop any uncommitted interim text
    input.placeholder = servicePlaceholder();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    if (sendOnStop) {
      sendOnStop = false;
      if (input.value.trim()) $("input-bar").requestSubmit();
    }
  };

  // One recogniser per stretch of listening; a pause for the claw's voice ends
  // it and the resume starts a fresh one. Each checks it is still the current
  // one, so a late "end" from the aborted recogniser cannot close dictation.
  const openRecognizer = () => {
    const r = new SR();
    recognizer = r;
    r.lang = "en-GB";
    // Keep listening through the pauses; a pause is not the end of a thought.
    r.continuous = true;
    // Show the words landing, so it is obvious it is hearing you.
    r.interimResults = true;

    r.onresult = (e) => {
      if (r !== recognizer || mustNotHear()) return;   // the claw's own voice
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          if (isOwnEcho(chunk, lastSpoken)) { noteEchoDropped(); continue; }
          finalSpeech += (finalSpeech ? " " : "") + chunk.trim();
        } else interim += chunk;
      }
      paint(interim);
    };

    r.onend = () => {
      if (r !== recognizer || dictationPaused) return;
      stopDictation();
    };
    r.onerror = (e) => {
      if (r !== recognizer || dictationPaused) return;
      if (e.error !== "aborted" && e.error !== "no-speech") {
        addMsg("system", `⚠ Microphone: ${e.error}`);
      }
      sendOnStop = false;      // an error is never the operator saying "send"
      stopDictation();
    };
    r.start();
  };

  pauseDictation = () => {
    if (!recognizer || dictationPaused) return;
    dictationPaused = true;
    paint("");
    try { recognizer.abort(); } catch { /* already ended */ }
    input.placeholder = "paused while I speak — press the mic to talk over me";
  };

  resumeDictation = () => {
    if (!recognizer || !dictationPaused) return;
    dictationPaused = false;
    if (state === "STANDBY") setState("LISTENING");
    input.placeholder = "listening — press the mic again to send";
    openRecognizer();
  };

  const startDictation = () => {
    dictationBase = input.value;
    finalSpeech = "";
    micBtn.classList.add("listening");
    setState("LISTENING");
    input.placeholder = "listening — press the mic again to send";
    openRecognizer();
  };

  browserMicClick = () => {
    // Talking over the claw means "be quiet, I'm speaking" — never "send".
    // silenceClaw() reopens a paused dictation; a closed one opens now.
    if (isClawSpeaking()) {
      silenceClaw();
      if (!recognizer) startDictation();
      return;
    }
    // In the quiet tail after speech the recogniser is still paused, and a
    // stop() on it would never end — the press would do nothing. Reopen first.
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
      resumeHearing();
    }
    if (recognizer) { sendOnStop = true; recognizer.stop(); return; }
    startDictation();
  };
}

function startWakeLoop() {
  // The wake word is a recogniser left running on the room. Only browser ears
  // can do that today; with local ears it would mean shipping the room to
  // Google for the sake of one word, so it stays off (a local wake word is a
  // follow-up).
  if (!SR || !wakeEnabled || ears.engine !== "browser") return;
  // resumeHearing() restarts it once the claw has finished speaking, and one
  // listener at a time — a second would hear every command twice.
  if (wakeRecognizer || mustNotHear()) return;
  const r = new SR();
  wakeRecognizer = r;
  r.lang = "en-GB";
  r.continuous = true;
  r.interimResults = false;
  r.onresult = (e) => {
    if (mustNotHear()) return;
    const text = e.results[e.results.length - 1][0].transcript.trim();
    const m = text.match(/(?:cunning\s+)?claw[,.]?\s*(.*)/i);
    if (m) {
      // The claw saying its own name aloud is not the operator calling it.
      if (isOwnEcho(text, lastSpoken)) { noteEchoDropped(); return; }
      const cmd = m[1].trim();
      if (cmd) sendMessage(cmd);
      else speak(`Yes, ${sir()}?`);
    }
  };
  r.onend = () => {
    if (wakeRecognizer === r) wakeRecognizer = null;
    if (wakeEnabled) setTimeout(startWakeLoop, 400);
  };
  r.onerror = () => {};
  try { r.start(); } catch { wakeRecognizer = null; /* already running */ }
}

// ---------------------------------------------------------------------------
// Local ears — the mic transcribed on this machine (src/ears.ts, whisper.cpp)
// ---------------------------------------------------------------------------
// local-ears:begin — src/ears.test.ts runs this exact block, so keep it
// self-contained: no globals, no DOM.
const EARS_RATE = 16000;

/** Root-mean-square level of one block of samples, 0..1. */
function frameRms(f32) {
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  return f32.length ? Math.sqrt(sum / f32.length) : 0;
}

/**
 * Any rate → 16 kHz, which is what whisper.cpp wants. A box filter first so
 * a 48 kHz mic's hiss does not fold down into the speech band, then linear
 * interpolation. AudioContext({ sampleRate: 16000 }) would be simpler, but
 * Firefox refuses to connect a mic at another rate into it.
 */
function downsampleTo16k(f32, fromRate) {
  if (fromRate === EARS_RATE) return f32;
  const ratio = fromRate / EARS_RATE;
  let src = f32;
  const width = Math.floor(ratio);
  if (width > 1) {
    src = new Float32Array(f32.length);
    let acc = 0;
    for (let i = 0; i < f32.length; i++) {
      acc += f32[i];
      if (i >= width) acc -= f32[i - width];
      src[i] = acc / Math.min(i + 1, width);
    }
  }
  const out = new Float32Array(Math.floor(f32.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const a = src[j] || 0;
    const b = j + 1 < src.length ? src[j + 1] : a;
    out[i] = a + (b - a) * (pos - j);
  }
  return out;
}

/** Mono 16-bit PCM WAV. Plain JS, so no ffmpeg is needed on either side. */
function encodeWav16(f32, rate) {
  const buf = new ArrayBuffer(44 + f32.length * 2);
  const v = new DataView(buf);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + f32.length * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/**
 * Voice-activity detection: has the operator started, and stopped, talking?
 * Energy against a noise floor seeded from the first block, that drops at once
 * to anything quieter and creeps up over ~10 s — so a fan is the room, not
 * someone talking, and a long sentence is not mistaken for the room either.
 * (Seeded from a fixed floor instead, a fan read as speech from the first
 * block and was sent to whisper, which wrote words for it.) Speech is 150 ms above threshold; the end is 1.2 s
 * of quiet after it — long enough for a breath, short enough not to wait.
 * feed() answers "speech" | "silence" | "end" (stop, transcribe) | "none"
 * (no speech at all: stop, send nothing).
 */
function createVad(opts) {
  const o = Object.assign({ hangoverMs: 1200, noSpeechMs: 8000, maxMs: 60000, minSpeechMs: 150, floor: 0.008, factor: 3 }, opts || {});
  let elapsed = 0, voiced = 0, quiet = 0, started = false, noise = null;
  return {
    feed(rms, ms) {
      elapsed += ms;
      if (noise === null) noise = rms;
      const loud = rms > Math.max(o.floor, noise * o.factor);
      noise = rms < noise ? rms : noise + (rms - noise) * (1 - Math.exp(-ms / 10000));
      if (loud) {
        voiced += ms;
        quiet = 0;
        if (voiced >= o.minSpeechMs) started = true;
      } else {
        quiet += ms;
        if (!started) voiced = 0;   // a click or a cough is not speech starting
      }
      if (elapsed >= o.maxMs) return started ? "end" : "none";
      if (started && quiet >= o.hangoverMs) return "end";
      if (!started && elapsed >= o.noSpeechMs) return "none";
      return loud ? "speech" : "silence";
    },
    get started() { return started; },
  };
}

/**
 * What the ears chip says. Honest about where the audio goes: the browser's
 * recogniser is a cloud service whichever browser it is, and whose depends on
 * the browser.
 */
function earsLabel(status, userAgent, vendor) {
  const engine = status && status.engine;
  if (engine === "whisper") {
    const model = String(status.detail || "").split("·").pop().trim();
    return { text: `LOCAL EARS${model ? ` · ${model}` : ""}`, cls: "local", cloud: "" };
  }
  if (engine === "browser") {
    const cloud = /Edg\//.test(userAgent || "") ? "Microsoft" : /Apple/.test(vendor || "") ? "Apple" : "Google";
    return { text: `BROWSER EARS — audio goes to ${cloud}`, cls: "cloud", cloud };
  }
  if (engine === "off") return { text: "EARS OFF", cls: "off", cloud: "" };
  return { text: "", cls: "", cloud: "" };
}
// local-ears:end

let ears = { engine: "unknown", label: "EARS", detail: "" };
let localRec = null;          // the recording in progress, if any
let warnedCloudEars = false;  // the "your voice goes to Google" line, once a load

function localRecording() {
  return Boolean(localRec && !localRec.done);
}

function paintEars() {
  const chip = $("ears-chip");
  const l = earsLabel(ears, navigator.userAgent, navigator.vendor);
  if (chip) {
    chip.textContent = l.text;
    chip.className = l.cls;
    chip.title = ears.detail || "";
  }
  const usable = ears.engine === "whisper" || (ears.engine === "browser" && SR);
  micBtn.classList.toggle("unsupported", !usable && ears.engine !== "unknown");
  micBtn.title = ears.engine === "whisper"
    ? "Local ears: click to speak — it stops when you do; click again to send"
    : ears.engine === "browser" && SR
      ? `Browser ears (audio goes to ${l.cloud}): click to speak, click again to send`
      : ears.engine === "off" ? `Ears off — ${ears.detail}` : "No speech recognition available";
  $("wake-toggle").classList.toggle("unsupported", !(SR && ears.engine === "browser"));
}

function setEars(next) {
  if (!next || typeof next.engine !== "string") return;
  ears = next;
  paintEars();
}

const earsReady = (async () => {
  try { setEars(await (await fetch("/api/listen")).json()); } catch { /* the status poll retries */ }
})();

/**
 * The worklet that taps the mic. Inline, from a Blob, so the HUD stays a set
 * of static files with no build step; it batches the 128-sample render quanta
 * into 2048 so the main thread is not woken 375 times a second.
 */
const TAP_WORKLET = `
class ClawTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("claw-tap", ClawTap);`;

async function openTap(ac, source, onFrame) {
  try {
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "text/javascript" }));
    try { await ac.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const node = new AudioWorkletNode(ac, "claw-tap");
    node.port.onmessage = (e) => onFrame(e.data);
    source.connect(node);
    return node;
  } catch {
    // Older Safari, or a page where Blob modules are refused.
    const node = ac.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(node);
    return node;
  }
}

/**
 * Press-to-talk that lets go by itself. Same dictaphone rules as the browser
 * path: the words land in the box for the operator to read; only a second
 * press sends. The VAD ending the clip never sends — that is the original
 * sin, a half-thought posted on a pause for breath.
 */
async function startLocalDictation() {
  const input = $("msg-input");
  const rec = { done: false, sendOnStop: false, transcribing: false, finish: null };
  localRec = rec;
  micBtn.classList.add("listening");
  setState("LISTENING");
  input.placeholder = "LOCAL EARS — listening on this machine; it stops when you do";

  let stream, ac;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    ac = new AudioContext();
    await ac.resume();
  } catch (err) {
    addMsg("system", `⚠ Microphone: ${err && err.message ? err.message : err}`);
    endLocalDictation(rec);
    return;
  }
  const source = ac.createMediaStreamSource(stream);
  const chunks = [];
  const vad = createVad();
  const rate = ac.sampleRate;
  let node = null;  // a quick second press can finish before the tap exists

  const teardown = () => {
    try { node && node.disconnect(); } catch { /* gone */ }
    try { source.disconnect(); } catch { /* gone */ }
    for (const t of stream.getTracks()) t.stop();
    ac.close().catch(() => {});
  };

  rec.finish = async (heardNothing) => {
    if (rec.done || rec.transcribing) return;
    rec.transcribing = true;
    teardown();
    if (heardNothing || (!vad.started && !rec.sendOnStop) || chunks.length === 0) {
      if (!rec.sendOnStop) addMsg("system", "I heard nothing, sir.");
      return endLocalDictation(rec);
    }
    input.placeholder = "transcribing on this machine…";
    micBtn.classList.add("busy");
    let total = 0;
    for (const c of chunks) total += c.length;
    const all = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    const wav = encodeWav16(downsampleTo16k(all, rate), EARS_RATE);
    try {
      const res = await fetch("/api/listen", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      const text = String(out.text || "").trim();
      if (text && isOwnEcho(text, lastSpoken)) noteEchoDropped();
      else if (text) {
        const base = input.value.trim();
        input.value = base ? `${base} ${text}` : text;
      } else if (!rec.sendOnStop) addMsg("system", "I heard nothing, sir.");
    } catch (err) {
      addMsg("system", `⚠ Local ears: ${err.message}`);
      rec.sendOnStop = false;  // a failure is never the operator saying "send"
    }
    endLocalDictation(rec);
  };

  node = await openTap(ac, source, (f32) => {
    if (rec.done || rec.transcribing) return;
    // The claw's own voice is never recorded, and does not count as the
    // operator's silence either: the clip simply skips it.
    if (mustNotHear()) return;
    chunks.push(f32);
    const verdict = vad.feed(frameRms(f32), (f32.length / rate) * 1000);
    if (verdict === "end") rec.finish(false);
    else if (verdict === "none") rec.finish(true);
  });
  // A ScriptProcessor only runs while connected to the speakers; through a
  // muted gain, so the operator never hears themselves.
  const mute = ac.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ac.destination);
  if (rec.done || rec.transcribing) teardown();
}

// While the claw speaks, the clip skips frames (see mustNotHear above); the
// placeholder says so, as it does for the browser recogniser.
{
  const pause = pauseDictation;
  const resume = resumeDictation;
  pauseDictation = () => {
    if (localRecording() && !localRec.transcribing) $("msg-input").placeholder = "paused while I speak — press the mic to talk over me";
    pause();
  };
  resumeDictation = () => {
    if (localRecording() && !localRec.transcribing) $("msg-input").placeholder = "LOCAL EARS — listening on this machine; it stops when you do";
    resume();
  };
}

function endLocalDictation(rec) {
  rec.done = true;
  if (localRec === rec) localRec = null;
  micBtn.classList.remove("listening", "busy");
  if (state === "LISTENING") setState("STANDBY");
  const input = $("msg-input");
  input.placeholder = "At your service, sir…";
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  if (rec.sendOnStop && input.value.trim()) $("input-bar").requestSubmit();
}

function localMicClick() {
  if (isClawSpeaking() || resumeTimer !== null) {
    // Talking over the claw: hush it. Never "send".
    if (isClawSpeaking()) silenceClaw();
    else { clearTimeout(resumeTimer); resumeTimer = null; resumeHearing(); }
    if (!localRecording()) startLocalDictation();
    return;
  }
  if (localRecording()) {
    // The second press: done talking, send what was said.
    localRec.sendOnStop = true;
    if (localRec.finish && !localRec.transcribing) localRec.finish(false);
    return;
  }
  startLocalDictation();
}

micBtn.addEventListener("click", async () => {
  await earsReady;
  if (ears.engine === "whisper") return localMicClick();
  if (ears.engine === "browser" && browserMicClick) {
    if (!warnedCloudEars && !recognizer) {
      warnedCloudEars = true;
      const { cloud } = earsLabel(ears, navigator.userAgent, navigator.vendor);
      addMsg("system", `Browser ears: what you say is sent to ${cloud} to be transcribed. For private ears, run ./setup-ears.sh (npm run doctor shows the fix).`);
    }
    return browserMicClick();
  }
  addMsg("system", ears.engine === "off"
    ? `The mic is off — ${ears.detail}`
    : "No speech recognition here: this browser has none and whisper.cpp is not set up. Run ./setup-ears.sh.");
});

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

let turnKind = "user";      // "heartbeat" turns must not talk over a reply
es.addEventListener("turn_start", (e) => {
  turnKind = sseData(e).kind === "heartbeat" ? "heartbeat" : "user";
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
  const { name, injection } = sseData(e);
  const chip = addChip(`✓ ${name} complete`);
  // The scanner (src/injection.ts) found text in this result aimed at the
  // claw. The model was warned; this is so the operator can see it too.
  if (injection && Array.isArray(injection.signals)) {
    const flag = document.createElement("span");
    flag.className = "inj-flag";
    flag.textContent = "⚑ instructions inside";
    flag.title =
      `This result contains text that tried to give instructions (${injection.signals.map(String).join(", ")}). ` +
      `It was treated as data, and anything irreversible this turn asks you first.`;
    chip.appendChild(flag);
  }
});

es.addEventListener("brain_route", (e) => {
  const { to, reason } = sseData(e);
  const div = document.createElement("div");
  div.className = "guard-chip";
  div.textContent = `\u25b8 ${to} takes this one \u00b7 ${reason}`;
  div.title = "A making job goes to the capable brain. Pin a brain to stop this.";
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
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

// A plan was approved: from here, its listed steps run without cards. Say so
// once, plainly, so the quiet that follows is understood rather than eerie.
// A job started, finished or died on a box. The floor view lives on /board;
// this is the one-line notice on the glass so the operator is not surprised.
es.addEventListener("remote_job", (e) => {
  const { name, box, state, command } = sseData(e);
  const div = document.createElement("div");
  div.className = "guard-chip";
  const mark = state === "finished" ? "\u2713" : state === "died" ? "\u2717" : "\u25b8";
  div.textContent = `${mark} ${box} \u00b7 ${name} \u00b7 ${state}`;
  if (command) div.title = command;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

es.addEventListener("plan_active", (e) => {
  const { title, total, minutesLeft } = sseData(e);
  const div = document.createElement("div");
  div.className = "guard-chip";
  div.textContent = `\u25b8 plan approved \u00b7 ${title} \u00b7 ${total} step(s), ${minutesLeft}m`;
  div.title = "These steps run without asking again. Anything else still raises a card.";
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

// Each step as it is spent. This is the audit trail: the card is gone, the
// record is not.
es.addEventListener("plan_step", (e) => {
  const { plan, step, tool, match } = sseData(e);
  const div = document.createElement("div");
  div.className = "guard-chip";
  div.textContent = `\u2713 plan step ${step} \u00b7 ${tool}: ${match}`;
  div.title = `Pre-approved under "${plan}".`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

es.addEventListener("heartbeat_ok", (e) => {
  const { at } = sseData(e);
  // A quiet heartbeat never sends turn_done, so without this the HUD sat on
  // THINKING with STOP showing, under a bubble that just said HEARTBEAT_OK.
  if (currentBubble && currentBubble.textContent.trim() === "HEARTBEAT_OK") {
    (currentBubble.closest(".msg") || currentBubble).remove();
  }
  currentBubble = null;
  setState("STANDBY");
  const chip = $("hb-chip");
  if (chip && at) chip.textContent = `\u2661 ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
});

es.addEventListener("turn_done", (e) => {
  const { text, stopped } = sseData(e);
  setState("STANDBY");
  // "Stop" stops the browser's voice as well as the server's.
  if (stopped) { if ("speechSynthesis" in window) speechSynthesis.cancel(); return; }
  // A heartbeat's news waits behind a reply being read, as on the server.
  speak(text, { after: turnKind === "heartbeat" });
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

// A house event (src/home-events.ts): the doorbell, a door, someone arriving.
// One system line built from our own fields — textContent via addMsg, as the
// friendly name came from HA. The still is not shown: it stays on disk.
es.addEventListener("home_event", (e) => {
  const { what, at, snapshot } = sseData(e);
  addMsg("system", `Home: ${what} (${String(at ?? "").slice(11)})${snapshot ? " · still saved" : ""}`);
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
  // The frame is a flex child with flex: 1, which ignores width; set the basis too.
  frame.style.flex = w ? `0 0 ${w}px` : "";
  frame.style.maxWidth = "100%";
  for (const b of document.querySelectorAll(".ctl.dev")) {
    b.classList.toggle("active", Number(b.dataset.w) === w);
  }
  // Report what the frame really is. A 768 request in a 546 px panel is
  // capped at 546, and the readout used to claim 768 regardless.
  const real = Math.round(frame.getBoundingClientRect().width) || "—";
  $("vp-dims").textContent = `${real} × ${frame.clientHeight || "—"}` +
    (w && typeof real === "number" && real < w ? ` (asked ${w}; the panel is narrower)` : "");
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

es.addEventListener("hello", () => {
  sseConnected = true;
  paintConnection();
  // A restarted server is silent; one still talking re-sends "speaking" right
  // after hello. Either way a stale "on" from before the drop must not keep
  // the mic shut for good.
  if (serverSpeaking) clawSpeaking("server", false);
});

// The server's voice (Piper/espeak) starting and stopping — see clawSpeaking().
es.addEventListener("speaking", (e) => {
  const { on, text } = sseData(e);
  clawSpeaking("server", Boolean(on), typeof text === "string" ? text : "");
});
es.onopen = () => { sseConnected = true; paintConnection(); };
es.onerror = () => { sseConnected = false; paintConnection(); };

es.addEventListener("timer_fired", (e) => {
  const { label } = sseData(e);
  addMsg("system", `⏰ ${label}`);
  speak(`${sir(true)}, a reminder: ${label}`);
});

es.addEventListener("approval_request", (e) => {
  const { id, summary, detail, practice, label } = sseData(e);
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
  // Learn mode's practice card: the same card, the same three buttons, so the
  // decision skill transfers — plus a stripe. The stripe comes only from the
  // server's practice flag, never from the card's text (src/approvals.ts takes
  // the label's words out of every real card).
  if (practice === true) {
    card.classList.add("practice");
    const stripe = document.createElement("div");
    stripe.className = "practice-stripe";
    stripe.textContent = String(label || "PRACTICE · nothing real will happen");
    card.prepend(stripe);
    card.querySelector(".ttl").firstChild.textContent = "PRACTICE CARD — ";
  }
  $("approval-area").appendChild(card);
  if (practice !== true) speak(`Requesting authorisation, ${sir()}.`);
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
      if (s.lessons > 0) {
        // Lessons are how a skill improves with use; show that it has.
        const les = document.createElement("span");
        les.className = "sk-lessons";
        les.textContent = `${s.lessons} lesson${s.lessons === 1 ? "" : "s"} learned here`;
        card.appendChild(les);
      }
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
            // toggleSkill re-rendered the list, so `card` is no longer on the page.
            const live = document.querySelector(`.skill-card[data-name="${CSS.escape(s.name)}"]`) || card;
            if (!live.querySelector(".sk-more")) live.appendChild(more);
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

// ---------------------------------------------------------------------------
// Mission control
// ---------------------------------------------------------------------------
// Every job the server registers (src/jobs.ts), kept live by the "job" event.
// An opened review is held here by id, not in the DOM, so the next event's
// re-render does not wipe what the operator just opened — the shape of the
// bug the connectors sheet and the Desk both had.
// jobs-apply:begin
const jobsById = new Map();
const jobReviews = new Map(); // id -> report text, or "" while it loads
const jobCancelling = new Set();
const LIVE_JOB_STATES = ["queued", "running", "needs-approval"];

/**
 * Keep the newest word on each job. The reply to a Cancel click carries the
 * job as it was when the server answered; the stream can already have said
 * it stopped. Found driving the HUD: the reply landed second and put a
 * cancelled job back to "running" on the glass. The registry's rev orders them.
 */
function applyJob(job) {
  if (!job || !job.id) return;
  const have = jobsById.get(job.id);
  if (have && (Number(have.rev) || 0) > (Number(job.rev) || 0)) return;
  jobsById.set(job.id, job);
}
// jobs-apply:end

function jobClock(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

function renderJobsBadge() {
  const live = [...jobsById.values()].filter((j) => LIVE_JOB_STATES.includes(j.state)).length;
  const badge = $("jobs-badge");
  if (badge) {
    badge.hidden = live === 0;
    badge.textContent = String(live);
  }
  const count = $("jobs-count");
  if (count) count.textContent = jobsById.size ? `${live} live · ${jobsById.size} in all` : "";
}

function renderJobs() {
  renderJobsBadge();
  const root = $("jobs-list");
  if (!root || $("jobs-overlay")?.hidden) return;
  root.replaceChildren();
  const list = [...jobsById.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "jobs-empty";
    empty.textContent = "Nothing on the board. Ask for a coding job — “have Claude Code fix …” — and it appears here, live.";
    root.appendChild(empty);
    return;
  }
  for (const j of list) {
    const card = document.createElement("div");
    card.className = "job-card";
    card.dataset.state = j.state;
    card.dataset.id = j.id;

    const top = document.createElement("div");
    top.className = "job-top";
    const state = document.createElement("span");
    state.className = "job-state";
    state.textContent = j.state;
    const title = document.createElement("span");
    title.className = "job-title";
    title.textContent = j.title;
    top.append(state, title);

    const meta = document.createElement("div");
    meta.className = "job-meta";
    const started = jobClock(j.startedAt || j.createdAt);
    const ended = jobClock(j.finishedAt);
    meta.textContent = `${j.kind} · ${String(j.id).slice(0, 8)}${started ? ` · from ${started}` : ""}${ended ? ` · ended ${ended}` : ""}`;

    const status = document.createElement("div");
    status.className = "job-status";
    status.textContent = j.status || "";

    card.append(top, meta, status);

    const actions = document.createElement("div");
    actions.className = "job-actions";
    // needs-approval is answered on its card, not here: Cancel would only be
    // a second, quieter way of saying no.
    if (j.state === "running" || j.state === "queued") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "ctl cancel";
      const busy = jobCancelling.has(j.id);
      cancel.disabled = busy;
      cancel.textContent = busy ? "CANCELLING…" : "CANCEL";
      cancel.onclick = () => cancelJob(j.id);
      actions.appendChild(cancel);
    }
    if (j.kind === "foreman" && j.reviewable && !LIVE_JOB_STATES.includes(j.state)) {
      const open = jobReviews.has(j.id);
      const review = document.createElement("button");
      review.type = "button";
      review.className = "ctl" + (open ? " active" : "");
      review.textContent = open ? "HIDE" : "REVIEW";
      review.onclick = () => toggleReview(j.id);
      actions.appendChild(review);
    }
    if (actions.childElementCount) card.appendChild(actions);

    if (jobReviews.has(j.id)) {
      const pre = document.createElement("pre");
      pre.className = "job-review";
      // The report carries Claude Code's own words inside the fence: text,
      // never markup.
      pre.textContent = jobReviews.get(j.id) || "Loading the report…";
      card.appendChild(pre);
    }
    root.appendChild(card);
  }
}

async function cancelJob(id) {
  jobCancelling.add(id);
  renderJobs();
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (body.job) applyJob(body.job);
    if (!res.ok && body.message) addMsg("system", body.message);
  } catch {
    addMsg("system", "Could not reach the claw to cancel that job.");
  } finally {
    jobCancelling.delete(id);
    renderJobs();
  }
}

async function toggleReview(id) {
  if (jobReviews.has(id)) {
    jobReviews.delete(id);
    renderJobs();
    return;
  }
  jobReviews.set(id, "");
  renderJobs();
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/review`);
    const body = await res.json().catch(() => ({}));
    jobReviews.set(id, res.ok ? String(body.text || "") : String(body.error || "No report."));
  } catch {
    jobReviews.set(id, "Could not reach the claw for the report.");
  }
  renderJobs();
}

async function loadJobs() {
  try {
    const res = await fetch("/api/jobs");
    if (!res.ok) return;
    const data = await res.json();
    for (const j of Array.isArray(data.jobs) ? data.jobs : []) applyJob(j);
    renderJobs();
  } catch { /* the stream fills it in */ }
}

function setJobsOpen(open) {
  const overlay = $("jobs-overlay");
  const btn = $("jobs-toggle");
  if (!overlay || !btn) return;
  overlay.hidden = !open;
  btn.classList.toggle("active", open);
  if (open) renderJobs();
}

es.addEventListener("job", (e) => {
  applyJob(sseData(e));
  renderJobs();
});
// A reconnect may have missed changes; the list is cheap to fetch again.
es.addEventListener("hello", () => loadJobs());

$("jobs-toggle")?.addEventListener("click", () => setJobsOpen($("jobs-overlay").hidden));
$("jobs-close")?.addEventListener("click", () => setJobsOpen(false));
$("jobs-overlay")?.addEventListener("click", (e) => {
  if (e.target === $("jobs-overlay")) setJobsOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("jobs-overlay") && !$("jobs-overlay").hidden) setJobsOpen(false);
});
loadJobs();

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
  resetDictation(); // or the mic's memory resurrects the sent message
  sendMessage(text);
});

// ---------------------------------------------------------------------------
// File upload — the paperclip
// ---------------------------------------------------------------------------
$("attach-btn")?.addEventListener("click", () => $("attach-input").click());
$("attach-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    addMsg("system", "⚠ That file is over 20MB — too big for the chat paperclip.");
    return;
  }
  addMsg("system", `Uploading ${file.name}…`);
  const data = await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.readAsDataURL(file);
  });
  try {
    const resp = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, data }),
    });
    const d = await resp.json();
    if (!resp.ok || !d.path) throw new Error(d.error || `HTTP ${resp.status}`);
    const input = $("msg-input");
    input.value = `[file attached: ${d.path}] ${input.value}`;
    input.focus();
    addMsg("system", `📎 ${file.name} uploaded — add your words and send.`);
  } catch (err) {
    addMsg("system", `⚠ Upload failed: ${err.message}`);
  }
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
  if (!SR || ears.engine !== "browser") {
    addMsg("system", ears.engine === "whisper"
      ? "WAKE needs a recogniser listening to the room all the time, and only the browser's (cloud) one can — so it stays off with local ears."
      : "WAKE needs speech recognition, and this browser has none.");
    return;
  }
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
let brainPickerPainted = "";
function renderBrainPicker(payload) {
  const el = $("brain-picker");
  if (!el) return;
  const data = payload?.catalog ? payload : payload?.brains ? payload.brains : null;
  const catalog = data?.catalog ?? payload?.catalog;
  if (!catalog) return;
  const pin = data.pin ?? null;
  const activeId = data.active?.id;
  // Rebuilding on every 5s poll destroyed the button under the cursor
  // between mousedown and mouseup — a click on a brain silently died once
  // in a while. Only rebuild when what the picker shows has changed.
  const signature = JSON.stringify({ catalog, pin, activeId });
  if (signature === brainPickerPainted) return;
  brainPickerPainted = signature;
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
      brain, brains, telegram, discord, ntfy, home, toolCount, preview, spend, toolDiet,
      addressAs: as, ears: earsNow,
    } = await res.json();
    learnAddress({ addressAs: as });
    renderBrainPicker(brains);
    // whisper set up while the HUD is open: the chip, and the mic, follow.
    if (earsNow && (earsNow.engine !== ears.engine || earsNow.detail !== ears.detail) && !localRecording() && !recognizer) setEars(earsNow);
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
      `Discord: ${discord?.enabled ? `on (${(discord.users || []).join(", ")})` : "off"}`,
      `ntfy: ${ntfy?.enabled ? `on (${ntfy.topic} · ${ntfy.server}${ntfy.delivery === "failing" ? " · failing" : ""})` : "off"}`,
      // The house watcher: the link's state and the rule count, never a host.
      `Home watch: ${home?.enabled ? `${home.link} · ${home.rules} rule${home.rules === 1 ? "" : "s"}` : `off${home?.why ? ` (${home.why})` : ""}`}`,
      toolDiet?.text ?? "",
    ].filter((line, i) => i === 0 || line).join("\n");
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
      $("spend-chip").title = toolDiet?.text ?? "";
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


