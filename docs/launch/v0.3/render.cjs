// Renders the 0.3 marketing kit from its HTML sources: PNGs at
// deviceScaleFactor 1 at their exact pixel sizes, and the two A4 one-pagers
// as PDFs with a PNG preview of each page. Re-run it whenever a number in the
// sources changes (tests, tools, connectors) — the numbers are typed in by
// hand, so `grep -c '^    name: "' src/tools.ts` and `npm test` first.
//
//   node docs/launch/v0.3/render.cjs            # everything
//   node docs/launch/v0.3/render.cjs carousel   # one source by name
//
// Needs Playwright (require("playwright")) and a Chromium; set CHROMIUM to
// its path if it is not at /opt/pw-browsers/chromium. pdftoppm (poppler)
// makes the PDF previews and is skipped with a note if missing. The fonts
// come from Google Fonts, so the renderer needs the network; an HTTPS_PROXY
// in the environment is passed to Chromium, which does not read it itself.
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");

const here = __dirname;
const url = (f) => "file://" + path.join(here, f);

const jobs = {
  carousel: { src: "carousel.html", width: 1080, height: 1080, each: ".slide", out: "carousel" },
  story: { src: "story.html", width: 1080, height: 1920, out: "story-0.3.png" },
  banner: { src: "linkedin-banner.html", width: 1584, height: 396, out: "linkedin-banner-0.3.png" },
  social: { src: "site-social.html", width: 1600, height: 900, out: "site-social-0.3.png" },
  business: { src: "business-onepager.html", pdf: "cunning-claw-for-your-business.pdf" },
  security: { src: "security-at-a-glance.html", pdf: "security-at-a-glance.pdf" },
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

// Anything that pokes outside its frame is a layout bug, not a style: list it.
async function overflowReport(page, frameSel) {
  return page.evaluate((sel) => {
    const out = [];
    for (const frame of document.querySelectorAll(sel)) {
      const fr = frame.getBoundingClientRect();
      for (const el of frame.querySelectorAll("*")) {
        if (el.closest(".numeral") || getComputedStyle(el).position === "absolute") continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const over = r.right > fr.right + 0.5 || r.bottom > fr.bottom + 0.5 || r.left < fr.left - 0.5 || r.top < fr.top - 0.5;
        const clipped = el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible";
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
    if (job.pdf) {
      await page.goto(url(job.src), { waitUntil: "load" });
      await settle(page);
      for (const line of await overflowReport(page, ".page")) console.warn("  overflow", line);
      const pdf = path.join(here, job.pdf);
      await page.pdf({ path: pdf, format: "A4", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true });
      try {
        const pages = execFileSync("pdfinfo", [pdf]).toString().match(/Pages:\s+(\d+)/)[1];
        console.log(`${job.pdf}: ${pages} page(s)`);
        execFileSync("pdftoppm", ["-png", "-r", "110", "-singlefile", pdf, pdf.replace(/\.pdf$/, "-preview")]);
        console.log(`  preview ${path.basename(pdf).replace(/\.pdf$/, "-preview.png")}`);
      } catch (e) {
        console.warn(`  no preview (pdfinfo/pdftoppm missing?): ${e.message}`);
      }
    } else {
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
    }
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
