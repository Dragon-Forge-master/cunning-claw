import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  countPdfPages, deskDocPath, exportPdf, localImageResolver, markdownDocument, pdfWriteNeedsApproval,
  prepareHtml, renderPdf, resolveOutput, resolveSource, RENDER_CSP, type ExportDeps, type ImageReport,
  type RenderResult,
} from "./export-pdf.js";
import { findChromeBinary } from "./browser.js";

/**
 * export_pdf writes a file and reads files, so the tests hold it to the same
 * lines write_file and read_file hold: the denylist, the Desk's name jail, a
 * card before anything is replaced. Then, where a Chrome exists, a real print.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claw-export-"));
const desk = path.join(root, "Desk");
fs.mkdirSync(desk, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

function put(rel: string, data: string | Buffer): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

const FAKE_PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>\n%%EOF");

function deps(over: Partial<ExportDeps> & { asked?: string[] } = {}): ExportDeps & { asked: string[]; rendered: string[] } {
  const asked: string[] = over.asked ?? [];
  const rendered: string[] = [];
  return {
    approve: async (summary) => {
      asked.push(summary);
      return true;
    },
    // write_file's rule, scoped to the test's Desk.
    freeWriteZone: (p) => p.startsWith(desk + path.sep),
    taskGrant: () => false,
    render: async (html): Promise<RenderResult> => {
      rendered.push(html);
      return { pdf: FAKE_PDF, overflow: [], slides: 0 };
    },
    desk,
    resolve: (p) => path.resolve(root, p),
    ...over,
    asked,
    rendered,
  };
}

test("the Desk's name jail holds", () => {
  assert.equal(deskDocPath("Grant draft", desk), path.join(desk, "Grant draft.md"));
  assert.equal(deskDocPath("../escape", desk), null);
  assert.equal(deskDocPath(".hidden", desk), null);
  assert.equal(deskDocPath("a/b", desk), null);
});

test("a source on the denylist is refused before it is read", async () => {
  // A markdown extension does not launder a key store: .env.md is still an .env.
  const p = put("project/.env.md", "OPENAI_API_KEY=sk-test-not-real");
  const d = deps();
  const out = await exportPdf({ source: p }, d);
  assert.match(out, /^BLOCKED/);
  assert.equal(d.rendered.length, 0);
  assert.match(String((resolveSource(path.join(root, ".ssh", "notes.md"), { desk }) as any).error), /^BLOCKED/);
});

test("only markdown and HTML are printed", () => {
  const p = put("data.csv", "a,b");
  assert.match(String((resolveSource(p, { desk }) as any).error), /markdown \(\.md\) or HTML/);
});

test("a bare name is a Desk document; a missing one says how Desk names work", () => {
  put("Desk/Grant draft.md", "# Grant");
  const s = resolveSource("Grant draft", { desk, resolve: (p) => path.resolve(root, p) });
  assert.deepEqual(s, { path: path.join(desk, "Grant draft.md"), kind: "markdown" });
  const missing = resolveSource("Nope", { desk, resolve: (p) => path.resolve(root, p) });
  assert.match(String((missing as any).error), /No such document/);
});

test("output: the Desk by default, .pdf only, never a denylisted path", () => {
  const src = path.join(desk, "Bid.md");
  assert.equal(resolveOutput(undefined, src, { desk }), path.join(desk, "Bid.pdf"));
  assert.equal(resolveOutput("Bid v2", src, { desk }), path.join(desk, "Bid v2.pdf"));
  assert.match(String((resolveOutput("notes.md", src, { desk }) as any).error), /writes \.pdf files/);
  const ssh = resolveOutput(path.join(root, ".ssh", "keys.pdf"), src, { desk, resolve: (p) => p });
  assert.match(String((ssh as any).error), /^BLOCKED/);
});

test("the write decision: new on the Desk is free, replacing a PDF always asks", () => {
  const rules = { freeWriteZone: (p: string) => p.startsWith(desk + path.sep), taskGrant: false };
  assert.equal(pdfWriteNeedsApproval(path.join(desk, "a.pdf"), false, rules), false);
  // write_file would overwrite its own Desk freely — a PDF is binary and the
  // snapshot cannot undo it, so this one asks.
  assert.equal(pdfWriteNeedsApproval(path.join(desk, "a.pdf"), true, rules), true);
  assert.equal(pdfWriteNeedsApproval("/srv/elsewhere/a.pdf", false, rules), true);
  assert.equal(pdfWriteNeedsApproval(path.join(desk, "a.pdf"), true, { ...rules, taskGrant: true }), false);
});

test("export writes a new PDF without a card, then asks before replacing it", async () => {
  put("Desk/Plan.md", "# Plan\n\n- one");
  const first = deps();
  const msg = await exportPdf({ source: "Plan" }, first);
  assert.match(msg, /Exported .*Plan\.pdf — 2 pages, A4 portrait/);
  assert.equal(first.asked.length, 0);
  assert.ok(fs.readFileSync(path.join(desk, "Plan.pdf")).subarray(0, 5).equals(Buffer.from("%PDF-")));

  const declined = deps({ approve: async (s) => { declined.asked.push(s); return false; } });
  fs.writeFileSync(path.join(desk, "Plan.pdf"), "the operator's copy");
  const msg2 = await exportPdf({ source: "Plan" }, declined);
  assert.equal(msg2, "The user declined the PDF export.");
  assert.match(declined.asked[0], /^Overwrite .*Plan\.pdf/);
  assert.equal(fs.readFileSync(path.join(desk, "Plan.pdf"), "utf-8"), "the operator's copy");
  assert.equal(declined.rendered.length, 0);
});

test("a render failure writes nothing", async () => {
  put("Desk/Broken.md", "# x");
  const d = deps({ render: async () => { throw new Error("no Chrome or Chromium found"); } });
  const msg = await exportPdf({ source: "Broken" }, d);
  assert.match(msg, /PDF export failed: no Chrome.*Nothing was written/);
  assert.equal(fs.existsSync(path.join(desk, "Broken.pdf")), false);
});

test("local images: embedded from the document's folder, refused anywhere else", () => {
  const src = put("deck/index.html", "<html></html>");
  put("deck/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  put("deck/.ssh/peek.png", "x");
  put("deck/notes.txt", "x");
  put("outside.png", "x");
  const painted = put("images/painted.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const report: ImageReport = { embedded: 0, skipped: [] };
  const r = localImageResolver(src, report, desk, path.join(root, "images"));
  assert.equal(r("logo.png"), "data:image/png;base64,iVBORw==");
  // generate_image's folder is the third place a deck's pictures may come from.
  assert.equal(r(painted), "data:image/png;base64,iVBORw==");
  assert.equal(r("https://example.org/a.png"), "https://example.org/a.png");
  assert.equal(r(".ssh/peek.png"), null);
  assert.equal(r("notes.txt"), null);
  assert.equal(r("../outside.png"), null);
  assert.equal(r("file:///etc/passwd"), null);
  assert.equal(r("http://example.org/a.png"), null);
  assert.equal(report.embedded, 2);
  assert.equal(report.skipped.length, 5);
  assert.ok(report.skipped.some((s) => s.includes("denylisted")));
});

test("HTML is prepared: the policy first, refreshes gone, local images inlined or dropped", () => {
  const html = '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://x.example"></head>' +
    '<body><img src="logo.png"><img src=\'secret.png\'></body></html>';
  const out = prepareHtml(html, { landscape: true, resolveImage: (s) => (s === "logo.png" ? "data:image/png;base64,AA" : null) });
  assert.ok(out.startsWith(`<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">`));
  assert.ok(!/refresh/i.test(out));
  assert.ok(out.includes('<img src="data:image/png;base64,AA">'));
  assert.ok(out.includes('<img src="">'));
  assert.ok(out.includes(".slide { width: 1280px; height: 720px;"));
  // A fragment with no doctype still gets one, and the policy straight after it.
  assert.ok(prepareHtml("<p>hi</p>", { resolveImage: () => null }).startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\""));
  assert.match(RENDER_CSP, /script-src 'none'/);
  assert.match(RENDER_CSP, /frame-src 'none'/);
});

test("a markdown document carries the policy and a title", () => {
  const doc = markdownDocument("# Bid <for> X\n\ntext", { breakBeforeH1: true });
  assert.ok(doc.includes(`content="${RENDER_CSP}"`));
  assert.ok(doc.includes("<title>Bid &lt;for&gt; X</title>"));
  assert.ok(doc.includes("h1:not(:first-child) { break-before: page"));
});

test("countPdfPages counts pages, not the page tree", () => {
  assert.equal(countPdfPages(FAKE_PDF), 2);
});

// ---------------------------------------------------------------------------
// A real print, when this machine has a Chrome.
// ---------------------------------------------------------------------------

async function chrome(): Promise<string | null> {
  if (process.env.CLAW_TEST_CHROME) return process.env.CLAW_TEST_CHROME;
  if (fs.existsSync("/opt/pw-browsers/chromium")) return "/opt/pw-browsers/chromium";
  return await findChromeBinary();
}
const bin = await chrome();
// Chrome refuses to start as root with its sandbox on; the product never
// turns it off, the test does, only for itself.
const extraArgs = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
const hasPdftotext = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("real Chrome: markdown prints to A4 with a page break honoured", { skip: !bin && "no Chrome here" }, async () => {
  const md = "# Grant draft\n\n| Item | Cost |\n|---|--:|\n| Staff | £10,000 |\n\n<iframe src=\"file:///etc/hostname\"></iframe>\n\n\\pagebreak\n\n## Budget\n\ntext";
  const r = await renderPdf(markdownDocument(md), { landscape: false, kind: "markdown", pageNumbers: true }, { binary: bin, extraArgs });
  assert.ok(r.pdf.subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.equal(countPdfPages(r.pdf), 2);
  if (hasPdftotext) {
    const f = put("real-md.pdf", r.pdf);
    const text = execFileSync("pdftotext", ["-layout", f, "-"], { encoding: "utf-8" });
    assert.match(text, /Grant draft/);
    assert.match(text, /£10,000/);
    // The tag is printed as the words of the tag.
    assert.match(text, /<iframe src="file:\/\/\/etc\/hostname"><\/iframe>/);
  }
});

test("real Chrome: an HTML deck is one 16:9 page per slide, overflow named, scripts dead", { skip: !bin && "no Chrome here" }, async () => {
  const secret = put("deck2/secret.txt", "SECRET-CANARY-7731");
  const deck = `<!doctype html><html><head><style>.slide{font:40px sans-serif;padding:60px}</style></head><body>
    <section class="slide"><h1>One</h1></section>
    <section class="slide"><h1>Two</h1>${"<p>a line too many</p>".repeat(30)}</section>
    <section class="slide"><h1>Three</h1><iframe src="file://${secret}"></iframe><object data="file://${secret}"></object></section>
    <script>for (let i = 0; i < 5; i++) { const s = document.createElement('section'); s.className = 'slide'; document.body.appendChild(s); }</script>
    </body></html>`;
  const r = await renderPdf(prepareHtml(deck, { landscape: true, resolveImage: () => null }), { landscape: true, kind: "html", pageNumbers: true }, { binary: bin, extraArgs });
  // Had the page's script run, there would be eight slides.
  assert.equal(r.slides, 3);
  assert.equal(countPdfPages(r.pdf), 3);
  assert.deepEqual(r.overflow, [2]);
  const box = r.pdf.toString("latin1").match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/);
  assert.ok(box, "a MediaBox");
  assert.ok(Math.abs(Number(box![1]) / Number(box![2]) - 16 / 9) < 0.01, `16:9, got ${box![1]}×${box![2]}`);
  if (hasPdftotext) {
    const f = put("real-deck.pdf", r.pdf);
    assert.ok(!execFileSync("pdftotext", [f, "-"], { encoding: "utf-8" }).includes("SECRET-CANARY"));
  }
});

test("real Chrome: page scripts are off even without the policy", { skip: !bin && "no Chrome here" }, async () => {
  // Two layers stop a script: the CSP and the switched-off engine. This one
  // renders with no CSP at all, so it fails if the engine switch goes.
  const raw = `<!doctype html><body><section class="slide">one</section>
    <script>for (let i = 0; i < 4; i++) { const s = document.createElement('section'); s.className = 'slide'; document.body.appendChild(s); }</script></body>`;
  const r = await renderPdf(raw, { landscape: true, kind: "html", pageNumbers: false }, { binary: bin, extraArgs });
  assert.equal(r.slides, 1);
});
