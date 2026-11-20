// The Pocket relay on Cloudflare: a Worker that routes each room to its own
// Durable Object, and the Durable Object that holds the room's WebSockets.
// All the judgement is in room.js; this file only adapts Cloudflare's
// WebSocket Hibernation API to it.
//
// Hibernation matters here because a claw stays connected all day. With
// ctx.acceptWebSocket (not ws.accept()), an idle room is evicted from memory
// and is not billed for duration; it wakes, constructor and all, when a frame
// arrives. Everything the room needs across that is in each socket's
// attachment, which is why room.js keeps no state of its own worth keeping.
// The "ping" keepalive is answered by the runtime without waking anything.
//
// No console.log anywhere, by rule: the relay logs nothing about anyone.
// wrangler.toml turns Workers Logs off as well; see README.md for what
// Cloudflare itself still records about every request.

import { DurableObject } from "cloudflare:workers";
import { CLOSE, Room } from "./room.js";

const ROOM_PATH = /^\/v1\/room\/([A-Za-z0-9_-]{43})$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "https://cunningclaw.com").split(",").map((s) => s.trim()).filter(Boolean);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true, service: "cunning-claw pocket relay", protocol: 1 });
    const m = ROOM_PATH.exec(url.pathname);
    if (!m) return json(404, { error: "not found" });
    if (request.method !== "GET" || request.headers.get("Upgrade") !== "websocket") return json(426, { error: "WebSocket upgrade required" });
    // Browsers always send Origin on a WebSocket; the claw (Node) sends none.
    // A page on some other site cannot use a visitor's browser to spend this
    // relay's connections. The end-to-end keys are what keep the content
    // safe; this only keeps strangers' pages off the meter.
    const origin = request.headers.get("Origin");
    if (origin && !allowedOrigins(env).includes(origin)) return json(403, { error: "origin not allowed" });
    if (env.CONNECT_LIMIT) {
      // Keyed by the connecting address for the 60 seconds the limiter
      // remembers it; nothing here writes it anywhere.
      const key = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.CONNECT_LIMIT.limit({ key });
      if (!success) return json(429, { error: "too many connections; wait a minute" });
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(request);
  },
};

/** One per room id. Holds the claw's socket and its phones' sockets, and nothing else. */
export class PocketRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the runtime itself, without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.rooms = new Map();
  }

  adapt(ws) {
    return {
      ws,
      send: (text) => ws.send(text),
      close: (code, reason) => ws.close(code, reason),
      get att() { return ws.deserializeAttachment(); },
      set att(v) { ws.serializeAttachment(v); },
    };
  }

  room(roomId) {
    let r = this.rooms.get(roomId);
    if (!r) {
      // Adapters are made afresh on every call; room.js recognises a socket
      // by its attachment's id, never by the wrapper object.
      r = new Room({ roomId, sockets: () => this.ctx.getWebSockets().map((ws) => this.adapt(ws)) });
      this.rooms.set(roomId, r);
    }
    return r;
  }

  roomOf(ws) {
    const att = ws.deserializeAttachment();
    return att && typeof att.room === "string" ? this.room(att.room) : null;
  }

  async fetch(request) {
    const m = ROOM_PATH.exec(new URL(request.url).pathname);
    if (!m) return new Response("not found", { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    this.room(m[1]).accept(this.adapt(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const r = this.roomOf(ws);
    if (!r) return ws.close(CLOSE.bad, "unknown socket");
    await r.message(this.adapt(ws), message);
  }

  async webSocketClose(ws, code, reason) {
    const r = this.roomOf(ws);
    if (r) r.closed(this.adapt(ws));
    // Complete the closing handshake, as the runtime expects of us.
    try { ws.close(code >= 3000 && code <= 4999 ? code : 1000, code >= 3000 && code <= 4999 ? reason : "bye"); } catch { /* already closed */ }
  }

  async webSocketError(ws) {
    const r = this.roomOf(ws);
    if (r) r.closed(this.adapt(ws));
  }
}
