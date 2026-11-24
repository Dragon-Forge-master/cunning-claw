import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error — a plain .mjs build script with no types; imported for its pure helpers.
import { buildSiteSeo, faqJsonLd, faqPairs, FAQ_PAGES, LLMS_FILES, stampFaq, stampLlms, stampVersion, textOf } from "../scripts/site-seo.mjs";
import { MCP_CATALOGUE } from "./mcp-catalog.js";

/**
 * What cunningclaw.com tells search engines, language models and the people
 * who follow its links.
 *
 * The pages are static and hand-written, so nothing stopped the structured
 * data naming a version the downloads no longer give, an FAQ answer in the
 * JSON-LD saying something the page does not, a new page shipping with no
 * canonical link and missing from the sitemap, a "see all 95" link leading to
 * a list of eighty, or a download button pointing at last release's file. Each
 * is a claim a person cannot easily see to correct, which is the kind this
 * project is strictest about. These hold them to the page, the feed and the code.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = (rel: string) => fs.readFileSync(path.join(root, "site", rel), "utf-8");
const inSite = (rel: string) => fs.existsSync(path.join(root, "site", rel));
const feed = JSON.parse(site("latest.json"));

/** The pages a stranger can land on from a search, and the address each answers at. */
const PAGES: Record<string, string> = {
  "index.html": "https://cunningclaw.com/",
  "features.html": "https://cunningclaw.com/features",
  "install.html": "https://cunningclaw.com/install",
  "security.html": "https://cunningclaw.com/security",
  "vs-openclaw.html": "https://cunningclaw.com/vs-openclaw",
  "its-happening.html": "https://cunningclaw.com/its-happening",
  "about.html": "https://cunningclaw.com/about",
  "map.html": "https://cunningclaw.com/map",
};
/** The pages of prose, which share one bar, one footer and two stylesheets. */
const READING = ["features.html", "install.html", "security.html", "vs-openclaw.html", "about.html", "its-happening.html"];

const meta = (html: string, attr: "name" | "property", key: string) =>
  (html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`)) || [])[1];
const jsonLd = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const nodes = (html: string) => jsonLd(html).flatMap((d) => (d["@graph"] ? d["@graph"] : [d]));
const ofType = (html: string, type: string) => nodes(html).filter((n) => n["@type"] === type);
const between = (html: string, open: string, close: string) => html.slice(html.indexOf(open), html.indexOf(close, html.indexOf(open)) + close.length);

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
    assert.ok(inSite(image.slice("https://cunningclaw.com/".length)), `${rel}: ${image} is not in site/`);
  }
});

test("seo: the home page says what Cunning Claw is, in the words people search with, in its title, description and one heading", () => {
  const html = site("index.html");
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
  assert.match(title, /local AI agent/i, "the title pairs the name with what it is");
  assert.match(meta(html, "name", "description")!, /^Cunning Claw is a .*local AI agent/, "so does the description");
  // The headline is a promise, not a description, so the name and the description ride above it inside the same h1.
  const h1 = textOf((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/) || [])[1] ?? "");
  assert.match(h1, /Cunning Claw/, "the page's one heading names the product");
  assert.match(h1, /local AI agent/i, "and says what it is");
});

test("seo: every image says what it shows, and every film has captions and a poster this folder holds", () => {
  for (const rel of [...Object.keys(PAGES), "404.html"]) {
    // Comments aside: one of them explains why the mark is an <img>, and is not one.
    for (const [tag] of site(rel).replace(/<!--[\s\S]*?-->/g, "").matchAll(/<img\b[^>]*>/g)) assert.match(tag, /\salt="/, `${rel}: an image with no alt attribute: ${tag.slice(0, 80)}`);
  }
  const videos = [...site("index.html").matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>/g)];
  assert.ok(videos.length >= 3, "the three films");
  for (const [, attrs, inner] of videos) {
    const poster = (attrs.match(/poster="([^"]+)"/) || [])[1];
    assert.ok(poster && inSite(poster), `a film's poster is missing from site/: ${poster}`);
    assert.match(attrs, /preload="none"/, "no film bytes before the visitor presses play");
    const track = (inner.match(/<track kind="captions"[^>]*src="([^"]+)"/) || [])[1];
    assert.ok(track && inSite(track), `a film with no caption file in site/: ${track}`);
    assert.match(site(track!), /^WEBVTT/, `${track} is a WebVTT file`);
  }
});

test("seo: no page carries an inline script, an inline handler or a style attribute, so the site's content policy refuses nothing", () => {
  for (const rel of [...READING, "index.html", "404.html"]) {
    const html = site(rel);
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
      const src = (m[1].match(/src="([^"]+)"/) || [])[1];
      if (src) assert.ok(/^[a-z-]+\.js$/.test(src) && inSite(src), `${rel}: a script from somewhere other than this folder: ${src}`);
      else assert.match(m[1], /type="application\/ld\+json"/, `${rel}: an inline script the CSP would refuse`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/, `${rel}: an inline event handler`);
    assert.doesNotMatch(html, /\sstyle\s*=\s*["']/, `${rel}: an inline style attribute where the stylesheet should speak`);
    assert.match(html, /<link rel="stylesheet" href="site\.css">/, `${rel}: the site's stylesheet`);
  }
  for (const rel of [...READING, "404.html"]) assert.match(site(rel), /<link rel="stylesheet" href="site\.css">\n<link rel="stylesheet" href="page\.css">/, `${rel}: page.css after site.css, whose tokens it uses`);
  // page.css names no colour of its own: a change of theme is one edit, in site.css.
  assert.doesNotMatch(site("page.css").replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "page.css uses site.css's tokens, never a colour of its own");
});

test("seo: the reading pages and the not-found page share one bar and one footer, and the home page's footer leads to the same places", () => {
  const bar = (rel: string) => between(site(rel), '<header class="bar">', "</header>").replace(/ aria-current="page"/g, "");
  const foot = (rel: string) => between(site(rel), '<footer class="foot">', "</footer>");
  for (const rel of [...READING, "404.html"]) {
    assert.equal(bar(rel), bar(READING[0]), `${rel}: its bar differs from ${READING[0]}'s`);
    assert.equal(foot(rel), foot(READING[0]), `${rel}: its footer differs from ${READING[0]}'s`);
  }
  for (const rel of READING) assert.equal((site(rel).match(/aria-current="page"/g) || []).length <= 2, true, `${rel}: at most its own link is marked current, once in each menu`);
  const hrefs = (s: string) => [...s.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(hrefs(foot("index.html")), hrefs(foot(READING[0])), "the home page's footer links");
});

test("seo: the structured data names the released version, the maker and the source, and tells the product from the game", () => {
  const [app] = ofType(site("index.html"), "SoftwareApplication");
  assert.ok(app, "a SoftwareApplication on the home page");
  assert.equal(app.name, "Cunning Claw");
  assert.equal(app.softwareVersion, feed.version, "the version the downloads give — run `npm run site:seo`");
  assert.equal(app.releaseNotes, feed.notes);
  for (const name of ["Cunning Claw AI", "Y Dyn Hysbys"]) assert.ok(app.alternateName.includes(name), `alternateName includes ${name}`);
  assert.match(app.applicationCategory, /^(BusinessApplication|DeveloperApplication|ProductivityApplication)$/);
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
  // Every page's structured data parses, and each reading page says where it sits.
  for (const rel of READING) assert.equal(ofType(site(rel), "BreadcrumbList").length, 1, `${rel}: a breadcrumb`);
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
  const page = (list: string) => `<div class="faq">${list}</div>\n<script type="application/ld+json" id="ld-faq">\n{}\n</script>`;
  const html = page('<details open>\n<summary><h3>Is it <em>safe</em>?</h3></summary>\n<p>Partly &amp; it says so. <a href="/security">More</a>.</p>\n   <p><code>a &lt; b</code></p></details>');
  assert.deepEqual(faqPairs(html), [{ question: "Is it safe?", answer: "Partly & it says so. More. a < b" }]);
  const block = stampFaq(html).split('id="ld-faq">')[1].split("\n</script>")[0];
  assert.ok(!block.includes("<"), 'a "<" in an answer is escaped, so no answer can end the script element');
  assert.equal(JSON.parse(block).mainEntity[0].acceptedAnswer.text, "Partly & it says so. More. a < b");
  assert.equal(stampFaq(stampFaq(html)), stampFaq(html), "stamping twice changes nothing");
  // A question outside the one shape would vanish from the data without this.
  assert.throws(() => faqPairs(page("<details><summary>Loose?</summary><p>Yes.</p></details>")), /1 questions on the page but 0 read/);
  assert.throws(() => faqPairs(page("")), /0 questions on the page but 0 read/);
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

test("seo: every version a page names and every file it offers is the feed's, and the set-up page offers all of them", () => {
  const offered = new Set(Object.values(feed.downloads) as string[]);
  for (const rel of [...Object.keys(PAGES), "404.html"]) {
    const html = site(rel);
    for (const [, text] of html.matchAll(/<span data-rel="version">([^<]*)<\/span>/g)) assert.equal(text, `version ${feed.version}`, `${rel}: a version marker that is not the released one`);
    for (const [, href] of html.matchAll(/<a[^>]*data-rel="href"[^>]*href="([^"]+)"/g)) assert.ok(offered.has(href), `${rel}: offers ${href}, which the feed does not`);
    // Any link into a release's files, marked or not, must be this release's.
    for (const [, href] of html.matchAll(/href="(https:\/\/github\.com\/Dragon-Forge-master\/cunning-claw\/releases\/download\/[^"]+)"/g)) assert.ok(offered.has(href), `${rel}: links ${href}, which is not in the feed`);
  }
  const install = site("install.html");
  for (const [key, href] of Object.entries(feed.downloads)) assert.ok(install.includes(`href="${href}"`), `install.html does not offer ${key}`);
  const home = site("index.html");
  for (const key of ["nsis-win-x64", "dmg-darwin-arm64", "dmg-darwin-x64", "appimage-linux-x64"]) assert.ok(home.includes(`href="${feed.downloads[key]}"`), `the home page does not offer ${key}`);
});

test("seo: 'see all 95' is true: the features page names every connector in the catalogue, and says how many there are", () => {
  const html = site("features.html");
  const names = new Set([...between(html, '<div class="directory" id="directory">', "</section>").matchAll(/<li>([^<]+)<\/li>/g)].map((m) => textOf(m[1])));
  for (const c of MCP_CATALOGUE) assert.ok(names.has(c.label), `features.html does not list the ${c.label} connector`);
  const groups = [...html.matchAll(/<span>(\d+) connectors?\.<\/span>/g)].map((m) => Number(m[1]));
  assert.equal(groups.reduce((a, b) => a + b, 0), MCP_CATALOGUE.length, "the group counts add up to the catalogue");
  // The home page states the total in words and in a figure; both must be the catalogue's.
  const home = site("index.html");
  const rest = Number((home.match(/and (\d+) more\./) || [])[1]);
  const shown = [...between(home, '<div class="group group-cx">', "</div>").matchAll(/<li>/g)].length;
  assert.equal(shown + rest, MCP_CATALOGUE.length, "the home page's named connectors and 'more' add up");
  assert.ok(home.includes(`See all ${MCP_CATALOGUE.length}`));
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
  // Every page of ours that llms.txt points at is one the sitemap lists, and it points at all of them.
  const map = site("sitemap.xml");
  for (const [, url] of txt.matchAll(/\]\((https:\/\/cunningclaw\.com\/[^)]*)\)/g)) {
    if (/\.(txt|json)$/.test(url)) assert.ok(inSite(url.split("/").pop()!), `${url} is not in site/`);
    else assert.ok(map.includes(`<loc>${url}</loc>`), `${url} is in llms.txt but not the sitemap`);
  }
  for (const url of Object.values(PAGES)) assert.ok(txt.includes(`(${url})`), `llms.txt does not list ${url}`);
});

test("seo: the sitemap lists every page and nothing that is not one, robots.txt points at it, and a wrong address gets a real not-found page", () => {
  const map = site("sitemap.xml");
  const locs = [...map.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const url of Object.values(PAGES)) assert.ok(locs.includes(url), `${url} is missing from the sitemap`);
  for (const loc of locs) {
    const rel = loc === "https://cunningclaw.com/" ? "index.html" : `${loc.slice("https://cunningclaw.com/".length)}.html`;
    assert.ok(inSite(rel), `the sitemap lists ${loc}, but site/${rel} does not exist`);
  }
  for (const m of map.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) assert.match(m[1], /^\d{4}-\d{2}-\d{2}$/);
  const robots = site("robots.txt");
  assert.match(robots, /^Sitemap: https:\/\/cunningclaw\.com\/sitemap\.xml$/m);
  assert.match(robots, /^User-agent: \*\nAllow: \/$/m, "open to every crawler");
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
  // Without 404.html, Pages answers any unknown address with the home page and a 200: a soft 404.
  const lost = site("404.html");
  assert.match(lost, /<meta name="robots" content="noindex">/);
  assert.ok(!locs.some((l) => l.includes("404")), "the not-found page is not in the sitemap");
});

test("seo: the pages lead to each other, and no link on them or on the map points at a page or an anchor that is not there", () => {
  const home = site("index.html");
  for (const rel of READING) assert.ok(home.includes(`href="/${rel.replace(".html", "")}`), `the home page links /${rel.replace(".html", "")}`);
  for (const rel of [...READING, "404.html"]) {
    const html = site(rel);
    assert.ok(html.includes('href="/"'), `${rel}: a way home`);
    assert.ok(html.includes('href="/#get"'), `${rel}: a way to the download`);
  }
  const ids = (rel: string) => new Set([...site(rel).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const fileOf = (p: string) => (p === "/" ? "index.html" : p === "/pocket/" ? "pocket/index.html" : `${p.slice(1)}.html`);
  const check = (from: string, href: string, self: string) => {
    const [p, hash] = href.split("#");
    const target = p === "" ? self : fileOf(p);
    assert.ok(inSite(target), `${from}: ${href} leads to no page`);
    if (hash && target !== "pocket/index.html") assert.ok(ids(target).has(hash), `${from}: ${href} names an anchor ${target} does not have`);
  };
  for (const rel of [...Object.keys(PAGES), "404.html"]) {
    for (const [, href] of site(rel).matchAll(/href="((?:\/|#)[^"]*)"/g)) check(rel, href, rel);
  }
  // The map's doors are written as full addresses in map.js.
  for (const [, href] of site("map.js").matchAll(/u: "https:\/\/cunningclaw\.com(\/[^"]*)"/g)) check("map.js", href, "index.html");
  // Anchors other sites and old shares already point at, and the ids the wall's script looks up.
  for (const id of ["watch", "demo", "week", "attack", "connects", "get", "install", "pricing", "new", "ask"]) assert.ok(ids("index.html").has(id), `the home page lost #${id}, which is linked from elsewhere`);
  for (const id of ["wall-cards", "wall-count", "wall-fallback", "wall-form", "wall-form-wait", "wall-list-note", "wall-name", "wall-send", "wall-status", "wall-text", "wall-turnstile"]) {
    assert.equal((home.match(new RegExp(`\\sid="${id}"`, "g")) || []).length, 1, `wall.js looks up #${id}; the home page must have it exactly once`);
  }
});

test("seo: a page that shows an address or a mailto link tells Cloudflare not to rewrite it", () => {
  // Found on the live site, 23 November 2026: with scripts off the practice card read "To: [email protected]".
  for (const rel of [...Object.keys(PAGES), "404.html"]) {
    const html = site(rel).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--(?!\/?email_off)[\s\S]*?-->/g, "");
    const shielded = html.replace(/<!--email_off-->[\s\S]*?<!--\/email_off-->/g, "");
    assert.doesNotMatch(shielded, /[\w.+-]+@[\w-]+\.[\w.-]+|href="mailto:/, `${rel}: an address or mailto link outside <!--email_off-->`);
  }
  assert.match(site("index.html"), /<!--email_off-->[\s\S]*sian@hafodtimber\.example[\s\S]*<!--\/email_off-->/);
});

test("seo: the comparison says where each statement about the other project was read, and when", () => {
  const html = site("vs-openclaw.html");
  const rows = [...html.matchAll(/<tr id="[^"]+">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  assert.ok(rows.length >= 5, "at least the five questions");
  for (const row of rows) {
    const other = row.split("<td>")[2] ?? "";
    assert.match(other, /class="src">Read at <a href="https:\/\/docs\.openclaw\.ai\//, `a row about OpenClaw with no source: ${textOf(row).slice(0, 60)}`);
  }
  assert.match(textOf(html), /read on \d{1,2} \w+ 20\d\d/, "the date the other project's documentation was read");
  assert.match(textOf(html), /not been independently audited/, "our own limit, on the page that compares");
});
