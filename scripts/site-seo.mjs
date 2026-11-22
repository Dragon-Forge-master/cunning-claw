// Keeps the site's machine-read facts in step with what a visitor can read.
//
//   npm run site:seo      (after changing a page's questions, or site/latest.json)
//
// Three things on cunningclaw.com are read by search engines and language
// models rather than people, and each used to be free to drift from the page:
//
//   - The FAQPage structured data. Google's rule, and plain honesty, is that
//     it says what the page says. So it is never written by hand: this script
//     reads each page's own <dl class="faq"> and writes the JSON-LD from it.
//   - The version in the SoftwareApplication structured data, and the link to
//     its release notes. Both come from site/latest.json, the same feed the
//     claws read, so the page cannot announce a version the downloads lack.
//   - The "Current release" line in llms.txt and llms-full.txt, likewise.
//
// src/site-seo.test.ts fails if any of the three differs from this output,
// which is the same bargain scripts/site-pocket.mjs makes for the phone app.
// No parser is pulled in: the pages are ours, and the few shapes read here
// (one dl, one div per question) are checked by that test.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SITE = path.join(ROOT, "site");
/** Pages whose questions are published as FAQPage data. */
export const FAQ_PAGES = ["index.html", "security.html", "vs-openclaw.html"];
export const LLMS_FILES = ["llms.txt", "llms-full.txt"];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rarr: "→", hellip: "…", mdash: "—", ndash: "–" };

/** The words a reader sees in a fragment of HTML: tags gone, entities decoded, runs of space collapsed. */
export function textOf(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/g, (m, name) => {
      if (!(name in ENTITIES)) throw new Error(`site-seo: entity ${m} is not one this script knows; add it or spell the character`);
      return ENTITIES[name];
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Each question and answer in the page's <dl class="faq">, as the reader sees them. */
export function faqPairs(html) {
  const lists = [...html.matchAll(/<dl class="faq">([\s\S]*?)<\/dl>/g)];
  if (lists.length !== 1) throw new Error(`site-seo: expected one <dl class="faq">, found ${lists.length}`);
  const pairs = [...lists[0][1].matchAll(/<div><dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd><\/div>/g)]
    .map((m) => ({ question: textOf(m[1]), answer: textOf(m[2]) }));
  // A question written in some other shape would silently go missing from the data.
  const asked = (lists[0][1].match(/<dt>/g) || []).length;
  if (pairs.length !== asked) throw new Error(`site-seo: ${asked} questions on the page but ${pairs.length} read; keep each as <div><dt>…</dt><dd>…</dd></div>`);
  return pairs;
}

/** The FAQPage block, one question to a line so a diff shows which answer changed. */
export function faqJsonLd(pairs) {
  const q = (p) => JSON.stringify({ "@type": "Question", name: p.question, acceptedAnswer: { "@type": "Answer", text: p.answer } });
  // "<" never needs to appear raw inside a script element, and escaping it means no answer can close one.
  return `{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[\n ${pairs.map(q).join(",\n ")}\n]}`.replace(/</g, "\\u003c");
}

const FAQ_BLOCK = /(<script type="application\/ld\+json" id="ld-faq">\n)[\s\S]*?(\n<\/script>)/;

export function stampFaq(html) {
  if (!FAQ_BLOCK.test(html)) throw new Error('site-seo: no <script type="application/ld+json" id="ld-faq"> to fill');
  return html.replace(FAQ_BLOCK, (_, open, close) => open + faqJsonLd(faqPairs(html)) + close);
}

/** The home page's SoftwareApplication names the released version and its notes, from the feed. */
export function stampVersion(html, feed) {
  for (const key of ["softwareVersion", "releaseNotes"]) {
    if (!new RegExp(`"${key}":"[^"]*"`).test(html)) throw new Error(`site-seo: no "${key}" in the home page's structured data`);
  }
  return html
    .replace(/"softwareVersion":"[^"]*"/, `"softwareVersion":${JSON.stringify(feed.version)}`)
    .replace(/"releaseNotes":"[^"]*"/, `"releaseNotes":${JSON.stringify(feed.notes)}`);
}

export function releaseLine(feed) {
  return `- Current release: ${feed.version}, published ${feed.date}. Release notes: ${feed.notes}`;
}

export function stampLlms(text, feed) {
  const line = /^- Current release: .*$/m;
  if (!line.test(text)) throw new Error('site-seo: no "- Current release:" line to fill');
  return text.replace(line, releaseLine(feed));
}

/** Every file this script owns a part of, as path → what it should hold. */
export function buildSiteSeo(site = SITE) {
  const feed = JSON.parse(fs.readFileSync(path.join(site, "latest.json"), "utf-8"));
  const out = new Map();
  for (const rel of FAQ_PAGES) {
    let html = stampFaq(fs.readFileSync(path.join(site, rel), "utf-8"));
    if (rel === "index.html") html = stampVersion(html, feed);
    out.set(rel, html);
  }
  for (const rel of LLMS_FILES) out.set(rel, stampLlms(fs.readFileSync(path.join(site, rel), "utf-8"), feed));
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let changed = 0;
  for (const [rel, want] of buildSiteSeo()) {
    const file = path.join(SITE, rel);
    if (fs.readFileSync(file, "utf-8") === want) continue;
    fs.writeFileSync(file, want);
    console.log(`site-seo: updated site/${rel}`);
    changed++;
  }
  console.log(changed ? `site-seo: ${changed} file(s) brought up to date` : "site-seo: nothing to do");
}
