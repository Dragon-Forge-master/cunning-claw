import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import {
  flattenAx,
  formatSnapshot,
  lookupRef,
  refLabel,
  fenceUntrusted,
  type ClawRef,
  type AxNode,
} from "./browser-ax.js";
import {
  expandGmailQuery,
  formatGmailList,
  formatGmailThread,
  gmailListUrl,
  parseGmailView,
  shouldSweepUnread,
  gmailFocusScript,
  isGmailMailboxUrl,
  isGoogleAuthUrl,
  isGmailRelatedUrl,
  formatGmailOpenFailure,
  GMAIL_LIST_JS,
  GMAIL_THREAD_JS,
  GMAIL_COMPOSE_OPEN_JS,
  GMAIL_CLICK_COMPOSE_JS,
  GMAIL_CLICK_SEND_JS,
  GMAIL_DRAFT_JS,
  GMAIL_ACTION_KEYS,
  GMAIL_ACTIONS,
  GMAIL_COMPOSE_KEY,
  GMAIL_REPLY_KEY,
  GMAIL_REPLY_ALL_KEY,
  type GmailAction,
  type GmailKeySpec,
  type GmailList,
  type GmailThread,
  type GmailView,
} from "./gmail.js";
import {
  WHATSAPP_URL,
  isWhatsAppUrl,
  shouldReuseTab,
  formatWhatsAppQr,
  formatWhatsAppOpenFailure,
  formatWhatsAppList,
  formatWhatsAppThread,
  WA_STATE_JS,
  WA_USE_HERE_JS,
  WA_FOCUS_SEARCH_JS,
  WA_CLICK_CHAT_JS,
  WA_THREAD_JS,
  WA_COMPOSE_JS,
  WA_CLICK_SEND_JS,
  type WhatsAppState,
  type WhatsAppThread,
  type WhatsAppDraft,
} from "./whatsapp.js";

export { fenceUntrusted, lookupRef, refLabel } from "./browser-ax.js";

const execFileAsync = promisify(execFile);

const PROFILE_DIR =
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "cunningclaw", "chrome-profile")
    : process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "cunningclaw", "chrome-profile")
      : path.join(os.homedir(), ".config", "cunningclaw", "chrome-profile");

export function chromeProfileDir(): string {
  return PROFILE_DIR;
}

const PORT = config.browser.debugPort;
const ORIGIN = `http://127.0.0.1:${PORT}`;

interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

/**
 * One WebSocket per tab, kept open.
 *
 * The previous client opened a socket, fired one method, and hung up. That
 * made waiting for load events, buffering console errors, and clicking with
 * DOM.getBoxModel all impossible — which is why clicks used element.click()
 * and sleeps, and why React apps often ignored them.
 */
class CdpSession {
  private ws: WebSocket;
  private ready: Promise<void>;
  private id = 0;
  private pending = new Map<number, Pending>();
  readonly errors: string[] = [];
  dead = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 8000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("CDP connect failed"));
      };
    });
    this.ws.onclose = () => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(new Error("CDP socket closed"));
      this.pending.clear();
    };
    this.ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.method === "Log.entryAdded") {
        const e = msg.params?.entry;
        const text = String(e?.text ?? e?.message ?? "").trim();
        const level = String(e?.level ?? "");
        if (text && (level === "error" || level === "exception")) {
          this.errors.push(text.slice(0, 240));
          if (this.errors.length > 20) this.errors.shift();
        }
      }
      if (msg.id == null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result);
    };
  }

  async call(method: string, params: object = {}): Promise<any> {
    await this.ready;
    if (this.dead) throw new Error("CDP socket closed");
    const id = ++this.id;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, config.browser.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.dead = true;
    try { this.ws.close(); } catch { /* noop */ }
  }
}

const sessions = new Map<string, CdpSession>();
let lastTargetId: string | null = null;
let lastRefs: ClawRef[] = [];
let lastUrl = "";

async function sessionFor(target: Target): Promise<CdpSession> {
  if (!target.webSocketDebuggerUrl) throw new Error("Target has no debugger URL");
  const existing = sessions.get(target.id);
  if (existing && !existing.dead) return existing;
  if (existing) existing.close();
  const s = new CdpSession(target.webSocketDebuggerUrl);
  sessions.set(target.id, s);
  lastTargetId = target.id;
  try {
    await s.call("Runtime.enable");
    await s.call("Log.enable");
    await s.call("Page.enable");
    await s.call("DOM.enable");
    await s.call("Accessibility.enable");
  } catch {
    // Older Chromium may not have Accessibility; snapshot will fall back.
  }
  return s;
}

async function evaluate(s: CdpSession, expression: string): Promise<any> {
  const result = await s.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "Page script error");
  }
  return result.result?.value;
}

// ---------------------------------------------------------------------------
// Chrome lifecycle
// ---------------------------------------------------------------------------

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${ORIGIN}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export function chromeCandidates(): string[] {
  const out: string[] = [];
  if (config.browser.binary) out.push(config.browser.binary);
  out.push(
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "google-chrome-beta",
    "chrome",
  );
  if (process.platform === "darwin") {
    out.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    );
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    out.push(
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      // Edge is Chromium and speaks CDP: every Windows machine has it, so
      // browser control works out of the box even before Chrome is installed.
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      "msedge",
    );
  }
  return out;
}

export async function findChromeBinary(): Promise<string | null> {
  for (const candidate of chromeCandidates()) {
    if (!candidate) continue;
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    try {
      await execFileAsync("which", [candidate]);
      return candidate;
    } catch { /* keep looking */ }
    try {
      await execFileAsync("where", [candidate]);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Launch Chrome with remote debugging on a Cunning Claw-owned profile. Idempotent. */
export async function ensureBrowser(): Promise<{ ok: boolean; message: string }> {
  if (await isUp()) return { ok: true, message: "Browser already running." };

  const bin = await findChromeBinary();
  if (!bin) return { ok: false, message: "No Chrome/Chromium binary found. Install Chrome or set browser.binary in claw.config.json." };

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(
    bin,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--restore-last-session",
      ...config.browser.extraFlags,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isUp()) return { ok: true, message: "Browser launched." };
  }
  return { ok: false, message: "Browser did not expose its debug port in time." };
}

export async function listTargets(): Promise<Target[]> {
  const res = await fetch(`${ORIGIN}/json/list`, { signal: AbortSignal.timeout(4000) });
  const all = (await res.json()) as Target[];
  return all.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
}

/**
 * Chrome's /json/new accepts PUT on some builds and GET on others, and the
 * fragment of a Gmail hash URL must be encoded. Parse the returned target so
 * we can follow the tab by id after it redirects to accounts.google.com.
 */
async function openNewTab(url: string): Promise<Target | null> {
  const q = encodeURIComponent(url);
  for (const method of ["PUT", "GET"] as const) {
    try {
      const res = await fetch(`${ORIGIN}/json/new?${q}`, {
        method,
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      try {
        const body = JSON.parse(text) as Target;
        if (body?.id) return body;
      } catch {
        /* some builds return a websocket URL as plain text */
      }
    } catch {
      /* try the other method */
    }
  }
  return null;
}

async function waitForTarget(pred: (t: Target) => boolean, timeoutMs = 8000): Promise<Target | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const hit = (await listTargets()).find(pred);
      if (hit) return hit;
    } catch {
      /* debug port blipped */
    }
    await sleep(250);
  }
  return null;
}

async function activeTarget(index?: number): Promise<Target> {
  const targets = await listTargets();
  if (targets.length === 0) throw new Error("No open tabs.");
  if (typeof index === "number") {
    if (index < 0 || index >= targets.length) throw new Error(`No tab at index ${index}.`);
    const t = targets[index];
    lastTargetId = t.id;
    return t;
  }
  if (lastTargetId) {
    const pinned = targets.find((t) => t.id === lastTargetId);
    if (pinned) return pinned;
  }
  return targets[0];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Wait until the document is complete, instead of guessing 1200ms. */
export async function settle(s: CdpSession, quietMs = 350, timeoutMs = 12000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let state = "loading";
    try {
      state = String(await evaluate(s, "document.readyState") ?? "loading");
    } catch {
      await sleep(200);
      continue;
    }
    if (state === "complete") {
      await sleep(quietMs);
      return;
    }
    await sleep(200);
  }
}

async function pageMeta(s: CdpSession): Promise<{ url: string; title: string }> {
  try {
    const m = await evaluate(s, `({ url: location.href, title: document.title })`);
    return { url: String(m?.url ?? ""), title: String(m?.title ?? "") };
  } catch {
    return { url: lastUrl, title: "" };
  }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

async function captureRefs(s: CdpSession): Promise<ClawRef[]> {
  try {
    await s.call("DOM.getDocument", { depth: 0 });
    const tree = await s.call("Accessibility.getFullAXTree");
    const nodes = (tree?.nodes ?? []) as AxNode[];
    return flattenAx(nodes);
  } catch {
    // Fallback: walk the DOM for the common interactive tags.
    const rows = await evaluate(s, `(() => {
      const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=tab],[contenteditable=true]';
      return [...document.querySelectorAll(sel)].slice(0, 180).map((el, i) => ({
        ref: 'e' + (i + 1),
        role: (el.getAttribute('role') || el.tagName.toLowerCase()),
        name: (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '').trim().slice(0, 120),
        value: (el.value || '').slice(0, 80),
      }));
    })()`);
    return Array.isArray(rows) ? rows : [];
  }
}

export async function snapshot(index?: number): Promise<string> {
  const boot = await ensureBrowser();
  if (!boot.ok) return boot.message;
  const target = await activeTarget(index);
  const s = await sessionFor(target);
  await settle(s, 150, 4000);
  const meta = await pageMeta(s);
  lastUrl = meta.url;
  lastRefs = await captureRefs(s);
  return formatSnapshot({
    url: meta.url,
    title: meta.title,
    refs: lastRefs,
    consoleErrors: s.errors.slice(-6),
  });
}

async function afterAction(s: CdpSession, headline: string): Promise<string> {
  const before = lastUrl;
  await settle(s);
  const meta = await pageMeta(s);
  lastUrl = meta.url;
  lastRefs = await captureRefs(s);
  // A click that navigates is the single most-missed event in web automation:
  // the model clicks "Generate", lands on the homepage, and reads the old
  // intent into the new page. Say the move out loud so it cannot be missed.
  const moved = before && before !== meta.url ? `\nPage navigated: ${before} → ${meta.url}` : "";
  const snap = formatSnapshot({
    url: meta.url,
    title: meta.title,
    refs: lastRefs,
    consoleErrors: s.errors.slice(-6),
    note: headline + moved,
  });
  return `${headline}${moved}\n\n${snap}`;
}

/**
 * A ref that is not in the last tree usually means the page moved on — a
 * navigation, a re-render, a dialog. The old answer ("call browser_snapshot
 * first") cost a whole round trip; hand back the fresh tree in the same breath.
 */
async function staleRefRecovery(s: CdpSession, ref: string): Promise<string> {
  return afterAction(
    s,
    `Ref ${ref} is not in the current page — it has changed since that snapshot. ` +
      `Nothing was clicked or typed. Fresh tree below; aim again with its refs.`,
  );
}

function resolveAim(input: { ref?: string; query?: string }): ClawRef | { query: string } {
  if (input.ref) {
    const hit = lookupRef(lastRefs, input.ref);
    if (!hit) {
      throw new Error(
        `No ref ${input.ref} in the last snapshot. Call browser_snapshot first — refs are e1, e2, … from that tree.`,
      );
    }
    return hit;
  }
  if (input.query) return { query: input.query };
  throw new Error("Pass a ref from the last snapshot (preferred) or a query (CSS / visible text).");
}

export function lastSnapshotRefs(): ClawRef[] {
  return lastRefs;
}

export function labelForAim(input: { ref?: string; query?: string; x?: number; y?: number }): string {
  if (input.ref) {
    const hit = lookupRef(lastRefs, input.ref);
    if (hit) return refLabel(hit);
    return input.ref;
  }
  if (input.query) return String(input.query);
  if (typeof input.x === "number" && typeof input.y === "number") {
    return `at ${input.x},${input.y}`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Page reading
// ---------------------------------------------------------------------------

const READ_PAGE_JS = `(() => {
  const drop = new Set(["SCRIPT","STYLE","NOSCRIPT","SVG","IFRAME"]);
  const root = document.querySelector("main,[role=main],article") || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out = [];
  let n;
  while ((n = walker.nextNode())) {
    if (drop.has(n.parentElement?.tagName)) continue;
    const t = n.textContent.replace(/\\s+/g, " ").trim();
    if (t.length > 1) out.push(t);
  }
  return { title: document.title, url: location.href, text: out.join("\\n") };
})()`;

export async function readPage(index?: number, maxChars = 8000): Promise<string> {
  const target = await activeTarget(index);
  const s = await sessionFor(target);
  const data = await evaluate(s, READ_PAGE_JS);
  const body = String(data?.text ?? "").slice(0, maxChars);
  return fenceUntrusted(data?.url ?? target.url, `TITLE: ${data?.title ?? target.title}\n\n${body}`);
}

export async function openUrl(url: string, newTab: boolean): Promise<string> {
  const boot = await ensureBrowser();
  if (!boot.ok) return boot.message;

  let target: Target | undefined;
  const list = await listTargets();
  if (!newTab) {
    const existing = list.find((t) => shouldReuseTab(t.url, url));
    if (existing) {
      lastTargetId = existing.id;
      const s = await sessionFor(existing);
      const meta = await pageMeta(s);
      if (shouldReuseTab(meta.url, url)) {
        await settle(s, 200, 4000);
        return afterAction(s, `Reused tab: ${meta.title || existing.title}`);
      }
      await s.call("Page.navigate", { url });
      await settle(s);
      return afterAction(s, `Opened ${url}`);
    }
  }

  if (newTab) {
    const created = await openNewTab(url);
    await sleep(300);
    const host = (() => {
      try { return new URL(url).host; } catch { return ""; }
    })();
    const after = await listTargets();
    target =
      (created && after.find((t) => t.id === created.id)) ||
      after.find((t) => t.url.startsWith(url) || (host && t.url.includes(host))) ||
      after[after.length - 1];
    if (!target) throw new Error("Opened a tab but could not find it.");
  } else {
    target = await activeTarget();
    const s = await sessionFor(target);
    await s.call("Page.navigate", { url });
  }
  const s = await sessionFor(target);
  await settle(s);
  return afterAction(s, `Opened ${url}`);
}

export async function tabs(): Promise<string> {
  await ensureBrowser();
  const list = await listTargets();
  if (list.length === 0) return "No open tabs.";
  return list.map((t, i) => {
    const mark = t.id === lastTargetId ? " *" : "";
    return `[${i}]${mark} ${t.title} — ${t.url}`;
  }).join("\n");
}

export async function closeTab(index: number): Promise<string> {
  const target = await activeTarget(index);
  sessions.get(target.id)?.close();
  sessions.delete(target.id);
  if (lastTargetId === target.id) lastTargetId = null;
  await fetch(`${ORIGIN}/json/close/${target.id}`);
  return `Closed tab [${index}] ${target.title}.`;
}

export async function goHistory(delta: -1 | 1, index?: number): Promise<string> {
  const target = await activeTarget(index);
  const s = await sessionFor(target);
  const hist = await s.call("Page.getNavigationHistory");
  const current = hist.currentIndex ?? 0;
  const entries = hist.entries ?? [];
  const next = current + delta;
  if (next < 0 || next >= entries.length) {
    return delta < 0 ? "No previous page in this tab." : "No forward page in this tab.";
  }
  await s.call("Page.navigateToHistoryEntry", { entryId: entries[next].id });
  return afterAction(s, delta < 0 ? "Went back" : "Went forward");
}

export async function reload(index?: number): Promise<string> {
  const target = await activeTarget(index);
  const s = await sessionFor(target);
  await s.call("Page.reload", { ignoreCache: false });
  return afterAction(s, "Reloaded");
}

// ---------------------------------------------------------------------------
// Pointer + keyboard via CDP Input — not element.click()
// ---------------------------------------------------------------------------

async function boxCenter(s: CdpSession, backendNodeId: number): Promise<{ x: number; y: number } | null> {
  try {
    await s.call("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch { /* some nodes cannot scroll */ }
  try {
    const quads = await s.call("DOM.getContentQuads", { backendNodeId });
    const q = quads?.quads?.[0] as number[] | undefined;
    if (q && q.length >= 8) {
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      return {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
      };
    }
  } catch { /* fall through */ }
  try {
    const box = await s.call("DOM.getBoxModel", { backendNodeId });
    const c = box?.model?.content as number[] | undefined;
    if (c && c.length >= 8) {
      return { x: (c[0] + c[4]) / 2, y: (c[1] + c[5]) / 2 };
    }
  } catch { /* fall through */ }
  return null;
}

async function mouseClick(s: CdpSession, x: number, y: number, button: "left" | "right" = "left"): Promise<void> {
  const btn = button === "right" ? "right" : "left";
  await s.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await s.call("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: btn, clickCount: 1,
  });
  await s.call("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: btn, clickCount: 1,
  });
}

const FIND_JS = (query: string) => `(() => {
  const q = ${JSON.stringify(query)};
  let el = null;
  try { el = document.querySelector(q); } catch {}
  if (!el) {
    const clickable = [...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],input,textarea,select,[onclick],[contenteditable=true]')];
    const want = q.toLowerCase();
    el = clickable.find(e => (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '')
      .trim().toLowerCase().includes(want));
  }
  if (!el) return { ok: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return {
    ok: true,
    x: r.x + r.width / 2,
    y: r.y + r.height / 2,
    label: (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 80),
  };
})()`;

async function locate(s: CdpSession, aim: ClawRef | { query: string }): Promise<{ x: number; y: number; label: string }> {
  if ("ref" in aim && aim.backendDOMNodeId) {
    const pt = await boxCenter(s, aim.backendDOMNodeId);
    if (pt) return { ...pt, label: refLabel(aim) };
  }
  const query = "query" in aim ? aim.query : [aim.name, aim.role].filter(Boolean).join(" ");
  const res = await evaluate(s, FIND_JS(query));
  if (!res?.ok) {
    throw new Error(`Found nothing matching ${"ref" in aim ? aim.ref : JSON.stringify(query)} to click.`);
  }
  return { x: res.x, y: res.y, label: res.label };
}

export async function click(
  input: { ref?: string; query?: string; tab?: number; button?: "left" | "right"; x?: number; y?: number },
): Promise<string> {
  const target = await activeTarget(input.tab);
  const s = await sessionFor(target);
  if (typeof input.x === "number" && typeof input.y === "number" && !input.ref && !input.query) {
    await mouseClick(s, input.x, input.y, input.button ?? "left");
    return afterAction(s, `Clicked at ${Math.round(input.x)},${Math.round(input.y)}`);
  }
  let aim: ReturnType<typeof resolveAim>;
  try {
    aim = resolveAim(input);
  } catch (err) {
    if (input.ref) return staleRefRecovery(s, input.ref);
    throw err;
  }
  const hit = await locate(s, aim);
  await mouseClick(s, hit.x, hit.y, input.button ?? "left");
  return afterAction(s, `Clicked ${hit.label}`);
}

export async function hover(input: { ref?: string; query?: string; tab?: number }): Promise<string> {
  const target = await activeTarget(input.tab);
  const s = await sessionFor(target);
  let aim: ReturnType<typeof resolveAim>;
  try {
    aim = resolveAim(input);
  } catch (err) {
    if (input.ref) return staleRefRecovery(s, input.ref);
    throw err;
  }
  const hit = await locate(s, aim);
  await s.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: hit.x, y: hit.y });
  return afterAction(s, `Hovered ${hit.label}`);
}

export async function typeText(input: {
  ref?: string;
  selector?: string;
  query?: string;
  text: string;
  submit?: boolean;
  replace?: boolean;
  tab?: number;
}): Promise<string> {
  const target = await activeTarget(input.tab);
  const s = await sessionFor(target);
  let aim: ReturnType<typeof resolveAim>;
  try {
    aim = resolveAim({ ref: input.ref, query: input.query ?? input.selector });
  } catch (err) {
    if (input.ref) return staleRefRecovery(s, input.ref);
    throw err;
  }
  const hit = await locate(s, aim);
  await mouseClick(s, hit.x, hit.y);
  await sleep(80);
  if (input.replace) {
    const modifiers = process.platform === "darwin" ? 4 : 2;
    await s.call("Input.dispatchKeyEvent", {
      type: "keyDown", key: "a", code: "KeyA",
      modifiers, windowsVirtualKeyCode: 65,
    });
    await s.call("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA",
      modifiers, windowsVirtualKeyCode: 65,
    });
  }
  await s.call("Input.insertText", { text: input.text });
  if (input.submit) {
    await s.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await s.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }
  return afterAction(s, `Typed into ${hit.label}${input.submit ? " and pressed Enter" : ""}`);
}

export async function fill(fields: Array<{ ref?: string; query?: string; text: string }>, tab?: number): Promise<string> {
  if (!fields.length) return "No fields to fill.";
  let last = "";
  for (const f of fields) {
    last = await typeText({ ...f, replace: true, tab, submit: false });
  }
  return last.replace(/^Typed[^\n]*/, `Filled ${fields.length} field${fields.length === 1 ? "" : "s"}`);
}

export async function pressKey(key: string, index?: number): Promise<string> {
  const target = await activeTarget(index);
  const s = await sessionFor(target);
  const map: Record<string, { key: string; code: string; vk: number }> = {
    enter: { key: "Enter", code: "Enter", vk: 13 },
    return: { key: "Enter", code: "Enter", vk: 13 },
    escape: { key: "Escape", code: "Escape", vk: 27 },
    esc: { key: "Escape", code: "Escape", vk: 27 },
    tab: { key: "Tab", code: "Tab", vk: 9 },
    backspace: { key: "Backspace", code: "Backspace", vk: 8 },
    delete: { key: "Delete", code: "Delete", vk: 46 },
    space: { key: " ", code: "Space", vk: 32 },
    arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  };
  const spec = map[key.trim().toLowerCase()] ?? {
    key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, vk: key.toUpperCase().charCodeAt(0),
  };
  await s.call("Input.dispatchKeyEvent", {
    type: "keyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk,
  });
  await s.call("Input.dispatchKeyEvent", {
    type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk,
  });
  return afterAction(s, `Pressed ${spec.key}`);
}

export async function scroll(input: { ref?: string; dy?: number; dx?: number; tab?: number }): Promise<string> {
  const target = await activeTarget(input.tab);
  const s = await sessionFor(target);
  if (input.ref) {
    const aim = resolveAim({ ref: input.ref });
    if ("backendDOMNodeId" in aim && aim.backendDOMNodeId) {
      await s.call("DOM.scrollIntoViewIfNeeded", { backendNodeId: aim.backendDOMNodeId });
      return afterAction(s, `Scrolled ${refLabel(aim)} into view`);
    }
  }
  const dy = input.dy ?? 600;
  const dx = input.dx ?? 0;
  await evaluate(s, `window.scrollBy(${Number(dx)}, ${Number(dy)})`);
  return afterAction(s, `Scrolled by ${dx},${dy}`);
}

export async function selectOption(input: {
  ref?: string;
  query?: string;
  value?: string;
  label?: string;
  tab?: number;
}): Promise<string> {
  const target = await activeTarget(input.tab);
  const s = await sessionFor(target);
  let aim: ReturnType<typeof resolveAim> | { query: string };
  try {
    aim = resolveAim(input);
  } catch {
    aim = { query: String(input.value ?? input.label ?? "") };
  }
  const want = String(input.value ?? input.label ?? "");
  if (!want) throw new Error("Pass value or label for the option to pick.");
  const js = `(() => {
    const want = ${JSON.stringify(want)}.toLowerCase();
    const sel = ${JSON.stringify("query" in aim ? aim.query : "")};
    let el = null;
    try { if (sel) el = document.querySelector(sel); } catch {}
    if (!el) el = [...document.querySelectorAll('select')].find(s =>
      (s.getAttribute('aria-label') || s.name || '').toLowerCase().includes(want) || true
    );
    if (!el || el.tagName !== 'SELECT') return { ok: false, reason: 'no <select>' };
    const opt = [...el.options].find(o =>
      o.value.toLowerCase() === want || o.text.toLowerCase().includes(want)
    );
    if (!opt) return { ok: false, reason: 'no matching option' };
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, label: opt.text, value: opt.value };
  })()`;
  const res = await evaluate(s, js);
  if (!res?.ok) {
    // Comboboxes are not <select> — click the ref then click the option by text.
    await click({ ref: input.ref, query: input.query ?? input.label, tab: input.tab });
    return click({ query: want, tab: input.tab });
  }
  return afterAction(s, `Selected ${res.label}`);
}

/**
 * "On the page" and "clickable" are different facts: a button can exist,
 * be visible, and still sit under a cookie banner. Interactable means
 * present, sized, enabled, and topmost at its own centre.
 */
const INTERACTABLE_JS = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
  const top = document.elementFromPoint(
    Math.min(Math.max(r.x + r.width / 2, 0), innerWidth - 1),
    Math.min(Math.max(r.y + r.height / 2, 0), innerHeight - 1),
  );
  return !!top && (el === top || el.contains(top) || top.contains(el));
})()`;

export async function waitFor(input: {
  text?: string;
  selector?: string;
  interactable?: string;
  url?: string;
  title?: string;
  ms?: number;
  timeoutMs?: number;
  tab?: number;
}): Promise<string> {
  const target = await activeTarget(input.tab);
  const s = await sessionFor(target);
  if (typeof input.ms === "number" && input.ms > 0) {
    await sleep(Math.min(Math.max(input.ms, 0), 30000));
    return afterAction(s, `Waited ${Math.min(input.ms, 30000)}ms`);
  }
  const timeout = Math.min(input.timeoutMs ?? 15000, 30000);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const meta = await pageMeta(s);
    if (input.url && meta.url.includes(input.url)) {
      return afterAction(s, `URL matched ${input.url}`);
    }
    if (input.title && meta.title.toLowerCase().includes(input.title.toLowerCase())) {
      return afterAction(s, `Title matched ${JSON.stringify(input.title)} (${meta.title})`);
    }
    if (input.selector) {
      const found = await evaluate(s, `Boolean(document.querySelector(${JSON.stringify(input.selector)}))`);
      if (found) return afterAction(s, `Selector ${input.selector} is on the page`);
    }
    if (input.interactable) {
      const ok = await evaluate(s, INTERACTABLE_JS(input.interactable));
      if (ok) return afterAction(s, `${input.interactable} is interactable — visible, enabled, and on top`);
    }
    if (input.text) {
      const found = await evaluate(
        s,
        `document.body?.innerText?.toLowerCase().includes(${JSON.stringify(input.text.toLowerCase())})`,
      );
      if (found) return afterAction(s, `Text matched ${JSON.stringify(input.text)}`);
    }
    if (!input.url && !input.selector && !input.text && !input.interactable && !input.title) {
      await settle(s, 200, timeout);
      return afterAction(s, "Page settled");
    }
    await sleep(250);
  }
  const what = input.text ?? input.selector ?? input.interactable ?? input.title ?? input.url ?? "settle";
  const hint = input.interactable
    ? " It exists but stayed covered or disabled — browser_dismiss may clear what is on top of it."
    : "";
  return `Timed out after ${timeout}ms waiting for ${what}.${hint}`;
}

// ---------------------------------------------------------------------------
// Overlay dismissal — cookie banners, consent walls, newsletter pop-ups
// ---------------------------------------------------------------------------

/**
 * Heuristic, deliberately conservative: only elements that look like overlays
 * (fixed/sticky or role=dialog, covering a real fraction of the viewport), and
 * only controls whose label plainly says what they do. Privacy first: a
 * reject/necessary-only control beats an accept when both are present.
 */
const DISMISS_JS = `(() => {
  const PREFER = [
    /\\b(reject|decline|refuse|deny)\\b|necessary only|only necessary|essential only|use necessary/i,
    /no thanks|not now|maybe later|remind me later|skip/i,
    /^(close|dismiss|got it|ok|okay|understood|i understand|continue)$|\\u00d7|\\u2715|\\u2716/i,
  ];
  const vw = innerWidth, vh = innerHeight;
  const overlays = [];
  for (const el of document.querySelectorAll('div,section,aside,dialog,[role=dialog],[aria-modal="true"]')) {
    const st = getComputedStyle(el);
    const dialogish = el.tagName === 'DIALOG' || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
    if (!dialogish && st.position !== 'fixed' && st.position !== 'sticky') continue;
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.width * r.height < vw * vh * 0.04) continue;
    overlays.push(el);
  }
  for (const group of PREFER) {
    for (const ov of overlays) {
      for (const b of ov.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')) {
        const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
        if (!t || t.length > 42 || !group.test(t)) continue;
        const r = b.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, label: t.slice(0, 60) };
      }
    }
  }
  return { ok: false, count: overlays.length };
})()`;

export async function dismissOverlays(index?: number): Promise<string> {
  const target = await activeTarget(index);
  const s = await sessionFor(target);
  const res = await evaluate(s, DISMISS_JS);
  if (!res?.ok) {
    return res?.count
      ? `Found ${res.count} overlay-like element(s) but no dismiss control whose label I trust. ` +
        `Nothing was clicked — snapshot the page and aim by ref instead.`
      : "No blocking overlay found — the page is already clear.";
  }
  await mouseClick(s, res.x, res.y);
  return afterAction(s, `Dismissed overlay via "${res.label}" (privacy first: reject beats accept when both exist)`);
}

export async function screenshotPage(index?: number): Promise<{ data: string; meta: string }> {
  const target = await activeTarget(index);
  const s = await sessionFor(target);
  const shot = await s.call("Page.captureScreenshot", { format: "png", fromSurface: true });
  const data = String(shot?.data ?? "");
  const meta = await pageMeta(s);
  const kb = Math.round((data.length * 3) / 4 / 1024);
  return { data, meta: `Page screenshot of ${meta.title} — ${meta.url} (${kb}KB)` };
}

// ---------------------------------------------------------------------------
// Email — Gmail through the signed-in Chrome profile, not the Gmail API.
// Search operators and hash URLs are the stable surface. Keyboard shortcuts
// (c, r, e, Shift+i, Ctrl+Enter) beat clicking obfuscated buttons.
// ---------------------------------------------------------------------------

async function dispatchChord(s: CdpSession, spec: GmailKeySpec): Promise<void> {
  const mod = spec.modifiers ?? 0;
  if (mod & 2) {
    await s.call("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2,
    });
  }
  if (mod & 4) {
    await s.call("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: 4,
    });
  }
  if (mod & 8) {
    await s.call("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8,
    });
  }
  await s.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    modifiers: mod,
  });
  await s.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    modifiers: mod,
  });
  if (mod & 8) {
    await s.call("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16,
    });
  }
  if (mod & 4) {
    await s.call("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91,
    });
  }
  if (mod & 2) {
    await s.call("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17,
    });
  }
}

async function gmailTab(): Promise<{ ok: true; s: CdpSession } | { ok: false; message: string }> {
  const boot = await ensureBrowser();
  if (!boot.ok) return { ok: false, message: boot.message };

  const inbox = "https://mail.google.com/mail/u/0/#inbox";
  let tabs: Target[] = [];
  try {
    tabs = await listTargets();
  } catch (err: any) {
    return {
      ok: false,
      message: formatGmailOpenFailure({
        profileDir: PROFILE_DIR,
        tabs: [],
        extra: `Could not list Chrome tabs: ${err?.message ?? err}. Is the debug port ${PORT} the Cunning Claw Chrome?`,
      }),
    };
  }

  let target: Target | undefined =
    tabs.find((t) => isGmailMailboxUrl(t.url)) ||
    tabs.find((t) => isGmailRelatedUrl(t.url));

  if (!target) {
    const created = await openNewTab(inbox);
    target = (created
      ? await waitForTarget((t) => t.id === created.id || isGmailRelatedUrl(t.url))
      : await waitForTarget((t) => isGmailRelatedUrl(t.url))) ?? undefined;
  }

  if (!target && tabs[0]) {
    try {
      const s = await sessionFor(tabs[0]);
      await s.call("Page.navigate", { url: inbox });
      target = await waitForTarget(
        (t) => t.id === tabs[0].id || isGmailRelatedUrl(t.url),
        8000,
      ) ?? tabs[0];
    } catch (err: any) {
      return {
        ok: false,
        message: formatGmailOpenFailure({
          profileDir: PROFILE_DIR,
          tabs,
          extra: `Tried to navigate an existing tab to Gmail and failed: ${err?.message ?? err}`,
        }),
      };
    }
  }

  if (!target) {
    let listed: Target[] = tabs;
    try { listed = await listTargets(); } catch { /* keep */ }
    return {
      ok: false,
      message: formatGmailOpenFailure({ profileDir: PROFILE_DIR, tabs: listed }),
    };
  }

  const s = await sessionFor(target);
  if (!isGmailMailboxUrl(target.url) && !isGoogleAuthUrl(target.url)) {
    try {
      await s.call("Page.navigate", { url: inbox });
      await settle(s, 400, 10000);
    } catch {
      /* scrapeList will still see a sign-in page */
    }
  }
  return { ok: true, s };
}

function signInMessage(): string {
  return [
    "Gmail is asking for sign-in in Cunning Claw's own Chrome — a separate window from your everyday browser.",
    `Profile: ${PROFILE_DIR}`,
    "Finish signing in once in that window (I never see or handle the password), then ask me again.",
    "Signing into the Chrome you already use for the rest of the day does not sign this one in.",
  ].join(" ");
}

async function scrapeList(s: CdpSession): Promise<GmailList> {
  let data: GmailList | null = null;
  for (let i = 0; i < 14; i++) {
    data = (await evaluate(s, GMAIL_LIST_JS)) as GmailList;
    if (data?.signin) return data;
    if (data?.ready) return data;
    if (data?.threadOpen && i < 2) {
      await dispatchChord(s, GMAIL_ACTION_KEYS.back);
      await sleep(700);
      continue;
    }
    await sleep(500);
  }
  return data ?? { ready: false, url: "", unreadFromTitle: null, tabs: [], messages: [] };
}

async function waitForCompose(s: CdpSession, tries = 10): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const st = await evaluate(s, GMAIL_COMPOSE_OPEN_JS) as { composeOpen?: boolean };
    if (st?.composeOpen) return true;
    await sleep(250);
  }
  return false;
}

export async function checkEmail(query?: string, view?: string): Promise<string> {
  const tab = await gmailTab();
  if (!tab.ok) return tab.message;
  const s = tab.s;
  const expanded = expandGmailQuery(query);
  const parsedView: GmailView = parseGmailView(view);
  const url = gmailListUrl(query, parsedView);
  await s.call("Page.navigate", { url });
  await settle(s, 500, 12000);

  const data = await scrapeList(s);
  if (data.signin || /accounts\.google\.com|signin/.test(data.url)) return signInMessage();
  if (!data.ready) {
    return "Gmail did not finish loading its message list. It may still be rendering — try again in a moment. If keyboard shortcuts are off, I also cannot fall back to a list that isn't there.";
  }

  const heading = expanded
    ? `Gmail search "${expanded}" — ${data.messages.length} conversations`
    : `Gmail ${parsedView} — ${data.messages.length} conversations`;
  let text = formatGmailList(data, heading);

  if (shouldSweepUnread(data, query, view)) {
    await s.call("Page.navigate", { url: gmailListUrl("is:unread") });
    await settle(s, 500, 10000);
    const unread = await scrapeList(s);
    if (unread.ready) {
      text +=
        "\n\n--- Hidden unread (is:unread — title/tabs showed more than Primary) ---\n" +
        formatGmailList(unread, `Gmail search "is:unread" — ${unread.messages.length} conversations`);
    }
  }

  return fenceUntrusted("mail.google.com", text);
}

export async function readEmail(index: number): Promise<string> {
  const tab = await gmailTab();
  if (!tab.ok) return tab.message;
  const s = tab.s;
  const opened = await evaluate(s, `(() => {
    const main = document.querySelector('div[role="main"]') || document.body;
    let rows = [...main.querySelectorAll("tr.zA")];
    if (!rows.length) {
      rows = [...main.querySelectorAll('div[role="listitem"]')].filter((el) =>
        el.querySelector('[email], span[name], .yX, .bA4, .bog')
      );
    }
    const row = rows[${Number(index)}];
    if (!row) return { ok: false, count: rows.length };
    row.click();
    return { ok: true, count: rows.length };
  })()`) as { ok: boolean; count: number };
  if (!opened?.ok) {
    return `No message at index ${index}. Currently ${opened?.count ?? 0} visible rows. check_email first, then use that numbering (it starts at 0).`;
  }
  await settle(s, 400, 8000);
  await dispatchChord(s, GMAIL_ACTION_KEYS.expand);
  await sleep(350);
  const thread = (await evaluate(s, GMAIL_THREAD_JS)) as GmailThread;
  return fenceUntrusted("mail.google.com", formatGmailThread(thread));
}

export async function peekCompose(): Promise<{ open: boolean; to: string; subject: string; body: string }> {
  const tab = await gmailTab();
  if (!tab.ok) return { open: false, to: "", subject: "", body: "" };
  const draft = await evaluate(tab.s, GMAIL_DRAFT_JS) as {
    open?: boolean; to?: string; subject?: string; body?: string;
  };
  return {
    open: Boolean(draft?.open),
    to: String(draft?.to ?? ""),
    subject: String(draft?.subject ?? ""),
    body: String(draft?.body ?? ""),
  };
}

async function insertInto(s: CdpSession, field: "to" | "subject" | "body", text: string, replace = false): Promise<boolean> {
  const focused = await evaluate(s, gmailFocusScript(field));
  if (!focused) return false;
  await sleep(80);
  if (replace) {
    const modifiers = process.platform === "darwin" ? 4 : 2;
    await dispatchChord(s, { key: "a", code: "KeyA", vk: 65, modifiers });
    await sleep(40);
  }
  await s.call("Input.insertText", { text });
  return true;
}

export async function draftEmail(input: {
  to?: string;
  subject?: string;
  body: string;
  reply?: boolean;
  replyAll?: boolean;
}): Promise<string> {
  const tab = await gmailTab();
  if (!tab.ok) return tab.message;
  const s = tab.s;

  if (input.reply || input.replyAll) {
    await dispatchChord(s, input.replyAll ? GMAIL_REPLY_ALL_KEY : GMAIL_REPLY_KEY);
  } else {
    await dispatchChord(s, GMAIL_COMPOSE_KEY);
  }

  let open = await waitForCompose(s);
  if (!open && !input.reply && !input.replyAll) {
    const clicked = await evaluate(s, GMAIL_CLICK_COMPOSE_JS);
    if (clicked) open = await waitForCompose(s);
  }
  if (!open) {
    return (
      "Could not open Gmail compose. Turn on keyboard shortcuts: " +
      "Settings → See all settings → General → Keyboard shortcuts → On, then reload. " +
      "Or the compose button was not on this view — check_email first."
    );
  }

  if (!input.reply && !input.replyAll && input.to) {
    const ok = await insertInto(s, "to", input.to, true);
    if (!ok) return "Compose opened but the To field was not there. Try again, or type it with browser_type.";
    await dispatchChord(s, { key: "Tab", code: "Tab", vk: 9 });
    await sleep(150);
  }
  if (!input.reply && !input.replyAll && input.subject) {
    await insertInto(s, "subject", input.subject, true);
    await dispatchChord(s, { key: "Tab", code: "Tab", vk: 9 });
    await sleep(80);
  }
  const bodyOk = await insertInto(s, "body", input.body, !(input.reply || input.replyAll));
  if (!bodyOk) {
    return "Compose opened but the message body was not focused. The draft may be empty — look at the window before sending.";
  }

  const preview = await evaluate(s, GMAIL_DRAFT_JS) as { to?: string; subject?: string; body?: string };
  return [
    "Draft is in the Gmail compose window. NOT sent.",
    `To: ${preview?.to || input.to || "(reply — existing recipients)"}`,
    `Subject: ${preview?.subject || input.subject || "(reply — existing subject)"}`,
    "",
    (preview?.body || input.body).slice(0, 2000),
    "",
    "Call send_email only after the operator has seen this and said to send it.",
  ].join("\n");
}

export async function sendEmail(): Promise<string> {
  const tab = await gmailTab();
  if (!tab.ok) return tab.message;
  const s = tab.s;
  const before = await evaluate(s, GMAIL_COMPOSE_OPEN_JS) as { composeOpen?: boolean };
  if (!before?.composeOpen) {
    return "No compose window is open. draft_email first, then send_email after the operator approves.";
  }
  const modifiers = process.platform === "darwin" ? 4 : 2;
  await dispatchChord(s, { key: "Enter", code: "Enter", vk: 13, modifiers });
  await sleep(700);
  let still = await evaluate(s, GMAIL_COMPOSE_OPEN_JS) as { composeOpen?: boolean };
  if (still?.composeOpen) {
    const clicked = await evaluate(s, GMAIL_CLICK_SEND_JS);
    if (clicked) await sleep(700);
    still = await evaluate(s, GMAIL_COMPOSE_OPEN_JS) as { composeOpen?: boolean };
  }
  if (still?.composeOpen) {
    return "Tried to send (Ctrl+Enter, then the Send button) but compose is still open. It may need a To address, or Gmail blocked it. Look at the window.";
  }
  return "Email sent. Compose window closed.";
}

export async function emailAction(action: string, index?: number): Promise<string> {
  if (!GMAIL_ACTIONS.includes(action as GmailAction)) {
    return `Unknown Gmail action "${action}". Use one of: ${GMAIL_ACTIONS.join(", ")}.`;
  }
  const tab = await gmailTab();
  if (!tab.ok) return tab.message;
  const s = tab.s;
  if (typeof index === "number") {
    const opened = await evaluate(s, `(() => {
      const main = document.querySelector('div[role="main"]') || document.body;
      let rows = [...main.querySelectorAll("tr.zA")];
      if (!rows.length) {
        rows = [...main.querySelectorAll('div[role="listitem"]')].filter((el) =>
          el.querySelector('[email], span[name], .yX, .bA4, .bog')
        );
      }
      const row = rows[${Number(index)}];
      if (!row) return { ok: false, count: rows.length };
      row.click();
      return { ok: true };
    })()`) as { ok: boolean; count?: number };
    if (!opened?.ok) {
      return `No conversation at index ${index} (${opened?.count ?? 0} visible). check_email first.`;
    }
    await settle(s, 300, 6000);
  }
  await dispatchChord(s, GMAIL_ACTION_KEYS[action as GmailAction]);
  await sleep(400);
  return `Gmail action "${action}" sent${typeof index === "number" ? ` on conversation ${index}` : ""}.`;
}

// ---------------------------------------------------------------------------
// WhatsApp Web / Business — same Chrome profile as Gmail. Reuse the tab;
// document.readyState is a lie; the title unread count is the truth.
// ---------------------------------------------------------------------------

export type CheckPageResult = { text: string; image?: string };

async function whatsappTab(): Promise<{ ok: true; s: CdpSession } | { ok: false; message: string }> {
  const boot = await ensureBrowser();
  if (!boot.ok) return { ok: false, message: boot.message };

  let tabs: Target[] = [];
  try {
    tabs = await listTargets();
  } catch (err: any) {
    return {
      ok: false,
      message: formatWhatsAppOpenFailure({
        profileDir: PROFILE_DIR,
        tabs: [],
        extra: `Could not list Chrome tabs: ${err?.message ?? err}. Is the debug port ${PORT} the Cunning Claw Chrome?`,
      }),
    };
  }

  let target: Target | undefined = tabs.find((t) => isWhatsAppUrl(t.url));
  if (!target) {
    const created = await openNewTab(WHATSAPP_URL);
    target = (created
      ? await waitForTarget((t) => t.id === created.id || isWhatsAppUrl(t.url), 10000)
      : await waitForTarget((t) => isWhatsAppUrl(t.url), 10000)) ?? undefined;
  }
  if (!target) {
    return {
      ok: false,
      message: formatWhatsAppOpenFailure({ profileDir: PROFILE_DIR, tabs }),
    };
  }
  lastTargetId = target.id;
  const s = await sessionFor(target);
  return { ok: true, s };
}

async function scrapeWhatsApp(s: CdpSession): Promise<WhatsAppState> {
  const data = (await evaluate(s, WA_STATE_JS)) as WhatsAppState | null;
  return data ?? {
    url: "",
    title: "",
    unreadFromTitle: null,
    qr: false,
    useHere: false,
    loading: true,
    ready: false,
    openChat: "",
    chats: [],
  };
}

async function waitForWhatsApp(s: CdpSession, timeoutMs = 22000): Promise<WhatsAppState> {
  const start = Date.now();
  let last: WhatsAppState | null = null;
  while (Date.now() - start < timeoutMs) {
    last = await scrapeWhatsApp(s);
    if (last.useHere) {
      const clicked = await evaluate(s, WA_USE_HERE_JS) as { ok?: boolean };
      if (clicked?.ok) await sleep(800);
      continue;
    }
    if (last.qr || last.ready) return last;
    await sleep(400);
  }
  return last ?? await scrapeWhatsApp(s);
}

async function openWhatsAppChat(s: CdpSession, opts: { index?: number; name?: string }): Promise<string | null> {
  if (typeof opts.index === "number") {
    const data = await scrapeWhatsApp(s);
    const chat = data.chats[opts.index];
    if (!chat) {
      return `No chat at index ${opts.index}. Currently ${data.chats.length} visible. check_whatsapp first (numbering starts at 0).`;
    }
    const hit = await evaluate(s, WA_CLICK_CHAT_JS(chat.name)) as { ok?: boolean; x?: number; y?: number; count?: number };
    if (!hit?.ok) return `Could not click chat [${opts.index}] ${chat.name} (${hit?.count ?? 0} rows).`;
    await mouseClick(s, hit.x ?? 0, hit.y ?? 0);
    await sleep(500);
    return null;
  }
  const name = String(opts.name ?? "").trim();
  if (!name) return "Pass index (from check_whatsapp) or name.";
  const search = await evaluate(s, WA_FOCUS_SEARCH_JS) as { ok?: boolean; x?: number; y?: number };
  if (search?.ok && search.x && search.y) {
    await mouseClick(s, search.x, search.y);
    await sleep(120);
  }
  await dispatchChord(s, { key: "a", code: "KeyA", vk: 65, modifiers: process.platform === "darwin" ? 4 : 2 });
  await sleep(40);
  await s.call("Input.insertText", { text: name });
  await sleep(900);
  const hit = await evaluate(s, WA_CLICK_CHAT_JS(name)) as { ok?: boolean; x?: number; y?: number; count?: number; label?: string };
  if (!hit?.ok) {
    return `No chat matching ${JSON.stringify(name)} (${hit?.count ?? 0} rows after search). check_whatsapp first.`;
  }
  await mouseClick(s, hit.x ?? 0, hit.y ?? 0);
  await sleep(500);
  return null;
}

export async function checkWhatsApp(query?: string): Promise<CheckPageResult> {
  const tab = await whatsappTab();
  if (!tab.ok) return { text: tab.message };
  const s = tab.s;
  let data = await waitForWhatsApp(s);
  if (data.qr) {
    const shot = await screenshotPage();
    return { text: formatWhatsAppQr(PROFILE_DIR), image: shot.data };
  }
  const q = String(query ?? "").trim();
  if (q) {
    const search = await evaluate(s, WA_FOCUS_SEARCH_JS) as { ok?: boolean; x?: number; y?: number };
    if (search?.ok && search.x && search.y) {
      await mouseClick(s, search.x, search.y);
      await sleep(120);
    }
    await dispatchChord(s, { key: "a", code: "KeyA", vk: 65, modifiers: process.platform === "darwin" ? 4 : 2 });
    await sleep(40);
    await s.call("Input.insertText", { text: q });
    await sleep(900);
    data = await scrapeWhatsApp(s);
  }
  const heading = q
    ? `WhatsApp search ${JSON.stringify(q)} — ${data.chats.length} chats`
    : `WhatsApp — ${data.chats.length} chats`;
  const text = fenceUntrusted("web.whatsapp.com", formatWhatsAppList(data, heading));
  if (!data.ready && data.loading) {
    const shot = await screenshotPage();
    return {
      text: text + "\n\nStill loading — screenshot attached. Wait, or scan the QR in Cunning Claw's Chrome if that is what you see.",
      image: shot.data,
    };
  }
  return { text };
}

export async function readChat(input: { index?: number; name?: string }): Promise<string> {
  const tab = await whatsappTab();
  if (!tab.ok) return tab.message;
  const s = tab.s;
  const err = await openWhatsAppChat(s, input);
  if (err) return err;
  await sleep(400);
  const thread = (await evaluate(s, WA_THREAD_JS)) as WhatsAppThread;
  return fenceUntrusted("web.whatsapp.com", formatWhatsAppThread(thread));
}

export async function peekChatCompose(): Promise<WhatsAppDraft> {
  const tab = await whatsappTab();
  if (!tab.ok) return { open: false, name: "", body: "" };
  const draft = (await evaluate(tab.s, WA_COMPOSE_JS)) as WhatsAppDraft & { x?: number; y?: number };
  return {
    open: Boolean(draft?.open),
    name: String(draft?.name ?? ""),
    body: String(draft?.body ?? ""),
  };
}

export async function draftChat(input: { body: string; index?: number; name?: string }): Promise<string> {
  const tab = await whatsappTab();
  if (!tab.ok) return tab.message;
  const s = tab.s;
  if (typeof input.index === "number" || String(input.name ?? "").trim()) {
    const err = await openWhatsAppChat(s, input);
    if (err) return err;
  }
  await sleep(300);
  const box = (await evaluate(s, WA_COMPOSE_JS)) as WhatsAppDraft & { x?: number; y?: number };
  if (!box?.open) {
    return "No compose box — open a chat first (read_chat or draft_chat with a name). A QR screen has no compose.";
  }
  await mouseClick(s, box.x ?? 0, box.y ?? 0);
  await sleep(80);
  await dispatchChord(s, { key: "a", code: "KeyA", vk: 65, modifiers: process.platform === "darwin" ? 4 : 2 });
  await sleep(40);
  await s.call("Input.insertText", { text: input.body });
  await sleep(200);
  const preview = (await evaluate(s, WA_COMPOSE_JS)) as WhatsAppDraft;
  return [
    "Draft is in the WhatsApp compose box. NOT sent. Enter sends — do not press it.",
    `Chat: ${preview?.name || box.name || "(open chat)"}`,
    "",
    (preview?.body || input.body).slice(0, 2000),
    "",
    "Call send_chat only after the operator has seen this and said to send it.",
  ].join("\n");
}

export async function sendChat(): Promise<string> {
  const tab = await whatsappTab();
  if (!tab.ok) return tab.message;
  const s = tab.s;
  const before = (await evaluate(s, WA_COMPOSE_JS)) as WhatsAppDraft;
  if (!before?.open) {
    return "No compose box is open. draft_chat first, then send_chat after the operator approves.";
  }
  if (!String(before.body ?? "").trim()) {
    return "Compose is empty. draft_chat first.";
  }
  const box = (await evaluate(s, WA_COMPOSE_JS)) as WhatsAppDraft & { x?: number; y?: number };
  if (box?.x && box?.y) await mouseClick(s, box.x, box.y);
  await sleep(80);
  await s.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await s.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(700);
  let still = (await evaluate(s, WA_COMPOSE_JS)) as WhatsAppDraft;
  if (still?.body && still.body.trim() === before.body.trim()) {
    const sendBtn = await evaluate(s, WA_CLICK_SEND_JS) as { ok?: boolean; x?: number; y?: number };
    if (sendBtn?.ok) {
      await mouseClick(s, sendBtn.x ?? 0, sendBtn.y ?? 0);
      await sleep(700);
      still = (await evaluate(s, WA_COMPOSE_JS)) as WhatsAppDraft;
    }
  }
  if (still?.body && still.body.trim() === before.body.trim()) {
    return "Tried to send (Enter, then the send button) but the draft is still in the box. Look at the window — WhatsApp may want a tap on Send, or the chat failed to load.";
  }
  const needle = before.body.trim().slice(0, 80);
  const thread = (await evaluate(s, WA_THREAD_JS)) as WhatsAppThread;
  const seen = (thread?.messages ?? []).some(
    (m) => m.outgoing && m.text.replace(/\s+/g, " ").includes(needle.replace(/\s+/g, " ")),
  );
  if (!seen) {
    return (
      `I pressed send to ${before.name || "the open chat"} and compose is clear, ` +
      `but I cannot see your words in the thread yet. I pressed send but cannot confirm it went — ` +
      `here is what is visible:\n` +
      formatWhatsAppThread(thread ?? { ok: false, name: before.name, messages: [] })
    );
  }
  const last = [...(thread.messages ?? [])].reverse().find((m) => m.outgoing);
  return `Message sent to ${before.name || "the open chat"}. Visible in the thread${last?.time ? ` at ${last.time}` : ""}: ${needle}`;
}

