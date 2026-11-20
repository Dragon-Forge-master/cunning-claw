/* Cunning Claw HUD — Learn mode.
 *
 * The course panel: the module list, the lesson in front of the learner, the
 * practice ground while a scenario runs, and due reviews. The server owns the
 * sequence (src/learn.ts); this file shows a step, sends the learner's answer
 * and draws what comes back. Every word from a lesson, a fixture or the model
 * goes in with textContent — fixture emails are written by "strangers" on
 * purpose — and innerHTML is used only for the empty static skeletons below.
 *
 * Every button here is the operator's own hand: these routes are the only way
 * Learn mode starts, moves or stops (T15 in docs/LEARN-MODE.md).
 */
(() => {
  const panel = $("learn-panel");
  const body = $("learn-body");
  const pane = $("learn-practice");
  const banner = $("practice-banner");
  if (!panel || !body || !pane) return;

  let cat = null;          // the catalogue, as /api/learn last sent it
  let reviewing = null;    // { items: [...], answered: {} } while a review is open
  // Messages stay until the learner's next action, not until the next draw:
  // a learn_step event redraws the panel a moment after most clicks, and a
  // message cleared on draw was shown for a frame and gone ("Lesson passed"
  // vanished this way on the first Playwright run).
  let lastFinished = null; // the lesson that just ended, for a one-line summary
  let notice = "";         // a one-line message under the panel head (errors, paths)

  const STATUS = { new: "NEW", started: "STARTED", practised: "PRACTISED", mastered: "PASSED" };
  const LAYERS = [
    ["floor", "The floor refuses it"],
    ["card", "A card asks first"],
    ["free", "It runs without a card"],
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function btn(label, onClick, cls = "ctl") {
    const b = el("button", cls, label);
    b.type = "button";
    b.onclick = onClick;
    return b;
  }

  async function api(url, payload) {
    if (payload !== undefined) notice = ""; // a new action replaces the last message
    try {
      const res = await fetch(url, payload === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && data && data.error) notice = String(data.error);
      return { ok: res.ok, data };
    } catch (err) {
      notice = `Could not reach the claw: ${err.message}`;
      return { ok: false, data: {} };
    }
  }

  async function refresh() {
    const r = await api("/api/learn");
    if (r.ok) cat = r.data;
    const lang = $("learn-lang");
    if (lang && cat?.lang) lang.value = cat.lang;
    paintBadge();
    paintPractice(cat?.practice);
    render();
  }

  function paintBadge() {
    const badge = $("learn-badge");
    if (!badge) return;
    const due = Number(cat?.due || 0);
    badge.hidden = due === 0;
    badge.textContent = due ? String(due) : "";
    $("learn-toggle")?.setAttribute("title", due ? `Learn mode — ${due} review question(s) due` : "Learn mode — a course in using your claw safely");
  }

  /** Below the header, however many rows the brain picker wrapped onto. */
  function place() {
    const head = document.querySelector("header");
    if (head) panel.style.top = `${Math.round(head.getBoundingClientRect().bottom + 8)}px`;
  }
  window.addEventListener("resize", () => { if (!panel.hidden) place(); });

  function setOpen(open) {
    if (open) place();
    panel.hidden = !open;
    $("learn-toggle")?.classList.toggle("active", open);
    if (open) refresh();
  }

  // -------------------------------------------------------------------------
  // The panel
  // -------------------------------------------------------------------------

  function render() {
    body.textContent = "";
    if (notice) body.appendChild(el("p", "lv-notice", notice));
    if (!cat) {
      body.appendChild(el("p", "lv-dim", "Loading the course…"));
      return;
    }
    if (reviewing) return renderReview();
    if (cat.current) return renderLesson(cat.current);
    renderModules();
  }

  function renderModules() {
    const top = el("div", "lv-top");
    const due = Number(cat.due || 0);
    if (due) {
      const row = el("div", "lv-due");
      row.appendChild(el("span", "", `${due} review question${due === 1 ? "" : "s"} due — about two minutes.`));
      row.appendChild(btn("REVIEW", startReview, "ctl active"));
      top.appendChild(row);
    }
    if (lastFinished) top.appendChild(el("p", "lv-done", lastFinished));
    const prefs = el("div", "lv-prefs");
    const remind = el("label", "lv-check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = Boolean(cat.nudges);
    box.onchange = async () => { await api("/api/learn/prefs", { nudges: box.checked }); refresh(); };
    remind.append(box, el("span", "", "Remind me when reviews are due (once a day at most)"));
    prefs.appendChild(remind);
    prefs.appendChild(btn("RECORD OF LEARNING", exportRecord));
    top.appendChild(prefs);
    if (cat.lang === "cy") {
      top.appendChild(el("p", "lv-welsh", "Welsh version: needs a Welsh-speaking author. The lessons below are in English until one is written."));
    }
    body.appendChild(top);

    for (const m of cat.modules || []) {
      if (!m.lessons.length) continue;
      const card = el("section", "lv-module" + (m.passed ? " passed" : ""));
      const head = el("div", "lv-module-head");
      head.appendChild(el("span", "lv-module-n", m.id === "capstone" ? "★" : String(m.order)));
      const t = el("span", "lv-module-title", m.title);
      head.appendChild(t);
      if (m.ward) head.appendChild(el("span", "lv-ward", m.ward));
      if (m.passed) head.appendChild(el("span", "lv-pass", "✓ PASSED"));
      card.appendChild(head);
      card.appendChild(el("p", "lv-dim", m.summary));
      for (const l of m.lessons) {
        const row = el("div", "lv-lesson");
        row.dataset.lesson = l.id;
        const name = el("span", "lv-lesson-title", l.title);
        row.appendChild(name);
        const meta = el("span", "lv-lesson-meta", `${l.minutes} min`);
        row.appendChild(meta);
        if (l.critical) row.appendChild(el("span", "lv-critical", "SAFETY-CRITICAL"));
        const st = el("span", `lv-status s-${l.status}`, STATUS[l.status] || l.status);
        if (l.status === "mastered" && l.masteredAt) st.title = `Passed ${new Date(l.masteredAt).toLocaleDateString("en-GB")}`;
        row.appendChild(st);
        if (l.reopen) row.appendChild(el("span", "lv-reopen", "PRACTISE AGAIN"));
        const label = l.status === "new" ? "START" : l.status === "mastered" ? "AGAIN" : "CONTINUE";
        row.appendChild(btn(label, async () => {
          lastFinished = null;
          const r = await api("/api/learn/start", { lesson: l.id });
          if (r.ok) cat.current = r.data.view;
          render();
        }));
        card.appendChild(row);
      }
      body.appendChild(card);
    }
  }

  function renderLesson(v) {
    const head = el("div", "lv-lesson-head");
    const crumbs = el("div", "lv-crumbs");
    crumbs.appendChild(el("span", "", v.lesson.moduleTitle || v.lesson.module));
    if (v.lesson.ward) crumbs.appendChild(el("span", "lv-ward", v.lesson.ward));
    head.appendChild(crumbs);
    head.appendChild(el("h3", "lv-title", v.lesson.title));
    const meta = el("div", "lv-meta");
    meta.appendChild(el("span", "lv-stepcount", `Step ${v.index + 1} of ${v.total}`));
    if (v.lesson.critical) meta.appendChild(el("span", "lv-critical", "SAFETY-CRITICAL · passed in full"));
    meta.appendChild(btn("CLOSE LESSON", async () => { await api("/api/learn/stop", {}); cat.current = null; refresh(); }));
    head.appendChild(meta);
    const bar = el("div", "lv-progress");
    const fill = el("div", "lv-progress-fill");
    fill.style.width = `${Math.round(((v.index + 1) / v.total) * 100)}%`;
    bar.appendChild(fill);
    head.appendChild(bar);
    if (cat.lang === "cy" && v.lesson.welsh === "needs-author") {
      head.appendChild(el("p", "lv-welsh", "Welsh version: needs a Welsh-speaking author. This lesson is shown in English."));
    }
    body.appendChild(head);

    const s = v.step;
    if (!s) return;
    const step = el("div", `lv-step t-${s.type}`);
    step.dataset.step = s.id;
    step.appendChild(el("div", "lv-steptype", STEP_NAMES[s.type] || s.type.toUpperCase()));
    if (s.text) step.appendChild(el("div", "lv-text", s.text));
    body.appendChild(step);

    if (s.type === "why" || s.type === "example") {
      step.appendChild(actions(btn("CONTINUE", next, "ctl active")));
      return;
    }
    if (s.type === "real") return renderReal(step, v);
    if (s.type === "practice") return renderPracticeStep(step, v);
    if (s.type === "check" && s.kind === "scenario") return renderScenarioCheck(step, v);
    renderQuestion(step, s, v.answered, v.feedback, async (answer) => {
      const r = await api("/api/learn/answer", answer);
      if (r.ok && r.data.view) cat.current = r.data.view;
      render();
    }, v.answered ? actions(btn(s.type === "check" ? "FINISH" : "CONTINUE", next, "ctl active")) : null);
  }

  const STEP_NAMES = {
    why: "WHY THIS MATTERS", ask: "BEFORE WE START", example: "HOW IT WORKS", real: "YOUR OWN JOB",
    practice: "PRACTICE GROUND", explain: "IN YOUR OWN WORDS", recall: "REMEMBER", check: "MASTERY CHECK",
  };

  function actions(...nodes) {
    const row = el("div", "lv-actions");
    for (const n of nodes) if (n) row.appendChild(n);
    return row;
  }

  /** One question: options or a text box, a confidence row, and the server's feedback once answered. */
  function renderQuestion(host, s, answered, fb, submit, after) {
    const picked = new Set();
    let confidence = "";
    if (!answered) {
      let text = null;
      if (s.options) {
        const list = el("div", "lv-options");
        s.options.forEach((o, i) => {
          const b = btn(o, () => {
            if (!s.multi) { picked.clear(); for (const x of list.children) x.classList.remove("on"); }
            if (picked.has(i)) { picked.delete(i); b.classList.remove("on"); } else { picked.add(i); b.classList.add("on"); }
          }, "lv-option");
          list.appendChild(b);
        });
        host.appendChild(list);
        if (s.multi) host.appendChild(el("p", "lv-dim", "Choose every one that applies."));
      } else {
        text = el("textarea", "lv-answer");
        text.rows = 3;
        text.placeholder = "Your answer, in your own words";
        host.appendChild(text);
      }
      if (s.confidence) {
        const conf = el("div", "lv-confidence");
        conf.appendChild(el("span", "lv-dim", "Before you see the answer — how sure are you?"));
        for (const [k, label] of [["sure", "SURE"], ["think", "THINK SO"], ["guess", "GUESSING"]]) {
          const c = btn(label, () => {
            confidence = k;
            for (const x of conf.querySelectorAll("button")) x.classList.remove("on");
            c.classList.add("on");
          }, "lv-conf");
          conf.appendChild(c);
        }
        host.appendChild(conf);
      }
      host.appendChild(actions(btn("ANSWER", () => submit({
        text: text ? text.value : undefined,
        choice: s.options ? [...picked] : undefined,
        confidence: confidence || undefined,
      }), "ctl active")));
    }
    if (fb) {
      const box = el("div", "lv-feedback" + (fb.correct ? " ok" : ""));
      if (fb.text) box.appendChild(el("p", "", fb.text));
      if (fb.help) box.appendChild(el("p", "lv-help", fb.help));
      if (fb.reveal && answered) box.appendChild(el("p", "lv-reveal", fb.reveal));
      if (fb.later) box.appendChild(el("p", "lv-dim", "Not passed this time. Nothing is locked — practise again later."));
      host.appendChild(box);
    }
    if (after) host.appendChild(after);
  }

  function renderReal(host, v) {
    const task = el("textarea", "lv-answer");
    task.rows = 2;
    task.placeholder = "Your job, in your own words (kept on this machine, redacted)";
    const saved = el("span", "lv-dim", "");
    host.appendChild(task);
    host.appendChild(actions(
      btn("SAVE MY JOB", async () => {
        const r = await api("/api/learn/real", { task: task.value });
        saved.textContent = r.ok ? "Saved." : (r.data.error || "Not saved.");
      }),
      saved,
    ));
    host.appendChild(el("p", "lv-dim", "Use the main chat for this — it is your real claw. The lesson waits here."));
    const done = btn("DONE", async () => {
      if (v.step.verify) {
        const r = await api("/api/learn/done", {});
        if (!r.ok) { render(); return; }
      }
      await next();
    }, "ctl active");
    host.appendChild(actions(done));
  }

  function renderPracticeStep(host, v) {
    const live = cat.practice && cat.practice.active;
    if (!live && !v.answered) {
      host.appendChild(el("p", "lv-dim", "Opening the practice ground sets your conversation aside and brings it back afterwards. Every tool is simulated; cards are real cards that do nothing."));
      host.appendChild(actions(btn("ENTER THE PRACTICE GROUND", async () => {
        const r = await api("/api/learn/practice/start", {});
        if (r.ok) paintPractice(r.data.practice);
        render();
      }, "ctl active")));
    } else if (live) {
      host.appendChild(el("p", "lv-dim", "The practice ground is open below. Decide each card in the transcript."));
    }
    if (v.answered && v.lastRun) host.appendChild(resultBox(v.lastRun));
    if (v.answered) host.appendChild(actions(btn("CONTINUE", next, "ctl active")));
  }

  function renderScenarioCheck(host, v) {
    const fb = v.feedback || {};
    const box = el("div", "lv-feedback" + (fb.correct ? " ok" : ""));
    box.appendChild(el("p", "", fb.text || ""));
    host.appendChild(box);
    if (fb.practiseAgain) {
      host.appendChild(actions(
        btn("PRACTISE AGAIN", async () => {
          const r = await api("/api/learn/again", {});
          if (r.ok) cat.current = r.data.view;
          render();
        }, "ctl active"),
        btn("FINISH FOR NOW", next),
      ));
    } else {
      host.appendChild(actions(btn("FINISH", next, "ctl active")));
    }
  }

  function resultBox(r) {
    const box = el("div", "lv-result" + (r.passed ? " ok" : ""));
    box.appendChild(el("p", "", `${r.passed ? "Passed" : "Not passed yet"} — ${Math.round(r.score * 100)}% of decisions matched the key${r.criticalPassed ? "" : "; a critical one did not"}.`));
    return box;
  }

  async function next() {
    const r = await api("/api/learn/next", {});
    if (r.ok && r.data.finished) {
      lastFinished = r.data.status === "mastered"
        ? "Lesson passed. It is on your Record of Learning, and its questions will come back for review."
        : "Lesson finished. Its check is not passed yet — you can come back to it any time.";
      cat.current = null;
    } else if (r.ok && r.data.view) {
      cat.current = r.data.view;
    }
    refresh();
  }

  async function exportRecord() {
    const pending = api("/api/learn/record", {});
    notice = "Writing your Record of Learning…";
    render();
    const r = await pending;
    notice = r.ok
      ? `Record of Learning written to the Desk (${r.data.markdown}). ${r.data.message || ""}`
      : `The Record of Learning could not be written: ${r.data.error || "unknown error"}`;
    render();
  }

  // -------------------------------------------------------------------------
  // Review (T10): due questions, interleaved
  // -------------------------------------------------------------------------

  async function startReview() {
    lastFinished = null;
    const r = await api("/api/learn/review");
    reviewing = { items: r.data.items || [], answered: {} };
    render();
  }

  function renderReview() {
    body.appendChild(el("h3", "lv-title", "Review"));
    body.appendChild(el("p", "lv-dim", "Questions from earlier lessons, mixed. Answer from memory — that is what makes it stick."));
    for (const item of reviewing.items) {
      const host = el("div", "lv-step t-recall");
      host.appendChild(el("div", "lv-steptype", item.lesson));
      host.appendChild(el("div", "lv-text", item.step.text));
      const fb = reviewing.answered[item.key];
      renderQuestion(host, item.step, Boolean(fb), fb, async (answer) => {
        const r = await api("/api/learn/review", { key: item.key, ...answer });
        if (r.ok) reviewing.answered[item.key] = { ...r.data, text: r.data.text };
        render();
      }, null);
      body.appendChild(host);
    }
    if (!reviewing.items.length) body.appendChild(el("p", "lv-done", "Nothing is due. Reviews come back on a 1, 3, 7, 16 and 35-day schedule."));
    body.appendChild(actions(btn("DONE", () => { reviewing = null; refresh(); }, "ctl active")));
  }

  // -------------------------------------------------------------------------
  // The practice ground
  // -------------------------------------------------------------------------

  let practiceOpen = false;

  function paintPractice(p) {
    const on = Boolean(p && p.active);
    document.body.dataset.practice = on ? "on" : "off";
    if (banner) banner.hidden = !on;
    pane.hidden = !on;
    if (!on) {
      practiceOpen = false;
      return;
    }
    if (!practiceOpen) {
      // A fresh run: build the static skeleton once, then only append to it,
      // so a later refresh never wipes what the learner has already seen.
      practiceOpen = true;
      pane.innerHTML = `
        <div class="pg-stripe"></div>
        <div class="pg-title"></div>
        <p class="pg-brief"></p>
        <div class="pg-log"></div>
        <div class="pg-ask"></div>
        <div class="pg-result"></div>
        <div class="pg-free" hidden>
          <p class="lv-dim">Now try it yourself. The practice claw is your real brain with every tool simulated — try the dangerous thing on purpose.</p>
          <form class="pg-say"><input type="text" placeholder="Ask the practice claw…" autocomplete="off"><button type="submit" class="ctl">SEND</button></form>
        </div>
        <div class="lv-actions"><button type="button" class="ctl pg-leave">LEAVE PRACTICE</button></div>`;
      pane.querySelector(".pg-stripe").textContent = p.label || "PRACTICE · nothing real will happen";
      pane.querySelector(".pg-leave").onclick = async () => {
        await api("/api/learn/practice/end", {});
        refresh();
      };
      const form = pane.querySelector(".pg-say");
      form.onsubmit = async (e) => {
        e.preventDefault();
        const input = form.querySelector("input");
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        log("you", text);
        await api("/api/learn/practice/say", { message: text });
      };
    }
    pane.querySelector(".pg-title").textContent = `${p.scenario?.title || "Practice"} · attempt ${p.attempt || 1}`;
    pane.querySelector(".pg-brief").textContent = p.scenario?.brief || "";
    pane.querySelector(".pg-free").hidden = !p.drillDone;
    if (p.result) showResult(p.result);
  }

  function log(kind, text, extra) {
    const area = pane.querySelector(".pg-log");
    if (!area) return null;
    const row = el("div", `pg-row pg-${kind}`);
    if (kind === "result") {
      const pre = el("pre", "pg-pre", text);
      row.appendChild(pre);
    } else {
      row.textContent = text;
    }
    if (extra) row.appendChild(extra);
    area.appendChild(row);
    area.scrollTop = area.scrollHeight;
    return row;
  }

  function showResult(r) {
    const host = pane.querySelector(".pg-result");
    if (!host) return;
    host.textContent = "";
    host.appendChild(resultBox(r));
  }

  es.addEventListener("learn_step", () => { if (!panel.hidden) refresh(); });
  es.addEventListener("learn_practice", (e) => {
    const p = sseData(e);
    paintPractice(p);
    if (!p.active && p.reason) addMsg("system", `Practice ground closed — ${p.reason}. Your conversation is back as it was.`);
    if (!panel.hidden) refresh();
  });
  es.addEventListener("learn_beat", (e) => {
    const { say, tool, input } = sseData(e);
    if (say) log("say", say);
    if (tool) log("tool", `▸ ${tool}${input && input.command ? `: ${input.command}` : ""}`);
  });
  es.addEventListener("learn_beat_result", (e) => {
    const { tool, text, flagged } = sseData(e);
    let flag = null;
    if (Array.isArray(flagged) && flagged.length) {
      flag = el("span", "inj-flag", "⚑ instructions inside");
      flag.title = `The scanner found text that tried to give instructions (${flagged.map(String).join(", ")}).`;
    }
    const row = log("tool", `✓ ${tool} complete`, flag);
    if (row) log("result", text);
  });
  es.addEventListener("learn_predict", (e) => {
    const { beat, say, command } = sseData(e);
    const host = pane.querySelector(".pg-ask");
    if (!host) return;
    host.textContent = "";
    host.appendChild(el("p", "pg-q", `${say || "This command:"} Which layer stops it?`));
    host.appendChild(el("pre", "pg-pre", command));
    const row = el("div", "lv-options");
    for (const [k, label] of LAYERS) {
      row.appendChild(btn(label, async () => {
        host.textContent = "";
        log("you", `Predicted: ${label}`);
        await api("/api/learn/practice/predict", { choice: k, beat });
      }, "lv-option"));
    }
    host.appendChild(row);
  });
  es.addEventListener("learn_debrief", (e) => {
    const { correct, text } = sseData(e);
    log(correct ? "debrief-ok" : "debrief", text);
  });
  es.addEventListener("learn_report_open", (e) => {
    const { prompt, options } = sseData(e);
    const host = pane.querySelector(".pg-ask");
    if (!host) return;
    host.textContent = "";
    host.appendChild(el("p", "pg-q", `⚑ ${prompt}`));
    const row = el("div", "lv-options");
    (options || []).forEach((o, i) => {
      row.appendChild(btn(o, async () => {
        host.textContent = "";
        log("you", `Reported: ${o}`);
        await api("/api/learn/practice/report", { index: i });
      }, "lv-option"));
    });
    host.appendChild(row);
  });
  es.addEventListener("learn_result", (e) => showResult(sseData(e)));
  es.addEventListener("learn_due", (e) => {
    const { due } = sseData(e);
    if (cat) cat.due = due;
    paintBadge();
    addMsg("system", `${due} Learn review question${due === 1 ? " is" : "s are"} due — about two minutes, whenever suits. Open LEARN.`);
  });

  $("learn-toggle")?.addEventListener("click", () => setOpen(panel.hidden));
  $("learn-close")?.addEventListener("click", () => setOpen(false));
  $("learn-lang")?.addEventListener("change", async (e) => {
    await api("/api/learn/prefs", { lang: e.target.value });
    refresh();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden && document.activeElement?.tagName !== "TEXTAREA") setOpen(false);
  });

  // The badge and the practice banner are right from the first paint, even
  // with the panel closed: a reload mid-scenario must still say PRACTICE.
  refresh();
})();
