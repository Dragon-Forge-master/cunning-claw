/* The update light: the version chip, its panel, and the one-time question.
 *
 * Everything the feed says arrives here as display text and is set with
 * textContent; links are the ones the server's validation passed (https, the
 * project's GitHub or cunningclaw.com), and they open in a new tab. Nothing
 * here downloads anything: the owner clicks the link or types the command.
 *
 * Uses app.js's $ and its event stream (es), which load first.
 */
(() => {
  const chip = $("claw-version");
  const panel = $("update-panel");
  const body = $("up-body");
  const ask = $("update-ask");
  if (!chip || !panel) return;

  let status = null;

  const dateText = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const timeText = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : `${dateText(iso)}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  /** Belt and braces: the server already refused anything else. */
  const safeLink = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return null;
      if (u.hostname === "cunningclaw.com") return u.href;
      if (u.hostname === "github.com" && u.pathname.startsWith("/Dragon-Forge-master/cunning-claw")) return u.href;
    } catch { /* not a URL */ }
    return null;
  };
  const link = (url, text, cls) => {
    const href = safeLink(url);
    if (!href) return null;
    const a = el("a", cls, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  };

  // --- The chip ------------------------------------------------------------------
  // showVersion (app.js) keeps the resting face in data-base-*; the light is
  // laid over it only while a newer version is known.
  function renderChip() {
    const base = chip.dataset.baseText;
    if (base === undefined) return;
    const s = status;
    chip.classList.toggle("update", Boolean(s?.newer));
    chip.classList.toggle("security", Boolean(s?.newer && s.security));
    if (s?.newer && s.latest) {
      chip.textContent = s.security
        ? `v${s.current} · security update: v${s.latest.version}`
        : `v${s.current} · update ready: v${s.latest.version}`;
      chip.title = s.security
        ? `A security update, v${s.latest.version}, is out — click to see what's new and how to update`
        : `v${s.latest.version} is out — click to see what's new and how to update`;
    } else {
      chip.textContent = base;
      chip.title = `${chip.dataset.baseTitle || ""} — click for updates`;
    }
  }
  window.renderUpdateChip = renderChip;

  // --- The panel -----------------------------------------------------------------
  function renderPanel() {
    const s = status;
    body.replaceChildren();
    if (!s) return;
    panel.classList.toggle("security", Boolean(s.newer && s.security));
    const title = $("up-title");
    if (s.newer && s.latest) {
      title.textContent = s.security ? `SECURITY UPDATE · v${s.latest.version}` : `UPDATE READY · v${s.latest.version}`;
      const lede = el("p", "up-lede", s.security
        ? `v${s.latest.version} fixes a security problem. You are on v${s.current}. Released ${dateText(s.latest.date + "T12:00:00Z")}.`
        : `You are on v${s.current}. Released ${dateText(s.latest.date + "T12:00:00Z")}.`);
      body.append(lede);
      if (s.latest.summary.length) {
        const ul = el("ul", "up-summary");
        for (const line of s.latest.summary) ul.append(el("li", "", line));
        body.append(ul);
      }
      const notes = link(s.latest.notes, "Full release notes ↗", "up-notes");
      if (notes) body.append(notes);
      body.append(el("div", "up-sub", "HOW TO UPDATE THIS CLAW"));
      for (const step of s.install.steps) body.append(el("p", "up-step", step));
      if (s.install.download) {
        const a = link(s.install.download.url, s.install.download.label, "ctl active up-download");
        if (a) body.append(a);
      }
      if (s.install.command) body.append(el("code", "up-command", s.install.command));
    } else {
      title.textContent = "UPDATES";
      if (s.result === "ok" && s.latest) body.append(el("p", "up-lede", `v${s.current} is the newest version.`));
      else if (s.consent !== "yes" && !s.checkedAt) body.append(el("p", "up-lede", `This is v${s.current}. The daily check is off; Check now asks once.`));
      else if (!s.checkedAt) body.append(el("p", "up-lede", `This is v${s.current}. The first check is on its way.`));
    }
    if (s.result === "failed" && s.why) body.append(el("p", "up-why", `The last check did not work: ${s.why}.`));
    if (s.checkedAt) body.append(el("p", "up-when", `Last checked ${timeText(s.checkedAt)}.`));

    $("up-daily").checked = s.consent === "yes";
    $("up-phone").checked = Boolean(s.phoneNote);
    // Offered only where it can do something: checks on, and a phone line set up.
    $("up-phone-row").hidden = s.consent !== "yes" || !s.phones;
    const check = $("up-check");
    check.disabled = Boolean(s.checking);
    check.textContent = s.checking ? "CHECKING…" : "CHECK NOW";
  }

  function apply(s) {
    if (!s || typeof s !== "object" || typeof s.current !== "string") return;
    status = s;
    renderChip();
    renderPanel();
    if (ask) ask.hidden = s.consent !== "unanswered";
  }

  function setOpen(open) {
    panel.hidden = !open;
    chip.setAttribute("aria-expanded", String(open));
    chip.classList.toggle("open", open);
    if (open) {
      renderPanel();
      $("up-title").focus();
    }
  }

  chip.addEventListener("click", () => setOpen(panel.hidden));
  $("up-close").addEventListener("click", () => { setOpen(false); chip.focus(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      setOpen(false);
      chip.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== chip) setOpen(false);
  });

  async function post(url, data) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data ?? {}) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  $("up-check").addEventListener("click", async () => {
    const msg = $("up-msg");
    msg.textContent = "Asking cunningclaw.com…";
    $("up-check").disabled = true;
    try {
      const s = await post("/api/updates/check");
      apply(s);
      msg.textContent = s.result === "failed" ? "That check did not work." : s.newer ? "A newer version is out." : "You have the newest version.";
    } catch {
      msg.textContent = "No answer from the claw — is it still running?";
      $("up-check").disabled = false;
    }
  });

  async function setting(change, msgText) {
    const msg = $("up-msg");
    try {
      apply(await post("/api/updates/settings", change));
      if (msgText) msg.textContent = msgText;
    } catch {
      msg.textContent = "That did not save — try again.";
    }
  }
  $("up-daily").addEventListener("change", (e) => {
    const on = e.currentTarget.checked;
    void setting({ check: on }, on ? "Checking once a day." : "Daily check off.");
  });
  $("up-phone").addEventListener("change", (e) => {
    const on = e.currentTarget.checked;
    void setting({ phoneNote: on }, on ? "Your phone will hear of each new version once." : "Your phone will not be told.");
  });

  // --- The one-time question ---------------------------------------------------------
  // Asked once, on the glass, of an install that never answered it on the
  // setup page. A card, not a modal: the owner can carry on and answer later.
  const answer = async (yes) => {
    try {
      apply(await post("/api/updates/settings", { check: yes }));
    } catch { /* the card stays; the next press tries again */ }
  };
  $("update-ask-yes")?.addEventListener("click", () => answer(true));
  $("update-ask-no")?.addEventListener("click", () => answer(false));
  $("update-ask-dismiss")?.addEventListener("click", () => answer(false));

  // --- Feeds -------------------------------------------------------------------------
  es.addEventListener("updates", (e) => apply(sseData(e)));
  es.addEventListener("hello", () => {
    fetch("/api/updates").then((r) => (r.ok ? r.json() : null)).then(apply).catch(() => {});
  });
  fetch("/api/updates").then((r) => (r.ok ? r.json() : null)).then(apply).catch(() => {});
})();
