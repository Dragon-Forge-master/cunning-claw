// The constellation. A data list becomes an SVG star chart: one hub, four
// arms, every star a real link. External file because the CSP forbids inline
// scripts. Add a destination by adding a line to STARS — the layout is
// computed, never hand-placed, so the sky rearranges itself.
//
// Layout law: each arm owns a quarter of the sky; its stars fan across at
// most 84 degrees and alternate between two radii so labels never touch;
// arms at the top and bottom label above/below their stars, arms at the
// sides label outward. Halo strokes keep text legible across the lines.
(function () {
  var W = 1200, H = 1040, CX = 600, CY = 520;
  var ARMS = [
    { id: "product", label: "THE CLAW", angle: -90, r: 300, stars: [
      { t: "cunningclaw.com", s: "the front door", u: "https://cunningclaw.com/" },
      { t: "Source", s: "GitHub · open source", u: "https://github.com/Dragon-Forge-master/cunning-claw" },
      { t: "npm · cunningclaw", s: "the name, held", u: "https://www.npmjs.com/package/cunningclaw" },
      { t: "Issues & Discussions", s: "bring what broke", u: "https://github.com/Dragon-Forge-master/cunning-claw/issues" },
      { t: "Security", s: "report privately", u: "https://github.com/Dragon-Forge-master/cunning-claw/security" },
      { t: "The film", s: "42 seconds", u: "https://cunningclaw.com/#demo" }
    ]},
    { id: "forge", label: "FORGENET · FREE TOOLS · MCP", angle: 0, r: 330, stars: [
      { t: "forgenet.cloud", s: "the suite", u: "https://forgenet.cloud/" },
      { t: "Forge Arch", s: "floor plans · DXF", u: "https://arch.forgenet.cloud/" },
      { t: "Forge Interior", s: "3D rooms", u: "https://interior.forgenet.cloud/" },
      { t: "Forge Land", s: "3D land planning", u: "https://land.forgenet.cloud/" },
      { t: "Forge CAD", s: "browser 3D design", u: "https://cad.forgenet.cloud/" },
      { t: "Forge Flow", s: "visual workflows", u: "https://flow.forgenet.cloud/" },
      { t: "Forge Sketch", s: "early alpha", u: "https://forge-sketch.pages.dev/" },
      { t: "The Forge blog", s: "articles", u: "https://blog.forgenet.cloud/" }
    ]},
    { id: "house", label: "DRAGON FORGE AI · CARDIFF", angle: 90, r: 300, stars: [
      { t: "dragonforgeai.dev", s: "the workshop", u: "https://dragonforgeai.dev/" },
      { t: "@Dragon_forge_ai", s: "on X", u: "https://x.com/Dragon_forge_ai" },
      { t: "GitHub · Dragon-Forge-master", s: "the account", u: "https://github.com/Dragon-Forge-master" }
    ]},
    { id: "inside", label: "INSIDE THE CLAW", angle: 180, r: 330, stars: [
      { t: "The Glass", s: "the HUD · loopback only", u: "https://cunningclaw.com/#watch" },
      { t: "Connect", s: "94 MCP connectors", u: "https://cunningclaw.com/#demo" },
      { t: "See it refuse", s: "the injection test", u: "https://cunningclaw.com/#attack" },
      { t: "Install", s: "Linux · macOS · Windows", u: "https://cunningclaw.com/#install" },
      { t: "Pricing", s: "free · BYOK forever", u: "https://cunningclaw.com/#pricing" },
      { t: "Just Works tier", s: "opens after launch", u: "https://cunningclaw.com/#pricing", soon: true }
    ]}
  ];

  var NS = "http://www.w3.org/2000/svg";
  function el(name, attrs, parent) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function polar(cx, cy, r, deg) {
    var a = deg * Math.PI / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }

  var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });
  el("circle", { class: "ring", cx: CX, cy: CY, r: 260 }, svg);
  el("circle", { class: "ring", cx: CX, cy: CY, r: 370 }, svg);

  ARMS.forEach(function (arm, i) {
    var g = el("g", { class: "orbit " + (i % 2 ? "o2" : "") }, svg);
    var vertical = arm.angle === -90 || arm.angle === 90;
    var hubP = polar(CX, CY, 150, arm.angle);
    el("path", { class: "link spine", d: "M" + CX + " " + CY + " L" + hubP.x + " " + hubP.y }, g);

    var n = arm.stars.length;
    var spread = n > 1 ? Math.max(60, Math.min(84, 15 * (n - 1))) : 0;
    arm.stars.forEach(function (s, j) {
      var deg = arm.angle - spread / 2 + (n === 1 ? 0 : spread * j / (n - 1));
      var r = arm.r + (j % 2 ? 48 : -30);
      var p = polar(CX, CY, r, deg);
      el("path", { class: "link", d: "M" + hubP.x + " " + hubP.y + " Q" + ((hubP.x + p.x) / 2) + " " + ((hubP.y + p.y) / 2) + " " + p.x + " " + p.y }, g);
      var a = el("a", { class: "node" + (s.soon ? " soon" : ""), href: s.u, "aria-label": s.t + " — " + s.s }, g);
      el("circle", { cx: p.x, cy: p.y, r: 7 }, a);
      if (vertical) {
        var above = arm.angle === -90;
        var ty = above ? p.y - 30 : p.y + 24;
        el("text", { x: p.x, y: ty, "text-anchor": "middle" }, a).textContent = s.t;
        el("text", { class: "sub", x: p.x, y: ty + 15, "text-anchor": "middle" }, a).textContent = s.s;
      } else {
        var right = p.x >= CX;
        var tx = p.x + (right ? 14 : -14);
        el("text", { x: tx, y: p.y + 4, "text-anchor": right ? "start" : "end" }, a).textContent = s.t;
        el("text", { class: "sub", x: tx, y: p.y + 19, "text-anchor": right ? "start" : "end" }, a).textContent = s.s;
      }
    });

    // the arm's name sits beside its hub, clear of the spine
    var lp = polar(CX, CY, 150, arm.angle);
    var lx = lp.x, ly = lp.y, anchor = "middle";
    if (vertical) { ly += arm.angle === -90 ? -16 : 26; }
    else { lx += arm.angle === 0 ? 14 : -14; ly -= 14; anchor = arm.angle === 0 ? "start" : "end"; }
    el("text", { class: "glabel", x: lx, y: ly, "text-anchor": anchor }, g).textContent = arm.label;
    el("circle", { class: "pulse", cx: hubP.x, cy: hubP.y, r: 4, fill: "#35d6ed" }, g);
  });

  // the core: the mark, glowing
  var core = el("a", { class: "node hub core", href: "https://cunningclaw.com/", "aria-label": "Cunning Claw — home" }, svg);
  el("circle", { cx: CX, cy: CY, r: 46 }, core);
  el("image", { href: "forge-mark-cyan.svg", x: CX - 30, y: CY - 30, width: 60, height: 60 }, core);
  el("text", { x: CX, y: CY + 72, "text-anchor": "middle" }, core).textContent = "CUNNING CLAW";
  el("text", { class: "sub", x: CX, y: CY + 88, "text-anchor": "middle" }, core).textContent = "Y DYN HYSBYS";

  document.getElementById("stage").appendChild(svg);
})();
