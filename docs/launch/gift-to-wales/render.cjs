// Renders the gift-to-Wales kit from its HTML sources, the same way
// ../v0.3/render.cjs renders the 0.3 kit: Chromium prints each source to a PDF
// at the page size its own @page sets (A5 flyers, A4 handout, 16:9 slides),
// and pdftoppm makes a PNG preview of the first page. Re-run it whenever a
// number or a line in the sources changes; the numbers are typed in by hand,
// so check them against docs/releases/v0.4.0.md first.
//
//   node docs/launch/gift-to-wales/render.cjs           # everything
//   node docs/launch/gift-to-wales/render.cjs slides    # one job by name
//
// Needs Playwright (require("playwright")) and a Chromium; set CHROMIUM to its
// path if it is not at /opt/pw-browsers/chromium. pdfinfo and pdftoppm
// (poppler) count the pages and make the previews, and are skipped with a note
// if missing. Fonts come from Google Fonts, so it needs the network; an
// HTTPS_PROXY in the environment is passed to Chromium, which does not read it.
//
// The QR code is a static file (qr-cunningclaw.svg), not built here, so this
// script needs no QR library; README.md says how to regenerate it.
"use strict";
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");

const here = __dirname;
const url = (f) => "file://" + path.join(here, f);

const jobs = {
  flyer: { src: "flyer.html", pdf: "flyer.pdf", frame: ".page", pages: 1 },
  trades: { src: "flyer-trades.html", pdf: "flyer-trades.pdf", frame: ".page", pages: 1 },
  slides: { src: "workshop-slides.html", pdf: "workshop-slides.pdf", frame: ".slide", viewport: { width: 1280, height: 720 } },
  handout: { src: "workshop-handout.html", pdf: "workshop-handout.pdf", frame: ".page", pages: 1 },
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
        if (getComputedStyle(el).position === "absolute") continue;
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
  let problems = 0;
  for (const [name, job] of Object.entries(jobs)) {
    if (pick.length && !pick.includes(name)) continue;
    const page = await ctx.newPage();
    if (job.viewport) await page.setViewportSize(job.viewport);
    await page.goto(url(job.src), { waitUntil: "load" });
    await settle(page);
    for (const line of await overflowReport(page, job.frame)) { console.warn("  overflow", line); problems++; }
    const frames = await page.locator(job.frame).count();
    const pdf = path.join(here, job.pdf);
    await page.pdf({ path: pdf, printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    try {
      const n = Number(execFileSync("pdfinfo", [pdf]).toString().match(/Pages:\s+(\d+)/)[1]);
      const want = job.pages ?? frames;
      console.log(`${job.pdf}: ${n} page(s)${n === want ? "" : `  <-- expected ${want}`}`);
      if (n !== want) problems++;
      execFileSync("pdftoppm", ["-png", "-r", job.viewport ? "72" : "110", "-singlefile", pdf, pdf.replace(/\.pdf$/, "-preview")]);
      console.log(`  preview ${path.basename(pdf).replace(/\.pdf$/, "-preview.png")}`);
    } catch (e) {
      console.warn(`  no page count or preview (pdfinfo/pdftoppm missing?): ${e.message}`);
    }
    await page.close();
  }
  await browser.close();
  if (problems) { console.error(`${problems} problem(s) above`); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
