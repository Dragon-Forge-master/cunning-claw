// The forge wall on the landing page: visitors' questions and ideas, and the
// journey each one takes — asked, answered, planned, built.
//
// External file because the CSP has no inline-script allowance (README.md).
// Everything a visitor wrote is set with textContent and nothing else: a card
// is a stranger's words, so "<b>" stays the four characters it was, and a
// URL in it stays text — never a link. The only href this script ever sets is
// a card's "built" link, which the team chose, and only after the same check
// the server makes (github.com/Dragon-Forge-master/cunning-claw or
// cunningclaw.com, https).
//
// It degrades in three steps, and every step is a page that works:
//   no script, or no API (not deployed yet)  → the static note stays, no form
//   API up, Turnstile site key not yet set   → cards show, the form waits
//   both                                     → cards, votes and the form
// Turnstile itself loads only when someone starts writing, so a visitor who
// only reads never fetches it.
(function () {
  "use strict";
  var API = "/api/wall";
  var LINK_RE = /^https:\/\/(?:github\.com\/Dragon-Forge-master\/cunning-claw|cunningclaw\.com)(?:\/[A-Za-z0-9._~\/#?=&%+-]*)?$/;
  var STAGES = [
    { key: "asked", label: "Asked" },
    { key: "answered", label: "Answered" },
    { key: "planned", label: "Planned" },
    { key: "built", label: "Built" },
  ];
  var TEXT_MAX = 600;

  var root = document.getElementById("ask");
  if (!root || !window.fetch) return;
  var list = document.getElementById("wall-cards");
  var listNote = document.getElementById("wall-list-note");
  var fallback = document.getElementById("wall-fallback");
  var form = document.getElementById("wall-form");
  var formWait = document.getElementById("wall-form-wait");
  var widget = document.getElementById("wall-turnstile");
  var status = document.getElementById("wall-status");
  var counter = document.getElementById("wall-count");
  var textBox = document.getElementById("wall-text");
  var sendBtn = document.getElementById("wall-send");

  var siteKey = widget ? String(widget.getAttribute("data-sitekey") || "") : "";
  // The placeholder in index.html is "TURNSTILE_SITE_KEY" until the operator
  // pastes the real one in (README.md); a form that cannot pass its own spam
  // check is a broken form, so it stays hidden until then.
  var keyReady = /^[0-9A-Za-z_-]{12,}$/.test(siteKey) && siteKey.indexOf("TURNSTILE") !== 0;
  var token = "";
  var widgetId = null;
  var turnstileAsked = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function prettyDay(iso) {
    if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
    try {
      return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    } catch (e) {
      return iso;
    }
  }

  function votedSet() {
    try {
      return JSON.parse(localStorage.getItem("wall-voted") || "[]");
    } catch (e) {
      return [];
    }
  }
  function rememberVote(id) {
    try {
      var v = votedSet();
      if (v.indexOf(id) === -1) v.push(id);
      localStorage.setItem("wall-voted", JSON.stringify(v.slice(-200)));
    } catch (e) { /* private window: the server still counts once */ }
  }

  function renderCard(c) {
    var li = el("li", "wcard");
    var head = el("div", "wc-head");
    head.appendChild(el("span", "wc-kind", (c.kind === "idea" ? "IDEA" : "QUESTION") + " · #" + Number(c.id)));
    li.appendChild(head);
    li.appendChild(el("p", "wc-text", c.text));
    if (c.name) li.appendChild(el("p", "wc-by", "— " + c.name));

    var reached = 0;
    STAGES.forEach(function (s, i) { if (s.key === c.stage) reached = i; });
    var journey = el("ol", "wc-journey");
    journey.setAttribute("aria-label", "Where this card has got to: " + STAGES[reached].label);
    STAGES.forEach(function (s, i) {
      var step = el("li", i < reached ? "done" : i === reached ? "now" : "");
      step.appendChild(el("b", null, s.label));
      var when = prettyDay(c[s.key]);
      if (when && i <= reached) step.appendChild(el("span", null, when));
      if (i === reached) step.setAttribute("aria-current", "step");
      journey.appendChild(step);
    });
    li.appendChild(journey);

    if (c.answer) {
      var ans = el("div", "wc-answer");
      ans.appendChild(el("b", null, "THE FORGE"));
      ans.appendChild(el("p", null, c.answer));
      li.appendChild(ans);
    }

    var foot = el("div", "wc-foot");
    if (typeof c.link === "string" && LINK_RE.test(c.link)) {
      var a = el("a", "wc-link", c.stage === "built" ? "See it in the code" : "Follow the plan");
      a.href = c.link;
      a.rel = "noopener";
      foot.appendChild(a);
    }
    var btn = el("button", "wc-vote");
    btn.type = "button";
    var mine = votedSet().indexOf(c.id) !== -1;
    setVote(btn, Number(c.votes) || 0, mine);
    btn.addEventListener("click", function () { vote(c.id, btn); });
    foot.appendChild(btn);
    li.appendChild(foot);
    return li;
  }

  function setVote(btn, n, mine) {
    btn.textContent = (mine ? "BACKED" : "ME TOO") + " · " + n;
    btn.setAttribute("aria-pressed", mine ? "true" : "false");
    btn.setAttribute("aria-label", (mine ? "You backed this. " : "Me too: back this card. ") + n + (n === 1 ? " person has" : " people have") + " backed it.");
    btn.disabled = mine;
  }

  function vote(id, btn) {
    btn.disabled = true;
    fetch(API + "/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j && res.j.ok) {
          rememberVote(id);
          setVote(btn, Number(res.j.votes) || 0, true);
        } else {
          btn.disabled = false;
          say(res.j && res.j.message ? res.j.message : "That vote did not go through. Please try again later.", true);
        }
      })
      .catch(function () {
        btn.disabled = false;
        say("That vote did not go through. Please try again later.", true);
      });
  }

  function say(text, isError) {
    if (!status) return;
    status.textContent = text;
    status.className = "wall-status" + (isError ? " err" : "");
  }

  function load() {
    fetch(API + "/cards", { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || j.ok !== true || !Array.isArray(j.cards)) throw new Error("not the wall");
        // The API is live: the static note gives way to the real thing.
        if (fallback) fallback.hidden = true;
        list.textContent = "";
        j.cards.forEach(function (c) { list.appendChild(renderCard(c)); });
        listNote.textContent = j.cards.length
          ? ""
          : "Nothing on the wall yet. The first card could be yours.";
        listNote.hidden = !listNote.textContent;
        list.hidden = !j.cards.length;
        if (keyReady) {
          form.hidden = false;
          if (formWait) formWait.hidden = true;
        } else if (formWait) {
          formWait.hidden = false;
        }
      })
      .catch(function () {
        // Not deployed, or down: leave the static note exactly as it is.
        list.hidden = true;
        listNote.hidden = true;
      });
  }

  function askTurnstile() {
    if (turnstileAsked || !keyReady) return;
    turnstileAsked = true;
    window.wallTurnstileReady = function () {
      if (!window.turnstile) return;
      widgetId = window.turnstile.render(widget, {
        sitekey: siteKey,
        action: "wall-submit",
        theme: "dark",
        callback: function (t) { token = t; },
        "expired-callback": function () { token = ""; },
        "error-callback": function () { token = ""; say("The spam check could not load. Please refresh and try again.", true); },
      });
    };
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=wallTurnstileReady";
    s.async = true;
    s.onerror = function () { say("The spam check could not load, so the form cannot send. Please try again later.", true); };
    document.head.appendChild(s);
  }

  function count() {
    var n = Array.from(textBox.value).length;
    counter.textContent = n + " / " + TEXT_MAX;
    counter.className = "wall-count" + (n > TEXT_MAX ? " over" : "");
  }

  if (form && textBox) {
    form.addEventListener("focusin", askTurnstile);
    textBox.addEventListener("input", count);
    count();
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var kindEl = form.querySelector("input[name=kind]:checked");
      var body = {
        kind: kindEl ? kindEl.value : "question",
        text: textBox.value,
        name: (document.getElementById("wall-name") || { value: "" }).value,
        turnstileToken: token,
      };
      if (Array.from(body.text.trim()).length < 8) return say("Say a little more — at least 8 characters.", true);
      if (Array.from(body.text).length > TEXT_MAX) return say("That is over " + TEXT_MAX + " characters.", true);
      if (!token) { askTurnstile(); return say("Please complete the spam check first.", true); }
      sendBtn.disabled = true;
      say("Sending…", false);
      fetch(API + "/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok && res.j.ok) {
            form.reset();
            count();
            say(res.j.message || "Thank you. A person reads every card before it appears here.", false);
          } else {
            say(res.j.message || "That did not send. Please try again later.", true);
          }
        })
        .catch(function () { say("That did not send. Please try again later.", true); })
        .then(function () {
          // A Turnstile token is good for one use, sent or refused.
          sendBtn.disabled = false;
          token = "";
          if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
        });
    });
  }

  load();
})();
