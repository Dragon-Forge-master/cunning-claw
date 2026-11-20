import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSitePocket, readSitePocket, SITE_MARK } from "../scripts/site-pocket.mjs";
import { onRequestPost } from "../site/functions/pocket/share.js";

/**
 * cunningclaw.com/pocket/ serves the phone app to anyone who pairs the easy
 * way, which makes the website part of the trust chain (docs/POCKET-RELAY.md,
 * "A compromised website"). These hold the line the repository can hold: the
 * site serves exactly the app in this repository, under a policy that lets
 * it load nothing else and talk to nothing but itself and the relay.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("site: site/pocket/ is public/pocket/ byte for byte, but for the one line that says it is the site and a release manifest of hashes", () => {
  const want = buildSitePocket();
  const have = readSitePocket();
  assert.deepEqual([...have.keys()].sort(), [...want.keys()].sort(), "the same files — run `npm run site:pocket`");
  for (const [rel, bytes] of want) assert.ok(bytes.equals(have.get(rel)!), `site/pocket/${rel} differs from public/pocket — run \`npm run site:pocket\``);
  // The release manifest names the version and pins every other file by hash.
  const release = JSON.parse(have.get("release.json")!.toString("utf8"));
  assert.equal(release.version, JSON.parse(read("package.json")).version);
  assert.deepEqual(Object.keys(release.sha256).sort(), [...have.keys()].filter((k) => k !== "release.json").sort());
  for (const [rel, hex] of Object.entries(release.sha256)) {
    assert.equal(crypto.createHash("sha256").update(have.get(rel)!).digest("hex"), hex, `release.json pins ${rel}`);
  }
  const html = have.get("index.html")!.toString("utf8");
  assert.ok(html.includes(SITE_MARK));
  assert.equal(html.replace(SITE_MARK, ""), read("public/pocket/index.html"));
});

test("site: the app's pages carry no inline script and load scripts from their own origin only", () => {
  for (const f of ["public/pocket/index.html", "site/pocket/index.html"]) {
    const html = read(f);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${f}: an inline <script>`);
    assert.doesNotMatch(html, /\son[a-z]+=/i, `${f}: an inline handler`);
    for (const m of html.matchAll(/<script[^>]*src="([^"]+)"/g)) assert.match(m[1], /^\/pocket\//, `${f}: ${m[1]}`);
  }
  // The transcript is model output and strangers' words: the phone sets text, never markup.
  for (const f of ["public/pocket/pocket.js", "public/pocket/relay.js", "public/pocket/e2e.js"]) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
  }
});

test("site: /pocket/ has a strict policy of its own that still lets it reach the relay, and only the relay", () => {
  const headers = read("site/_headers");
  const block = headers.slice(headers.indexOf("/pocket/*"));
  assert.ok(headers.indexOf("/pocket/*") > headers.indexOf("/*\n"), "the detach must come after the rule it detaches");
  assert.match(block, /^\s+! Content-Security-Policy$/m, "the homepage's policy is detached, not joined");
  const csp = /^\s+Content-Security-Policy: (.+)$/m.exec(block)![1];
  const dir = (name: string) => csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) ?? "";
  assert.equal(dir("default-src"), "default-src 'none'");
  assert.equal(dir("script-src"), "script-src 'self'");
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.equal(dir("frame-ancestors"), "frame-ancestors 'none'");
  // The relay this CSP allows is the relay the claw is configured for and the Worker is deployed at.
  const relay = new URL(JSON.parse(read("claw.config.json")).pocket.relay.url);
  assert.equal(dir("connect-src"), `connect-src 'self' wss://${relay.host}`);
  assert.match(read("relay/pocket/wrangler.toml"), new RegExp(`pattern = "${relay.host.replace(/\./g, "\\.")}"`));
  assert.equal(new URL(JSON.parse(read("claw.config.json")).pocket.relay.appOrigin).origin, "https://cunningclaw.com");
  assert.match(read("relay/pocket/wrangler.toml"), /ALLOWED_ORIGINS = "https:\/\/cunningclaw\.com"/);
});

test("site: a share that reaches the site before the service worker is installed is sent back to the app, not read", async () => {
  const res = onRequestPost();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/pocket/#share-unavailable");
});
