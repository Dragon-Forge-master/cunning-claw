import assert from "node:assert/strict";
import test from "node:test";
import { ensureToken, currentToken, requireAuth, issueSession, COOKIE } from "./auth.js";

/**
 * Binding to loopback is not a permission boundary. Any process running as this
 * user could otherwise POST to /api/chat and get a shell through CUNNING CLAW.
 */

ensureToken();
const TOKEN = currentToken();

function call(headers: Record<string, string | undefined>, method = "POST") {
  let status = 0;
  let body: any = null;
  let nexted = false;
  const res: any = {
    status(s: number) { status = s; return res; },
    json(b: any) { body = b; return res; },
    setHeader() {},
  };
  requireAuth({ headers, method } as any, res, () => { nexted = true; });
  return { status, body, nexted };
}

test("a token is generated and is not guessable", () => {
  assert.ok(TOKEN.length >= 32, "token must be long");
  assert.notEqual(TOKEN, "cunningclaw");
});

test("an unauthenticated request is refused", () => {
  const r = call({});
  assert.equal(r.nexted, false, "must not reach the handler");
  assert.equal(r.status, 401);
});

test("a wrong token is refused", () => {
  assert.equal(call({ authorization: "Bearer not-the-token" }).nexted, false);
});

test("a token of the wrong length is refused without throwing", () => {
  // timingSafeEqual throws on length mismatch if lengths are not checked first.
  assert.doesNotThrow(() => call({ authorization: "Bearer x" }));
  assert.equal(call({ authorization: "Bearer x" }).nexted, false);
});

test("a bearer token authenticates a script", () => {
  assert.equal(call({ authorization: `Bearer ${TOKEN}` }).nexted, true);
});

test("the session cookie authenticates the HUD's event stream", () => {
  // EventSource cannot set headers, so the cookie is the only way SSE authenticates.
  assert.equal(call({ cookie: `${COOKIE}=${encodeURIComponent(TOKEN)}` }, "GET").nexted, true);
});

test("a cookie among others is still found", () => {
  const r = call({ cookie: `theme=dark; ${COOKIE}=${encodeURIComponent(TOKEN)}; x=1` }, "GET");
  assert.equal(r.nexted, true);
});

test("a cross-site POST carrying our cookie is refused (CSRF)", () => {
  const r = call({
    cookie: `${COOKIE}=${encodeURIComponent(TOKEN)}`,
    origin: "https://evil.example",
    host: "127.0.0.1:3900",
  });
  assert.equal(r.nexted, false, "another site must not ride the session cookie");
  assert.equal(r.status, 403);
});

test("a same-origin POST from the HUD is allowed", () => {
  const r = call({
    cookie: `${COOKIE}=${encodeURIComponent(TOKEN)}`,
    origin: "http://127.0.0.1:3900",
    host: "127.0.0.1:3900",
  });
  assert.equal(r.nexted, true);
});

test("the session cookie is HttpOnly and SameSite=Strict", () => {
  let header = "";
  issueSession({ setHeader: (_k: string, v: string) => { header = v; } } as any);
  assert.match(header, /HttpOnly/, "page scripts must not read it");
  assert.match(header, /SameSite=Strict/, "this is what blocks CSRF at the browser");
});
