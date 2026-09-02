import { chromium } from "playwright";
import fs from "node:fs";
const S = process.env.TOUR_OUT ?? process.cwd();
const BASE = process.env.CLAW_URL ?? "http://127.0.0.1:3900";
const CARDS = process.env.TOUR_CARDS ?? new URL("..", import.meta.url).pathname;
const durs = JSON.parse(fs.readFileSync(`${S}/durs.json`, "utf8"));
const marks = [];
fs.rmSync(`${S}/vid2`, { recursive: true, force: true });
const b = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: `${S}/vid2`, size: { width: 1920, height: 1080 } } });
const p = await ctx.newPage();
const t0 = Date.now();
const wait = (ms) => p.waitForTimeout(ms);
const caption = (text) => p.evaluate((t) => {
  let el = document.getElementById("cc-cap");
  if (!el) { el = document.createElement("div"); el.id = "cc-cap"; document.body.appendChild(el); }
  el.style.cssText = "position:fixed;left:0;right:0;bottom:56px;text-align:center;z-index:99999;pointer-events:none;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:26px;letter-spacing:.06em;color:#35d6ed";
  el.innerHTML = ""; const s = document.createElement("span");
  s.style.cssText = "background:rgba(10,17,28,.92);padding:12px 22px;border:1px solid rgba(26,139,160,.45)"; s.textContent = t; el.appendChild(s);
}, text);
// Speak: log when the line starts, hold for its length plus a breath.
const say = async (name, cap, pad = 700) => { if (cap) await caption(cap); marks.push({ name, at: (Date.now() - t0) / 1000 }); await wait(durs[name] * 1000 + pad); };

await p.goto(`file://${CARDS}/title-frame.html`); await wait(400);
await say("01-title", null, 1400);
await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await wait(6500);
await say("02-glass", "The glass. Your machine, loopback only, behind a token.");
await p.click("#mcp-toggle", { timeout: 3000 }); await wait(1200);
await say("03-connect", "Ninety connectors. Seeing a name does not connect it — Connect does.", 300);
await p.fill("#mcp-search", "lovable"); await wait(1200);
await p.locator("#mcp-table button.ctl", { hasText: "Connect" }).first().click({ noWaitAfter: true, timeout: 3000 }); await wait(2800);
await say("04-lovable", "Lovable wants a sign-in. It says so, and waits.");
await p.click("#mcp-close", { timeout: 3000 }); await wait(500);
await p.click("#skills-toggle", { timeout: 3000 }); await wait(1100);
await say("05-skills", "Twenty-four skills. Click one to arm it for the next thing you say.");
await p.locator("#skills-close, #skills-overlay button:has-text(\"CLOSE\")").first().click({ timeout: 3000 }).catch(() => p.keyboard.press("Escape")); await wait(500);
await p.goto(`${BASE}/board`, { waitUntil: "domcontentloaded" }); await wait(2300);
await say("06-board", "The Forge Board — the machine, the spend, the work.");
await p.goto(`${BASE}/docs`, { waitUntil: "domcontentloaded" }); await wait(1800);
await p.locator("text=Morning briefing").first().click({ timeout: 3000 }).catch(() => {}); await wait(1200);
await say("07-desk", "The Desk — his documents and yours, on disk, as markdown.");
await p.goto(`file://${CARDS}/end-frame.html`); await wait(500);
await say("08-end", null, 1800);
const total = (Date.now() - t0) / 1000;
await ctx.close(); await b.close();
const f = fs.readdirSync(`${S}/vid2`).find((x) => x.endsWith(".webm"));
fs.renameSync(`${S}/vid2/${f}`, `${S}/tour2.webm`);
fs.writeFileSync(`${S}/marks.json`, JSON.stringify({ total, marks }, null, 1));
console.log("recorded", total.toFixed(1), "s;", marks.map((m) => `${m.name}@${m.at.toFixed(1)}`).join("  "));
