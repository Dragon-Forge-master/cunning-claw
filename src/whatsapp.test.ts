import assert from "node:assert/strict";
import test from "node:test";
import {
  isWhatsAppUrl,
  pageHost,
  parseUnreadFromTitle,
  shouldReuseTab,
  formatWhatsAppList,
  formatWhatsAppThread,
  formatWhatsAppQr,
  formatWhatsAppOpenFailure,
  WA_STATE_JS,
  WA_THREAD_JS,
  WA_COMPOSE_JS,
  type WhatsAppState,
} from "./whatsapp.js";
import { toolDefinitions } from "./tools.js";

test("web.whatsapp.com is WhatsApp; a random host is not", () => {
  assert.equal(isWhatsAppUrl("https://web.whatsapp.com/"), true);
  assert.equal(isWhatsAppUrl("https://web.whatsapp.com/send?phone=44"), true);
  assert.equal(isWhatsAppUrl("https://mail.google.com/"), false);
});

test("reusing a tab matches host, so a loaded WhatsApp is not reloaded", () => {
  assert.equal(pageHost("https://www.web.whatsapp.com/foo"), "web.whatsapp.com");
  assert.equal(
    shouldReuseTab("https://web.whatsapp.com/", "https://web.whatsapp.com/send"),
    true,
  );
  assert.equal(shouldReuseTab("https://web.whatsapp.com/", "https://mail.google.com/"), false);
  assert.equal(shouldReuseTab("chrome://newtab/", "https://web.whatsapp.com/"), false);
});

test("the tab title (34) WhatsApp Business is the unread count Claude Code reads", () => {
  assert.equal(parseUnreadFromTitle("(34) WhatsApp Business"), 34);
  assert.equal(parseUnreadFromTitle("(1) WhatsApp"), 1);
  assert.equal(parseUnreadFromTitle("WhatsApp"), null);
  assert.equal(parseUnreadFromTitle("web.whatsapp.com"), null);
});

test("a chat list reports TITLE_UNREAD and numbered rows", () => {
  const data: WhatsAppState = {
    url: "https://web.whatsapp.com/",
    title: "(34) WhatsApp Business",
    unreadFromTitle: 34,
    qr: false,
    useHere: false,
    loading: false,
    ready: true,
    openChat: "",
    chats: [
      { name: "Ffion", preview: "Ffion: can you look at the Golf", time: "12:40", unread: 2, muted: false },
      { name: "Dave", preview: "Draft: thanks", time: "Yesterday", unread: 0, muted: true },
    ],
  };
  const text = formatWhatsAppList(data, "WhatsApp — 2 chats");
  assert.match(text, /TITLE_UNREAD: 34/);
  assert.match(text, /\[0\] 2 UNREAD 12:40 — Ffion/);
  assert.match(text, /\[1\] MUTED/);
});

test("a title count with an empty list is a lie — say so, the way Gmail's Primary miss is said", () => {
  const data: WhatsAppState = {
    url: "https://web.whatsapp.com/",
    title: "(34) WhatsApp Business",
    unreadFromTitle: 34,
    qr: false,
    useHere: false,
    loading: false,
    ready: true,
    openChat: "",
    chats: [],
  };
  const text = formatWhatsAppList(data, "WhatsApp — 0 chats");
  assert.match(text, /TITLE says 34 unread but this list shows none/);
});

test("an open thread is numbered, with YOU vs the contact", () => {
  const text = formatWhatsAppThread({
    ok: true,
    name: "Ffion",
    messages: [
      { outgoing: false, time: "12:01", text: "Can you quote the Golf" },
      { outgoing: true, time: "12:02", text: "sending today" },
    ],
  });
  assert.match(text, /CHAT: Ffion/);
  assert.match(text, /--- 0 Ffion/);
  assert.match(text, /--- 1 YOU/);
  assert.match(text, /Can you quote the Golf/);
});

test("QR copy names the Claw Chrome profile, not everyday Chrome", () => {
  const text = formatWhatsAppQr("/home/chris/.config/cunningclaw/chrome-profile");
  assert.match(text, /QR code/);
  assert.match(text, /cunningclaw\/chrome-profile/);
  assert.match(text, /everyday/);
});

test("open failure lists the tabs the debug port can see", () => {
  const text = formatWhatsAppOpenFailure({
    profileDir: "/tmp/claw-chrome",
    tabs: [{ title: "New Tab", url: "chrome://newtab/" }],
  });
  assert.match(text, /\[0\] New Tab/);
  assert.match(text, /\/tmp\/claw-chrome/);
});

test("page scripts are plain JS — TypeScript casts in a string would throw in Chrome", () => {
  for (const src of [WA_STATE_JS, WA_THREAD_JS, WA_COMPOSE_JS]) {
    assert.doesNotMatch(src, /\sas\s+[A-Z]/);
  }
});

test("whatsapp tools are on the roster, and send always asks", () => {
  const names = toolDefinitions.map((t) => t.name);
  for (const n of ["check_whatsapp", "read_chat", "draft_chat", "send_chat"]) {
    assert.ok(names.includes(n), n);
  }
  const send = toolDefinitions.find((t) => t.name === "send_chat");
  assert.match(String(send?.description), /asks Chris first|Always asks/i);
});
