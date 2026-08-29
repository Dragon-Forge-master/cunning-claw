/**
 * WhatsApp Web / Business, as a tradesman's tool.
 *
 * Claude Code's loop on this site is: open (or reuse) the tab, wait because the
 * shell is "complete" long before the chat list exists, screenshot when the
 * accessibility tree is empty, and read the unread count from the tab title
 * — "(34) WhatsApp Business". Driving it with xdotool against a native window
 * is the fallback, not the craft.
 *
 * Obfuscated class names change. Title, #pane-side, [role=listitem] aria-labels,
 * footer contenteditable, and a QR canvas do not — those are the API.
 */

export const WHATSAPP_URL = "https://web.whatsapp.com/";

export type WhatsAppChat = {
  name: string;
  preview: string;
  time: string;
  unread: number;
  muted: boolean;
};

export type WhatsAppState = {
  url: string;
  title: string;
  unreadFromTitle: number | null;
  qr: boolean;
  useHere: boolean;
  loading: boolean;
  ready: boolean;
  openChat: string;
  chats: WhatsAppChat[];
};

export type WhatsAppMessage = {
  outgoing: boolean;
  time: string;
  text: string;
};

export type WhatsAppThread = {
  ok: boolean;
  name: string;
  messages: WhatsAppMessage[];
};

export type WhatsAppDraft = {
  open: boolean;
  name: string;
  body: string;
};

export function isWhatsAppUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "web.whatsapp.com" || host === "whatsapp.com";
  } catch {
    return /web\.whatsapp\.com/i.test(url);
  }
}

/** Same origin as an already-open tab — do not reload; WhatsApp flashes QR if you do. */
export function pageHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function shouldReuseTab(existingUrl: string, wantUrl: string): boolean {
  const a = pageHost(existingUrl);
  const b = pageHost(wantUrl);
  return Boolean(a && a === b);
}

export function parseUnreadFromTitle(title: string): number | null {
  const m = String(title ?? "").trim().match(/^\((\d+)\)/);
  return m ? Number(m[1]) : null;
}

export function formatWhatsAppQr(profileDir: string): string {
  return [
    "WhatsApp Web is showing a QR code in Cunning Claw's Chrome — not your everyday browser.",
    `Profile: ${profileDir}`,
    "",
    "Open that Chrome window (the one that is not your usual one), scan the code with the phone that runs WhatsApp Business, then ask me again. Signing into WhatsApp in everyday Chrome does nothing here.",
  ].join("\n");
}

export function formatWhatsAppOpenFailure(opts: {
  profileDir: string;
  tabs: Array<{ title: string; url: string }>;
  extra?: string;
}): string {
  const tabs = opts.tabs.length
    ? opts.tabs.map((t, i) => `  [${i}] ${t.title || "(no title)"} — ${t.url}`).join("\n")
    : "  (no page tabs — Chrome's debug port is up but empty)";
  return [
    "Could not open WhatsApp Web in Cunning Claw's Chrome.",
    `Profile: ${opts.profileDir}`,
    "",
    "That is a separate window from your everyday Chrome. The session that scanned the QR lives there. Tabs I can currently see:",
    tabs,
    opts.extra ? "\n" + opts.extra : "",
  ].filter((l) => l !== "").join("\n");
}

export function formatWhatsAppList(data: WhatsAppState, heading: string): string {
  const titleUnread =
    data.unreadFromTitle != null ? `TITLE_UNREAD: ${data.unreadFromTitle}` : "TITLE_UNREAD: (none — title has no count)";
  const listedUnread = data.chats.reduce((n, c) => n + (c.unread > 0 ? 1 : 0), 0);
  const mismatch =
    data.unreadFromTitle != null && data.unreadFromTitle > 0 && listedUnread === 0
      ? `TITLE says ${data.unreadFromTitle} unread but this list shows none — scroll the left pane or search; muted chats hide badges.`
      : "";
  const open = data.openChat ? `OPEN: ${data.openChat}` : "OPEN: (chat list)";
  const lines = data.chats.map((c, i) => {
    const flags = [
      c.unread ? `${c.unread} UNREAD` : "",
      c.muted ? "MUTED" : "",
    ].filter(Boolean).join(" ");
    return `[${i}]${flags ? " " + flags : ""} ${c.time} — ${c.name}\n    ${c.preview}`;
  });
  return [
    heading,
    `TITLE: ${data.title}`,
    titleUnread,
    open,
    mismatch,
    `${data.chats.length} chats on this view.`,
    "",
    lines.join("\n") || "(no chats visible — still loading, or search returned nothing)",
  ].filter((l) => l !== "").join("\n");
}

export function formatWhatsAppThread(data: WhatsAppThread): string {
  if (!data.ok) return "Could not read the open chat. check_whatsapp first, then read_chat with that index or name.";
  const parts = data.messages.map((m, i) => {
    const who = m.outgoing ? "YOU" : data.name || "THEM";
    return `--- ${i} ${who}${m.time ? " · " + m.time : ""} ---\n${m.text}`;
  });
  return `CHAT: ${data.name}\n${data.messages.length} message(s) visible\n\n${parts.join("\n\n") || "(no text messages in view — scroll up)"}`;
}

/**
 * Page script: QR vs list vs "use here", title unread count, chat rows from
 * aria-labels. No TypeScript — this string runs in Chrome.
 */
export const WA_STATE_JS = `(() => {
  const url = location.href;
  const title = document.title || "";
  const unreadFromTitle = (() => {
    const m = title.match(/^\\((\\d+)\\)/);
    return m ? Number(m[1]) : null;
  })();
  const body = (document.body && document.body.innerText || "").slice(0, 4000);
  const canvas = document.querySelector("canvas");
  const qr = Boolean(
    document.querySelector('[data-testid="qrcode"], [data-ref] canvas, canvas[aria-label*="QR" i]')
    || (canvas && /scan this qr|log in to whatsapp|link with phone number|open whatsapp on your phone/i.test(body))
  );
  const useHere = [...document.querySelectorAll("button, div[role='button'], span")].some((el) =>
    /^(use here|continue here)$/i.test((el.innerText || "").trim())
  );
  const pane = document.getElementById("pane-side")
    || document.querySelector('[data-testid="chat-list"], [aria-label*="Chat list" i]')
    || document.querySelector('#app');
  const items = pane
    ? [...pane.querySelectorAll('[role="listitem"], [role="row"]')]
    : [];
  const chats = [];
  for (const el of items) {
    const aria = (el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
    const raw = aria || (el.innerText || "").replace(/\\s+/g, " ").trim();
    if (!raw || raw.length < 2) continue;
    if (/search or start new chat|search input textbox|^search$/i.test(raw) && raw.length < 48) continue;
    const unreadM = raw.match(/(\\d+)\\s*unread/i);
    const unread = unreadM ? Number(unreadM[1]) : /\\bunread\\b/i.test(raw) ? 1 : 0;
    const muted = /\\bmuted\\b/i.test(raw);
    const timeM = raw.match(/\\b(\\d{1,2}:\\d{2}\\s*(?:am|pm)?|yesterday|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})\\b/i);
    const time = timeM ? timeM[1] : "";
    let name = raw.split(/,/)[0].replace(/\\(\\d+\\)\\s*$/, "").trim();
    name = name.replace(/\\s+\\d+\\s*unread.*$/i, "").trim().slice(0, 80);
    if (!name) continue;
    const preview = raw.slice(0, 180);
    chats.push({ name, preview, time, unread, muted });
    if (chats.length >= 40) break;
  }
  const header = document.querySelector("#main header");
  let openChat = "";
  if (header) {
    const titled = header.querySelector("[title]");
    const span = header.querySelector("span[dir], span[title]");
    openChat = (
      (titled && titled.getAttribute("title"))
      || (span && (span.getAttribute("title") || span.textContent))
      || ""
    ).trim().split("\\n")[0];
  }
  const ready = chats.length > 0 || Boolean(openChat);
  const loading = !qr && !useHere && !ready;
  return {
    url, title, unreadFromTitle, qr, useHere, loading, ready,
    openChat: (openChat || "").slice(0, 80),
    chats,
  };
})()`;

export const WA_USE_HERE_JS = `(() => {
  const btn = [...document.querySelectorAll("button, div[role='button']")].find((el) =>
    /use here|continue here/i.test((el.innerText || el.getAttribute("aria-label") || "").trim())
  );
  if (!btn) return { ok: false };
  btn.click();
  return { ok: true, label: (btn.innerText || "").trim().slice(0, 40) };
})()`;

export const WA_FOCUS_SEARCH_JS = `(() => {
  const side = document.getElementById("pane-side") || document.querySelector("#side") || document.body;
  const box = side.querySelector('[contenteditable="true"]')
    || document.querySelector('[data-testid="chat-list-search"] [contenteditable="true"]')
    || document.querySelector('[title="Search input textbox"]')
    || document.querySelector('[aria-label*="Search" i][contenteditable="true"]');
  if (!box) return { ok: false };
  box.focus();
  const r = box.getBoundingClientRect();
  return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

export const WA_CLICK_CHAT_JS = (want: string) => `(() => {
  const want = ${JSON.stringify(want)}.toLowerCase();
  const pane = document.getElementById("pane-side")
    || document.querySelector('[data-testid="chat-list"]')
    || document.body;
  const items = [...pane.querySelectorAll('[role="listitem"], [role="row"]')];
  const el = items.find((e) => {
    const t = (e.getAttribute("aria-label") || e.innerText || "").toLowerCase();
    return t.includes(want);
  });
  if (!el) return { ok: false, count: items.length };
  const r = el.getBoundingClientRect();
  el.scrollIntoView({ block: "center" });
  return {
    ok: true,
    count: items.length,
    x: r.x + r.width / 2,
    y: r.y + Math.min(r.height / 2, 28),
    label: (el.getAttribute("aria-label") || el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 80),
  };
})()`;

export const WA_THREAD_JS = `(() => {
  const main = document.getElementById("main") || document.querySelector('[data-testid="conversation-panel-wrapper"]');
  if (!main) return { ok: false, name: "", messages: [] };
  const header = main.querySelector("header");
  let name = "";
  if (header) {
    const titled = header.querySelector("[title]");
    name = ((titled && titled.getAttribute("title"))
      || (header.querySelector("span[dir]") && header.querySelector("span[dir]").textContent)
      || "").trim().split("\\n")[0];
  }
  const nodes = [...main.querySelectorAll('[data-testid="msg-container"], .message-in, .message-out')];
  const messages = [];
  for (const n of nodes) {
    const cls = String(n.className || "");
    const pre = n.querySelector(".copyable-text");
    const attr = (pre && pre.getAttribute("data-pre-plain-text")) || "";
    const textEl = n.querySelector("span.selectable-text, .copyable-text span, .copyable-text");
    const text = ((textEl && textEl.innerText) || "").replace(/\\s+/g, " ").trim();
    if (!text) continue;
    if (/^(today|yesterday|\\d{1,2} \\w+ \\d{4})$/i.test(text) && text.length < 24) continue;
    const timeM = attr.match(/\\[([^\\]]+)\\]/);
    const ticks = Boolean(n.querySelector('[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-time"]'));
    const outgoing = /message-out/.test(cls) || /\\] You:/i.test(attr) || ticks;
    messages.push({
      outgoing,
      time: timeM ? timeM[1] : "",
      text: text.slice(0, 1500),
    });
    if (messages.length >= 40) break;
  }
  return { ok: true, name: (name || "").slice(0, 80), messages };
})()`;

export const WA_COMPOSE_JS = `(() => {
  const footer = document.querySelector("footer") || document.querySelector('#main footer');
  const box = (footer && footer.querySelector('[contenteditable="true"]'))
    || document.querySelector('[data-testid="conversation-compose-box-input"]')
    || document.querySelector('#main [contenteditable="true"][data-tab]')
    || document.querySelector('[aria-label*="Type a message" i][contenteditable="true"]')
    || document.querySelector('[aria-placeholder*="Type a message" i]');
  if (!box) return { open: false, name: "", body: "", x: 0, y: 0 };
  const header = document.querySelector("#main header");
  let name = "";
  if (header) {
    const titled = header.querySelector("[title]");
    name = ((titled && titled.getAttribute("title"))
      || (header.querySelector("span[dir]") && header.querySelector("span[dir]").textContent)
      || "").trim().split("\\n")[0];
  }
  const r = box.getBoundingClientRect();
  return {
    open: true,
    name: (name || "").slice(0, 80),
    body: (box.innerText || "").replace(/\\u00a0/g, " ").trim(),
    x: r.x + Math.min(r.width / 2, 40),
    y: r.y + r.height / 2,
  };
})()`;

export const WA_CLICK_SEND_JS = `(() => {
  const btn = document.querySelector('[data-testid="send"], [data-icon="send"]')
    || [...document.querySelectorAll("button, span[role='button'], div[role='button']")].find((el) =>
      /^(send)$/i.test((el.getAttribute("aria-label") || el.innerText || "").trim())
    );
  if (!btn) return { ok: false };
  const host = btn.closest("button, [role='button']") || btn;
  const r = host.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { ok: false };
  return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;
