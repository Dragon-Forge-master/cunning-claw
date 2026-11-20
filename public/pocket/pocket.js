// Pocket Claw — the phone's glass. Vanilla JS, no build, like the HUD.
// Every word the model or a stranger wrote is set with textContent; there is
// no innerHTML in this file. The device token lives in an HttpOnly cookie the
// page never sees; the page holds no secret of its own.
"use strict";

const $ = (id) => document.getElementById(id);
const VIEWS = ["pair", "gone", "talk", "approvals", "share", "phone"];
const state = { me: null, unlocked: false, approvals: new Map(), events: null, claw: null, toolLine: null, shared: [] };

// --- small helpers -------------------------------------------------------------

function show(view) {
  for (const v of VIEWS) $(`screen-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("on", a.dataset.view === view);
  if (view === "talk") scrollLog();
}

function say(id, text, bad = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("bad", bad);
}

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", credentials: "same-origin", headers: {} };
  if (opts.body !== undefined) {
    init.headers["Content-Type"] = opts.type || "application/json";
    init.body = opts.type ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(`/pocket/api${path}`, init);
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (res.status === 423) setLocked(true);
  return { status: res.status, ok: res.ok, json: json || {} };
}

const b64uToBytes = (s) => {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const bytesToB64u = (buf) => {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// --- WebAuthn ---------------------------------------------------------------------

async function webauthnCreate(pk) {
  const publicKey = {
    ...pk,
    challenge: b64uToBytes(pk.challenge),
    user: { ...pk.user, id: b64uToBytes(pk.user.id) },
  };
  const cred = await navigator.credentials.create({ publicKey });
  return {
    id: cred.id,
    type: cred.type,
    response: {
      clientDataJSON: bytesToB64u(cred.response.clientDataJSON),
      attestationObject: bytesToB64u(cred.response.attestationObject),
    },
  };
}

async function webauthnGet(pk) {
  const publicKey = {
    ...pk,
    challenge: b64uToBytes(pk.challenge),
    allowCredentials: (pk.allowCredentials || []).map((c) => ({ ...c, id: b64uToBytes(c.id) })),
  };
  const a = await navigator.credentials.get({ publicKey });
  return {
    id: a.id,
    type: a.type,
    response: {
      clientDataJSON: bytesToB64u(a.response.clientDataJSON),
      authenticatorData: bytesToB64u(a.response.authenticatorData),
      signature: bytesToB64u(a.response.signature),
      userHandle: a.response.userHandle ? bytesToB64u(a.response.userHandle) : null,
    },
  };
}

/** A fresh assertion for one purpose — unlock, or approve/deny one card. */
async function prove(purpose, approvalId) {
  const c = await api("/challenge", { method: "POST", body: { purpose, approvalId } });
  if (!c.ok) throw new Error(c.json.error || `HTTP ${c.status}`);
  return webauthnGet(c.json.publicKey);
}

// --- Pairing -----------------------------------------------------------------------

function defaultName() {
  const ua = navigator.userAgent;
  const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  if (m && m[1] && m[1] !== "K") return m[1].trim().slice(0, 40);
  return /Android/.test(ua) ? "Android phone" : /iPhone/.test(ua) ? "iPhone" : "Phone";
}

function startPairing(code) {
  show("pair");
  $("pair-name").value = defaultName();
  $("pair-go").onclick = async () => {
    $("pair-go").disabled = true;
    say("pair-msg", "Asking the claw…");
    try {
      const opts = await api("/pair/options", { method: "POST", body: { code } });
      if (!opts.ok) throw new Error(opts.json.error || `HTTP ${opts.status}`);
      say("pair-msg", "Touch the sensor, or use your screen lock.");
      const credential = await webauthnCreate(opts.json.publicKey);
      const done = await api("/pair/finish", { method: "POST", body: { enrolment: opts.json.enrolment, name: $("pair-name").value, credential } });
      if (!done.ok) throw new Error(done.json.error || `HTTP ${done.status}`);
      say("pair-msg", "Paired.");
      await start("talk");
    } catch (err) {
      say("pair-msg", `Not paired: ${err.message || err}`, true);
      $("pair-go").disabled = false;
    }
  };
}

// --- Lock ------------------------------------------------------------------------------

function setLocked(locked) {
  state.unlocked = !locked;
  $("locked-panel").hidden = !locked;
  $("composer").hidden = locked;
  $("log").hidden = locked;
  $("lock-state").hidden = false;
  $("lock-state").textContent = locked ? "LOCKED" : "OPEN";
}

async function unlock() {
  $("unlock-go").disabled = true;
  try {
    const assertion = await prove("unlock");
    const r = await api("/unlock", { method: "POST", body: { assertion } });
    if (!r.ok) throw new Error(r.json.error || `HTTP ${r.status}`);
    setLocked(false);
    await loadHistory();
  } catch (err) {
    addLine("sys", `Still locked: ${err.message || err}`);
  } finally {
    $("unlock-go").disabled = false;
  }
}

// --- Talk ------------------------------------------------------------------------------

function scrollLog() {
  const main = document.querySelector("main");
  main.scrollTop = main.scrollHeight;
}

function addLine(kind, text) {
  const div = document.createElement("div");
  div.className = `bubble ${kind}`;
  div.textContent = text;
  $("log").appendChild(div);
  scrollLog();
  return div;
}

async function loadHistory() {
  const r = await api("/history");
  if (!r.ok) return;
  $("log").replaceChildren();
  for (const t of r.json.turns || []) addLine(t.role === "user" ? "me" : "claw", t.text);
}

async function send(text) {
  const message = String(text || "").trim();
  if (!message) return;
  addLine("me", message);
  const r = await api("/chat", { method: "POST", body: { message } });
  if (!r.ok) addLine("sys", r.json.error || `Not sent (HTTP ${r.status}).`);
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("say").value;
  $("say").value = "";
  void send(v);
});

// --- Voice: recorded here, transcribed by the claw's own ears (whisper.cpp) ----------

const EARS_RATE = 16000;
let rec = null;

function downsample(f32, from) {
  if (from === EARS_RATE) return f32;
  const ratio = from / EARS_RATE;
  const out = new Float32Array(Math.floor(f32.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // Average the source samples this output sample stands for: a box filter,
    // so a 48 kHz mic's hiss does not fold into the speech band.
    const a = Math.floor(i * ratio);
    const b = Math.min(f32.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += f32[j];
    out[i] = b > a ? sum / (b - a) : 0;
  }
  return out;
}

function wav16(f32, rate) {
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

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ac = new AudioContext();
  await ac.resume();
  const src = ac.createMediaStreamSource(stream);
  const node = ac.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  const mute = ac.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute);
  mute.connect(ac.destination);
  rec = { stream, ac, node, src, chunks, rate: ac.sampleRate };
  $("mic").classList.add("live");
  $("say").placeholder = "Listening — press again to stop";
}

async function stopRecording() {
  const r = rec;
  rec = null;
  $("mic").classList.remove("live");
  $("say").placeholder = "Transcribing on the claw…";
  try { r.node.disconnect(); r.src.disconnect(); } catch { /* gone */ }
  for (const t of r.stream.getTracks()) t.stop();
  r.ac.close().catch(() => {});
  let n = 0;
  for (const c of r.chunks) n += c.length;
  const all = new Float32Array(n);
  let off = 0;
  for (const c of r.chunks) { all.set(c, off); off += c.length; }
  const res = await api("/listen", { method: "POST", type: "audio/wav", body: wav16(downsample(all, r.rate), EARS_RATE) });
  $("say").placeholder = "Say something to the claw";
  if (!res.ok) return addLine("sys", res.json.error || `Ears: HTTP ${res.status}`);
  // Dictaphone rule, as on the HUD: the words land in the box; you send them.
  const text = String(res.json.text || "").trim();
  if (text) $("say").value = $("say").value ? `${$("say").value} ${text}` : text;
  else addLine("sys", "I heard nothing.");
}

$("mic").addEventListener("click", async () => {
  try {
    if (rec) await stopRecording();
    else await startRecording();
  } catch (err) {
    rec = null;
    $("mic").classList.remove("live");
    addLine("sys", `Microphone: ${err.message || err}`);
  }
});

// --- Camera and shared files -------------------------------------------------------------

$("snap").addEventListener("click", () => $("camera").click());
$("camera").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (f) openShare([f], "receipt");
});

function openShare(files, suggested) {
  state.shared = files.slice(0, 1);
  const box = $("share-preview");
  box.replaceChildren();
  for (const f of state.shared) {
    if (f.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.alt = "The shared picture";
      img.src = URL.createObjectURL(f);
      box.appendChild(img);
    }
    const line = document.createElement("div");
    line.className = "file";
    // A stranger chose this name; it is shown as text and never sent as ours.
    line.textContent = `${f.type || "file"} · ${Math.round(f.size / 1024)} KB`;
    box.appendChild(line);
  }
  if (files.length > 1) say("share-msg", "One file at a time — the first is here.");
  else say("share-msg", "");
  $("share-receipt").classList.toggle("primary", suggested === "receipt");
  $("share-ask").classList.toggle("primary", suggested !== "receipt");
  show("share");
}

async function sendShare(intent) {
  const f = state.shared[0];
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) return say("share-msg", "That file is over 20MB.", true);
  for (const b of ["share-receipt", "share-ask", "share-keep"]) $(b).disabled = true;
  say("share-msg", "Sending to the claw…");
  try {
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(f);
    });
    const note = $("share-note").value;
    const res = await api("/upload", { method: "POST", body: { data, intent, note } });
    if (!res.ok) throw new Error(res.json.error || `HTTP ${res.status}`);
    $("share-note").value = "";
    state.shared = [];
    if (intent === "keep") {
      say("share-msg", `Kept on the Desk: ${res.json.path}`);
    } else {
      addLine("me", intent === "receipt" ? `Attached a receipt to file. ${note}`.trim() : `Attached: ${note || "what is this?"}`);
      location.hash = "#talk";
    }
  } catch (err) {
    say("share-msg", `Not sent: ${err.message || err}`, true);
  } finally {
    for (const b of ["share-receipt", "share-ask", "share-keep"]) $(b).disabled = false;
  }
}
$("share-receipt").addEventListener("click", () => sendShare("receipt"));
$("share-ask").addEventListener("click", () => sendShare("ask"));
$("share-keep").addEventListener("click", () => sendShare("keep"));

/**
 * Android's share sheet POSTs the file to /pocket/share; the service worker
 * keeps it in a cache of its own for the length of one hand-over, and this
 * reads it and deletes it at once. Conversation data is never cached.
 */
async function takeSharedFiles() {
  if (!("caches" in window)) return [];
  const inbox = await caches.open("pocket-share-inbox");
  const files = [];
  for (const req of await inbox.keys()) {
    const res = await inbox.match(req);
    await inbox.delete(req);
    if (!res) continue;
    const blob = await res.blob();
    files.push(new File([blob], "shared", { type: blob.type || res.headers.get("content-type") || "" }));
  }
  return files;
}

// --- Approvals --------------------------------------------------------------------------

function renderApprovals() {
  const box = $("cards");
  box.replaceChildren();
  for (const a of state.approvals.values()) box.appendChild(card(a));
  $("no-cards").hidden = state.approvals.size > 0;
  const n = state.approvals.size;
  $("badge").hidden = n === 0;
  $("badge").textContent = String(n);
  $("fact-pending").textContent = n ? `${n} approval${n === 1 ? "" : "s"}` : "nothing";
}

function card(a) {
  const el = document.createElement("article");
  el.className = "card";
  const what = document.createElement("div");
  what.className = "what";
  what.textContent = a.summary;
  const detail = document.createElement("pre");
  detail.textContent = a.detail;
  const verdict = document.createElement("div");
  verdict.className = "verdict";
  const yes = document.createElement("button");
  yes.className = "primary";
  yes.type = "button";
  yes.textContent = "Approve";
  const no = document.createElement("button");
  no.type = "button";
  no.textContent = "Deny";
  const note = document.createElement("div");
  note.className = "note";
  const answer = async (approved) => {
    yes.disabled = no.disabled = true;
    note.textContent = "Fingerprint or screen lock, for this card…";
    try {
      const assertion = await prove(approved ? "approve" : "deny", a.id);
      const r = await api(`/approvals/${encodeURIComponent(a.id)}`, { method: "POST", body: { approved, assertion } });
      if (!r.ok) throw new Error(r.json.error || `HTTP ${r.status}`);
      note.textContent = approved ? "Approved." : "Denied.";
    } catch (err) {
      note.textContent = `Not answered: ${err.message || err}`;
      yes.disabled = no.disabled = false;
    }
  };
  yes.addEventListener("click", () => answer(true));
  no.addEventListener("click", () => answer(false));
  verdict.append(no, yes);
  el.append(what, detail, verdict, note);
  return el;
}

async function loadApprovals() {
  const r = await api("/approvals");
  if (!r.ok) return;
  state.approvals = new Map((r.json.approvals || []).map((a) => [a.id, a]));
  renderApprovals();
}

// --- The event stream -----------------------------------------------------------------------

function connectEvents() {
  if (state.events) state.events.close();
  const es = new EventSource("/pocket/api/events");
  state.events = es;
  const data = (e) => { try { return JSON.parse(e.data); } catch { return {}; } };
  es.addEventListener("approval_request", (e) => {
    const a = data(e);
    state.approvals.set(a.id, a);
    renderApprovals();
  });
  es.addEventListener("approval_resolved", (e) => {
    state.approvals.delete(data(e).id);
    renderApprovals();
  });
  es.addEventListener("turn_start", () => { state.claw = null; state.toolLine = null; });
  es.addEventListener("text", (e) => {
    if (!state.claw) state.claw = addLine("claw", "");
    state.claw.textContent += data(e).delta || "";
    scrollLog();
  });
  es.addEventListener("tool_start", (e) => {
    const name = String(data(e).name || "a tool");
    if (state.toolLine) state.toolLine.textContent = `· ${name}`;
    else state.toolLine = addLine("tool", `· ${name}`);
    state.claw = null; // words after a tool start a new bubble, as they do on the HUD
  });
  es.addEventListener("turn_done", (e) => {
    const t = data(e).text;
    if (t && !state.claw && !data(e).stopped) addLine("claw", t);
    state.claw = null;
    state.toolLine = null;
  });
  es.addEventListener("agent_error", (e) => addLine("sys", data(e).message || "The claw hit an error."));
  es.addEventListener("notice", (e) => addLine("sys", data(e).message || ""));
  // A revoked phone's stream is closed by the claw; stop retrying into a 401.
  es.onerror = async () => {
    const me = await api("/me");
    if (me.status === 401) { es.close(); gone("Not paired", "This phone was unpaired. Press POCKET on the HUD to pair it again."); }
  };
}

// --- Push ------------------------------------------------------------------------------------

async function enablePush() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("this browser cannot take push notifications");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("notifications were not allowed");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(state.me.vapidKey) });
    const r = await api("/push", { method: "POST", body: { subscription: sub.toJSON() } });
    if (!r.ok) throw new Error(r.json.error || `HTTP ${r.status}`);
    $("fact-push").textContent = "on";
    say("phone-msg", "You will be told when approvals wait.");
  } catch (err) {
    say("phone-msg", `No notifications: ${err.message || err}`, true);
  }
}
$("push-go").addEventListener("click", enablePush);
$("lock-go").addEventListener("click", async () => {
  await api("/lock", { method: "POST", body: {} });
  setLocked(true);
  $("log").replaceChildren();
  location.hash = "#talk";
});
$("unlock-go").addEventListener("click", unlock);

// --- Boot -------------------------------------------------------------------------------------

function gone(title, text) {
  $("tabs").hidden = true;
  $("gone-title").textContent = title;
  $("gone-text").textContent = text;
  show("gone");
}

function route() {
  const h = location.hash.replace(/^#/, "");
  if (h === "approvals") return show("approvals");
  if (h === "phone") return show("phone");
  if (h === "snap") { show("talk"); return addLine("sys", "Press the camera to photograph a receipt."); }
  if (h === "share-unavailable") { show("talk"); return addLine("sys", "That share arrived before Pocket Claw was ready. Share it again."); }
  if (h === "share") return; // handled by start()
  show("talk");
}

async function start(firstView) {
  const me = await api("/me");
  if (me.status === 404) {
    return gone("Open this on your phone", "Pocket Claw answers on your tailnet address, not on this machine's own. See docs/POCKET-CLAW.md.");
  }
  if (me.status === 401 || me.status === 429) {
    return gone("Not paired", me.json.error || "Press POCKET on the HUD and scan the code with this phone.");
  }
  state.me = me.json;
  $("tabs").hidden = false;
  $("fact-name").textContent = me.json.name;
  $("fact-claw").textContent = me.json.claw;
  $("fact-push").textContent = me.json.push ? "on" : "off";
  setLocked(!me.json.unlocked);
  connectEvents();
  await loadApprovals();
  if (me.json.unlocked) await loadHistory();
  if (location.hash === "#share") {
    const files = await takeSharedFiles();
    if (files.length) return openShare(files, files[0].type.startsWith("image/") ? "receipt" : "ask");
  }
  if (firstView) location.hash = `#${firstView}`;
  route();
}

window.addEventListener("hashchange", () => { if (state.me) route(); });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/pocket/sw.js", { scope: "/pocket/" }).catch(() => { /* the page works without it */ });
}

(function boot() {
  const m = /^#pair=([A-Za-z0-9_-]{16,64})$/.exec(location.hash);
  if (m) {
    // The code is a secret: off the address bar and out of history at once.
    history.replaceState(null, "", "/pocket/");
    return startPairing(m[1]);
  }
  void start();
})();
