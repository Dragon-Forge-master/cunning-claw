// The HUD's POCKET panel: tell the claw its tailnet name, show a one-time
// pairing QR, list the paired phones with Revoke. Its own file so the HUD's
// app.js stays as it was. The QR is computed on this machine (src/qr.ts) and
// drawn on a canvas here; the code never goes near an image service.
// Device names are typed by the operator on their phone, but they are still
// set with textContent — this panel has no innerHTML.
"use strict";

(() => {
  const btn = document.getElementById("pocket-toggle");
  if (!btn) return;

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  };

  // Static rules only; nothing interpolated.
  const style = document.createElement("style");
  style.textContent = `
    #pocket-overlay[hidden] { display: none; }
    #pocket-overlay { position: fixed; inset: 0; z-index: 60; background: rgba(2,6,12,0.82); display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px; overflow-y: auto; }
    #pocket-overlay .pocket-sheet { width: min(560px, 100%); background: var(--panel, #08141f); border: 1px solid var(--cyan-dim, #1a6c7a); border-radius: 8px; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
    #pocket-overlay .pocket-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    #pocket-overlay p { font-size: 12px; line-height: 1.6; opacity: 0.85; }
    #pocket-overlay .pocket-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    #pocket-overlay input { flex: 1; min-width: 220px; background: transparent; color: inherit; border: 1px solid var(--cyan-dim, #1a6c7a); border-radius: 4px; padding: 6px 8px; font: inherit; font-size: 12px; }
    #pocket-overlay canvas { background: #fff; border-radius: 6px; align-self: center; image-rendering: pixelated; width: 264px; height: 264px; }
    #pocket-overlay .pocket-qr { display: flex; flex-direction: column; gap: 8px; align-items: center; }
    #pocket-overlay .pocket-link { font-size: 11px; word-break: break-all; opacity: 0.8; }
    #pocket-overlay .pocket-dev { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 8px 0; border-top: 1px solid rgba(53,214,237,0.15); font-size: 12px; }
    #pocket-overlay .pocket-dev .meta { opacity: 0.7; font-size: 11px; }
    #pocket-overlay .pocket-msg { min-height: 1.3em; font-size: 12px; color: var(--amber, #ffb454); }
  `;
  document.head.appendChild(style);

  const msg = el("div", { class: "pocket-msg", role: "status" });
  const hostInput = el("input", { type: "text", placeholder: "your-pc.your-tailnet.ts.net", spellcheck: "false", autocomplete: "off" });
  const hostsLine = el("p");
  const qrBox = el("div", { class: "pocket-qr" });
  const devices = el("div");

  const sheet = el("div", { class: "pocket-sheet" },
    el("div", { class: "pocket-head" },
      el("div", {},
        el("div", { class: "panel-title", text: "POCKET CLAW" }),
        el("p", { text: "The claw's own phone app, reached through your private tailnet. The claw still listens only on this machine; `tailscale serve` carries your phone's requests to it. Steps: docs/POCKET-CLAW.md." })),
      el("button", { type: "button", class: "ctl", text: "CLOSE", onclick: () => close() })),
    el("div", { class: "pocket-row" },
      hostInput,
      el("button", { type: "button", class: "ctl", text: "SAVE NAME", onclick: () => saveHost() })),
    hostsLine,
    el("div", { class: "pocket-row" },
      el("button", { type: "button", class: "ctl active", id: "pocket-pair-btn", text: "PAIR A PHONE", onclick: () => mint() })),
    qrBox,
    msg,
    el("div", { class: "panel-title", text: "PAIRED PHONES" }),
    devices);
  const overlay = el("div", { id: "pocket-overlay", hidden: "" }, sheet);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);

  const when = (iso) => {
    if (!iso) return "never";
    const d = new Date(iso);
    return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  async function call(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = {};
    try { json = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, json };
  }

  function renderDevices(list) {
    devices.replaceChildren();
    if (!list.length) {
      devices.append(el("p", { text: "No phone is paired." }));
      return;
    }
    for (const d of list) {
      const revoke = el("button", { type: "button", class: "ctl", text: "REVOKE" });
      revoke.addEventListener("click", async () => {
        if (!confirm(`Revoke ${d.name}? It will need pairing again.`)) return;
        const r = await call("DELETE", `/api/pocket/devices/${encodeURIComponent(d.id)}`);
        if (!r.ok) msg.textContent = r.json.error || `HTTP ${r.status}`;
        else { msg.textContent = `${d.name} revoked.`; renderDevices(r.json.devices || []); }
      });
      devices.append(el("div", { class: "pocket-dev" },
        el("div", { text: d.name }),
        revoke,
        el("div", { class: "meta", text: `paired ${when(d.created)} · last seen ${when(d.lastSeen)} · notifications ${d.push ? "on" : "off"}` })));
    }
  }

  async function refresh() {
    const r = await call("GET", "/api/pocket");
    if (!r.ok) { msg.textContent = r.json.error || `HTTP ${r.status}`; return; }
    hostInput.value = r.json.savedHost || "";
    hostsLine.textContent = r.json.hosts.length
      ? `Answering on: ${r.json.hosts.join(", ")}`
      : "No tailnet name yet. Run `tailscale serve --bg 3900` on this machine, then paste the https name it prints (without https://).";
    renderDevices(r.json.devices || []);
  }

  async function saveHost() {
    const r = await call("POST", "/api/pocket/host", { host: hostInput.value });
    msg.textContent = r.ok ? "Saved." : (r.json.error || `HTTP ${r.status}`);
    await refresh();
  }

  function drawQr(rows) {
    const n = rows.length;
    const quiet = 4;
    const scale = Math.max(4, Math.floor(264 / (n + quiet * 2)));
    const canvas = el("canvas", { width: String((n + quiet * 2) * scale), height: String((n + quiet * 2) * scale), "aria-label": "Pairing code for your phone's camera" });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0a111c";
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === "1") ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    });
    return canvas;
  }

  async function mint() {
    const r = await call("POST", "/api/pocket/pair");
    qrBox.replaceChildren();
    if (!r.ok) { msg.textContent = r.json.error || `HTTP ${r.status}`; return; }
    msg.textContent = "";
    // The link is the secret; it stays hidden unless asked for, because the HUD is filmed.
    const link = el("div", { class: "pocket-link", hidden: "" });
    link.textContent = r.json.url;
    const reveal = el("button", { type: "button", class: "ctl", text: "SHOW LINK" });
    reveal.addEventListener("click", () => { link.hidden = !link.hidden; reveal.textContent = link.hidden ? "SHOW LINK" : "HIDE LINK"; });
    const until = new Date(r.json.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    qrBox.append(
      drawQr(r.json.qr),
      el("p", { text: `Scan with your phone's camera and open it in Chrome. One use, good until ${until}. Your phone must be on your tailnet.` }),
      reveal,
      link);
  }

  function open() { overlay.hidden = false; void refresh(); }
  function close() {
    overlay.hidden = true;
    // A code left on screen is a code someone could photograph.
    qrBox.replaceChildren();
    void call("DELETE", "/api/pocket/pair");
  }

  btn.addEventListener("click", () => (overlay.hidden ? open() : close()));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });
})();
