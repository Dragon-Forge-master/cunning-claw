// The home page's few moving parts: the practice card, the downloads that know
// your computer, the films, "send the link" on a phone, and the supplier page's
// hidden line.
//
// External because the CSP allows no inline script (site/_headers). Every state
// is already in the HTML: this file only shows, hides and relabels. It writes
// no markup, sets no URL it did not read from the page, and makes no request.
// With scripts off the page is complete; each block below returns quietly when
// the element it looks for is absent, so other pages can load this file too.
(function () {
  "use strict";
  var doc = document;
  var root = doc.documentElement;
  root.classList.add("js");

  function one(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function all(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }

  // --- Which computer is this? -------------------------------------------
  // Asked of the browser, sent nowhere. A Mac cannot be told apart, Apple
  // Silicon from Intel (both report Intel), so both Mac files are offered.
  function detect() {
    var uad = navigator.userAgentData;
    var s = uad && uad.platform ? String(uad.platform) : (navigator.platform || "") + " " + (navigator.userAgent || "");
    if (/Android|iPhone|iPad|iPod/i.test(s)) return "phone";
    if (/Mac/i.test(navigator.platform || "") && navigator.maxTouchPoints > 1) return "phone";
    if (/Win/i.test(s)) return "windows";
    if (/Mac/i.test(s)) return "mac";
    if (/CrOS|Chrome OS/i.test(s)) return "other";
    if (/Linux|X11/i.test(s)) return "linux";
    return "other";
  }
  var os = detect();
  root.setAttribute("data-os", os);
  var known = os === "windows" || os === "mac" || os === "linux";

  var detectNote = one("#get .detect");
  if (detectNote && known) detectNote.hidden = false;

  // Step one shows the first-run line for this system only; the button brings back the rest.
  var firstrun = one("#firstrun");
  var firstrunMore = one("#firstrun-more");
  // On a phone, or a system this page cannot name, all three are folded away.
  if (firstrun && firstrunMore) {
    var closedLabel = known ? "Show the other systems" : "Show what to press on each system";
    firstrunMore.textContent = closedLabel;
    firstrunMore.hidden = false;
    firstrunMore.addEventListener("click", function () {
      var open = firstrun.classList.toggle("is-open");
      firstrunMore.setAttribute("aria-expanded", open ? "true" : "false");
      firstrunMore.textContent = open ? (known ? "Show only my system" : "Hide them") : closedLabel;
    });
  }

  // --- The practice card ---------------------------------------------------
  var practice = one("#practice");
  if (practice) {
    var scenes = all(".scene", practice);
    var reset = function (scene) {
      one(".card-btns", scene).hidden = false;
      one(".card-out", scene).hidden = true;
    };
    var show = function (n) {
      scenes.forEach(function (scene) {
        reset(scene);
        scene.hidden = scene.getAttribute("data-scene") !== String(n);
      });
    };
    // They ship disabled so that, without this file, the card is a picture and not dead buttons.
    all("button[disabled]", practice).forEach(function (b) { b.disabled = false; });
    practice.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button") : null;
      if (!b) return;
      var scene = b.closest(".scene");
      if (b.hasAttribute("data-answer") && scene) {
        var out = one(".card-out", scene);
        var answer = b.getAttribute("data-answer");
        all("[data-out]", out).forEach(function (p) { p.hidden = p.getAttribute("data-out") !== answer; });
        one(".card-btns", scene).hidden = true;
        out.hidden = false;
        out.focus();
      } else if (b.hasAttribute("data-next")) {
        show(2);
        one('.scene[data-scene="2"] .msg-he', practice).focus();
      } else if (b.hasAttribute("data-restart")) {
        show(1);
        one('.scene[data-scene="1"] .cb', practice).focus();
      }
    });
  }

  // --- Films ----------------------------------------------------------------
  // Poster first and not a byte of video until Play. The overlay stands in for
  // the browser's controls until then, so an unplayed film is one tab stop.
  var starters = {};
  var videos = all(".film video");
  all(".film").forEach(function (film) {
    var video = one("video", film);
    var play = one(".film-play", film);
    if (!video || !play) return;
    video.controls = false;
    play.hidden = false;
    var start = function () {
      play.hidden = true;
      video.controls = true;
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* the controls are there to try again */ });
      video.focus({ preventScroll: true });
    };
    play.addEventListener("click", start);
    video.addEventListener("play", function () {
      play.hidden = true;
      video.controls = true;
      videos.forEach(function (other) { if (other !== video) other.pause(); });
    });
    if (film.id) starters[film.id] = start;
  });
  // "Watch him catch a bank-details scam": the link still jumps; the click also plays, with sound.
  all("a[data-play]").forEach(function (a) {
    a.addEventListener("click", function () {
      var start = starters[a.getAttribute("data-play")];
      if (start) start();
    });
  });

  // --- Send the link to my computer (phones) ---------------------------------
  // The share sheet where there is one, the visitor's own mail app where not.
  // The address is read back out of the mailto: link, so it lives in one place.
  function linkFrom(a) {
    var m = /[?&]body=([^&]+)/.exec(a.getAttribute("href") || "");
    try { return m ? decodeURIComponent(m[1]) : ""; } catch (e) { return ""; }
  }
  all("a[data-send]").forEach(function (a) {
    var url = linkFrom(a);
    if (!url || !navigator.share) return;
    a.addEventListener("click", function (e) {
      e.preventDefault();
      navigator.share({ title: "Cunning Claw", text: "Cunning Claw: open this on your computer", url: url }).catch(function () { /* closed without sharing */ });
    });
  });
  var copy = one("[data-copy]");
  var copied = one(".copied");
  var copySource = one("#get a[data-send]");
  if (copy && copied && copySource && navigator.clipboard && navigator.clipboard.writeText) {
    copy.hidden = false;
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(linkFrom(copySource)).then(
        function () { copied.textContent = "Copied"; },
        function () { copied.textContent = "Could not copy. The link is cunningclaw.com"; }
      );
    });
  }

  // --- The supplier's page ----------------------------------------------------
  // Without this file the planted line is simply shown. With it, the page starts
  // as a person would see it and the button shows what an AI reads.
  var specimen = one("#specimen");
  var reveal = one("#reveal");
  if (specimen && reveal) {
    reveal.hidden = false;
    var page = one("#page", specimen);
    reveal.addEventListener("click", function () {
      var open = specimen.classList.toggle("is-open");
      reveal.setAttribute("aria-expanded", open ? "true" : "false");
      reveal.textContent = open ? "Hide it again" : "Show what was hidden";
      // The line sits near the foot of the page, as it did in the film: bring it into the frame.
      if (open && page) page.scrollTop = page.scrollHeight;
    });
  }

  // --- The menu (narrow screens) ----------------------------------------------
  var menu = one(".menu");
  if (menu) {
    menu.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("nav a")) menu.open = false;
    });
    doc.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.open) { menu.open = false; one("summary", menu).focus(); }
    });
  }
})();
