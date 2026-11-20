// Pocket Claw's service worker. It caches the shell and nothing else: the
// page, its style, its script, its icons. Every /pocket/api/ request goes to
// the network untouched — the conversation, the cards and the history are
// never written to a cache on the phone. The one other thing it holds is a
// file shared from another app, for the instant between Android handing it
// over and the page taking it (the page deletes it as it reads it).
"use strict";

const SHELL = "pocket-shell-v2";
const INBOX = "pocket-share-inbox";
const FILES = [
  "/pocket/",
  "/pocket/pocket.css",
  "/pocket/pocket.js",
  "/pocket/relay.js",
  "/pocket/e2e.js",
  "/pocket/manifest.webmanifest",
  "/pocket/icons/mark.svg",
  "/pocket/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== INBOX) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function takeShare(request) {
  try {
    const form = await request.formData();
    const inbox = await caches.open(INBOX);
    let i = 0;
    for (const f of form.getAll("file")) {
      if (!(f instanceof File) || i >= 4) continue;
      await inbox.put(`/pocket/__inbox/${Date.now()}-${i++}`, new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream" } }));
    }
  } catch { /* nothing usable was shared; the page says so */ }
  return Response.redirect("/pocket/#share", 303);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === "POST" && url.pathname === "/pocket/share") {
    event.respondWith(takeShare(req));
    return;
  }
  if (req.method !== "GET" || url.pathname.startsWith("/pocket/api/")) return;
  const isShell = req.mode === "navigate" || FILES.includes(url.pathname);
  if (!isShell) return;
  // Network first, so a fixed page reaches the phone at once; the cached
  // shell is only for when home cannot be reached.
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh.ok && FILES.includes(url.pathname)) {
        const copy = fresh.clone();
        caches.open(SHELL).then((c) => c.put(url.pathname, copy)).catch(() => {});
      }
      return fresh;
    } catch {
      const cached = await caches.match(req.mode === "navigate" ? "/pocket/" : url.pathname);
      return cached || new Response("Pocket Claw cannot load: this phone is offline, or cannot reach where the app lives.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  })());
});

// A count and a label only: the claw never sends a card's text to the push service.
self.addEventListener("push", (event) => {
  let msg = { title: "Pocket Claw", body: "An approval is waiting", tag: "approvals", url: "/pocket/#approvals" };
  try { msg = { ...msg, ...event.data.json() }; } catch { /* keep the default */ }
  event.waitUntil(self.registration.showNotification(String(msg.title), {
    body: String(msg.body),
    tag: String(msg.tag),
    renotify: true,
    icon: "/pocket/icons/icon-192.png",
    badge: "/pocket/icons/badge-96.png",
    data: { url: String(msg.url).startsWith("/pocket/") ? msg.url : "/pocket/#approvals" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/pocket/#approvals";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).pathname.startsWith("/pocket/")) {
        await c.focus();
        return c.navigate(url).catch(() => {});
      }
    }
    return self.clients.openWindow(url);
  })());
});
