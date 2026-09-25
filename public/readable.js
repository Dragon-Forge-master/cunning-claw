// The reading face. Loaded in <head> on every HUD page so the text never
// flashes the wrong typeface: a cached copy of the choice is applied before
// the body paints, then the install's stored choice (data/hud-prefs.json via
// /api/hud-prefs) confirms or corrects it. The header's Aa button flips it.
(function () {
  var root = document.documentElement;
  var KEY = "claw.font";
  function apply(font) {
    root.setAttribute("data-font", font === "dyslexic" ? "dyslexic" : "standard");
    try { localStorage.setItem(KEY, root.getAttribute("data-font")); } catch (e) { /* private window */ }
    var b = document.getElementById("font-toggle");
    if (b) {
      var on = root.getAttribute("data-font") === "dyslexic";
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  try { apply(localStorage.getItem(KEY)); } catch (e) { apply("standard"); }

  fetch("/api/hud-prefs").then(function (r) { return r.ok ? r.json() : null; })
    .then(function (p) { if (p && p.font) apply(p.font); })
    .catch(function () { /* the cached choice stands */ });

  function toggle() {
    var next = root.getAttribute("data-font") === "dyslexic" ? "standard" : "dyslexic";
    apply(next);
    fetch("/api/hud-prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ font: next }),
    }).catch(function () { /* stays on for this browser even if the save fails */ });
  }
  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("font-toggle");
    if (b) b.addEventListener("click", toggle);
    apply(root.getAttribute("data-font"));
  });
})();
