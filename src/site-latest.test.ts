import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error — a plain .mjs build script with no types; imported for its pure helpers.
import { archiveName, INSTALLERS, installerName, TARGETS } from "../scripts/bundle.mjs";
import { compareSemver, DOWNLOAD_KEYS, MAX_FEED_BYTES, validateFeed } from "./updates.js";

/**
 * site/latest.json is the file every claw that said yes reads once a day.
 * A mistake in it lights the chip on every one of those claws at once, or
 * hides a security update from all of them, so it is held here to the same
 * validator the claw runs, and to the release it describes.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = fs.readFileSync(path.join(root, "site", "latest.json"), "utf-8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

test("site/latest.json passes the claw's own feed validation, well inside the size cap", () => {
  const out = validateFeed(JSON.parse(raw));
  assert.ok(out.ok, out.ok ? "" : `the claw would refuse it: ${out.why}`);
  assert.ok(Buffer.byteLength(raw) < MAX_FEED_BYTES / 4, "keep the feed small; the claw refuses anything over its cap");
  // Validation ignores what it does not know (so old claws survive a new
  // field); the file itself should carry nothing the claw would drop.
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ["date", "downloads", "notes", "security", "summary", "version"]);
  for (const k of Object.keys(parsed.downloads)) assert.ok((DOWNLOAD_KEYS as readonly string[]).includes(k), `downloads.${k} is a key no claw reads`);
  assert.ok(parsed.summary.length >= 1, "an update with nothing to say about it is no help on the panel");
});

/**
 * The rule: the feed's version may equal package.json's (the release is out
 * and the feed says so) or lag it (package.json has been bumped while the
 * release is being prepared, and the feed still names the last one that was
 * published — which is right, because its files exist). It may never be
 * newer: that is a feed announcing a version this code has never been, whose
 * downloads would be links to nothing. site/README.md's release checklist
 * updates the feed only after the release is published.
 */
test("site/latest.json is never newer than package.json", () => {
  const feed = JSON.parse(raw);
  assert.ok(compareSemver(feed.version, pkg.version) <= 0, `latest.json says ${feed.version} but package.json is ${pkg.version}`);
});

test("every download in site/latest.json is that release's asset, named as scripts/bundle.mjs names it", () => {
  const feed = JSON.parse(raw);
  const v = feed.version;
  const base = `https://github.com/Dragon-Forge-master/cunning-claw/releases/download/v${v}/`;
  assert.equal(feed.notes, `https://github.com/Dragon-Forge-master/cunning-claw/releases/tag/v${v}`);
  const expected: Record<string, string> = {};
  for (const [kind, os] of Object.entries(INSTALLERS as Record<string, string>)) {
    for (const [target, t] of Object.entries(TARGETS as Record<string, { os: string }>)) {
      if (t.os === os) expected[`${kind}-${target}`] = base + installerName(kind, v, target);
    }
  }
  for (const target of Object.keys(TARGETS)) expected[`archive-${target}`] = base + archiveName(v, target);
  if (compareSemver(v, pkg.version) === 0) {
    // At release time the feed names exactly what this code builds.
    assert.deepEqual(feed.downloads, expected, "one link per installer and archive the release builds, and no other");
  } else {
    // While the next version is being prepared the feed still names the last
    // published release, which may lack kinds added since (0.5.1 had no .deb):
    // every link it lists must still be that release's file, correctly named.
    for (const [key, url] of Object.entries(feed.downloads as Record<string, string>)) {
      assert.equal(url, expected[key], `${key} is named as scripts/bundle.mjs names it`);
    }
    assert.ok(Object.keys(feed.downloads).length > 0, "the feed offers at least one download");
  }
});

test("site/_headers gives latest.json a cache short enough to spread a release within the day", () => {
  const headers = fs.readFileSync(path.join(root, "site", "_headers"), "utf-8");
  const block = headers.split(/\n(?=\S)/).find((b) => b.startsWith("/latest.json"));
  assert.ok(block, "site/_headers has a /latest.json block");
  const age = Number(block.match(/Cache-Control:.*max-age=(\d+)/)?.[1]);
  assert.ok(age > 0 && age <= 6 * 3600, `max-age ${age}s: under six hours, so a daily check sees a new release the same day`);
  assert.doesNotMatch(block, /Access-Control-Allow-Origin/, "the claw fetches server-side; no page needs CORS to read it");
});
