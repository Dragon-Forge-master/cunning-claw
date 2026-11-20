import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequest, hostGate, normalisePocketHost, pocketDoctorLine, pocketOrigin, pocketRpId } from "./pocket-host.js";

/**
 * The loopback bind is not a boundary against a DNS-rebinding page, and a
 * tailnet proxy forwards whatever Host the client sends. These pin the one
 * rule that answers both: the HUD answers to loopback names only, Pocket to
 * the operator's listed names only, and everything else gets nothing.
 */

const OPTS = { bindHost: "127.0.0.1", pocketHosts: ["claw-desk.tail1a2b3c.ts.net"] };
const TS = { "x-forwarded-host": "claw-desk.tail1a2b3c.ts.net", "x-forwarded-for": "100.101.102.103", "x-forwarded-proto": "https", "tailscale-user-login": "owner@example.com" };

test("the HUD's own names are local", () => {
  for (const host of ["127.0.0.1:3900", "localhost:3900", "[::1]:3900", "LOCALHOST:3900"]) {
    assert.equal(classifyRequest({ host }, OPTS).kind, "local", host);
  }
});

test("a DNS-rebinding page's name is refused, so GET / cannot hand it the session", () => {
  const v = classifyRequest({ host: "rebind.attacker.example:3900", origin: "http://rebind.attacker.example:3900" }, OPTS);
  assert.equal(v.kind, "refused");
});

test("an unlisted name is refused even when it arrives through tailscale serve", () => {
  const v = classifyRequest({ host: "other-box.tail1a2b3c.ts.net", ...TS, "x-forwarded-host": "other-box.tail1a2b3c.ts.net" }, OPTS);
  assert.equal(v.kind, "refused");
});

test("a tailnet device that sends Host: 127.0.0.1 through the proxy is not local", () => {
  const v = classifyRequest({ host: "127.0.0.1:3900", ...TS, "x-forwarded-host": "127.0.0.1:3900" }, OPTS);
  assert.equal(v.kind, "refused");
  // Any one proxy header is enough to lose local standing.
  for (const h of ["x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip", "tailscale-user-login"]) {
    assert.equal(classifyRequest({ host: "localhost:3900", [h]: "1.2.3.4" }, OPTS).kind, "refused", h);
  }
});

test("the listed tailnet name through tailscale serve is Pocket, with an https origin", () => {
  const v = classifyRequest({ host: "claw-desk.tail1a2b3c.ts.net", ...TS }, OPTS);
  assert.deepEqual(v, { kind: "pocket", host: "claw-desk.tail1a2b3c.ts.net", origin: "https://claw-desk.tail1a2b3c.ts.net" });
});

test("a proxy whose X-Forwarded-Host disagrees with Host is refused", () => {
  const v = classifyRequest({ host: "claw-desk.tail1a2b3c.ts.net", ...TS, "x-forwarded-host": "evil.example" }, OPTS);
  assert.equal(v.kind, "refused");
});

test("pocket hosts: DNS names only, never an IP or a loopback name", () => {
  assert.equal(normalisePocketHost("Claw-Desk.tail1a2b3c.ts.net"), "claw-desk.tail1a2b3c.ts.net");
  assert.equal(normalisePocketHost("https://claw-desk.tail1a2b3c.ts.net/pocket/"), "claw-desk.tail1a2b3c.ts.net");
  assert.equal(normalisePocketHost("pocket.localhost:3911"), "pocket.localhost:3911");
  for (const bad of ["localhost", "127.0.0.1", "100.101.102.103", "[::1]", "no-dot", "a..b", "-x.ts.net", "x.ts.net:99999", "x y.ts.net", 7]) {
    assert.equal(normalisePocketHost(bad), null, String(bad));
  }
});

test("origin and rpId: https for real names, http only for .localhost test names", () => {
  assert.equal(pocketOrigin("claw-desk.tail1a2b3c.ts.net"), "https://claw-desk.tail1a2b3c.ts.net");
  assert.equal(pocketOrigin("pocket.localhost:3911"), "http://pocket.localhost:3911");
  assert.equal(pocketRpId("pocket.localhost:3911"), "pocket.localhost");
});

function run(gate: ReturnType<typeof hostGate>, host: string, path: string, extra: Record<string, string> = {}) {
  const out: { status: number; nexted: boolean; locals: any; location?: string } = { status: 200, nexted: false, locals: {} };
  const res: any = {
    locals: out.locals,
    status(s: number) { out.status = s; return res; },
    type() { return res; },
    send() { return res; },
    json() { return res; },
    redirect(s: number, loc: string) { out.status = s; out.location = loc; return res; },
  };
  gate({ headers: { host, ...extra }, path } as any, res, () => { out.nexted = true; });
  return out;
}

test("the gate: the tailnet name sees /pocket/ and nothing of the HUD", () => {
  const gate = hostGate(() => OPTS);
  const host = "claw-desk.tail1a2b3c.ts.net";
  assert.equal(run(gate, host, "/pocket/", TS).nexted, true);
  assert.equal(run(gate, host, "/pocket/api/me", TS).locals.pocket.origin, `https://${host}`);
  for (const p of ["/index.html", "/api/chat", "/api/events", "/keys", "/board", "/served/x/y", "/pocketx"]) {
    const r = run(gate, host, p, TS);
    assert.equal(r.nexted, false, p);
    assert.equal(r.status, 404, p);
  }
  assert.equal(run(gate, host, "/", TS).location, "/pocket/");
});

test("the gate: an unlisted Host gets 421 and never reaches a route", () => {
  const gate = hostGate(() => OPTS);
  const r = run(gate, "evil.example:3900", "/");
  assert.equal(r.status, 421);
  assert.equal(r.nexted, false);
  assert.equal(run(gate, "127.0.0.1:3900", "/").nexted, true);
});

test("the doctor line is informational when tailscale is missing", () => {
  const off = pocketDoctorLine(false, []);
  assert.equal(off.status, "warn");
  assert.match(off.text, /tailscale not found/);
  assert.match(off.text, /POCKET-CLAW\.md/);
  assert.match(off.text, /https:\/\/tailscale\.com\/download/, "a warned line names its fix");
  assert.equal(pocketDoctorLine(true, ["claw-desk.tail1a2b3c.ts.net"]).status, "ok");
});
