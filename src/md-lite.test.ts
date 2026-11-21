import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// public/md-lite.js is a plain browser script; load it as the HUD does, into
// a context of its own, and take the MdLite it hangs on the global.
const here = path.dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => fs.readFileSync(path.join(here, "..", "public", f), "utf-8");
const ctx: any = {};
vm.runInNewContext(pub("md-lite.js"), ctx);
const { parse, plain, render } = ctx.MdLite as {
  parse: (t: string) => { kind: string; lead: string; spans: { t: string; b?: boolean; i?: boolean; code?: boolean }[] }[];
  plain: (t: string) => string;
  render: (el: any, t: string) => void;
};

/** Just enough DOM to see what render() builds — and that it builds nothing else. */
function fakeDoc() {
  const made: string[] = [];
  class Text { constructor(public data: string) {} get textContent() { return this.data; } }
  class El {
    children: (El | Text)[] = [];
    className = "";
    private own = "";
    constructor(public tagName: string, public ownerDocument: any) {}
    appendChild(n: El | Text) { this.children.push(n); return n; }
    replaceChildren(...n: (El | Text)[]) { this.children = n; }
    set textContent(v: string) { this.own = v; this.children = []; }
    get textContent(): string { return this.own + this.children.map((c) => c.textContent).join(""); }
  }
  const doc: any = {
    createElement: (tag: string) => { made.push(tag); return new El(tag, doc); },
    createTextNode: (t: string) => new Text(t),
  };
  return { doc, made, root: new El("span", doc) };
}

// The answer from the bank-details film, as the model wrote it.
const ANSWER =
  "Coed Celyn Timber's payment terms are **30 days** from the invoice date.\n\n" +
  "- **Sort Code:** `12-34-56`\n" +
  "- **Account Number:** 12345678\n\n" +
  "*Note:* Hidden fine print tried to switch the details to `65-43-21 / 87654321`.";

test("the film's answer reads without a single asterisk or backtick", () => {
  const words = plain(ANSWER);
  assert.doesNotMatch(words, /[*`]/);
  assert.match(words, /^• Sort Code: 12-34-56$/m);
  assert.match(words, /payment terms are 30 days from/);
  const lines = parse(ANSWER);
  assert.ok(lines[2].spans.some((s) => s.b && s.t === "Sort Code:"));
  assert.ok(lines[2].spans.some((s) => s.code && s.t === "12-34-56"));
  assert.ok(lines[5].spans.some((s) => s.i && s.t === "Note:"));
});

test("what only looks like a mark is left as typed", () => {
  for (const t of [
    "2 * 3 * 4 = 24",
    "set retry_count_max in claw.config.json",
    "file_name_here.txt and __init__",
    "an unfinished **bold that has not closed yet",
    "a lone ` backtick",
    "** spaced ** is not bold",
  ]) assert.equal(plain(t), t, t);
});

test("headings, bullets and fences lose their markup, keep their words", () => {
  // JSON round trips: arrays made inside the vm context have its prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(parse("## Payment terms").map((l) => l.kind))), ["h"]);
  assert.equal(plain("## Payment terms"), "Payment terms");
  assert.equal(plain("  * nested item"), "  • nested item");
  const fenced = parse("Run:\n```bash\nnpm run *build*\n```\ndone");
  assert.deepEqual(JSON.parse(JSON.stringify(fenced.map((l) => l.kind))), ["p", "code", "p"]);
  assert.equal(fenced[1].spans[0].t, "npm run *build*", "inside a fence nothing is emphasis");
});

test("render builds strong, em and code only — a reply's HTML stays text", () => {
  const { doc, made, root } = fakeDoc();
  const hostile = '**Hi** <img src=x onerror="alert(1)"> `<script>` *there*';
  render(root, hostile);
  assert.deepEqual([...new Set(made)].sort(), ["code", "em", "strong"]);
  assert.equal(root.textContent, 'Hi <img src=x onerror="alert(1)"> <script> there');
});

test("a streamed reply redrawn per delta ends the same as one drawn whole", () => {
  const a = fakeDoc();
  let raw = "";
  for (const delta of ["The **Sort", " Code:** `12-", "34-56`"]) { raw += delta; render(a.root, raw); }
  const b = fakeDoc();
  render(b.root, raw);
  assert.equal(a.root.textContent, b.root.textContent);
  assert.equal(a.root.textContent, "The Sort Code: 12-34-56");
});

test("the HUD loads md-lite before app.js and draws the claw's words with it", () => {
  const html = pub("index.html");
  const md = html.indexOf('<script src="md-lite.js">');
  assert.ok(md > 0 && md < html.indexOf('<script src="app.js">'), "md-lite.js must load before app.js");
  const app = pub("app.js");
  assert.match(app, /if \(role === "cunningclaw"\) drawReply\(span, text\)/, "a reply restored from history is drawn");
  assert.match(app, /drawReply\(currentBubble, /, "a streamed reply is drawn");
  assert.doesNotMatch(app, /currentBubble\.textContent \+=/, "no streamed text bypasses the drawing");
});
