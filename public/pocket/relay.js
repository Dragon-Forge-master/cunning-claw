// Pocket's relay transport, the phone's side. pocket.js asks it for exactly
// what it asks fetch and EventSource for on the tailnet path — a request and
// its answer, or a stream of events — and this carries them through Dragon
// Forge's relay inside the end-to-end channel (e2e.js). The relay sees which
// room, when and how much; it never sees what.
//
// What the phone keeps (IndexedDB, this origin only): the relay's address,
// the claw's room id and static public key, this phone's static key pair —
// the private half non-extractable, so it can be used here but never read
// out — and the relay token that gets it into the room. Nothing else: no
// conversation, no card, no history is ever written down on the phone.

import { E2EError, b64u, initiate, generateKey, pairingPsk, pairingTicket } from "./e2e.js";

/** The relay's close codes (relay/pocket/src/room.js), as sentences for the glass. */
export function closeMessage(code, reason) {
  switch (code) {
    case 4401: return { gone: true, text: "This phone is not paired with that claw any more. Press POCKET on the HUD to pair it again." };
    case 4403:
      if (reason === "unpaired" || reason === "unknown") return { gone: true, text: "This phone was unpaired. Press POCKET on the HUD to pair it again." };
      if (reason === "pairing") return { gone: true, text: "That pairing code was already used or has expired. Press PAIR A PHONE on the HUD for a fresh one." };
      if (reason === "mac" || reason === "record" || reason === "key" || reason === "room") {
        return { gone: false, text: "Something between this phone and the claw altered the connection, so it was dropped. Nothing it sent was accepted." };
      }
      return { gone: false, text: "The claw closed the connection." };
    case 4404: return { gone: false, text: "Your claw is offline. Is the computer on, and the claw running?" };
    case 4429: return { gone: false, text: "The relay asked this phone to slow down. Trying again shortly." };
    case 4409:
    case 4410: return { gone: false, text: "The claw reconnected. Joining it again…" };
    default: return { gone: false, text: "" };
  }
}

export const UNREACHABLE = "Dragon Forge's relay cannot be reached. If it is not running yet, pair with the private network (Tailscale) from the HUD instead.";

/** The pairing, kept in IndexedDB. CryptoKey objects store there as themselves, still non-extractable. */
export function idbStore(db = "pocket-relay") {
  const open = () => new Promise((resolve, reject) => {
    const r = indexedDB.open(db, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("pairing");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const run = async (mode, fn) => {
    const d = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = d.transaction("pairing", mode);
        const req = fn(tx.objectStore("pairing"));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally { d.close(); }
  };
  return {
    get: () => run("readonly", (s) => s.get("claw")),
    set: (v) => run("readwrite", (s) => s.put(v, "claw")),
    clear: () => run("readwrite", (s) => s.delete("claw")),
  };
}

/** What a QR link's fragment carries for a relay pairing, or null. */
export function parsePairLink(hash) {
  const p = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const code = p.get("pair") || "";
  const room = p.get("room") || "";
  const ck = p.get("ck") || "";
  const relay = p.get("relay") || "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(room) || !/^[A-Za-z0-9_-]{43}$/.test(ck)) return null;
  let u;
  try { u = new URL(relay); } catch { return null; }
  if (u.protocol !== "wss:" && !(u.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(u.hostname))) return null;
  return { code, room, ck, relay: u.href.replace(/\/+$/, "") };
}

/**
 * One phone's link to its claw. `connect(url)` makes a WebSocket (the real
 * one in a browser); `store` keeps the pairing; `onState({ state, text })`
 * tells the page what to show. state: "connecting" | "open" | "offline" | "gone".
 */
export function createRelayLink({ store, connect = (url) => new WebSocket(url), onState = () => {}, retryMs = 2000, readyMs = 15_000 }) {
  let ws = null;
  let session = null;
  let opening = null;
  let nextId = 1;
  let backoff = retryMs;
  let pairInfo = null; // set while pairing: { code, room, ck, relay, phone }
  let saved = null;
  let stopped = false;
  let retryTimer = null;
  const pending = new Map();
  let sendChain = Promise.resolve();

  const tell = (state, text = "") => onState({ state, text });

  function failAll(err) {
    for (const p of pending.values()) p.fail(err);
    pending.clear();
  }

  function dropSocket() {
    const s = ws;
    ws = null;
    session = null;
    if (s) {
      s.onopen = s.onmessage = s.onerror = s.onclose = null;
      try { s.close(1000, "bye"); } catch { /* gone */ }
    }
  }

  /** Open the socket, say hello to the relay, handshake with the claw. Resolves when records can flow. */
  function open() {
    if (session) return Promise.resolve();
    if (opening) return opening;
    const info = pairInfo || saved;
    if (!info) return Promise.reject(new E2EError("state", "This phone is not paired."));
    tell("connecting", "Reaching your claw…");
    opening = new Promise((resolve, reject) => {
      let s;
      let opened = false;
      let hs = null;
      let settled = false;
      let deadline = null;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        opening = null;
        if (err) reject(err); else resolve();
      };
      try {
        s = connect(`${info.relay}/v1/room/${info.room}`);
      } catch {
        tell("offline", UNREACHABLE);
        return done(new E2EError("unreachable", UNREACHABLE));
      }
      ws = s;
      // A dial that neither opens nor fails (a relay restarting mid-handshake)
      // is given up as if it had closed, so the retry below still happens.
      deadline = setTimeout(() => {
        if (settled || ws !== s) return;
        try { s.close(); } catch { /* never opened */ }
        s.onclose?.({ code: 0, reason: "no answer" });
      }, readyMs);
      s.onopen = async () => {
        opened = true;
        const hello = pairInfo
          ? { t: "hello", role: "phone", ticket: await pairingTicket(pairInfo.code) }
          : { t: "hello", role: "phone", token: saved.token };
        s.send(JSON.stringify(hello));
      };
      s.onmessage = async (e) => {
        let m;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        try {
          if (m.t === "ready" && !hs) {
            hs = pairInfo
              ? await initiate({ mode: "pair", room: info.room, phone: pairInfo.phone, psk: await pairingPsk(pairInfo.code), clawFingerprint: pairInfo.ck })
              : await initiate({ mode: "session", room: info.room, phone: saved.phone, clawKey: saved.clawKey });
            s.send(JSON.stringify({ t: "m", d: hs.hello }));
            return;
          }
          if (m.t !== "m" || typeof m.d !== "string") return;
          if (!session) {
            const out = await hs.finish(m.d);
            s.send(JSON.stringify({ t: "m", d: out.reply }));
            session = out.session;
            if (pairInfo) pairInfo.clawKey = out.clawKey;
            backoff = retryMs;
            tell("open", "");
            return done();
          }
          const msg = await session.open(m.d);
          if (msg !== undefined) onMessage(msg);
        } catch (err) {
          // A handshake or record that fails is a tampered line: drop it, say so.
          const text = err instanceof E2EError && err.code === "key"
            ? "The claw's key is not the one this phone trusts. Something on the way substituted it; nothing was sent."
            : "Something between this phone and the claw altered the connection, so it was dropped. Nothing it sent was accepted.";
          dropSocket();
          failAll(new Error(text));
          tell("offline", text);
          done(new Error(text));
        }
      };
      s.onerror = () => { /* onclose follows with the reason */ };
      s.onclose = (e) => {
        if (ws !== s) return;
        ws = null;
        session = null;
        const said = closeMessage(e?.code, e?.reason);
        const text = said.text || (opened ? "Lost the connection to your claw. Trying again…" : UNREACHABLE);
        failAll(new Error(text));
        tell(said.gone ? "gone" : "offline", text);
        done(new Error(text));
        if (!said.gone && !stopped && pending.size === 0 && saved) {
          // A saved pairing reconnects by itself, slower each time.
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => { retryTimer = null; if (!stopped && !session) open().catch(() => {}); }, backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      };
    });
    return opening;
  }

  function onMessage(m) {
    const p = pending.get(m.id);
    if (!p) return;
    if (m.t === "res") { pending.delete(m.id); p.res(m); }
    else if (m.t === "head") p.head?.(m);
    else if (m.t === "data") p.data?.(m.body);
    else if (m.t === "end") { pending.delete(m.id); p.end?.(); }
  }

  function send(msg) {
    // Records must leave in the order their nonces were taken: seal now, send in turn.
    const sealing = session.seal(msg);
    const s = ws;
    sendChain = sendChain.then(async () => {
      for (const d of await sealing) s?.send(JSON.stringify({ t: "m", d }));
    }).catch(() => {});
    return sendChain;
  }

  /** One request; resolves to { status, type, body } or rejects with a sentence. */
  async function request(method, path, opts = {}) {
    await open();
    const id = nextId++;
    const msg = { t: "req", id, method, path };
    if (opts.body !== undefined) {
      msg.type = opts.type || "application/json";
      if (opts.body instanceof ArrayBuffer || ArrayBuffer.isView(opts.body)) {
        msg.body = b64u(opts.body instanceof ArrayBuffer ? new Uint8Array(opts.body) : new Uint8Array(opts.body.buffer, opts.body.byteOffset, opts.body.byteLength));
        msg.enc = "b64";
      } else {
        msg.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      }
    }
    const answer = new Promise((resolve, reject) => {
      pending.set(id, { res: (m) => resolve({ status: m.status, type: m.type, body: m.body }), fail: reject });
    });
    await send(msg);
    return answer;
  }

  /** A streamed response (the event feed). Returns { close }; onEnd(err) when it stops for any reason. */
  async function stream(path, onData, onEnd) {
    await open();
    const id = nextId++;
    let over = false;
    const finish = (err) => { if (!over) { over = true; onEnd(err); } };
    pending.set(id, {
      head: (m) => { if (m.status !== 200) finish(new Error(`HTTP ${m.status}`)); },
      data: (s) => onData(s),
      end: () => finish(null),
      res: (m) => finish(new Error(`HTTP ${m.status}`)),
      fail: (err) => finish(err),
    });
    await send({ t: "req", id, method: "GET", path });
    return {
      close() {
        if (over) return;
        over = true;
        pending.delete(id);
        if (session) void send({ t: "cancel", id });
      },
    };
  }

  return {
    request,
    stream,
    /** Start pairing from a QR link: a fresh static key for this phone, and a pairing-mode channel. */
    async beginPairing(link) {
      pairInfo = { ...link, phone: await generateKey() };
      dropSocket();
      await open();
    },
    /** Pairing finished (pair/finish gave a relay token): keep it, so the phone can come back. */
    async finishPairing(token) {
      saved = { relay: pairInfo.relay, room: pairInfo.room, clawKey: pairInfo.clawKey, phone: pairInfo.phone, token };
      await store.set(saved);
      pairInfo = null;
    },
    /** Load a pairing kept from before. Resolves true if there is one. */
    async load() {
      saved = (await store.get()) || null;
      return Boolean(saved);
    },
    async forget() {
      stopped = true;
      clearTimeout(retryTimer);
      saved = null;
      dropSocket();
      await store.clear();
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      dropSocket();
      failAll(new Error("closed"));
    },
    paired: () => Boolean(saved),
  };
}
