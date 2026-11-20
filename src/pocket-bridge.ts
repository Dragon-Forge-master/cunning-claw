import http from "node:http";
import net from "node:net";
import express, { type RequestHandler } from "express";
import type { RelayLocals } from "./pocket.js";

/**
 * The relay is a transport, not a second Pocket. A request that arrives on an
 * authenticated end-to-end channel (src/pocket-relay.ts) is handed to the very
 * same Express router the tailnet name is served by — pocket.phone — with no
 * socket and no listener in between: a synthetic request goes in, the
 * response comes out as messages for the channel. So pairing, the lock
 * levels, the fresh assertion per card, revoke, receipts, shares, jobs and
 * push are Pocket's own code on both paths, and a fix to one is a fix to both.
 *
 * What the bridge sets, and the tailnet path's host gate would otherwise
 * decide: res.locals.pocket — the app's host and origin (cunningclaw.com),
 * and `relay`, naming the channel and the key it proved. Nothing a request
 * carries can set those. The Origin header is set here too, to the app's
 * origin, so Pocket's same-origin check holds as written: a request on the
 * channel came from the app that holds the channel's key, and no other page
 * can put one there.
 *
 * Only /pocket/api/ is reachable this way. The bridge app mounts the phone
 * router and nothing else, so the HUD's routes do not exist on this side.
 */

/** A request as the phone's transport sends it (docs/POCKET-RELAY.md, "Application messages"). */
export interface BridgeRequest {
  id: number;
  method: string;
  path: string;
  type?: string;
  body?: string;
  /** "b64" when the body is bytes (the mic's WAV); otherwise UTF-8 text. */
  enc?: "b64";
}

export type BridgeReply =
  | { t: "res"; id: number; status: number; type: string; body: string }
  | { t: "head"; id: number; status: number; type: string }
  | { t: "data"; id: number; body: string }
  | { t: "end"; id: number };

const METHODS = new Set(["GET", "POST", "DELETE"]);
const PATH = /^\/pocket\/api\/[A-Za-z0-9/_.~%-]{0,200}$/;
const TYPE = /^[a-z0-9.+/-]{1,80}(; ?charset=utf-8)?$/i;

/** Why a request is not one the bridge will dispatch, or null when it is. */
export function refuseRequest(m: unknown): string | null {
  const r = m as Partial<BridgeRequest> | null;
  if (!r || typeof r !== "object") return "not a request";
  if (!Number.isSafeInteger(r.id) || (r.id as number) < 0) return "bad id";
  if (typeof r.method !== "string" || !METHODS.has(r.method)) return "method must be GET, POST or DELETE";
  if (typeof r.path !== "string" || !PATH.test(r.path) || r.path.includes("..")) return "only /pocket/api/ paths";
  if (r.type !== undefined && (typeof r.type !== "string" || !TYPE.test(r.type))) return "bad content type";
  if (r.body !== undefined && typeof r.body !== "string") return "body must be a string";
  if (r.enc !== undefined && r.enc !== "b64") return "bad encoding";
  return null;
}

export interface Dispatched {
  /** The phone gave up on it (a closed stream), or the channel went away. */
  abort(): void;
}

export function createBridge(phone: RequestHandler, opts: { largeBodies: ReadonlySet<string>; host: string; origin: string }) {
  const app = express();
  app.disable("x-powered-by");
  // No conditional GETs through the channel: a 304 would be one more state to carry for nothing.
  app.set("etag", false);
  // The same body rule as server.ts: photo routes parse their own, larger bodies.
  const small = express.json({ limit: "1mb" });
  app.use((req, res, next) => (opts.largeBodies.has(req.path) ? next() : small(req, res, next)));
  app.use(phone);
  app.use((_req, res) => res.status(404).json({ error: "No such Pocket route." }));

  function dispatch(m: BridgeRequest, relay: RelayLocals, send: (reply: BridgeReply) => void): Dispatched {
    const body = m.body === undefined ? null : m.enc === "b64" ? Buffer.from(m.body, "base64") : Buffer.from(m.body, "utf8");
    const req = new http.IncomingMessage(new net.Socket());
    req.method = m.method;
    req.url = m.path;
    req.headers = {
      host: opts.host,
      origin: opts.origin,
      ...(body ? { "content-type": m.type ?? "application/json", "content-length": String(body.length) } : {}),
    };
    if (body) req.push(body);
    req.push(null);
    const res = new http.ServerResponse(req);
    // Express keeps any locals already there; these stand where the host gate's verdict would.
    (res as unknown as { locals: unknown }).locals = { pocket: { host: opts.host, origin: opts.origin, relay } };

    let done = false;
    let streaming = false;
    let status = 200;
    let type = "";
    const typeOf = (): string => {
      const t = res.getHeader("content-type");
      return String(type || t || "application/octet-stream");
    };
    const text = (chunk: unknown, encoding?: unknown): string =>
      chunk === undefined || chunk === null || typeof chunk === "function" ? ""
        : Buffer.isBuffer(chunk) ? chunk.toString("utf8")
          : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8")
            : Buffer.from(String(chunk), typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8").toString("utf8");
    const openStream = () => {
      if (streaming) return;
      streaming = true;
      send({ t: "head", id: m.id, status: res.statusCode || status, type: typeOf() });
    };

    const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => http.ServerResponse;
    (res as unknown as { writeHead: unknown }).writeHead = (code: number, ...rest: unknown[]) => {
      status = code;
      const hdrs = rest.find((x) => x && typeof x === "object") as Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(hdrs ?? {})) if (k.toLowerCase() === "content-type") type = String(v);
      return writeHead(code, ...rest);
    };
    (res as unknown as { write: unknown }).write = (chunk: unknown, encoding?: unknown) => {
      if (done) return false;
      openStream();
      const s = text(chunk, encoding);
      if (s) send({ t: "data", id: m.id, body: s });
      return true;
    };
    (res as unknown as { end: unknown }).end = (chunk?: unknown, encoding?: unknown) => {
      if (done) return res;
      done = true;
      const s = text(chunk, encoding);
      if (streaming) {
        if (s) send({ t: "data", id: m.id, body: s });
        send({ t: "end", id: m.id });
      } else {
        send({ t: "res", id: m.id, status: res.statusCode || status, type: typeOf(), body: s });
      }
      res.emit("finish");
      return res;
    };

    app(req as express.Request, res as unknown as express.Response, () => { /* the 404 above always answers */ });
    return {
      abort() {
        if (done) return;
        done = true;
        // Pocket's event stream cleans up on the request's close, as it does for a real socket.
        req.emit("close");
        res.emit("close");
      },
    };
  }

  return { dispatch };
}
