// The holograms lean toward the cursor. External file for the same reason as
// launch.js: the CSP has no inline-script allowance. The CSS owns the float
// (--fy) and the resting tilt; this only nudges --rx/--ry a few degrees from
// wherever the pointer is, so the panes read as hanging in the air rather
// than printed on the page. Touch and reduced-motion get the still version.
(function () {
  if (!window.matchMedia("(pointer: fine)").matches) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var panes = [].slice.call(document.querySelectorAll(".holo"));
  if (!panes.length) return;
  var rest = panes.map(function (el) {
    var cs = getComputedStyle(el);
    return { rx: parseFloat(cs.getPropertyValue("--rx")) || 0, ry: parseFloat(cs.getPropertyValue("--ry")) || 0 };
  });
  var pending = null;
  function apply() {
    pending = null;
    panes.forEach(function (el, i) {
      var r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var dx = (mx - cx) / innerWidth, dy = (my - cy) / innerHeight;
      var lean = el.dataset.holo === "hero" ? 2.5 : 1.5;
      el.style.setProperty("--ry", (rest[i].ry + dx * lean * 2).toFixed(2) + "deg");
      el.style.setProperty("--rx", (rest[i].rx - dy * lean * 2).toFixed(2) + "deg");
    });
  }
  var mx = innerWidth / 2, my = innerHeight / 2;
  addEventListener("mousemove", function (e) {
    mx = e.clientX; my = e.clientY;
    if (!pending) pending = requestAnimationFrame(apply);
  }, { passive: true });
  addEventListener("scroll", function () { if (!pending) pending = requestAnimationFrame(apply); }, { passive: true });
})();
