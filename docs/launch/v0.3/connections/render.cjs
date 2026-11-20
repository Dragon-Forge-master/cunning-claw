// Renders the connections set from its HTML sources: PNGs at
// deviceScaleFactor 1 at their exact pixel sizes, the same way ../render.cjs
// renders the 0.3 kit. The counts in the sources are typed in by hand from
// MCP_CATALOGUE (src/mcp-catalog.ts); re-check them before re-rendering.
//
//   node docs/launch/v0.3/connections/render.cjs          # everything
//   node docs/launch/v0.3/connections/render.cjs week     # one source by name
//
// Needs Playwright (require("playwright")) and a Chromium; set CHROMIUM to
// its path if it is not at /opt/pw-browsers/chromium. The fonts come from
// Google Fonts, so the renderer needs the network; an HTTPS_PROXY in the
// environment is passed to Chromium, which does not read it itself.
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const here = __dirname;
const url = (f) => "file://" + path.join(here, f);

const jobs = {
  square: { src: "hub-square.html", width: 1080, height: 1080, out: "connections-1080.png" },
  wide: { src: "hub-wide.html", width: 1600, height: 900, out: "connections-1600x900.png" },
  story: { src: "hub-story.html", width: 1080, height: 1920, out: "connections-story.png" },
  week: { src: "week-carousel.html", width: 1080, height: 1080, each: ".slide", out: "week" },
};

function launchOptions() {
  const o = { executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" };
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (p) {
    const u = new URL(p);
    o.proxy = { server: `${u.protocol}//${u.host}` };
    if (u.username) o.proxy.username = decodeURIComponent(u.username);
    if (u.password) o.proxy.password = decodeURIComponent(u.password);
  }
  return o;
}

// Anything that pokes outside its frame, or is cut off inside a card, is a
// layout bug, not a style: list it. The hub's cards clip their own overflow
// (a fixed grid cell cannot grow), so a card whose content is taller than the
// card is reported here rather than silently losing its last line.
async function overflowReport(page, frameSel) {
  return page.evaluate((sel) => {
    const out = [];
    for (const frame of document.querySelectorAll(sel)) {
      const fr = frame.getBoundingClientRect();
      for (const el of frame.querySelectorAll("*")) {
        if (el.closest(".numeral") || el.closest("svg") || getComputedStyle(el).position === "absolute") continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const over = r.right > fr.right + 0.5 || r.bottom > fr.bottom + 0.5 || r.left < fr.left - 0.5 || r.top < fr.top - 0.5;
        const cs = getComputedStyle(el);
        const clipped = cs.overflow !== "visible" && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
        if (over || clipped) out.push(`${frame.dataset.name || sel}: <${el.tagName.toLowerCase()} class="${el.className}"> "${(el.textContent || "").trim().slice(0, 50)}"`);
      }
    }
    return out;
  }, frameSel);
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.evaluate(() => document.fonts.ready);
}

(async () => {
  const pick = process.argv.slice(2);
  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext({ deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  for (const [name, job] of Object.entries(jobs)) {
    if (pick.length && !pick.includes(name)) continue;
    const page = await ctx.newPage();
    await page.setViewportSize({ width: job.width, height: job.height });
    await page.goto(url(job.src), { waitUntil: "load" });
    await settle(page);
    for (const line of await overflowReport(page, job.each || ".frame")) console.warn("  overflow", line);
    if (job.each) {
      const dir = path.join(here, job.out);
      fs.mkdirSync(dir, { recursive: true });
      const slides = page.locator(job.each);
      const n = await slides.count();
      for (let i = 0; i < n; i++) {
        const s = slides.nth(i);
        const file = (await s.getAttribute("data-name")) + ".png";
        await s.screenshot({ path: path.join(dir, file) });
      }
      console.log(`${job.out}/: ${n} slides`);
    } else {
      await page.screenshot({ path: path.join(here, job.out), clip: { x: 0, y: 0, width: job.width, height: job.height } });
      console.log(job.out);
    }
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
