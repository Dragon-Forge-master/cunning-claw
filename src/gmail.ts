/**
 * Gmail, as a tradesman's tool.
 *
 * Two reasons agents "miss a load" of mail:
 *  1. They scrape only the visible Primary tab. Promotions / Updates / Social
 *     hold the rest, and Gmail's title `(12)` counts them all.
 *  2. They trust obfuscated class names (`tr.zA`, `.a3s`) as the only DOM, and
 *     they never expand a collapsed conversation, so a thread looks like one
 *     short message.
 *
 * Search operators and hash URLs are the stable API. The DOM is a fallback
 * with several selectors. Keyboard shortcuts (c, r, e, Ctrl+Enter) beat
 * clicking obfuscated buttons — when they are turned on.
 */

export type GmailView = "inbox" | "sent" | "drafts" | "starred" | "snoozed" | "spam" | "all" | "important";

export type GmailTab = { label: string; selected: boolean };

export type GmailRow = {
  unread: boolean;
  starred: boolean;
  attached: boolean;
  sender: string;
  subject: string;
  snippet: string;
  date: string;
};

export type GmailList = {
  ready: boolean;
  signin?: boolean;
  threadOpen?: boolean;
  url: string;
  unreadFromTitle: number | null;
  tabs: GmailTab[];
  messages: GmailRow[];
};

export type GmailMessage = {
  from: string;
  fromName: string;
  date: string;
  text: string;
};

export type GmailThread = {
  ok: boolean;
  subj: string;
  messages: GmailMessage[];
};

const VIEWS: Record<GmailView, string> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  starred: "starred",
  snoozed: "snoozed",
  spam: "spam",
  all: "all",
  important: "imp",
};

/** Phrases operators actually say, mapped onto Gmail's search language. */
const PHRASES: Record<string, string> = {
  unread: "is:unread",
  "unread mail": "is:unread",
  "new mail": "is:unread",
  starred: "is:starred",
  important: "is:important",
  today: "newer_than:1d",
  "today's": "newer_than:1d",
  "this morning": "newer_than:1d",
  latest: "newer_than:1d",
  yesterday: "newer_than:2d older_than:1d",
  "this week": "newer_than:7d",
  "this month": "newer_than:30d",
  attachments: "has:attachment",
  "with attachments": "has:attachment",
  sent: "in:sent",
  drafts: "in:drafts",
  spam: "in:spam",
  anywhere: "in:anywhere",
  promotions: "category:promotions",
  newsletters: "category:promotions",
  updates: "category:updates",
  social: "category:social",
  primary: "category:primary",
  forums: "category:forums",
  purchases: "category:purchases",
  receipts: "category:purchases",
  reservations: "category:reservations",
};

const OPERATOR_LEAD =
  /^(from|to|cc|bcc|subject|is|in|label|has|filename|category|newer_than|older_than|after|before|list|deliveredto|size|larger|smaller):/i;

/**
 * Turn a spoken query into Gmail search operators when it is a known phrase.
 * Leave anything that already looks like an operator, or a free-text hunt, alone.
 * "unread from dave" becomes "is:unread from dave" — leading phrase, rest kept.
 */
export function expandGmailQuery(raw?: string): string {
  const q = (raw ?? "").trim();
  if (!q) return "";
  if (OPERATOR_LEAD.test(q)) return q;
  const lower = q.toLowerCase();
  if (PHRASES[lower]) return PHRASES[lower];
  const phrases = Object.keys(PHRASES).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    if (lower.startsWith(phrase + " ")) {
      return PHRASES[phrase] + q.slice(phrase.length);
    }
  }
  return q;
}

export function parseGmailView(raw?: string): GmailView {
  const v = (raw ?? "inbox").trim().toLowerCase();
  return (v in VIEWS ? v : "inbox") as GmailView;
}

export function gmailListUrl(query?: string, view: GmailView = "inbox"): string {
  const q = expandGmailQuery(query);
  if (q) return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}`;
  return `https://mail.google.com/mail/u/0/#${VIEWS[parseGmailView(view)] ?? "inbox"}`;
}

function hostPath(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, "").toLowerCase(), path: u.pathname.toLowerCase() };
  } catch {
    return null;
  }
}

/** A tab that is actually Gmail, not a Google marketing page. */
export function isGmailMailboxUrl(url: string): boolean {
  const p = hostPath(url);
  if (!p) return /mail\.google\.com/i.test(url);
  return p.host === "mail.google.com" || p.host === "gmail.com" || p.host === "inbox.google.com";
}

/** Sign-in / account picker — the usual landing after opening Gmail in a fresh profile. */
export function isGoogleAuthUrl(url: string): boolean {
  const p = hostPath(url);
  if (!p) return /accounts\.google\.com/i.test(url);
  if (p.host === "accounts.google.com") return true;
  if (p.host.endsWith(".google.com") && /signin|accountchooser|servicelogin/i.test(p.path + url)) return true;
  return false;
}

export function isGmailRelatedUrl(url: string): boolean {
  return isGmailMailboxUrl(url) || isGoogleAuthUrl(url) || /google\.com\/gmail/i.test(url);
}

export function formatGmailOpenFailure(opts: {
  profileDir: string;
  tabs: Array<{ title: string; url: string }>;
  extra?: string;
}): string {
  const tabs = opts.tabs.length
    ? opts.tabs.map((t, i) => `  [${i}] ${t.title || "(no title)"} — ${t.url}`).join("\n")
    : "  (no page tabs — Chrome's debug port is up but empty)";
  return [
    "Could not open Gmail in Cunning Claw's Chrome.",
    `Profile: ${opts.profileDir}`,
    "",
    "That is a separate window from your everyday Chrome. Signing into the everyday browser does not sign this one in. Look for a Chrome window that is not your usual one, finish Google sign-in there once, then ask me again.",
    "",
    "Tabs I can currently see:",
    tabs,
    opts.extra ? "\n" + opts.extra : "",
  ].filter((l) => l !== "").join("\n");
}

/**
 * Primary is not the inbox. Gmail's title `(12)` counts Promotions / Updates /
 * Social too. If that number is bigger than the rows on this view, or another
 * tab is advertising unread, a second pass with is:unread is required.
 */
export function shouldSweepUnread(data: GmailList, query?: string, view?: string): boolean {
  if ((query ?? "").trim()) return false;
  if (view && parseGmailView(view) !== "inbox") return false;
  const listed = data.messages.filter((m) => m.unread).length;
  if (data.unreadFromTitle != null && data.unreadFromTitle > listed) return true;
  return data.tabs.some((t) => !t.selected && /\d+\s*unread/i.test(t.label));
}

export function formatGmailList(data: GmailList, heading: string): string {
  const tabs = data.tabs.length
    ? "TABS: " + data.tabs.map((t) => `${t.selected ? "*" : ""}${t.label}`).join(" · ")
    : "";
  const titleUnread = data.unreadFromTitle != null ? `TITLE_UNREAD: ${data.unreadFromTitle}` : "";
  const listedUnread = data.messages.filter((m) => m.unread).length;
  const mismatch =
    data.unreadFromTitle != null && data.unreadFromTitle > listedUnread
      ? `NOTE: Gmail's title says ${data.unreadFromTitle} unread, this list shows ${listedUnread}. The rest are probably in Promotions / Updates / Social — search is:unread or those category: tabs.`
      : "";
  const lines = data.messages.map((m, i) => {
    const flags = [
      m.unread ? "UNREAD" : "",
      m.starred ? "STAR" : "",
      m.attached ? "FILE" : "",
    ].filter(Boolean).join(" ");
    return `[${i}]${flags ? " " + flags : ""} ${m.date} — ${m.sender}\n    ${m.subject}\n    ${m.snippet}`;
  });
  return [
    heading,
    titleUnread,
    tabs,
    mismatch,
    `${data.messages.length} conversations on this view.`,
    "",
    lines.join("\n") || "(no conversations in this view)",
  ].filter((l) => l !== "").join("\n");
}

export function formatGmailThread(data: GmailThread): string {
  if (!data.ok) return "Could not read the open conversation.";
  const parts = data.messages.map((m, i) => {
    const who = [m.fromName, m.from].filter(Boolean).join(" ");
    return `--- message ${i} ---\nFROM: ${who}\nDATE: ${m.date}\n\n${m.text}`;
  });
  return `SUBJECT: ${data.subj}\n${data.messages.length} message(s) in thread\n\n${parts.join("\n\n")}`;
}

/**
 * Page script: scrape the conversation list with more than one DOM shape, plus
 * category tabs and the unread count Gmail puts in the document title.
 */
export const GMAIL_LIST_JS = `(() => {
  const url = location.href;
  if (/accounts\\.google\\.com|ServiceLogin|signin\\/v2/.test(url) && !/mail\\.google\\.com/.test(url)) {
    return { ready: false, signin: true, url, unreadFromTitle: null, tabs: [], messages: [] };
  }
  const title = document.title || "";
  const unreadFromTitle = (() => {
    const m = title.match(/^\\((\\d+)\\)/);
    return m ? Number(m[1]) : null;
  })();
  const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => {
    const label = (t.getAttribute("aria-label") || t.textContent || "").replace(/\\s+/g, " ").trim();
    return { label, selected: t.getAttribute("aria-selected") === "true" };
  }).filter((t) => /primary|social|promotions|updates|forums|reservations|purchases/i.test(t.label));

  const main = document.querySelector('div[role="main"]') || document.body;
  let rows = [...main.querySelectorAll("tr.zA")];
  if (!rows.length) {
    rows = [...main.querySelectorAll('div[role="listitem"]')].filter((el) =>
      el.querySelector('[email], span[name], .yX, .bA4, .bog')
    );
  }
  if (!rows.length) {
    const thread = document.querySelector("h2.hP, div.a3s, [data-message-id]");
    return { ready: false, threadOpen: Boolean(thread), url, unreadFromTitle, tabs, messages: [] };
  }

  const messages = rows.slice(0, 80).map((r) => {
    const aria = (r.getAttribute("aria-label") || "").toLowerCase();
    const unread = r.classList.contains("zE") || /\\bunread\\b/.test(aria);
    const starred = Boolean(r.querySelector('[aria-label*="Starred"], [aria-label*="starred"]'))
      || /\\bstarred\\b/.test(aria);
    const attached = Boolean(r.querySelector('[aria-label*="Attachment"], img[alt*="Attachment"], span.aZo'))
      || /\\battachment\\b/.test(aria);
    const sender = (
      r.querySelector(".yP, .zF")?.getAttribute("name")
      || r.querySelector("[email]")?.getAttribute("name")
      || r.querySelector("[email]")?.getAttribute("email")
      || r.querySelector(".yX, .bA4")?.textContent
      || ""
    ).replace(/\\s+/g, " ").trim().slice(0, 80);
    const subject = (
      r.querySelector(".bog, .y6 span")?.textContent
      || ""
    ).replace(/\\s+/g, " ").trim().slice(0, 160);
    const snippet = (
      r.querySelector(".y2")?.textContent || ""
    ).replace(/^[\\s\\-–]+/, "").replace(/\\s+/g, " ").trim().slice(0, 200);
    const date = (
      r.querySelector(".xW span, span[title]")?.getAttribute("title")
      || r.querySelector(".xW, .xY")?.textContent
      || ""
    ).replace(/\\s+/g, " ").trim();
    return { unread, starred, attached, sender, subject, snippet, date };
  });
  return { ready: true, url, unreadFromTitle, tabs, messages };
})()`;

/** Expand collapsed messages, then read every body in the open thread. */
export const GMAIL_THREAD_JS = `(() => {
  for (const el of document.querySelectorAll('.ajT, .kQ, span.ajR')) {
    try { el.click(); } catch {}
  }
  const subj = (document.querySelector("h2.hP")?.textContent || "").trim();
  let nodes = [...document.querySelectorAll("div[data-message-id]")];
  if (!nodes.length) nodes = [...document.querySelectorAll(".h7")];
  if (!nodes.length) {
    const body = document.querySelector("div.a3s");
    if (!body) return { ok: false, subj, messages: [] };
    nodes = [body.closest(".gs, .h7, div") || body];
  }
  const messages = nodes.map((n) => {
    const fromEl = n.querySelector(".gD, span[email]");
    const from = (fromEl?.getAttribute("email") || "").trim();
    const fromName = (fromEl?.getAttribute("name") || fromEl?.textContent || "").trim().slice(0, 80);
    const date = (
      n.querySelector(".g3")?.getAttribute("title")
      || n.querySelector(".g3")?.textContent
      || ""
    ).trim();
    const text = (n.querySelector("div.a3s")?.innerText || n.innerText || "").trim().slice(0, 8000);
    return { from, fromName, date, text };
  }).filter((m) => m.text || m.from);
  if (!subj && !messages.length) return { ok: false, subj: "", messages: [] };
  return { ok: true, subj, messages };
})()`;

export const GMAIL_COMPOSE_OPEN_JS = `(() => {
  const body = document.querySelector('div[aria-label="Message Body"][contenteditable="true"], div[role="textbox"][contenteditable="true"]');
  const to = document.querySelector('textarea[name="to"], input[name="to"], [aria-label*="To recipients"], [aria-label="To"]');
  const subject = document.querySelector('input[name="subjectbox"]');
  const composeBtn = document.querySelector('[gh="cm"], [aria-label="Compose"], .T-I.T-I-KE');
  return {
    composeOpen: Boolean(body || subject || to),
    hasBody: Boolean(body),
    hasTo: Boolean(to),
    hasSubject: Boolean(subject),
    hasComposeButton: Boolean(composeBtn),
  };
})()`;

export const GMAIL_CLICK_COMPOSE_JS = `(() => {
  const btn = document.querySelector('[gh="cm"], [aria-label="Compose"], .T-I.T-I-KE');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

export const GMAIL_CLICK_SEND_JS = `(() => {
  const nodes = [...document.querySelectorAll('[role="button"], div.T-I')];
  const btn = nodes.find((el) => {
    const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim();
    return /^send\\b/i.test(label);
  });
  if (!btn) return false;
  btn.click();
  return true;
})()`;

/** What is currently in the compose window — for the approval card, not for sending. */
export const GMAIL_DRAFT_JS = `(() => {
  const box = document.querySelector('[role="dialog"], .M9, .AD') || document;
  const chips = [...box.querySelectorAll("span[email], [data-hovercard-id]")]
    .map((el) => el.getAttribute("email") || el.getAttribute("data-hovercard-id") || "")
    .filter(Boolean);
  const toField = box.querySelector('textarea[name="to"], input[name="to"]');
  const typed = (toField && "value" in toField ? String(toField.value) : "").trim();
  const to = [...new Set([...chips, typed].filter(Boolean))].join(", ");
  const subjectEl = box.querySelector('input[name="subjectbox"]');
  const subject = (subjectEl && "value" in subjectEl ? String(subjectEl.value) : "") || "";
  const bodyEl = box.querySelector('div[aria-label="Message Body"]');
  const body = (bodyEl && bodyEl.innerText ? bodyEl.innerText : "") || "";
  return { open: Boolean(body || subject || to), to, subject, body: body.slice(0, 4000) };
})()`;

export function gmailFocusScript(field: "to" | "subject" | "body"): string {
  const selectors: Record<typeof field, string> = {
    to: 'textarea[name="to"], input[name="to"], input[aria-label="To"], [aria-label="To recipients"]',
    subject: 'input[name="subjectbox"], input[aria-label="Subject"]',
    body: 'div[aria-label="Message Body"][contenteditable="true"], div[role="textbox"][aria-label="Message Body"]',
  };
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selectors[field])});
    if (!el) return false;
    el.focus();
    return true;
  })()`;
}

export type GmailAction =
  | "archive" | "star" | "unstar" | "read" | "unread"
  | "back" | "spam" | "trash" | "select" | "expand";

export const GMAIL_ACTIONS: GmailAction[] = [
  "archive", "star", "unstar", "read", "unread", "back", "spam", "trash", "select", "expand",
];

export type GmailKeySpec = { key: string; code: string; vk: number; modifiers?: number };

/** Gmail shortcuts. Settings → General → Keyboard shortcuts must be On. Shift = 8. */
export const GMAIL_ACTION_KEYS: Record<GmailAction, GmailKeySpec> = {
  archive: { key: "e", code: "KeyE", vk: 69 },
  star: { key: "s", code: "KeyS", vk: 83 },
  unstar: { key: "s", code: "KeyS", vk: 83 },
  read: { key: "I", code: "KeyI", vk: 73, modifiers: 8 },
  unread: { key: "U", code: "KeyU", vk: 85, modifiers: 8 },
  back: { key: "u", code: "KeyU", vk: 85 },
  spam: { key: "!", code: "Digit1", vk: 49, modifiers: 8 },
  trash: { key: "#", code: "Digit3", vk: 51, modifiers: 8 },
  select: { key: "x", code: "KeyX", vk: 88 },
  expand: { key: ";", code: "Semicolon", vk: 186, modifiers: 8 },
};

export const GMAIL_COMPOSE_KEY: GmailKeySpec = { key: "c", code: "KeyC", vk: 67 };
export const GMAIL_REPLY_KEY: GmailKeySpec = { key: "r", code: "KeyR", vk: 82 };
export const GMAIL_REPLY_ALL_KEY: GmailKeySpec = { key: "a", code: "KeyA", vk: 65 };
