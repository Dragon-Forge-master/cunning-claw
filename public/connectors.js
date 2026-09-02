/* Connectors page. Separate from app.js on purpose — that file is crowded. */
(function () {
  const $ = (id) => document.getElementById(id);
  let snapshot = { connectors: [], path: "", enabled: true, needsAuth: 0, connected: 0, sources: [], categories: [], catalogueSize: 0 };
  let filter = "all";
  let category = "all";
  let search = "";
  let busy = "";
  /**
   * The result of the last button press.
   *
   * It has to live outside render(), because render() rewrites the banner from
   * the snapshot every time it runs — and act() calls render() in its finally
   * block. Holding the outcome here is what stops "Added canva", "needs sign-in"
   * and "no browser opened" being painted and wiped in the same tick, which made
   * every button look dead.
   */
  let notice = null;

  function setOpen(open) {
    const overlay = $("mcp-overlay");
    const btn = $("mcp-toggle");
    if (!overlay || !btn) return;
    overlay.hidden = !open;
    btn.classList.toggle("active", open);
    if (open) {
      const skills = $("skills-overlay");
      if (skills) skills.hidden = true;
      $("skills-toggle")?.classList.remove("active");
      notice = null;
      // Paint the cached snapshot NOW — load() only re-renders when the
      // snapshot changed, and by open time the background poll has usually
      // cached an identical one, which left the overlay blank on open.
      render();
      load();
    }
  }

  function setBanner(text, isError) {
    const el = $("mcp-banner");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = "";
    // Sign-in links have to be clickable: openBrowser cannot be relied on, so
    // the banner is the fallback path for finishing OAuth by hand. Built as
    // nodes rather than innerHTML — the text includes server-supplied detail.
    for (const part of String(text).split(/(https?:\/\/[^\s]+)/g)) {
      if (!part) continue;
      if (/^https?:\/\//.test(part)) {
        const a = document.createElement("a");
        a.href = part;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = part;
        a.style.textDecoration = "underline";
        el.appendChild(a);
      } else {
        el.appendChild(document.createTextNode(part));
      }
    }
    el.style.color = isError ? "var(--red)" : "var(--amber)";
  }

  function paintBadge() {
    const badge = $("mcp-badge");
    if (!badge) return;
    const n = snapshot.needsAuth || 0;
    badge.hidden = n === 0;
    badge.textContent = String(n);
    $("mcp-toggle")?.classList.toggle("needs-auth", n > 0);
  }

  function initials(label) {
    return (label || "?").slice(0, 2).toUpperCase();
  }

  function matches(c) {
    if (filter === "connected" && c.status !== "connected" && c.status !== "needs_auth" && c.status !== "failed") return false;
    if (filter === "not_connected" && c.configured) return false;
    if (category !== "all" && c.category !== category) return false;
    if (search) {
      const q = search.toLowerCase();
      const blob = `${c.label} ${c.id} ${c.blurb} ${c.category || ""} ${c.url || ""} ${c.command || ""}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  }

  function statusView(c) {
    if (c.status === "connected") return { cls: "ok", mark: "✓", text: c.tools ? `${c.tools} tool${c.tools === 1 ? "" : "s"}` : "Connected" };
    // Token vendors without their key get one honest status instead of the
    // needs_auth/failed churn a doomed OAuth attempt produces.
    if (c.tokenEnv && !c.tokenSet) return { cls: "warn", mark: "!", text: "Needs a key — see KEYS" };
    if (c.status === "needs_auth") return { cls: "warn", mark: "!", text: "Action required" };
    if (c.status === "failed") return { cls: "err", mark: "×", text: c.detail ? c.detail.slice(0, 80) : "Failed" };
    if (c.status === "disabled") return { cls: "idle", mark: "·", text: "Disabled" };
    return { cls: "idle", mark: "○", text: "Not connected" };
  }

  function actionButtons(c) {
    const wrap = document.createElement("div");
    wrap.className = "mcp-actions";
    const add = (label, title, fn, extraClass) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctl" + (extraClass ? " " + extraClass : "");
      b.textContent = busy === c.id + label ? "…" : label;
      b.title = title;
      b.disabled = Boolean(busy);
      b.onclick = fn;
      wrap.appendChild(b);
    };
    // A token vendor (GitHub) can never finish a browser sign-in — its key
    // lives on the Keys page. Offer that door, never the OAuth one.
    if (c.tokenEnv && !c.tokenSet && c.status !== "connected") {
      add("Add key", `${c.label} signs in with a token — paste ${c.tokenEnv} on the Keys page`, () => window.open("/keys", "_blank"), "active");
    } else if (c.status === "not_connected" || (c.status === "failed" && !c.configured)) {
      add("Connect", `Add ${c.label} and try to connect`, () => act("connect", c.id));
    } else if (c.status === "needs_auth") {
      if (c.tokenEnv) add("Retry", "Try again with the saved token", () => act("connect", c.id), "active");
      else add("Reconnect", "Sign in in the system browser", () => act("login", c.id), "active");
    } else if (c.status === "failed") {
      add("Retry", "Try connecting again", () => act("connect", c.id));
      if (c.url && !c.tokenEnv) add("Reconnect", "Sign in in the system browser", () => act("login", c.id));
    } else if (c.status === "connected") {
      if (c.url && !c.tokenEnv) add("Reconnect", "Sign in again", () => act("login", c.id));
      // A connected local server had no button at all unless it was removable,
      // so a card that was working looked identical to a card that was broken.
      else add("Refresh", "Restart this local server and reload its tools", () => act("connect", c.id));
    }
    if (c.owned) add("Remove", "Remove from ~/.config/cunningclaw/mcp.json", () => act("remove", c.id));
    return wrap;
  }

  function renderPopular() {
    const root = $("mcp-popular");
    if (!root) return;
    root.innerHTML = "";
    const popular = (snapshot.connectors || []).filter((c) => c.popular);
    for (const c of popular) {
      const card = document.createElement("div");
      card.className = "mcp-pop";
      const name = document.createElement("div");
      name.className = "pop-name";
      name.textContent = `${initials(c.label)}  ${c.label}`;
      const blurb = document.createElement("div");
      blurb.className = "pop-blurb";
      blurb.textContent = c.blurb;
      card.append(name, blurb, actionButtons(c));
      root.appendChild(card);
    }
  }

  function renderCount() {
    const el = $("mcp-count");
    if (!el) return;
    const total = snapshot.catalogueSize || (snapshot.connectors || []).length;
    const connected = snapshot.connected || 0;
    const shown = (snapshot.connectors || []).filter(matches).length;
    const noun = total === 1 ? "connector" : "connectors";
    el.textContent = search || category !== "all" || filter !== "all"
      ? `${shown} shown · ${total} ${noun} · ${connected} connected`
      : `${total} ${noun} · ${connected} connected`;
  }

  function renderCats() {
    const root = $("mcp-cats");
    if (!root) return;
    root.innerHTML = "";
    const cats = ["all", ...(snapshot.categories || [])];
    for (const cat of cats) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mcp-cat" + (category === cat ? " active" : "");
      btn.dataset.category = cat;
      btn.textContent = cat === "all" ? "All categories" : cat;
      root.appendChild(btn);
    }
  }

  function renderTable() {
    const root = $("mcp-table");
    if (!root) return;
    root.innerHTML = "";
    const rows = (snapshot.connectors || []).filter(matches);
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "mcp-empty";
      empty.textContent = search
        ? "No connectors match that search."
        : category !== "all"
          ? `No ${category} connectors in this view.`
          : "No connectors yet. Connect Canva from Popular, or ADD a Claude Code snippet.";
      root.appendChild(empty);
      return;
    }
    const head = document.createElement("div");
    head.className = "mcp-cols";
    head.innerHTML = "<span>Connector</span><span>Type</span><span>Status</span><span></span>";
    root.appendChild(head);

    const order = (snapshot.categories && snapshot.categories.length
      ? snapshot.categories
      : [...new Set(rows.map((c) => c.category).filter(Boolean))]);
    const groups = new Map();
    for (const c of rows) {
      const cat = c.category || "Custom";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(c);
    }
    const cats = [
      ...order.filter((c) => groups.has(c)),
      ...[...groups.keys()].filter((c) => !order.includes(c)),
    ];
    const showGroups = !search;

    function appendRow(c) {
      const row = document.createElement("div");
      row.className = "mcp-row";
      const name = document.createElement("div");
      const title = document.createElement("span");
      title.className = "c-name";
      title.textContent = c.label;
      const blurb = document.createElement("span");
      blurb.className = "c-blurb";
      const src = c.source ? c.source.replace(/^.*\//, "…/") : (c.configured ? "" : "Not added yet");
      blurb.textContent = [c.blurb, src].filter(Boolean).join(" · ");
      name.append(title, blurb);
      const type = document.createElement("div");
      type.className = "c-type";
      type.textContent = c.typeLabel;
      const st = statusView(c);
      const status = document.createElement("div");
      status.className = "mcp-status " + st.cls;
      const mark = document.createElement("span");
      mark.className = "mcp-mark";
      mark.textContent = st.mark;
      const lab = document.createElement("span");
      lab.textContent = st.text;
      status.append(mark, lab);
      row.append(name, type, status, actionButtons(c));
      root.appendChild(row);
    }

    for (const cat of cats) {
      if (showGroups) {
        const g = document.createElement("div");
        g.className = "mcp-group";
        g.textContent = `${cat} · ${groups.get(cat).length}`;
        root.appendChild(g);
      }
      for (const c of groups.get(cat)) appendRow(c);
    }
  }

  function render() {
    paintBadge();
    if (!$("mcp-overlay") || $("mcp-overlay").hidden) return;
    if (notice) setBanner(notice.text, notice.isError);
    else if (!snapshot.enabled) setBanner("MCP is disabled in claw.config.json (mcp.enabled).");
    else if (snapshot.needsAuth) setBanner(`${snapshot.needsAuth} connector${snapshot.needsAuth === 1 ? "" : "s"} need sign-in. Reconnect opens the system browser.`);
    else if ((snapshot.sources || []).length) {
      setBanner("Reading " + snapshot.sources.map((s) => s.file).join(" · "));
    } else {
      setBanner("");
    }
    renderCount();
    renderCats();
    renderPopular();
    renderTable();
  }

  async function load() {
    try {
      const res = await fetch("/api/mcp");
      if (!res.ok) return;
      const next = await res.json();
      // The 12-second poll used to rebuild every card unconditionally. Press
      // a button as the poll lands and the element under the cursor is
      // destroyed between mousedown and mouseup — the click dies silently.
      // Only repaint when the snapshot actually changed, and never while an
      // action is in flight.
      const changed = JSON.stringify(next) !== JSON.stringify(snapshot);
      snapshot = next;
      if (busy) return;
      if (changed) render();
    } catch { /* overlay will retry on open */ }
  }

  async function act(kind, id) {
    if (busy) return;
    if (kind === "remove" && !confirm(`Remove connector "${id}" from ${snapshot.path}?`)) return;
    notice = null;
    busy = id + (kind === "login" ? "Reconnect" : kind === "remove" ? "Remove" : "Connect");
    // OAuth blocks for up to three minutes while it waits for the callback, and
    // every button is disabled for the duration. Saying so up front is the
    // difference between "it is working" and "this button is broken".
    if (kind === "login") {
      notice = {
        text: `Signing in to ${id} — a browser tab should open. If none does, the sign-in link appears in the transcript. Waits up to 3 minutes.`,
        isError: false,
      };
    }
    render();
    const url =
      kind === "remove" ? `/api/mcp/${encodeURIComponent(id)}` :
      kind === "login" ? `/api/mcp/${encodeURIComponent(id)}/login` :
      `/api/mcp/${encodeURIComponent(id)}/connect`;
    const opts = kind === "remove" ? { method: "DELETE" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
    try {
      const res = await fetch(url, opts);
      const data = await res.json();
      if (data.snapshot) snapshot = data.snapshot;
      let text = data.message || (data.error ? String(data.error) : "");
      if (kind === "login" && !data.ok) {
        text = (text || "Sign-in did not finish.") +
          " If no browser opened, use the mcp-remote snippet under ADD.";
      }
      if (!text) text = data.ok ? `${id}: done.` : `${id}: that did not work, and said nothing about why.`;
      notice = { text, isError: !data.ok };
    } catch (err) {
      notice = { text: String(err.message || err), isError: true };
    } finally {
      busy = "";
      render();
    }
  }

  async function submitAdd(e) {
    e.preventDefault();
    const form = e.target;
    const paste = String(form.paste.value || "").trim();
    let body = {};
    if (paste) {
      try {
        const json = JSON.parse(paste);
        body = json.mcpServers ? json : { mcpServers: json };
      } catch {
        notice = { text: "Paste valid JSON — the same mcpServers object Claude Code uses.", isError: true };
        render();
        return;
      }
    } else {
      const id = String(form.id.value || "").trim();
      const url = String(form.url.value || "").trim();
      const command = String(form.command.value || "").trim();
      const args = String(form.args.value || "").trim().split(/\s+/).filter(Boolean);
      body = { id, url: url || undefined, command: command || undefined, args: args.length ? args : undefined };
    }
    busy = "add";
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.snapshot) snapshot = data.snapshot;
      notice = {
        text: data.message || (data.error ? String(data.error) : (data.ok ? "Added." : "That did not work.")),
        isError: !data.ok,
      };
      if (data.ok) {
        form.reset();
        $("mcp-add-form").hidden = true;
      }
    } catch (err) {
      notice = { text: String(err.message || err), isError: true };
    } finally {
      busy = "";
      render();
    }
  }

  $("mcp-toggle")?.addEventListener("click", () => setOpen($("mcp-overlay").hidden));
  $("mcp-close")?.addEventListener("click", () => setOpen(false));
  $("mcp-overlay")?.addEventListener("click", (e) => {
    if (e.target === $("mcp-overlay")) setOpen(false);
  });
  $("mcp-add-toggle")?.addEventListener("click", () => {
    const form = $("mcp-add-form");
    form.hidden = !form.hidden;
  });
  $("mcp-add-cancel")?.addEventListener("click", () => { $("mcp-add-form").hidden = true; });
  $("mcp-add-form")?.addEventListener("submit", submitAdd);
  $("mcp-search")?.addEventListener("input", (e) => {
    search = e.target.value.trim();
    renderCount();
    renderTable();
  });
  $("mcp-tabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    filter = btn.dataset.filter;
    for (const t of $("mcp-tabs").querySelectorAll(".mcp-tab")) t.classList.toggle("active", t === btn);
    renderCount();
    renderTable();
  });
  $("mcp-cats")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-category]");
    if (!btn) return;
    category = btn.dataset.category;
    for (const t of $("mcp-cats").querySelectorAll(".mcp-cat")) t.classList.toggle("active", t === btn);
    renderCount();
    renderTable();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("mcp-overlay") && !$("mcp-overlay").hidden) {
      setOpen(false);
      e.stopPropagation();
    }
  });

  load();
  setInterval(load, 12000);
})();
