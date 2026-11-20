import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { hostGate } from "./pocket-host.js";
import { IDENTITY_PATH, clawIdentity, compareVersions, identityRoute, portClashMessage, probePort, type Occupant } from "./port-clash.js";

/**
 * The founder double-clicked the v0.5.1 AppImage while his git install ran as
 * a service; it printed "Something is already running on port 3900 — opening
 * it. If that is not Cunning Claw, change server.port", and he could not tell
 * that it was his own claw. These pin who the port is taken to be, and the
 * words for each case.
 */

/** A stand-in for fetch: path → [status, body]; anything unlisted refuses the connection. */
function fakeFetch(routes: Record<string, [number, string]>) {
  const seen: string[] = [];
  const impl = async (url: string) => {
    const p = new URL(url).pathname;
    seen.push(p);
    const r = routes[p];
    if (!r) throw new TypeError("fetch failed");
    return new Response(r[1], { status: r[0] });
  };
  return { impl, seen };
}

const BASE = "http://127.0.0.1:3900";
const WELCOME = "<!doctype html><html><head><title>Welcome — Cunning Claw</title></head></html>";

test("a claw that says who it is is known by name and version", async () => {
  const f = fakeFetch({ [IDENTITY_PATH]: [200, JSON.stringify(clawIdentity("0.5.1"))] });
  assert.deepEqual(await probePort(BASE, f.impl), { kind: "claw", version: "0.5.1" });
  assert.deepEqual(f.seen, [IDENTITY_PATH], "one question is enough");
});

test("a claw from before the identity route is known by its setup page", async () => {
  // v0.5.1 and earlier: the route 404s, the setup page answers.
  const f = fakeFetch({ [IDENTITY_PATH]: [404, "Cannot GET"], "/welcome": [200, WELCOME] });
  assert.deepEqual(await probePort(BASE, f.impl), { kind: "claw", version: null });
});

test("anything else on the port is not taken for a claw", async () => {
  assert.deepEqual(await probePort(BASE, fakeFetch({}).impl), { kind: "other" }, "nothing that speaks HTTP");
  const web = fakeFetch({ [IDENTITY_PATH]: [200, '{"app":"something-else"}'], "/welcome": [200, "<title>Welcome to nginx!</title>"] });
  assert.deepEqual(await probePort(BASE, web.impl), { kind: "other" });
  const garbage = fakeFetch({ [IDENTITY_PATH]: [200, "not json"], "/welcome": [500, WELCOME] });
  assert.deepEqual(await probePort(BASE, garbage.impl), { kind: "other" }, "an error page is not a setup page");
});

test("a version that is not a version never reaches the screen", async () => {
  const f = fakeFetch({ [IDENTITY_PATH]: [200, JSON.stringify({ app: "cunning-claw", version: "1.0.0\u001b[2J; rm -rf ~" })] });
  assert.deepEqual(await probePort(BASE, f.impl), { kind: "claw", version: null });
});

test("versions compare by number, not by string", () => {
  assert.equal(compareVersions("0.5.1", "0.10.0"), -1);
  assert.equal(compareVersions("0.5.1", "0.5.1"), 0);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.5.1-rc.1", "0.5.1"), 0);
});

const base = { port: 3900, url: "http://127.0.0.1:3900/", ourVersion: "0.5.1", platform: "linux" as NodeJS.Platform, configFile: "~/.local/share/cunningclaw/claw.config.json" };
const say = (occupant: Occupant, extra: Partial<typeof base & { opened: boolean }> = {}) =>
  portClashMessage({ ...base, opened: true, occupant, ...extra }).join("\n");

test("another Cunning Claw, double-clicked: named, with its version, and opened", () => {
  const same = say({ kind: "claw", version: "0.5.1" });
  assert.equal(same, "Cunning Claw is already running on this computer (v0.5.1), so I've opened that one instead of starting a second copy.");
  assert.doesNotMatch(same, /Something|If that is not/, "no guessing left to the owner");
});

test("an older claw on the port says how to use this one instead", () => {
  const older = say({ kind: "claw", version: "0.4.0" }, { ourVersion: "0.5.1" });
  assert.match(older, /^Cunning Claw is already running on this computer \(v0\.4\.0\), so I've opened that one/);
  assert.match(older, /That one is older than this copy \(v0\.5\.1\)\. To use this one instead, stop the other first \(systemctl --user stop cunningclaw, if it runs as a service; otherwise close its window\), then start this again\./);
  const unknown = say({ kind: "claw", version: null });
  assert.match(unknown, /^Cunning Claw is already running on this computer, so I've opened that one/);
  assert.match(unknown, /does not say its version, so it is older than this copy \(v0\.5\.1\)/);
  assert.doesNotMatch(say({ kind: "claw", version: "0.4.0" }, { platform: "darwin" }), /systemctl/, "no systemd on a Mac");
  assert.doesNotMatch(say({ kind: "claw", version: "0.6.0" }), /older/, "a newer one is the one to keep");
});

test("from a terminal, it says where the running claw is instead of claiming to open it", () => {
  const t = say({ kind: "claw", version: "0.5.1" }, { opened: false });
  assert.equal(t, "Cunning Claw is already running on this computer (v0.5.1), at http://127.0.0.1:3900/ — so this copy has not started a second one.");
});

test("something else on the port: which port, and how to pick another", () => {
  const other = say({ kind: "other" });
  assert.match(other, /^Something else is using port 3900, so Cunning Claw cannot start\./);
  assert.match(other, /set "port" under "server" in ~\/\.local\/share\/cunningclaw\/claw\.config\.json \(3901, say\)/);
  assert.match(other, /ss -ltnp 'sport = :3900'/);
  assert.match(say({ kind: "other" }, { platform: "win32" }), /netstat -ano \| findstr :3900/);
  assert.doesNotMatch(other, /opened/);
});

test("the identity route says only name and version, and only to a name the host gate allows", async () => {
  const app = express();
  app.use(hostGate(() => ({ bindHost: "127.0.0.1", pocketHosts: ["claw-desk.tail1a2b3c.ts.net"] })));
  app.get(IDENTITY_PATH, identityRoute("9.8.7"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  // node:http, because fetch will not send a Host header of our choosing.
  const status = (host: string) => new Promise<number>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: IDENTITY_PATH, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on("error", reject);
  });
  try {
    const local = await fetch(`http://127.0.0.1:${port}${IDENTITY_PATH}`);
    assert.equal(local.status, 200);
    assert.deepEqual(Object.keys(await local.json()).sort(), ["app", "version"], "nothing personal: no name, no brain, no port list");
    assert.equal(local.headers.get("access-control-allow-origin"), null, "no CORS, so a web page cannot read it");
    assert.deepEqual(await probePort(`http://127.0.0.1:${port}`), { kind: "claw", version: "9.8.7" }, "the real fetch, end to end");
    assert.equal(await status(`rebind.attacker.example:${port}`), 421, "a rebinding page's name is refused");
    assert.equal(await status("claw-desk.tail1a2b3c.ts.net"), 404, "the tailnet name gets /pocket/ only");
  } finally {
    server.close();
  }
});
