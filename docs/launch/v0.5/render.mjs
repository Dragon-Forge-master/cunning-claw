// Renders the 0.5 share image at its exact size, and says if anything
// overflows the frame. Needs Playwright, a Chromium and the network (Google
// Fonts). Output: site/social-0.5.png.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("/opt/node22/lib/node_modules/playwright/index.mjs")); }

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`file://${here}/site-social.html`, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
const over = await page.evaluate(() =>
  [...document.querySelectorAll("body *")]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.right > 1600 || r.bottom > 900; })
    .map((el) => el.className || el.tagName));
if (over.length) console.log("overflows the frame:", over.join(", "));
const out = path.join(here, "..", "..", "..", "site", "social-0.5.png");
await page.screenshot({ path: out });
await browser.close();
console.log("wrote", out);
