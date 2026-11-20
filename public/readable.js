// The reading face. Loaded in <head> on every HUD page so the text never
// flashes the wrong typeface: a cached copy of the choice is applied before
// the body paints, then the install's stored choice (data/hud-prefs.json via
// /api/hud-prefs) confirms or corrects it. The header's Aa button opens a
// small menu of the three faces — the HUD's own monospace, a plain everyday
// sans, and OpenDyslexic — each shown in its own face, so the choice is seen.
(function () {
  var root = document.documentElement;
  var KEY = "claw.font";
  var FACES = [
    { id: "standard", label: "HUD — the claw's own face" },
    { id: "plain", label: "Plain — everyday text" },
    { id: "dyslexic", label: "Dyslexia-friendly (OpenDyslexic)" },
  ];
  function known(font) {
    for (var i = 0; i < FACES.length; i++) if (FACES[i].id === font) return font;
    return "standard";
  }
  function apply(font) {
    root.setAttribute("data-font", known(font));
    try { localStorage.setItem(KEY, root.getAttribute("data-font")); } catch (e) { /* private window */ }
    var b = document.getElementById("font-toggle");
    if (b) b.classList.toggle("active", root.getAttribute("data-font") !== "standard");
    var items = document.querySelectorAll(".font-menu button[data-face]");
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute("aria-checked", items[i].getAttribute("data-face") === root.getAttribute("data-font") ? "true" : "false");
    }
  }
  try { apply(localStorage.getItem(KEY)); } catch (e) { apply("standard"); }

  fetch("/api/hud-prefs").then(function (r) { return r.ok ? r.json() : null; })
    .then(function (p) { if (p && p.font) apply(p.font); })
    .catch(function () { /* the cached choice stands */ });

  function choose(font) {
    apply(font);
    fetch("/api/hud-prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ font: known(font) }),
    }).catch(function () { /* stays chosen for this browser even if the save fails */ });
  }

  var menu = null;
  function close(focusButton) {
    if (!menu) return;
    menu.remove();
    menu = null;
    var b = document.getElementById("font-toggle");
    if (b) {
      b.setAttribute("aria-expanded", "false");
      if (focusButton) b.focus();
    }
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function outside(e) {
    var b = document.getElementById("font-toggle");
    if (menu && !menu.contains(e.target) && e.target !== b) close(false);
  }
  function onKey(e) {
    if (!menu) return;
    if (e.key === "Escape") { e.preventDefault(); close(true); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      var items = Array.prototype.slice.call(menu.querySelectorAll("button"));
      var at = items.indexOf(document.activeElement);
      var next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next].focus();
    }
  }
  function open(b) {
    menu = document.createElement("div");
    menu.className = "font-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Reading face");
    for (var i = 0; i < FACES.length; i++) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "f-" + FACES[i].id;
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("data-face", FACES[i].id);
      item.textContent = FACES[i].label;
      item.addEventListener("click", function (ev) {
        choose(ev.currentTarget.getAttribute("data-face"));
        close(true);
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    // Under the button, kept inside the window on a narrow screen.
    var r = b.getBoundingClientRect();
    var left = Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8);
    menu.style.left = Math.max(8, left) + "px";
    menu.style.top = (r.bottom + window.scrollY + 6) + "px";
    b.setAttribute("aria-expanded", "true");
    apply(root.getAttribute("data-font"));
    var checked = menu.querySelector('[aria-checked="true"]') || menu.querySelector("button");
    checked.focus();
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("font-toggle");
    if (b) b.addEventListener("click", function () { if (menu) close(true); else open(b); });
    apply(root.getAttribute("data-font"));
  });
})();
