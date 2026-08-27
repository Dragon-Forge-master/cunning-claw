import assert from "node:assert/strict";
import test from "node:test";
import {
  expandGmailQuery,
  formatGmailList,
  formatGmailThread,
  gmailListUrl,
  parseGmailView,
  shouldSweepUnread,
  GMAIL_ACTIONS,
  GMAIL_LIST_JS,
  GMAIL_THREAD_JS,
  GMAIL_DRAFT_JS,
  type GmailList,
} from "./gmail.js";
import { toolDefinitions } from "./tools.js";

test("spoken phrases become Gmail operators; real operators pass through", () => {
  assert.equal(expandGmailQuery("unread"), "is:unread");
  assert.equal(expandGmailQuery("today"), "newer_than:1d");
  assert.equal(expandGmailQuery("promotions"), "category:promotions");
  assert.equal(expandGmailQuery("newsletters"), "category:promotions");
  assert.equal(expandGmailQuery("receipts"), "category:purchases");
  assert.equal(expandGmailQuery("from:hsbc.co.uk"), "from:hsbc.co.uk");
  assert.equal(expandGmailQuery("is:unread from:bank"), "is:unread from:bank");
  assert.equal(expandGmailQuery("quote for the Golf"), "quote for the Golf");
  assert.equal(expandGmailQuery(""), "");
});

test("a leading spoken phrase expands and the rest of the query is kept", () => {
  assert.equal(expandGmailQuery("unread from dave"), "is:unread from dave");
  assert.equal(expandGmailQuery("unread from:bank"), "is:unread from:bank");
  assert.equal(expandGmailQuery("today subject:mot"), "newer_than:1d subject:mot");
});

test("list URLs use the hash search API, not a CSS scrape", () => {
  assert.equal(gmailListUrl(), "https://mail.google.com/mail/u/0/#inbox");
  assert.equal(gmailListUrl(undefined, "sent"), "https://mail.google.com/mail/u/0/#sent");
  assert.equal(gmailListUrl(undefined, "not-a-view" as never), "https://mail.google.com/mail/u/0/#inbox");
  assert.equal(parseGmailView("DRAFTS"), "drafts");
  assert.equal(parseGmailView("nope"), "inbox");
  assert.match(gmailListUrl("unread"), /#search\/is%3Aunread$/);
  assert.match(gmailListUrl("from:a@b.c"), /#search\/from%3Aa%40b.c/);
});

test("a title unread count bigger than the visible list is called out as hidden tabs", () => {
  const data: GmailList = {
    ready: true,
    url: "https://mail.google.com/mail/u/0/#inbox",
    unreadFromTitle: 12,
    tabs: [
      { label: "Primary 3 unread", selected: true },
      { label: "Promotions 9 unread", selected: false },
    ],
    messages: [
      { unread: true, starred: false, attached: false, sender: "Abi", subject: "Hello", snippet: "hi", date: "4:01" },
      { unread: false, starred: true, attached: true, sender: "DVLA", subject: "Tax", snippet: "due", date: "Mon" },
    ],
  };
  const text = formatGmailList(data, "Gmail inbox");
  assert.match(text, /TITLE_UNREAD: 12/);
  assert.match(text, /\*Primary 3 unread/);
  assert.match(text, /Promotions 9 unread/);
  assert.match(text, /probably in Promotions/);
  assert.match(text, /\[0\] UNREAD/);
  assert.match(text, /\[1\] STAR FILE/);
  assert.match(text, /Abi/);
  assert.equal(shouldSweepUnread(data), true);
  assert.equal(shouldSweepUnread(data, "is:unread"), false, "already searching — do not loop");
  assert.equal(shouldSweepUnread(data, undefined, "sent"), false);
});

test("Primary with a quiet title does not trigger a second unread pass", () => {
  const data: GmailList = {
    ready: true,
    url: "https://mail.google.com/mail/u/0/#inbox",
    unreadFromTitle: 1,
    tabs: [{ label: "Primary 1 unread", selected: true }],
    messages: [
      { unread: true, starred: false, attached: false, sender: "Abi", subject: "Hello", snippet: "hi", date: "4:01" },
    ],
  };
  assert.equal(shouldSweepUnread(data), false);
});

test("an unselected tab advertising unread is enough to sweep", () => {
  const data: GmailList = {
    ready: true,
    url: "https://mail.google.com/mail/u/0/#inbox",
    unreadFromTitle: null,
    tabs: [
      { label: "Primary", selected: true },
      { label: "Updates 4 unread", selected: false },
    ],
    messages: [],
  };
  assert.equal(shouldSweepUnread(data), true);
});

test("a thread formats every message, not just the last body", () => {
  const text = formatGmailThread({
    ok: true,
    subj: "Re: Quote",
    messages: [
      { from: "a@x", fromName: "Ann", date: "Mon", text: "Can you quote the Golf?" },
      { from: "chris@y", fromName: "Chris", date: "Tue", text: "Yes — sending today." },
    ],
  });
  assert.match(text, /2 message\(s\) in thread/);
  assert.match(text, /--- message 0 ---/);
  assert.match(text, /--- message 1 ---/);
  assert.match(text, /Can you quote the Golf/);
  assert.match(text, /sending today/);
});

test("page scripts are plain JS — TypeScript casts in a string would throw in Chrome", () => {
  for (const src of [GMAIL_LIST_JS, GMAIL_THREAD_JS, GMAIL_DRAFT_JS]) {
    assert.doesNotMatch(src, /\sas\s+[A-Z]/);
  }
});

test("gmail tools are on the roster, including draft and send", () => {
  const names = toolDefinitions.map((t) => t.name);
  for (const n of ["check_email", "read_email", "draft_email", "send_email", "email_action"]) {
    assert.ok(names.includes(n), n);
  }
  const send = toolDefinitions.find((t) => t.name === "send_email");
  assert.match(String(send?.description), /asks Chris first|Always asks/i);
  const action = toolDefinitions.find((t) => t.name === "email_action");
  const schema = action?.input_schema as { properties?: { action?: { enum?: string[] } } };
  for (const a of GMAIL_ACTIONS) {
    assert.ok(schema.properties?.action?.enum?.includes(a), a);
  }
});
