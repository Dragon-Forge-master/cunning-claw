import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error — a plain .mjs build script with no types; imported for its pure helpers.
import { buildSiteSeo, faqJsonLd, faqPairs, FAQ_PAGES, LLMS_FILES, stampFaq, stampLlms, stampVersion, textOf } from "../scripts/site-seo.mjs";

/**
 * What search engines and language models are told about Cunning Claw.
 *
 * The pages are static and hand-written, so nothing stopped the structured
 * data naming a version the downloads no longer give, an FAQ answer in the
 * JSON-LD saying something the page does not, or a new page shipping with no
 * canonical link and missing from the sitemap. Each of those is a claim made
 * to a machine that a person cannot see to correct, which is the kind this
 * project is strictest about. These hold them to the page and to the feed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = (rel: string) => fs.readFileSync(path.join(root, "site", rel), "utf-8");
const feed = JSON.parse(site("latest.json"));

/** The pages a stranger can land on from a search, and the address each answers at. */
const PAGES: Record<string, string> = {
  "index.html": "https://cunningclaw.com/",
  "security.html": "https://cunningclaw.com/security",
  "vs-openclaw.html": "https://cunningclaw.com/vs-openclaw",
  "map.html": "https://cunningclaw.com/map",
};

const meta = (html: string, attr: "name" | "property", key: string) =>
  (html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`)) || [])[1];
const jsonLd = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const nodes = (html: string) => jsonLd(html).flatMap((d) => (d["@graph"] ? d["@graph"] : [d]));
const ofType = (html: string, type: string) => nodes(html).filter((n) => n["@type"] === type);

test("seo: every page has one h1, a UK-English lang, a title and description of a length a result page shows, and its own canonical", () => {
  const titles = new Set<string>();
  for (const [rel, url] of Object.entries(PAGES)) {
    const html = site(rel);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${rel}: exactly one h1`);
    assert.match(html, /<html lang="en-GB">/, `${rel}: lang`);
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] ?? "";
    assert.ok(title.length >= 20 && title.length <= 60, `${rel}: title is ${title.length} characters; keep it within 20 to 60`);
    assert.match(title, /Cunning Claw/, `${rel}: the title names the product`);
    assert.ok(!titles.has(title), `${rel}: a title shared with another page`);
    titles.add(title);
    const desc = meta(html, "name", "description") ?? "";
    assert.ok(desc.length >= 70 && desc.length <= 175, `${rel}: description is ${desc.length} characters; keep it within 70 to 175`);
    assert.equal((html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1], url, `${rel}: canonical`);
    assert.equal(meta(html, "property", "og:url"), url, `${rel}: og:url matches the canonical`);
    for (const key of ["og:title", "og:description", "og:image"]) assert.ok(meta(html, "property", key), `${rel}: ${key}`);
    for (const key of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) assert.ok(meta(html, "name", key), `${rel}: ${key}`);
    // The share image has to be a file this folder really serves.
    const image = meta(html, "property", "og:image")!;
    assert.ok(image.startsWith("https://cunningclaw.com/"), `${rel}: og:image is absolute and ours`);
    assert.ok(fs.existsSync(path.join(root, "site", image.slice("https://cunningclaw.com/".length))), `${rel}: ${image} is not in site/`);
  }
});

test("seo: the home page says what Cunning Claw is, in the words people search with, beside the name", () => {
  const html = site("index.html");
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
  assert.match(title, /local AI agent/i, "the title pairs the name with what it is");
  assert.match(meta(html, "name", "description")!, /^Cunning Claw is a .*local AI agent/, "so does the description");
});

test("seo: every image says what it shows, and only a decorative one may say nothing", () => {
  for (const rel of Object.keys(PAGES)) {
    // Comments aside: one of them explains why the mark is an <img>, and is not one.
    for (const [tag] of site(rel).replace(/<!--[\s\S]*?-->/g, "").matchAll(/<img\b[^>]*>/g)) assert.match(tag, /\salt="/, `${rel}: an image with no alt attribute: ${tag.slice(0, 80)}`);
  }
  // The two reading pages carry the mark beside the wordmark; the wordmark is its text, so the image stays silent.
  for (const rel of ["security.html", "vs-openclaw.html"]) assert.match(site(rel), /<img src="forge-mark-cyan\.svg" alt=""/);
});

test("seo: the reading pages obey the site's content policy: no inline script, no inline handler, their stylesheet from this folder", () => {
  for (const rel of ["security.html", "vs-openclaw.html"]) {
    const html = site(rel);
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /type="application\/ld\+json"/, `${rel}: a script the CSP would refuse`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/, `${rel}: an inline event handler`);
    assert.doesNotMatch(html, /\sstyle\s*=\s*["']/, `${rel}: an inline style attribute where the stylesheet should speak`);
    assert.match(html, /<link rel="stylesheet" href="page\.css">/);
    assert.ok(fs.existsSync(path.join(root, "site", "page.css")));
  }
});

test("seo: the structured data names the released version, the maker and the source, and tells the product from the game", () => {
  const [app] = ofType(site("index.html"), "SoftwareApplication");
  assert.ok(app, "a SoftwareApplication on the home page");
  assert.equal(app.name, "Cunning Claw");
  assert.equal(app.softwareVersion, feed.version, "the version the downloads give — run `npm run site:seo`");
  assert.equal(app.releaseNotes, feed.notes);
  for (const name of ["Cunning Claw AI", "Y Dyn Hysbys"]) assert.ok(app.alternateName.includes(name), `alternateName includes ${name}`);
  assert.match(app.applicationCategory, /^(DeveloperApplication|ProductivityApplication)$/);
  for (const os of ["Linux", "macOS", "Windows"]) assert.match(app.operatingSystem, new RegExp(os));
  assert.equal(app.offers.price, "0");
  assert.ok(app.sameAs.includes("https://github.com/Dragon-Forge-master/cunning-claw"), "sameAs links the repository");
  assert.match(app.disambiguatingDescription, /Diablo II/, "says it is not the game's item");
  // No rating and no review: there are none, and structured data must not invent them.
  assert.equal(app.aggregateRating, undefined);
  assert.equal(app.review, undefined);
  const [org] = ofType(site("index.html"), "Organization");
  assert.equal(app.author["@id"], org["@id"]);
  assert.equal(org.name, "Dragon Forge AI");
  assert.equal(org.address.addressLocality, "Cardiff");
});

test("seo: each FAQPage is the page's own questions and answers, word for word", () => {
  for (const rel of FAQ_PAGES) {
    const html = site(rel);
    const pairs = faqPairs(html);
    assert.ok(pairs.length >= 6, `${rel}: at least six questions`);
    const [faq] = ofType(html, "FAQPage");
    assert.ok(faq, `${rel}: a FAQPage block`);
    assert.deepEqual(
      faq.mainEntity.map((q: { name: string; acceptedAnswer: { text: string } }) => ({ question: q.name, answer: q.acceptedAnswer.text })),
      pairs,
      `${rel}: the JSON-LD and the visible answers differ — run \`npm run site:seo\``,
    );
    // Whatever a machine is told, a reader can find on the page.
    const seen = textOf(html.replace(/<script[\s\S]*?<\/script>/g, ""));
    for (const p of pairs) assert.ok(seen.includes(p.answer), `${rel}: "${p.question}" is answered in the data but not on the page`);
  }
});

test("seo: the generator reads questions as a reader does, refuses a shape it would lose, and cannot be closed by an answer", () => {
  const page = (dl: string) => `<dl class="faq">${dl}</dl>\n<script type="application/ld+json" id="ld-faq">\n{}\n</script>`;
  const html = page('<div><dt>Is it <em>safe</em>?</dt><dd>Partly &amp; it says so. <a href="/security">More</a>.\n   <code>a &lt; b</code></dd></div>');
  assert.deepEqual(faqPairs(html), [{ question: "Is it safe?", answer: "Partly & it says so. More. a < b" }]);
  const block = stampFaq(html).split('id="ld-faq">')[1].split("\n</script>")[0];
  assert.ok(!block.includes("<"), 'a "<" in an answer is escaped, so no answer can end the script element');
  assert.equal(JSON.parse(block).mainEntity[0].acceptedAnswer.text, "Partly & it says so. More. a < b");
  assert.equal(stampFaq(stampFaq(html)), stampFaq(html), "stamping twice changes nothing");
  // A question outside the one-div shape would vanish from the data without this.
  assert.throws(() => faqPairs(page("<dt>Loose?</dt><dd>Yes.</dd>")), /1 questions on the page but 0 read/);
  assert.throws(() => faqPairs("<p>no list</p>"), /expected one/);
  assert.throws(() => textOf("caf&eacute;"), /entity &eacute;/);
  assert.match(faqJsonLd([{ question: "q", answer: "a" }]), /"@type":"FAQPage"/);
});

test("seo: a release moves the version in the structured data and in both llms files", () => {
  const next = { ...feed, version: "9.9.9", date: "2031-01-02", notes: "https://example.test/notes" };
  const [app] = ofType(stampVersion(site("index.html"), next), "SoftwareApplication");
  assert.equal(app.softwareVersion, "9.9.9");
  assert.equal(app.releaseNotes, "https://example.test/notes");
  for (const rel of LLMS_FILES) {
    const out = stampLlms(site(rel), next);
    assert.match(out, /^- Current release: 9\.9\.9, published 2031-01-02\. Release notes: https:\/\/example\.test\/notes$/m);
    assert.ok(!out.includes(`Current release: ${feed.version},`), `${rel}: the old release line is gone`);
  }
  assert.throws(() => stampLlms("# no such line", next), /Current release/);
  assert.throws(() => stampVersion("<html></html>", next), /softwareVersion/);
});

test("seo: nothing the generator owns has drifted from the page or the feed", () => {
  for (const [rel, want] of buildSiteSeo()) assert.equal(site(rel), want, `site/${rel} is stale — run \`npm run site:seo\``);
});

test("seo: llms.txt follows llmstxt.org and states the facts a model most often gets wrong", () => {
  const txt = site("llms.txt");
  const lines = txt.split("\n");
  assert.equal(lines[0], "# Cunning Claw", "an H1 with the name, first");
  assert.equal(lines.filter((l) => l.startsWith("# ")).length, 1, "one H1");
  assert.match(lines.find((l) => l.trim() && !l.startsWith("#"))!, /^> /, "then a blockquote summary");
  assert.ok(lines.some((l) => l === "## Optional"), "the section a short context may skip");
  // Under each H2, a list of links with a note.
  let section = "";
  for (const l of lines) {
    if (l.startsWith("## ")) section = l;
    else if (section && l.trim()) assert.match(l, /^- \[[^\]]+\]\(https:\/\/[^)\s]+\): \S/, `under "${section}": ${l}`);
  }
  for (const rel of LLMS_FILES) {
    const t = site(rel);
    assert.ok(t.includes(`Current release: ${feed.version}, published ${feed.date}`), `${rel}: names the released version`);
    assert.match(t, /Diablo II/, `${rel}: tells the product from the game`);
    assert.match(t, /Dragon Forge AI/);
    assert.match(t, /not (been )?independently audited/, `${rel}: carries the limit with the claim`);
    assert.match(t, /https:\/\/github\.com\/Dragon-Forge-master\/cunning-claw/);
  }
  // Every page of ours that llms.txt points at is one the sitemap lists.
  const map = site("sitemap.xml");
  for (const [, url] of txt.matchAll(/\]\((https:\/\/cunningclaw\.com\/[^)]*)\)/g)) {
    if (/\.(txt|json)$/.test(url)) assert.ok(fs.existsSync(path.join(root, "site", url.split("/").pop()!)), `${url} is not in site/`);
    else assert.ok(map.includes(`<loc>${url}</loc>`), `${url} is in llms.txt but not the sitemap`);
  }
});

test("seo: the sitemap lists every page and nothing that is not one, and robots.txt points at it", () => {
  const map = site("sitemap.xml");
  const locs = [...map.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const url of Object.values(PAGES)) assert.ok(locs.includes(url), `${url} is missing from the sitemap`);
  for (const loc of locs) {
    const rel = loc === "https://cunningclaw.com/" ? "index.html" : `${loc.slice("https://cunningclaw.com/".length)}.html`;
    assert.ok(fs.existsSync(path.join(root, "site", rel)), `the sitemap lists ${loc}, but site/${rel} does not exist`);
  }
  for (const m of map.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) assert.match(m[1], /^\d{4}-\d{2}-\d{2}$/);
  const robots = site("robots.txt");
  assert.match(robots, /^Sitemap: https:\/\/cunningclaw\.com\/sitemap\.xml$/m);
  assert.match(robots, /^User-agent: \*\nAllow: \/$/m, "open to every crawler");
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
});

test("seo: the pages lead to each other, and no link on them points at a page or an anchor that is not there", () => {
  const home = site("index.html");
  for (const href of ["/security", "/vs-openclaw"]) assert.ok(home.includes(`href="${href}"`), `the home page links ${href}`);
  for (const rel of ["security.html", "vs-openclaw.html"]) {
    const html = site(rel);
    assert.ok(html.includes('href="/"'), `${rel}: a way home`);
    assert.ok(html.includes('href="/#get"'), `${rel}: a way to the download`);
  }
  assert.ok(site("security.html").includes('href="/vs-openclaw"') && site("vs-openclaw.html").includes('href="/security"'));
  const ids = (rel: string) => new Set([...site(rel).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const fileOf = (p: string) => (p === "/" ? "index.html" : `${p.slice(1)}.html`);
  for (const rel of Object.keys(PAGES)) {
    for (const [, href] of site(rel).matchAll(/href="((?:\/|#)[^"]*)"/g)) {
      const [p, hash] = href.split("#");
      const target = p === "" ? rel : p === "/pocket/" ? "pocket/index.html" : fileOf(p);
      assert.ok(fs.existsSync(path.join(root, "site", target)), `${rel}: ${href} leads to no page`);
      if (hash && target !== "pocket/index.html") assert.ok(ids(target).has(hash), `${rel}: ${href} names an anchor ${target} does not have`);
    }
  }
});

test("seo: the comparison says where each statement about the other project was read, and when", () => {
  const html = site("vs-openclaw.html");
  const rows = [...html.matchAll(/<tr id="[^"]+">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  assert.ok(rows.length >= 5, "at least the five questions");
  for (const row of rows) {
    const other = row.split("<td>")[2] ?? "";
    // The last row has no source line only if it makes no claim; none does today.
    assert.match(other, /class="src">Read at <a href="https:\/\/docs\.openclaw\.ai\//, `a row about OpenClaw with no source: ${textOf(row).slice(0, 60)}`);
  }
  assert.match(textOf(html), /read on \d{1,2} \w+ 20\d\d/, "the date the other project's documentation was read");
  assert.match(textOf(html), /not been independently audited/, "our own limit, on the page that compares");
});
