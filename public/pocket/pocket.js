// Pocket Claw — the phone's glass. Vanilla JS, no build, like the HUD.
// Every word the model or a stranger wrote is set with textContent; there is
// no innerHTML in this file.
//
// Two ways home, one app. On the claw's own tailnet name the page talks to
// the claw with fetch and EventSource, and the device token lives in an
// HttpOnly cookie the page never sees. Served from cunningclaw.com it talks
// through Dragon Forge's relay instead (relay.js): the same requests and the
// same event feed, inside an end-to-end encrypted channel, and the phone is
// known by a key the page can use but never read. Everything above `api()`
// and `connectEvents()` is the same code either way.
import { createRelayLink, idbStore, parsePairLink } from "./relay.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["pair", "gone", "talk", "approvals", "share", "receipt", "jobs", "phone"];
const state = { me: null, unlocked: false, approvals: new Map(), jobs: new Map(), events: null, claw: null, toolLine: null, shared: [], receipt: null };
/** Served from cunningclaw.com (site/pocket/), not by a claw: the relay is the only way home. */
const SITE = document.querySelector('meta[name="pocket-home"]')?.getAttribute("content") === "site";
/** The relay link, when this phone reaches its claw through the relay. */
let relay = null;

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
  if (relay) return relayApi(path, opts);
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

/** The same request through the relay's end-to-end channel; the same answer shape as fetch's. */
async function relayApi(path, opts) {
  let res;
  try {
    res = await relay.request(opts.method || "GET", `/pocket/api${path}`, opts.body === undefined ? {} : { body: opts.body, type: opts.type });
  } catch (err) {
    return { status: 0, ok: false, json: { error: String(err.message || err) } };
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* empty body */ }
  if (res.status === 423) setLocked(true);
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json: json || {} };
}

/** Set while the glass says the claw cannot be reached: the link coming back should bring it back. */
let awaitingLink = false;

/** What the link says about itself: a line under the bar, or the end of this pairing. */
function onLinkState({ state: s, text }) {
  const line = $("link-state");
  if (s === "gone") {
    void relay?.forget();
    return gone("Not paired", text);
  }
  if (awaitingLink && s !== "open") {
    // The "cannot reach" screen is already the message: keep it current
    // rather than say it twice, once under the bar and once below it.
    line.hidden = true;
    if (text) $("gone-text").textContent = text;
    return;
  }
  line.hidden = s === "open" || !text;
  line.textContent = text || "";
  // The link retries by itself; once it is through, the page should not sit
  // on "cannot reach" until someone thinks to reload it.
  if (s === "open" && awaitingLink) {
    awaitingLink = false;
    void start();
  }
}

function makeRelayLink() {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot do the encryption Pocket needs. Open it in Chrome.");
  return createRelayLink({ store: idbStore(), onState: onLinkState });
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

function startPairing(code, viaRelay) {
  show("pair");
  $("pair-name").value = defaultName();
  $("pair-how").textContent = viaRelay
    ? "Through Dragon Forge's relay, end-to-end encrypted: the relay carries the connection between this phone and your claw, and cannot read or change it."
    : "Over your private network: straight from this phone to your claw.";
  $("pair-go").onclick = async () => {
    $("pair-go").disabled = true;
    say("pair-msg", viaRelay ? "Reaching your claw through the relay…" : "Asking the claw…");
    try {
      if (viaRelay) {
        relay = makeRelayLink();
        await relay.beginPairing(viaRelay);
        say("pair-msg", "Asking the claw…");
      }
      const opts = await api("/pair/options", { method: "POST", body: { code } });
      if (!opts.ok) throw new Error(opts.json.error || `HTTP ${opts.status}`);
      say("pair-msg", "Touch the sensor, or use your screen lock.");
      const credential = await webauthnCreate(opts.json.publicKey);
      const done = await api("/pair/finish", { method: "POST", body: { enrolment: opts.json.enrolment, name: $("pair-name").value, credential } });
      if (!done.ok) throw new Error(done.json.error || `HTTP ${done.status}`);
      if (viaRelay) await relay.finishPairing(done.json.relayToken);
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
  // Filing a receipt needs the unlock; the button says which step comes next.
  $("receipt-snap").textContent = locked ? "Unlock first" : "Photograph the receipt";
  if (!$("screen-jobs").hidden) void loadJobs();
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
  // The ledger files photos (JPEG, PNG). A PDF or a HEIC can still go to the chat.
  const fileable = state.shared.length > 0 && /^image\/(jpeg|png)$/.test(state.shared[0].type);
  $("share-receipt").disabled = !fileable;
  if (files.length > 1) say("share-msg", "One file at a time — the first is here.");
  else if (!fileable) say("share-msg", "Receipts are filed from JPEG or PNG photos. This one can be attached to the chat.");
  else say("share-msg", "");
  $("share-receipt").classList.toggle("primary", fileable && suggested === "receipt");
  $("share-ask").classList.toggle("primary", !fileable || suggested !== "receipt");
  show("share");
}

const readAsBase64 = (f) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

// --- Receipts: filed in the ledger, the same path a captioned Telegram photo takes ----------

function showReceipt(view) {
  state.receipt = view;
  $("receipt-capture").hidden = Boolean(view);
  $("receipt-filed").hidden = !view;
  if (view) {
    // Our summary line, built from what the reader took off the slip. Shown
    // as text; it never goes to the chat or the model from here.
    $("receipt-line").textContent = view.line;
    $("receipt-warning").textContent = view.warning || "";
    $("receipt-fix").value = "";
  }
  show("receipt");
}

async function fileReceipt(f, note) {
  if (f.size > 20 * 1024 * 1024) throw new Error("that photo is over 20MB");
  const res = await api("/receipt", { method: "POST", body: { data: await readAsBase64(f), note: note || "" } });
  if (!res.ok) throw new Error(res.json.error || `HTTP ${res.status}`);
  return res.json.receipt;
}

// Locked, the first press unlocks and the second opens the camera: a fingerprint
// prompt uses up the tap that a file chooser needs, so they cannot share one.
$("receipt-snap").addEventListener("click", () => (state.unlocked ? $("receipt-camera").click() : unlock()));
$("receipt-camera").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  say("receipt-msg", "Reading the receipt…");
  $("receipt-snap").disabled = true;
  try {
    showReceipt(await fileReceipt(f, ""));
    say("receipt-msg", "");
  } catch (err) {
    say("receipt-msg", `Not filed: ${err.message || err}`, true);
  } finally {
    $("receipt-snap").disabled = false;
  }
});

async function fixReceipt(text) {
  if (!state.receipt || !text.trim()) return;
  for (const b of ["receipt-fix-go", "receipt-void"]) $(b).disabled = true;
  try {
    const res = await api(`/receipts/${encodeURIComponent(state.receipt.id)}/fix`, { method: "POST", body: { text } });
    if (!res.ok) throw new Error(res.json.error || `HTTP ${res.status}`);
    showReceipt(res.json.receipt);
    say("receipt-msg", res.json.changed.length ? `Corrected: ${res.json.changed.join(", ").replace(/_pence/g, "").replace(/payment_method/g, "payment")}.` : "Nothing changed — it already said that.");
  } catch (err) {
    say("receipt-msg", String(err.message || err), true);
  } finally {
    for (const b of ["receipt-fix-go", "receipt-void"]) $(b).disabled = false;
  }
}
$("receipt-fix-go").addEventListener("click", () => fixReceipt($("receipt-fix").value));
$("receipt-fix").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void fixReceipt($("receipt-fix").value); } });
$("receipt-void").addEventListener("click", () => fixReceipt("void"));
$("receipt-again").addEventListener("click", () => { showReceipt(null); say("receipt-msg", ""); });

async function sendShare(intent) {
  const f = state.shared[0];
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) return say("share-msg", "That file is over 20MB.", true);
  for (const b of ["share-receipt", "share-ask", "share-keep"]) $(b).disabled = true;
  say("share-msg", intent === "receipt" ? "Reading the receipt…" : "Sending to the claw…");
  const note = $("share-note").value;
  try {
    if (intent === "receipt") {
      // The ledger, not the chat: the same filing path as a Telegram photo
      // captioned "receipt". The slip's words never become a turn.
      const filed = await fileReceipt(f, note);
      $("share-note").value = "";
      state.shared = [];
      showReceipt(filed);
      say("receipt-msg", "");
      return;
    }
    const res = await api("/upload", { method: "POST", body: { data: await readAsBase64(f), intent, note } });
    if (!res.ok) throw new Error(res.json.error || `HTTP ${res.status}`);
    $("share-note").value = "";
    state.shared = [];
    if (intent === "keep") {
      say("share-msg", `Kept on the Desk: ${res.json.path}`);
    } else {
      addLine("me", `Attached: ${note || "what is this?"}`);
      location.hash = "#talk";
    }
  } catch (err) {
    say("share-msg", `Not sent: ${err.message || err}`, true);
  } finally {
    for (const b of ["share-receipt", "share-ask", "share-keep"]) $(b).disabled = false;
    if (state.shared[0]) $("share-receipt").disabled = !/^image\/(jpeg|png)$/.test(state.shared[0].type);
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

// --- Jobs: mission control, compact ------------------------------------------------------------

const ACTIVE = new Set(["queued", "running", "needs-approval"]);

function renderJobs() {
  const box = $("jobs-list");
  box.replaceChildren();
  $("jobs-locked").hidden = state.unlocked;
  if (!state.unlocked) { $("no-jobs").hidden = true; return; }
  // Work in flight first, newest first within each half.
  const list = [...state.jobs.values()].sort((a, b) => (ACTIVE.has(b.state) - ACTIVE.has(a.state)) || (b.rev - a.rev));
  for (const j of list) box.appendChild(jobCard(j));
  $("no-jobs").hidden = list.length > 0;
}

function jobCard(j) {
  const el = document.createElement("article");
  el.className = "job";
  el.dataset.state = j.state;
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = j.title;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${j.short} · ${j.kind} · ${j.state}`;
  // The registry's own words about the work, never its output, and they do not tick.
  const status = document.createElement("div");
  status.className = "status";
  status.textContent = j.status;
  const note = document.createElement("div");
  note.className = "note";
  el.append(title, meta, status);
  if (j.cancellable) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "big";
    stop.textContent = "Cancel";
    stop.addEventListener("click", async () => {
      stop.disabled = true;
      note.textContent = "Fingerprint or screen lock, for this job…";
      try {
        const c = await api("/challenge", { method: "POST", body: { purpose: "cancel", jobId: j.id } });
        if (!c.ok) throw new Error(c.json.error || `HTTP ${c.status}`);
        const assertion = await webauthnGet(c.json.publicKey);
        const r = await api(`/jobs/${encodeURIComponent(j.id)}/cancel`, { method: "POST", body: { assertion } });
        if (!r.ok) throw new Error(r.json.message || r.json.error || `HTTP ${r.status}`);
        note.textContent = r.json.message || "Asked it to stop.";
        if (r.json.job) upsertJob(r.json.job, false);
      } catch (err) {
        note.textContent = `Not cancelled: ${err.message || err}`;
        stop.disabled = false;
      }
    });
    el.append(stop);
  }
  el.append(note);
  return el;
}

/** A late snapshot must not overwrite a newer one: the registry's rev orders them. */
function upsertJob(j, render = true) {
  const had = state.jobs.get(j.id);
  if (had && had.rev > j.rev) return;
  state.jobs.set(j.id, j);
  if (render && !$("screen-jobs").hidden) renderJobs();
}

async function loadJobs() {
  if (!state.unlocked) return renderJobs();
  const r = await api("/jobs");
  if (r.ok) state.jobs = new Map((r.json.jobs || []).map((j) => [j.id, j]));
  renderJobs();
}

// --- The event stream -----------------------------------------------------------------------

/** What each event does to the glass, whichever way it arrived. */
const ON_EVENT = {
  approval_request: (a) => {
    state.approvals.set(a.id, a);
    renderApprovals();
  },
  approval_resolved: (d) => {
    state.approvals.delete(d.id);
    renderApprovals();
  },
  turn_start: () => { state.claw = null; state.toolLine = null; },
  text: (d) => {
    if (!state.claw) state.claw = addLine("claw", "");
    state.claw.textContent += d.delta || "";
    scrollLog();
  },
  tool_start: (d) => {
    const name = String(d.name || "a tool");
    if (state.toolLine) state.toolLine.textContent = `· ${name}`;
    else state.toolLine = addLine("tool", `· ${name}`);
    state.claw = null; // words after a tool start a new bubble, as they do on the HUD
  },
  turn_done: (d) => {
    if (d.text && !state.claw && !d.stopped) addLine("claw", d.text);
    state.claw = null;
    state.toolLine = null;
  },
  job: (j) => { if (j.id) upsertJob(j); },
  agent_error: (d) => addLine("sys", d.message || "The claw hit an error."),
  notice: (d) => addLine("sys", d.message || ""),
};
const parseData = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };

function connectEvents() {
  if (state.events) state.events.close();
  if (relay) return connectRelayEvents();
  const es = new EventSource("/pocket/api/events");
  state.events = es;
  for (const [name, fn] of Object.entries(ON_EVENT)) es.addEventListener(name, (e) => fn(parseData(e.data)));
  // A revoked phone's stream is closed by the claw; stop retrying into a 401.
  es.onerror = async () => {
    const me = await api("/me");
    if (me.status === 401) { es.close(); gone("Not paired", "This phone was unpaired. Press POCKET on the HUD to pair it again."); }
  };
}

/**
 * The same feed through the relay: the claw's own text/event-stream bytes,
 * carried in the channel, cut into events here as EventSource would.
 */
function connectRelayEvents() {
  const handle = { closed: false, inner: null, close() { this.closed = true; this.inner?.close(); } };
  state.events = handle;
  let buf = "";
  const block = (text) => {
    let name = "message";
    const data = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (Object.hasOwn(ON_EVENT, name)) ON_EVENT[name](parseData(data.join("\n")));
  };
  const again = () => setTimeout(() => { if (!handle.closed && state.events === handle) connectEvents(); }, 3000);
  relay.stream("/pocket/api/events", (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      block(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }, async () => {
    if (handle.closed) return;
    const me = await api("/me");
    if (me.status === 401) return gone("Not paired", "This phone was unpaired. Press POCKET on the HUD to pair it again.");
    again();
  }).then((st) => { handle.inner = st; if (handle.closed) st.close(); }, again);
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
  if (h === "snap" || h === "receipt") return showReceipt(null);
  if (h === "jobs") { show("jobs"); return void loadJobs(); }
  if (h === "share-unavailable") { show("talk"); return addLine("sys", "That share arrived before Pocket Claw was ready. Share it again."); }
  if (h === "share") return; // handled by start()
  show("talk");
}

async function start(firstView) {
  const me = await api("/me");
  if (me.status === 0 && relay) {
    // The relay or the claw cannot be reached. The link keeps trying, this
    // screen says why (onLinkState keeps it current), and the page comes back
    // by itself when the link gets through.
    awaitingLink = true;
    $("link-state").hidden = true;
    return gone("Cannot reach your claw", me.json.error || "Trying again shortly.");
  }
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
  $("fact-via").textContent = relay ? "Dragon Forge's relay, end-to-end encrypted" : "your private network";
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

window.addEventListener("hashchange", () => {
  // A pairing link opened while the app is already showing (the camera hands
  // the QR's URL to this tab) changes only the fragment: boot again for it,
  // rather than read the code as a view name.
  if (parsePairLink(location.hash) || /^#pair=/.test(location.hash)) return location.reload();
  if (state.me) route();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/pocket/sw.js", { scope: "/pocket/" }).catch(() => { /* the page works without it */ });
}

(async function boot() {
  // A relay QR's link carries the code, the room, the claw's fingerprint and the relay.
  const link = parsePairLink(location.hash);
  const m = /^#pair=([A-Za-z0-9_-]{16,64})$/.exec(location.hash);
  if (link || m) {
    // The code is a secret: off the address bar and out of history at once.
    history.replaceState(null, "", "/pocket/");
    if (link) return startPairing(link.code, link);
    if (!SITE) return startPairing(m[1], null);
    return gone("That code is for your private network", "It opens on your claw's own tailnet address, not here. On the HUD, press PAIR A PHONE and choose Easy for a code this page can use.");
  }
  if (SITE) {
    try {
      relay = makeRelayLink();
      if (await relay.load()) return void start();
    } catch (err) {
      return gone("This browser cannot run Pocket Claw", String(err.message || err));
    }
    relay = null;
    return gone("Pair from your claw", "On the computer that runs your claw, open the HUD, press POCKET, then PAIR A PHONE. Scan the code with this phone's camera.");
  }
  void start();
})();
