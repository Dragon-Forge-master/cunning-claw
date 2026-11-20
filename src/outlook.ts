/**
 * Outlook on the web, driven the way Gmail is: in Cunning Claw's own
 * signed-in Chrome, over CDP, with no keys and no app registration. Work and
 * school mailboxes (Microsoft 365, outlook.office.com) and personal ones
 * (Outlook.com / Hotmail, outlook.live.com) are the same app.
 *
 * What it leans on, and why. Outlook's class names are generated and change
 * between builds, so nothing here reads one. It reads ARIA roles and
 * accessible names — the contract Outlook keeps for screen readers, which
 * Microsoft documents and tests (support.microsoft.com, "Use a screen reader
 * to … in Outlook"). Buttons are found by their accessible name first, because
 * that works whichever keyboard-shortcut set the operator chose and when
 * shortcuts are switched off; a shortcut is the fallback, and only one that
 * Microsoft lists for its "Outlook" set.
 *
 *   message list   [role=listbox] or [role=grid] named "…Message list…",
 *                  else the first listbox in [role=main]; rows are
 *                  [role=option] / [role=row]. A row's accessible name carries
 *                  "Unread", "Flagged", "Has attachments"; the sender is the
 *                  element whose title is an address.
 *   folders        [role=treeitem] named "Inbox…", count from "N unread"
 *   Focused/Other  [role=tab]
 *   search         input named "Search" (or inside [role=search])
 *   reading pane   [aria-label="Reading Pane"], else [role=main]; subject is
 *                  its first [role=heading]; each message body is
 *                  [aria-label="Message body"] or [role=document]; collapsed
 *                  messages are [aria-expanded=false] and are opened first
 *   compose        To/Cc/Bcc wells named "To"/"Cc"/"Bcc"; subject named
 *                  "Add a subject" or "Subject"; body a contenteditable
 *                  textbox named "Message body…"; a reply's quoted history
 *                  starts at #appendonsend / #divRplyFwdMsg
 *   buttons        "New mail"/"New email"/"New message", "Reply",
 *                  "Reply all", "Send", "Archive", "Delete", "Mark as read",
 *                  "Mark as unread", "Read / Unread", "Flag / Unflag",
 *                  "Flag this message", "Unflag"
 *   shortcuts      (the "Outlook" set) N new, R reply, Shift+R reply all,
 *                  Ctrl+Enter send, E archive, Delete delete, Q read,
 *                  U unread, Insert flag. N, R, Shift+R, Q, Insert and
 *                  Ctrl+Enter are the same in the "Outlook.com" set.
 *   sign-in        login.microsoftonline.com / login.live.com /
 *                  login.microsoft.com, or a page with the loginfmt field
 *
 * Every one of these was checked against a local fixture that imitates
 * Outlook's accessibility structure (src/outlook.test.ts), NOT against the
 * real outlook.office.com — there was no account to test with. When the real
 * page differs, each step says which landmark it could not find instead of
 * doing nothing quietly; buttons inside a message body are never pressed,
 * because a message body is a stranger's HTML.
 *
 * The driver functions take a MailPage — evaluate, navigate, click, key,
 * type — rather than a CDP session, so the same code runs against the
 * operator's Chrome (browser.ts builds one) and the test's throwaway Chromium,
 * and this file imports nothing but the fence.
 */
import { fenceUntrusted } from "./browser-ax.js";

export type KeySpec = { key: string; code: string; vk: number; modifiers?: number };

/** What the Outlook driver needs from a tab. browser.ts builds one per CDP session. */
export interface MailPage {
  evaluate(expression: string): Promise<any>;
  /** Navigate and wait for the document to settle. */
  navigate(url: string): Promise<void>;
  /** A real mouse click at viewport coordinates. */
  click(x: number, y: number): Promise<void>;
  key(spec: KeySpec): Promise<void>;
  insertText(text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  platform?: string;
}

// ---------------------------------------------------------------------------
// Folders and search
// ---------------------------------------------------------------------------

/** URL segments under the mailbox home, e.g. https://outlook.office.com/mail/sentitems. */
export const OUTLOOK_FOLDERS: Record<string, string> = {
  inbox: "inbox",
  sent: "sentitems",
  drafts: "drafts",
  junk: "junkemail",
  spam: "junkemail",
  deleted: "deleteditems",
  trash: "deleteditems",
  archive: "archive",
};

export type OutlookPlan = { folder: string; search: string; notes: string[] };

/** Spoken phrases, onto Outlook's search keywords (support.microsoft.com, "How to search in Outlook"). */
const PHRASES: Record<string, { search?: string; folder?: string; note?: string }> = {
  unread: { search: "read:no" },
  "unread mail": { search: "read:no" },
  "new mail": { search: "read:no" },
  starred: { search: "hasflag:true" },
  flagged: { search: "hasflag:true" },
  today: { search: "received:today" },
  "today's": { search: "received:today" },
  "this morning": { search: "received:today" },
  latest: { search: "received:today" },
  yesterday: { search: "received:yesterday" },
  "this week": { search: 'received:"this week"' },
  "this month": { search: 'received:"this month"' },
  attachments: { search: "hasattachment:yes" },
  "with attachments": { search: "hasattachment:yes" },
  sent: { folder: "sent" },
  drafts: { folder: "drafts" },
  spam: { folder: "junk" },
  junk: { folder: "junk" },
  deleted: { folder: "deleted" },
  trash: { folder: "deleted" },
  archive: { folder: "archive" },
  anywhere: { note: "Outlook's search already looks across folders." },
};
const GMAIL_CATEGORIES = ["promotions", "updates", "social", "primary", "forums", "purchases", "reservations"];
for (const cat of [...GMAIL_CATEGORIES, "newsletters", "receipts", "important"]) {
  PHRASES[cat] = { note: `Outlook has no "${cat}" category; its inbox is split Focused / Other instead, and both are reported.` };
}

const GMAIL_IN: Record<string, string> = {
  inbox: "inbox", sent: "sent", drafts: "drafts", spam: "junk", junk: "junk",
  trash: "deleted", deleted: "deleted", archive: "archive",
};

/** Split on spaces, keeping "quoted phrases" whole. */
function tokens(q: string): string[] {
  return q.match(/[^\s"]+:"[^"]*"|"[^"]*"|\S+/g) ?? [];
}

/**
 * A check_email query and view, in Outlook's terms. Gmail's own operators are
 * translated where Outlook has the same thing (is:unread → read:no,
 * has:attachment → hasattachment:yes, in:sent → the Sent Items folder) and
 * dropped with a note where it has not, so the operator is told rather than
 * shown a silently wider search.
 */
export function planOutlookList(query?: string, view?: string): OutlookPlan | { error: string } {
  const notes: string[] = [];
  let folderKey = "inbox";
  const v = String(view ?? "").trim().toLowerCase();
  if (v) {
    if (v === "starred" || v === "flagged") {
      // A filter rather than a folder in Outlook.
      query = `hasflag:true ${query ?? ""}`;
    } else if (v === "snoozed") {
      return { error: "Outlook on the web has no Snoozed view for check_email. Nothing was read." };
    } else if (v === "all" || v === "important") {
      notes.push(v === "all" ? "Outlook has no All Mail view; this is the inbox, and a search looks across folders." : "Outlook has no Important view; Focused / Other is reported instead.");
    } else if (OUTLOOK_FOLDERS[v]) {
      folderKey = v;
    }
  }
  let q = String(query ?? "").trim();
  const lower = q.toLowerCase();
  const phrases = Object.keys(PHRASES).sort((a, b) => b.length - a.length);
  for (const p of phrases) {
    if (lower === p || lower.startsWith(p + " ")) {
      const hit = PHRASES[p];
      if (hit.folder) folderKey = hit.folder;
      if (hit.note) notes.push(hit.note);
      q = `${hit.search ?? ""} ${q.slice(p.length)}`.trim();
      break;
    }
  }
  const out: string[] = [];
  for (const t of tokens(q)) {
    const m = t.match(/^([a-z_]+):(.*)$/i);
    if (!m) { out.push(t); continue; }
    const op = m[1].toLowerCase();
    const val = m[2].replace(/^"|"$/g, "").toLowerCase();
    if (op === "category" && GMAIL_CATEGORIES.includes(val)) {
      // Gmail's category:social is a tab; Outlook's category:red is a colour
      // the operator gave a message. Same word, different thing.
      notes.push(`category:${val} is a Gmail tab; Outlook has Focused / Other instead, and both are reported.`);
    } else if (["from", "to", "cc", "bcc", "subject", "received", "sent", "read", "hasattachment", "hasflag", "category", "followupflag", "body"].includes(op)) {
      out.push(t);
    } else if (op === "is" && val === "unread") out.push("read:no");
    else if (op === "is" && val === "read") out.push("read:yes");
    else if (op === "is" && (val === "starred" || val === "flagged")) out.push("hasflag:true");
    else if (op === "has" && (val === "attachment" || val === "attachments")) out.push("hasattachment:yes");
    else if (op === "in" && GMAIL_IN[val]) folderKey = GMAIL_IN[val];
    else if (op === "in" && (val === "anywhere" || val === "all")) notes.push("Outlook's search already looks across folders.");
    else if (op === "newer_than") {
      const n = Number(val.replace(/d$/, ""));
      if (n <= 1) out.push("received:today");
      else if (n <= 7) { out.push('received:"this week"'); notes.push(`newer_than:${val} was read as received:"this week".`); }
      else if (n <= 31) { out.push('received:"this month"'); notes.push(`newer_than:${val} was read as received:"this month".`); }
      else notes.push(`newer_than:${val} has no Outlook equivalent and was left out.`);
    } else notes.push(`${op}: is Gmail's and has no Outlook equivalent; it was left out.`);
  }
  return { folder: OUTLOOK_FOLDERS[folderKey] ?? "inbox", search: out.join(" ").trim(), notes };
}

export function outlookFolderUrl(home: string, folder: string): string {
  return home.replace(/\/?$/, "/") + folder;
}

// ---------------------------------------------------------------------------
// Where the tab is
// ---------------------------------------------------------------------------

const AUTH_HOSTS = ["login.microsoftonline.com", "login.live.com", "login.microsoft.com", "account.live.com", "signup.live.com"];
const MAILBOX_HOSTS = ["outlook.office.com", "outlook.office365.com", "outlook.cloud.microsoft", "outlook.live.com"];

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export function isOutlookMailboxUrl(url: string, host?: string): boolean {
  const h = hostOf(url);
  return host ? h === host : MAILBOX_HOSTS.includes(h);
}

/**
 * Microsoft's sign-in, or the marketing page a signed-out outlook.live.com
 * lands on — both mean "sign in once in this window".
 */
export function isMicrosoftSignInUrl(url: string): boolean {
  const h = hostOf(url);
  if (AUTH_HOSTS.includes(h)) return true;
  if (h === "www.microsoft.com" || h === "microsoft.com") {
    try { return /outlook/i.test(new URL(url).pathname); } catch { return false; }
  }
  return false;
}

export function isOutlookRelatedUrl(url: string): boolean {
  return isOutlookMailboxUrl(url) || isMicrosoftSignInUrl(url);
}

export function formatOutlookOpenFailure(opts: { profileDir: string; home: string; tabs: Array<{ title: string; url: string }>; extra?: string }): string {
  const tabs = opts.tabs.length
    ? opts.tabs.map((t, i) => `  [${i}] ${t.title || "(no title)"} — ${t.url}`).join("\n")
    : "  (no page tabs — Chrome's debug port is up but empty)";
  return [
    `Could not open Outlook (${opts.home}) in Cunning Claw's Chrome.`,
    `Profile: ${opts.profileDir}`,
    "",
    "That is a separate window from your everyday browser. Signing into Outlook there does not sign this one in. Look for a Chrome window that is not your usual one, sign in to Outlook there once, then ask me again.",
    "",
    "Tabs I can currently see:",
    tabs,
    opts.extra ? "\n" + opts.extra : "",
  ].filter((l) => l !== "").join("\n");
}

export function outlookSignInMessage(profileDir: string, home: string): string {
  return [
    `Outlook is asking for sign-in in Cunning Claw's own Chrome — a separate window from your everyday browser (${home}).`,
    `Profile: ${profileDir}`,
    "Sign in once in that window with your Microsoft account (I never see or handle the password, or the code your phone shows), then ask me again.",
    "A work account may also ask your IT admin's questions — stay signed in, if it offers, so this is a one-time step.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Page scripts. Plain JS (they run in Chrome), String.raw so a regex reads as
// one. Shared helpers come first in each.
// ---------------------------------------------------------------------------

const PRELUDE = String.raw`
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const nameOf = (el) => norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // A message body is a stranger's HTML. Nothing inside one is ever a control.
  // A role=document that holds the app's own list or folders is a wrapper, not
  // a message, so it does not count; one named Message body always does.
  const BODY = '[aria-label^="Message body"], [role="document"]:not(:has([role="listbox"], [role="tree"], [role="grid"]))';
  const inBody = (el) => el.matches(BODY) || Boolean(el.parentElement && el.parentElement.closest(BODY));
  const listEl = () =>
    document.querySelector('[role="listbox"][aria-label*="essage list"], [role="grid"][aria-label*="essage list"]')
    || document.querySelector('[role="main"] [role="listbox"], [role="main"] [role="grid"]')
    || document.querySelector('[role="listbox"]');
  const rowsOf = (lb) => lb
    ? [...lb.querySelectorAll('[role="option"], [role="row"]')].filter((r) => !r.querySelector('[role="columnheader"]') && visible(r))
    : [];
  const rowKey = (r) => r.getAttribute("data-convid") || r.getAttribute("data-item-id") || r.id || nameOf(r);
  const rowState = (r) => {
    // The label repeats the sender, subject and preview, which strangers
    // write: take those out first, so a subject saying "Flagged" or "Unread"
    // cannot pass for the row's state and turn a toggle the wrong way.
    let label = norm(r.getAttribute("aria-label")).toLowerCase();
    for (const line of (r.innerText || "").split("\n").map(norm).filter((l) => l.length > 2)) {
      label = label.split(line.toLowerCase()).join(" ");
    }
    return {
      unread: /\bunread\b/.test(label) || r.getAttribute("data-unread") === "true",
      flagged: /\bflagged\b/.test(label),
      attached: /\battachments?\b/.test(label),
      selected: r.getAttribute("aria-selected") === "true",
    };
  };
  const controls = (scope) => [...(scope || document).querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="tab"]')]
    .filter((b) => visible(b) && !inBody(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true");
  const findControl = (patterns, scope) => {
    for (const p of patterns) {
      const re = new RegExp(p, "i");
      const hit = controls(scope).find((b) => re.test(nameOf(b)));
      if (hit) return hit;
    }
    return null;
  };
  const centre = (el) => {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const pane = () => document.querySelector('[aria-label="Reading Pane"], [aria-label="Reading pane"]') || document.querySelector('[role="main"]');
  const bodyBox = () => [...document.querySelectorAll('[contenteditable="true"][aria-label^="Message body"], [role="textbox"][aria-label^="Message body"][contenteditable="true"]')].find(visible) || null;
  const well = (name) => [...document.querySelectorAll('[aria-label="' + name + '"]')]
    .find((el) => visible(el) && !inBody(el) && (el.isContentEditable || el.getAttribute("role") === "textbox" || el.tagName === "INPUT" || el.querySelector('[contenteditable="true"], input'))) || null;
  const subjectBox = () => [...document.querySelectorAll('input[aria-label="Add a subject"], input[placeholder="Add a subject"], input[aria-label="Subject"]')].find(visible) || null;
`;

/** Facts about the page; outlookVerdict decides what they mean. */
export const OUTLOOK_STATE_JS = String.raw`(() => {
  ${PRELUDE}
  return {
    url: location.href,
    title: document.title || "",
    loginForm: Boolean(document.querySelector('input[name="loginfmt"], input[type="email"][autocomplete="username"]')),
    landmarks: {
      list: Boolean(listEl()),
      folders: Boolean(document.querySelector('[role="tree"]')),
      search: Boolean(document.querySelector('input[aria-label^="Search"], [role="search"] input')),
      newMail: Boolean(findControl(["^new (mail|email|message)\\b"])),
      readingPane: Boolean(document.querySelector('[aria-label="Reading Pane"], [aria-label="Reading pane"]')),
      compose: Boolean(bodyBox()),
    },
  };
})()`;

export type OutlookPageState = {
  url: string;
  title: string;
  loginForm: boolean;
  landmarks: { list: boolean; folders: boolean; search: boolean; newMail: boolean; readingPane: boolean; compose: boolean };
};

export type OutlookVerdict = { kind: "signin" } | { kind: "ready" } | { kind: "missing"; message: string };

/**
 * Signed out, ready, or not the page this code was written for. "missing"
 * names what was found and what was not, so a changed Outlook is a sentence
 * the operator can act on rather than an empty list that looks like no mail.
 */
export function outlookVerdict(st: OutlookPageState | null | undefined, need: "list" | "readingPane" | "compose" = "list"): OutlookVerdict {
  if (!st) return { kind: "missing", message: "Outlook's page did not answer at all — the tab may have closed or still be loading." };
  if (isMicrosoftSignInUrl(st.url) || st.loginForm) return { kind: "signin" };
  if (st.landmarks[need]) return { kind: "ready" };
  const yes = (b: boolean) => (b ? "found" : "not found");
  const what = need === "list"
    ? "its message list (role listbox or grid named Message list)"
    : need === "readingPane" ? "an open conversation (the Reading Pane)" : "a compose window (a Message body textbox)";
  return {
    kind: "missing",
    message:
      `Outlook is open but I could not find ${what}. ` +
      `Message list ${yes(st.landmarks.list)}, folder pane ${yes(st.landmarks.folders)}, search box ${yes(st.landmarks.search)}, ` +
      `New mail button ${yes(st.landmarks.newMail)}, reading pane ${yes(st.landmarks.readingPane)}. ` +
      `Page: "${st.title}". It may still be loading, Microsoft may have changed the page, or this is not the mailbox. ` +
      "Nothing was done. Try again in a moment; if it keeps happening, browser_snapshot shows what is on the page.",
  };
}

export type OutlookRow = {
  unread: boolean;
  flagged: boolean;
  attached: boolean;
  sender: string;
  address: string;
  subject: string;
  snippet: string;
  date: string;
};

export type OutlookList = {
  folderUnread: number | null;
  tabs: Array<{ label: string; selected: boolean }>;
  messages: OutlookRow[];
};

/** The visible conversation list, the Focused / Other tabs and the Inbox's unread count. */
export const OUTLOOK_LIST_JS = String.raw`(() => {
  ${PRELUDE}
  const DATE = /^(\d{1,2}:\d{2}( ?[ap]m)?|(mon|tue|wed|thu|fri|sat|sun)[a-z]*( \d{1,2}[\/.]\d{1,2}([\/.]\d{2,4})?)?|\d{1,2}[\/.]\d{1,2}([\/.]\d{2,4})?|\d{1,2} [a-z]{3,9}( \d{4})?|yesterday|today)$/i;
  const inbox = [...document.querySelectorAll('[role="treeitem"]')].find((t) => /^inbox\b/i.test(nameOf(t)));
  let folderUnread = null;
  if (inbox) {
    const m = nameOf(inbox).match(/(\d+)\s*unread/i) || norm(inbox.textContent).match(/^inbox\s*(\d+)$/i);
    if (m) folderUnread = Number(m[1]);
  }
  const tabs = [...document.querySelectorAll('[role="tab"]')]
    .map((t) => ({ label: nameOf(t), selected: t.getAttribute("aria-selected") === "true" }))
    .filter((t) => /^(focused|other)\b/i.test(t.label));
  const rows = rowsOf(listEl());
  const messages = rows.slice(0, 80).map((r) => {
    const s = rowState(r);
    const who = r.querySelector('[title*="@"]');
    const address = who ? norm(who.getAttribute("title")) : "";
    const lines = (r.innerText || "").split("\n").map(norm).filter(Boolean);
    const sender = norm(who ? who.textContent : lines[0]) || address;
    const rest = lines.filter((l) => l !== sender);
    const date = rest.find((l) => DATE.test(l)) || "";
    const others = rest.filter((l) => l !== date);
    const subject = others[0] || "";
    const snippet = others.slice(1).join(" ");
    return {
      unread: s.unread, flagged: s.flagged, attached: s.attached,
      sender: sender.slice(0, 80), address: address.slice(0, 120),
      subject: subject.slice(0, 160), snippet: snippet.slice(0, 200), date: date.slice(0, 40),
    };
  });
  return { folderUnread, tabs, messages };
})()`;

/** Where row `i` is, and who it is, so a real mouse click can open it. */
export function outlookRowScript(index: number): string {
  return String.raw`(() => {
    ${PRELUDE}
    const rows = rowsOf(listEl());
    const r = rows[${Math.floor(Number(index))}];
    if (!r) return { ok: false, count: rows.length };
    return { ok: true, count: rows.length, key: rowKey(r), at: centre(r), state: rowState(r) };
  })()`;
}

/** The selected row, for an action with no index. */
export const OUTLOOK_SELECTED_ROW_JS = String.raw`(() => {
  ${PRELUDE}
  const r = rowsOf(listEl()).find((x) => x.getAttribute("aria-selected") === "true");
  return r ? { ok: true, key: rowKey(r), state: rowState(r) } : { ok: false };
})()`;

/** One row's state again, by the key captured before acting; gone if it left the list. */
export function outlookRowStateScript(key: string): string {
  return String.raw`(() => {
    ${PRELUDE}
    const want = ${JSON.stringify(key)};
    const r = rowsOf(listEl()).find((x) => rowKey(x) === want);
    return r ? { gone: false, state: rowState(r) } : { gone: true };
  })()`;
}

/** Press a control by accessible name. Never one inside a message body. */
export function outlookControlScript(patterns: string[], scope: "page" | "compose" | "pane" = "page"): string {
  return String.raw`(() => {
    ${PRELUDE}
    let root = document;
    if (${JSON.stringify(scope)} === "compose") {
      const b = bodyBox();
      root = (b && (b.closest('[role="dialog"], [role="region"], form, [role="main"]'))) || document;
    } else if (${JSON.stringify(scope)} === "pane") {
      root = pane() || document;
    }
    const hit = findControl(${JSON.stringify(patterns)}, root);
    return hit ? { ok: true, name: nameOf(hit), at: centre(hit) } : { ok: false };
  })()`;
}

/** Open every collapsed message in the reading pane. A menu is not a message. */
export const OUTLOOK_EXPAND_JS = String.raw`(() => {
  ${PRELUDE}
  const p = pane();
  if (!p) return 0;
  let n = 0;
  for (const el of p.querySelectorAll('[aria-expanded="false"]')) {
    if (inBody(el) || el.hasAttribute("aria-haspopup")) continue;
    try { el.click(); n++; } catch {}
  }
  return n;
})()`;

export type OutlookThread = {
  ok: boolean;
  subject: string;
  messages: Array<{ from: string; fromName: string; date: string; text: string }>;
};

/** Every message body in the open conversation, with whoever the header names. */
export const OUTLOOK_THREAD_JS = String.raw`(() => {
  ${PRELUDE}
  const DATE = /(\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b.*\d)|(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})|(\d{1,2}:\d{2})/i;
  const p = pane();
  if (!p) return { ok: false, subject: "", messages: [] };
  const h = [...p.querySelectorAll('[role="heading"], h1, h2')].find((x) => !inBody(x));
  const subject = h ? norm(h.textContent) : "";
  const bodies = [...p.querySelectorAll(BODY)].filter((b) => !(b.parentElement && b.parentElement.closest(BODY)));
  const messages = bodies.map((b) => {
    let c = b.parentElement;
    let who = null;
    while (c && c !== p.parentElement) {
      who = [...c.querySelectorAll('[title*="@"]')].find((e) => !b.contains(e)) || null;
      if (who) break;
      c = c.parentElement;
    }
    const scope = c || p;
    const leaves = [...scope.querySelectorAll("time, span, div")].filter((e) => !b.contains(e) && !e.children.length);
    const t = scope.querySelector("time");
    const dateEl = t || leaves.find((e) => DATE.test(norm(e.textContent)));
    return {
      from: who ? norm(who.getAttribute("title")).slice(0, 120) : "",
      fromName: who ? norm(who.textContent).slice(0, 80) : "",
      date: dateEl ? norm(dateEl.getAttribute("datetime") || dateEl.textContent).slice(0, 60) : "",
      text: (b.innerText || "").trim().slice(0, 8000),
    };
  }).filter((m) => m.text || m.from);
  if (!subject && !messages.length) return { ok: false, subject: "", messages: [] };
  return { ok: true, subject, messages };
})()`;

export type OutlookCompose = {
  open: boolean;
  /** Addresses visible in To/Cc/Bcc — what the consent guard checks. */
  to: string;
  /** What the card shows: every recipient, by address or by name. */
  toShown: string;
  recipientCount: number;
  subject: string;
  /** The operator's own words, not a reply's quoted history. */
  body: string;
  quoted: boolean;
};

/**
 * The compose window, for the draft's result and the send card. A reply in
 * Outlook carries the whole earlier conversation in its body below
 * #appendonsend; that is the stranger's text, so it is cut off here — the
 * draft result would otherwise hand it to the model unfenced, and the consent
 * guard would find a quoted newsletter's unsubscribe line and pass a send
 * that has none of its own.
 */
export const OUTLOOK_COMPOSE_JS = String.raw`(() => {
  ${PRELUDE}
  const EMAIL = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const body = bodyBox();
  const subj = subjectBox();
  const wells = ["To", "Cc", "Bcc"].map(well).filter(Boolean);
  const addrs = [];
  const shown = [];
  let count = 0;
  for (const w of wells) {
    const chips = [...w.querySelectorAll('[role="button"], [role="listitem"], [role="option"], [data-lpc-hover-target-id], span[title]')]
      .filter((c) => !c.parentElement.closest('[role="button"], [role="listitem"], [role="option"], [data-lpc-hover-target-id], span[title]') || c.parentElement === w);
    const seen = new Set();
    for (const c of chips) {
      if (seen.has(c)) continue;
      seen.add(c);
      const said = [c.getAttribute("aria-label"), c.getAttribute("title"), c.textContent].join(" ");
      const found = said.match(EMAIL) || [];
      count++;
      if (found.length) { addrs.push(found[0].toLowerCase()); shown.push(found[0].toLowerCase()); }
      else shown.push(norm(c.textContent).slice(0, 60) + " (name only)");
    }
    // Text typed but not yet turned into a recipient.
    const typed = [...w.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ")
      + " " + [...w.querySelectorAll("input")].map((i) => i.value).join(" ");
    for (const a of (typed.match(EMAIL) || [])) {
      if (!addrs.includes(a.toLowerCase())) { addrs.push(a.toLowerCase()); shown.push(a.toLowerCase()); count++; }
    }
  }
  let own = "";
  let quoted = false;
  if (body) {
    const mark = body.querySelector('#appendonsend, #divRplyFwdMsg, [id$="divRplyFwdMsg"], [id$="appendonsend"]');
    if (mark) {
      quoted = true;
      let top = mark;
      while (top.parentElement && top.parentElement !== body) top = top.parentElement;
      const parts = [];
      for (const ch of body.childNodes) {
        if (ch === top) break;
        parts.push(ch.nodeType === 3 ? ch.textContent : (ch.innerText || ch.textContent || ""));
      }
      own = parts.join("\n");
    } else {
      own = body.innerText || "";
    }
  }
  own = own.replace(/\n{3,}/g, "\n\n").trim();
  // Head and tail: the unsubscribe line of a newsletter is at the bottom.
  const cut = own.length > 4000 ? own.slice(0, 3000) + "\n…\n" + own.slice(-1000) : own;
  const subject = subj && "value" in subj ? String(subj.value) : "";
  return {
    open: Boolean(body || subj),
    to: addrs.join(", "),
    toShown: shown.join(", "),
    recipientCount: count,
    subject,
    body: cut,
    quoted,
  };
})()`;

/** Focus a compose field, or the search box. The body's caret goes to the top, above any signature or quote. */
export function outlookFocusScript(field: "to" | "subject" | "body" | "search"): string {
  return String.raw`(() => {
    ${PRELUDE}
    const f = ${JSON.stringify(field)};
    let el = null;
    if (f === "to") {
      const w = well("To");
      el = w && (w.isContentEditable || w.tagName === "INPUT" ? w : w.querySelector('[contenteditable="true"], input'));
    } else if (f === "subject") el = subjectBox();
    else if (f === "body") el = bodyBox();
    else el = document.querySelector('input[aria-label^="Search"], [role="search"] input');
    if (!el) return false;
    el.focus();
    if (f === "body" || (f === "to" && el.isContentEditable)) {
      // The body's caret goes to the top, above any signature or quote; the
      // To line's to the end, after any recipient already there.
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(f === "body");
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    if (f === "subject" || f === "search") { try { el.select(); } catch {} }
    return true;
  })()`;
}

// ---------------------------------------------------------------------------
// Buttons and keys
// ---------------------------------------------------------------------------

const SHIFT = 8;

export const OUTLOOK_KEYS = {
  newMail: { key: "n", code: "KeyN", vk: 78 },
  reply: { key: "r", code: "KeyR", vk: 82 },
  replyAll: { key: "R", code: "KeyR", vk: 82, modifiers: SHIFT },
  archive: { key: "e", code: "KeyE", vk: 69 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  read: { key: "q", code: "KeyQ", vk: 81 },
  unread: { key: "u", code: "KeyU", vk: 85 },
  flag: { key: "Insert", code: "Insert", vk: 45 },
  semicolon: { key: ";", code: "Semicolon", vk: 186 },
  enter: { key: "Enter", code: "Enter", vk: 13 },
} satisfies Record<string, KeySpec>;

export const OUTLOOK_BUTTONS = {
  newMail: ["^new (mail|email|message)\\b"],
  reply: ["^reply$"],
  replyAll: ["^reply all$"],
  send: ["^send$"],
  otherTab: ["^other\\b"],
  focusedTab: ["^focused\\b"],
};

export type OutlookAction = "archive" | "read" | "unread" | "flag" | "unflag" | "delete";

/**
 * Each action: the accessible names to press, the shortcut if none is found,
 * and what the row must look like afterwards for the result to say it worked.
 * Read / Unread and Flag / Unflag are toggles in Outlook's ribbon, which is
 * why the state is checked first: pressing a toggle on a row already in the
 * wanted state would undo it.
 */
export const OUTLOOK_ACTION_SPECS: Record<OutlookAction, { buttons: string[]; key: KeySpec; expect: "gone" | { unread?: boolean; flagged?: boolean } }> = {
  archive: { buttons: ["^archive$"], key: OUTLOOK_KEYS.archive, expect: "gone" },
  delete: { buttons: ["^delete$"], key: OUTLOOK_KEYS.delete, expect: "gone" },
  read: { buttons: ["^mark as read$", "^read$", "^read / unread$"], key: OUTLOOK_KEYS.read, expect: { unread: false } },
  unread: { buttons: ["^mark as unread$", "^unread$", "^read / unread$"], key: OUTLOOK_KEYS.unread, expect: { unread: true } },
  flag: { buttons: ["^flag this message$", "^flag$", "^flag / unflag$"], key: OUTLOOK_KEYS.flag, expect: { flagged: true } },
  unflag: { buttons: ["^unflag( this message)?$", "^clear flag$", "^flag / unflag$"], key: OUTLOOK_KEYS.flag, expect: { flagged: false } },
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatOutlookList(data: OutlookList, heading: string, notes: string[] = [], prefix = ""): string {
  const tabs = data.tabs.length ? "TABS: " + data.tabs.map((t) => `${t.selected ? "*" : ""}${t.label}`).join(" · ") : "";
  const folder = data.folderUnread != null ? `FOLDER_UNREAD: ${data.folderUnread}` : "";
  const listedUnread = data.messages.filter((m) => m.unread).length;
  const mismatch =
    data.folderUnread != null && data.folderUnread > listedUnread
      ? `NOTE: Outlook's Inbox says ${data.folderUnread} unread, this list shows ${listedUnread}. The rest are probably under Other, or further down — search "unread".`
      : "";
  const lines = data.messages.map((m, i) => {
    const flags = [m.unread ? "UNREAD" : "", m.flagged ? "FLAG" : "", m.attached ? "FILE" : ""].filter(Boolean).join(" ");
    const who = m.address && m.address !== m.sender ? `${m.sender} <${m.address}>` : m.sender;
    return `[${prefix}${i}]${flags ? " " + flags : ""} ${m.date} — ${who}\n    ${m.subject}\n    ${m.snippet}`;
  });
  return [
    heading,
    folder,
    tabs,
    mismatch,
    ...notes.map((n) => `NOTE: ${n}`),
    `${data.messages.length} conversations on this view.`,
    "",
    lines.join("\n") || "(no conversations in this view)",
  ].filter((l) => l !== "").join("\n");
}

export function formatOutlookThread(data: OutlookThread): string {
  if (!data.ok) return "Could not read the open conversation.";
  const parts = data.messages.map((m, i) => {
    const who = [m.fromName, m.from && m.from !== m.fromName ? `<${m.from}>` : ""].filter(Boolean).join(" ");
    return `--- message ${i} ---\nFROM: ${who}\nDATE: ${m.date}\n\n${m.text}`;
  });
  return `SUBJECT: ${data.subject}\n${data.messages.length} message(s) in thread\n\n${parts.join("\n\n")}`;
}

/** Same reasoning as Gmail's: an unread count bigger than the Focused list means mail is hiding under Other. */
export function shouldSweepOther(data: OutlookList, plan: OutlookPlan): boolean {
  if (plan.search || plan.folder !== "inbox") return false;
  const focused = data.tabs.find((t) => /^focused/i.test(t.label));
  const other = data.tabs.find((t) => /^other/i.test(t.label));
  if (!focused?.selected || !other) return false;
  const listed = data.messages.filter((m) => m.unread).length;
  return data.folderUnread != null && data.folderUnread > listed;
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export type OutlookEnv = { home: string; profileDir: string };

function sourceOf(home: string): string {
  try { return new URL(home).host; } catch { return "outlook"; }
}

async function pageState(page: MailPage): Promise<OutlookPageState | null> {
  try {
    return (await page.evaluate(OUTLOOK_STATE_JS)) as OutlookPageState;
  } catch {
    return null;
  }
}

/** Poll until the landmark is there, the page is a sign-in, or time runs out. */
async function waitFor(page: MailPage, need: "list" | "readingPane" | "compose", tries = 14, gap = 500): Promise<OutlookVerdict> {
  let v: OutlookVerdict = { kind: "missing", message: "" };
  for (let i = 0; i < tries; i++) {
    v = outlookVerdict(await pageState(page), need);
    if (v.kind !== "missing") return v;
    await page.sleep(gap);
  }
  return v;
}

function notReady(v: OutlookVerdict, env: OutlookEnv): string | null {
  if (v.kind === "signin") return outlookSignInMessage(env.profileDir, env.home);
  if (v.kind === "missing") return v.message;
  return null;
}

async function scrape(page: MailPage): Promise<OutlookList> {
  const data = (await page.evaluate(OUTLOOK_LIST_JS)) as OutlookList | null;
  return data ?? { folderUnread: null, tabs: [], messages: [] };
}

async function press(page: MailPage, patterns: string[], scope: "page" | "compose" | "pane" = "page"): Promise<string | null> {
  const hit = (await page.evaluate(outlookControlScript(patterns, scope))) as { ok: boolean; name?: string; at?: { x: number; y: number } };
  if (!hit?.ok || !hit.at) return null;
  await page.click(hit.at.x, hit.at.y);
  return hit.name ?? "";
}

export async function outlookCheckEmail(page: MailPage, env: OutlookEnv, query?: string, view?: string): Promise<string> {
  const plan = planOutlookList(query, view);
  if ("error" in plan) return plan.error;
  await page.navigate(outlookFolderUrl(env.home, plan.folder));
  const ready = notReady(await waitFor(page, "list"), env);
  if (ready) return ready;

  if (plan.search) {
    const focused = await page.evaluate(outlookFocusScript("search"));
    if (!focused) {
      return (
        "Outlook's search box was not found (an input named Search), so the search could not run. " +
        "Nothing was read. Microsoft may have changed the page — browser_snapshot shows what is there."
      );
    }
    await page.insertText(plan.search);
    await page.key(OUTLOOK_KEYS.enter);
    await page.sleep(1200);
    const after = notReady(await waitFor(page, "list"), env);
    if (after) return after;
  }

  const data = await scrape(page);
  const where = plan.folder === "inbox" ? "inbox" : plan.folder;
  const heading = plan.search
    ? `Outlook search "${plan.search}" — ${data.messages.length} conversations`
    : `Outlook ${where} — ${data.messages.length} conversations`;
  let text = formatOutlookList(data, heading, plan.notes);

  if (shouldSweepOther(data, plan)) {
    const name = await press(page, OUTLOOK_BUTTONS.otherTab);
    if (name !== null) {
      await page.sleep(800);
      const other = await scrape(page);
      // Back to Focused, so read_email's numbers still mean the list above —
      // left on Other, "read 0" opened a newsletter instead of the customer.
      await press(page, OUTLOOK_BUTTONS.focusedTab);
      await page.sleep(500);
      text +=
        "\n\n--- Other (the Inbox count was bigger than Focused showed) ---\n" +
        formatOutlookList(
          other,
          `Outlook inbox, Other — ${other.messages.length} conversations. Numbered o0, o1…: read_email and email_action numbers ` +
            `mean the Focused list above; to open one of these, check_email "unread" first.`,
          [],
          "o",
        );
    }
  }
  return fenceUntrusted(sourceOf(env.home), text);
}

export async function outlookReadEmail(page: MailPage, env: OutlookEnv, index: number): Promise<string> {
  const ready = notReady(await waitFor(page, "list", 4), env);
  if (ready) return ready;
  const row = (await page.evaluate(outlookRowScript(index))) as { ok: boolean; count: number; at?: { x: number; y: number } };
  if (!row?.ok || !row.at) {
    return `No message at index ${index}. Currently ${row?.count ?? 0} visible rows. check_email first, then use that numbering (it starts at 0).`;
  }
  await page.click(row.at.x, row.at.y);
  const open = notReady(await waitFor(page, "readingPane", 12, 300), env);
  if (open) return open;
  const expanded = Number(await page.evaluate(OUTLOOK_EXPAND_JS)) || 0;
  if (expanded) await page.sleep(500);
  const thread = (await page.evaluate(OUTLOOK_THREAD_JS)) as OutlookThread;
  if (!thread?.ok) {
    return (
      "The conversation opened, but no message body was found in it (an element named Message body, or role document). " +
      "Nothing was read. Microsoft may have changed the page — browser_snapshot shows what is there."
    );
  }
  return fenceUntrusted(sourceOf(env.home), formatOutlookThread(thread));
}

export async function outlookPeekCompose(page: MailPage): Promise<OutlookCompose> {
  try {
    const c = (await page.evaluate(OUTLOOK_COMPOSE_JS)) as Partial<OutlookCompose> | null;
    return {
      open: Boolean(c?.open),
      to: String(c?.to ?? ""),
      toShown: String(c?.toShown ?? ""),
      recipientCount: Number(c?.recipientCount ?? 0) || 0,
      subject: String(c?.subject ?? ""),
      body: String(c?.body ?? ""),
      quoted: Boolean(c?.quoted),
    };
  } catch {
    return { open: false, to: "", toShown: "", recipientCount: 0, subject: "", body: "", quoted: false };
  }
}

async function waitCompose(page: MailPage, tries = 12): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if ((await outlookPeekCompose(page)).open) return true;
    await page.sleep(250);
  }
  return false;
}

function selectAll(page: MailPage): KeySpec {
  return { key: "a", code: "KeyA", vk: 65, modifiers: page.platform === "darwin" ? 4 : 2 };
}

export async function outlookDraftEmail(
  page: MailPage,
  env: OutlookEnv,
  input: { to?: string; subject?: string; body: string; reply?: boolean; replyAll?: boolean },
): Promise<string> {
  const replying = Boolean(input.reply || input.replyAll);
  const st = await pageState(page);
  const v = outlookVerdict(st, replying ? "readingPane" : "list");
  if (v.kind === "signin") return outlookSignInMessage(env.profileDir, env.home);
  if (v.kind === "missing" && !st?.landmarks.compose) {
    return replying
      ? "No conversation is open in Outlook to reply to. read_email first, then draft_email with reply."
      : v.message;
  }

  if (st?.landmarks.compose) {
    // Typing into whatever draft is already open would splice two messages.
    return (
      "A compose window is already open in Outlook. Send it, or discard it, in the window first — " +
      "I will not type into a draft I did not open. Nothing was typed."
    );
  }
  const buttons = replying ? (input.replyAll ? OUTLOOK_BUTTONS.replyAll : OUTLOOK_BUTTONS.reply) : OUTLOOK_BUTTONS.newMail;
  // Reply is in the reading pane and in the ribbon; the pane's answers the
  // open conversation, so it is tried first.
  let pressed = replying ? await press(page, buttons, "pane") : null;
  if (pressed === null) pressed = await press(page, buttons, "page");
  let route: string;
  if (pressed !== null) route = `pressed "${pressed}"`;
  else {
    await page.key(replying ? (input.replyAll ? OUTLOOK_KEYS.replyAll : OUTLOOK_KEYS.reply) : OUTLOOK_KEYS.newMail);
    route = "used the keyboard shortcut";
  }
  if (!(await waitCompose(page))) {
    return (
      `Could not open an Outlook compose window (${route}; no Message body textbox appeared). ` +
      "Nothing was typed. If keyboard shortcuts are off and the button has moved, Microsoft may have changed the page — " +
      "browser_snapshot shows what is there."
    );
  }

  const asked = replying ? [] : String(input.to ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (asked.length) {
    if (!(await page.evaluate(outlookFocusScript("to")))) {
      return "Compose opened but the To field (named To) was not there. Nothing more was typed; look at the window.";
    }
    for (const a of asked) {
      await page.insertText(a);
      // A semicolon turns typed text into a recipient as typed. Enter would
      // take the top suggestion, which can be a different person.
      await page.key(OUTLOOK_KEYS.semicolon);
      await page.sleep(150);
    }
  }
  if (!replying && input.subject) {
    if (await page.evaluate(outlookFocusScript("subject"))) {
      await page.key(selectAll(page));
      await page.insertText(input.subject);
    }
  }
  if (!(await page.evaluate(outlookFocusScript("body")))) {
    return "Compose opened but the message body was not found. The draft may be empty — look at the window before sending.";
  }
  // Typed at the top, never select-all: the body already holds the operator's
  // signature, and in a reply the conversation being answered.
  await page.insertText(input.body);
  await page.sleep(150);

  const preview = await outlookPeekCompose(page);
  const missing = asked.filter((a) => !preview.to.split(", ").includes(a.toLowerCase()));
  return [
    "Draft is in the Outlook compose window. NOT sent.",
    `To: ${preview.toShown || input.to || (replying ? "(reply — existing recipients)" : "(none)")}`,
    `Subject: ${preview.subject || input.subject || (replying ? "(reply — existing subject)" : "(none)")}`,
    missing.length ? `CHECK: Outlook does not show ${missing.join(", ")} as a recipient. Look at the To line before sending.` : "",
    "",
    (preview.body || input.body).slice(0, 2000),
    preview.quoted ? "\n(The earlier messages are quoted below it in the window, as Outlook does.)" : "",
    "",
    "Call send_email only after the operator has seen this and said to send it.",
  ].filter((l, i, all) => l !== "" || (all[i - 1] ?? "") !== "").join("\n");
}

export async function outlookSendEmail(page: MailPage): Promise<string> {
  const before = await outlookPeekCompose(page);
  if (!before.open) return "No compose window is open. draft_email first, then send_email after the operator approves.";
  const pressed = await press(page, OUTLOOK_BUTTONS.send, "compose");
  if (pressed === null) {
    await page.key({ key: "Enter", code: "Enter", vk: 13, modifiers: page.platform === "darwin" ? 4 : 2 });
  }
  for (let i = 0; i < 12; i++) {
    await page.sleep(250);
    if (!(await outlookPeekCompose(page)).open) {
      return "Email sent from Outlook. Compose window closed.";
    }
  }
  const dialog = Boolean(await page.evaluate(`Boolean(document.querySelector('[role="alertdialog"]'))`));
  return (
    `Tried to send (${pressed !== null ? `pressed "${pressed}"` : "no Send button found, so Ctrl+Enter"}) but the compose window is still open. ` +
    (dialog ? "Outlook is showing a dialog — look at the window. " : "It may need a To address, or Outlook blocked it. Look at the window. ") +
    "Do not report this as sent."
  );
}

export async function outlookEmailAction(page: MailPage, env: OutlookEnv, action: OutlookAction, index?: number): Promise<string> {
  const spec = OUTLOOK_ACTION_SPECS[action];
  if (!spec) return `Unknown Outlook action "${action}".`;
  const ready = notReady(await waitFor(page, "list", 4), env);
  if (ready) return ready;
  const which = typeof index === "number" ? `conversation ${index}` : "the selected conversation";

  let key = "";
  let state: { unread: boolean; flagged: boolean } | null = null;
  if (typeof index === "number") {
    const row = (await page.evaluate(outlookRowScript(index))) as { ok: boolean; count: number; key?: string; at?: { x: number; y: number } };
    if (!row?.ok || !row.at) return `No conversation at index ${index} (${row?.count ?? 0} visible). check_email first.`;
    await page.click(row.at.x, row.at.y);
    await page.sleep(400);
    key = row.key ?? "";
  } else {
    const sel = (await page.evaluate(OUTLOOK_SELECTED_ROW_JS)) as { ok: boolean; key?: string };
    if (!sel?.ok) return "No conversation is selected in Outlook. Give an index from check_email. Nothing was done.";
    key = sel.key ?? "";
  }
  const now = (await page.evaluate(outlookRowStateScript(key))) as { gone: boolean; state?: { unread: boolean; flagged: boolean } };
  if (now?.gone || !now?.state) return `Outlook no longer shows ${which} in the list. Nothing was done; check_email again.`;
  state = now.state;

  if (spec.expect !== "gone") {
    const want = spec.expect;
    const already = (want.unread === undefined || state.unread === want.unread) && (want.flagged === undefined || state.flagged === want.flagged);
    if (already) return `Outlook already shows ${which} as ${action === "flag" ? "flagged" : action === "unflag" ? "not flagged" : action}. Nothing was pressed.`;
  }

  const pressed = await press(page, spec.buttons);
  if (pressed === null) await page.key(spec.key);
  const how = pressed !== null ? `pressed "${pressed}"` : "no button found, so the keyboard shortcut";

  for (let i = 0; i < 10; i++) {
    await page.sleep(250);
    const after = (await page.evaluate(outlookRowStateScript(key))) as { gone: boolean; state?: { unread: boolean; flagged: boolean } };
    if (spec.expect === "gone" ? after?.gone : after?.state && (
      (spec.expect.unread === undefined || after.state.unread === spec.expect.unread) &&
      (spec.expect.flagged === undefined || after.state.flagged === spec.expect.flagged)
    )) {
      const done = action === "delete" ? "moved to Deleted Items" : action === "archive" ? "archived" : action === "flag" ? "flagged" : action === "unflag" ? "unflagged" : `marked ${action}`;
      return `Outlook: ${which} ${done} (${how}).`;
    }
  }
  return (
    `Outlook: tried to ${action} ${which} (${how}), but the list does not show the change. ` +
    "It may not have happened — the button may have moved, or keyboard shortcuts are off or set to another style " +
    "(Settings → General → Accessibility → Keyboard shortcuts). Look at the window; do not report it as done."
  );
}
