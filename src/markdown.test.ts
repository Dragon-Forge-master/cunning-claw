import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml, firstHeading, renderInline, renderMarkdown, slugify } from "./markdown.js";

/**
 * The renderer prints documents the claw drafted — often from web pages and
 * emails — so the first half of these tests is about what must never become
 * markup, and the second about the subset a grant or a report needs.
 */

test("HTML written into markdown comes out as text, never as tags", () => {
  const html = renderMarkdown("Hello <script>alert(1)</script>\n\n<iframe src=\"file:///etc/passwd\"></iframe>");
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<iframe/i.test(html));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;iframe src=&quot;file:///etc/passwd&quot;&gt;"));
});

test("HTML inside a table cell, a heading, a list and a quote is escaped too", () => {
  const md = "# <b>Title</b>\n\n| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | ok |\n\n- <svg onload=alert(1)>\n\n> <object data=x>";
  const html = renderMarkdown(md);
  for (const tag of ["<b>", "<img", "<svg", "<object"]) assert.ok(!html.includes(tag), `${tag} leaked`);
});

test("a link keeps only a scheme a reader should follow", () => {
  const js = renderMarkdown("[click](javascript:alert(1))");
  assert.ok(!/href/i.test(js));
  assert.ok(js.includes("click"));
  const data = renderInline("[x](data:text/html,<script>alert(1)</script>)");
  assert.ok(!/href/i.test(data));
  assert.ok(renderInline("[site](https://example.org/a)").includes('<a href="https://example.org/a">site</a>'));
  assert.ok(renderInline("[mail](mailto:hi@example.org)").includes('href="mailto:hi@example.org"'));
});

test("a quote in a URL cannot close the attribute", () => {
  const html = renderInline('[a](https://x.example/"onmouseover=alert(1))');
  assert.ok(!html.includes('"onmouseover'));
  assert.ok(html.includes("&quot;onmouseover"));
});

test("underscores and asterisks inside a URL are not read as emphasis", () => {
  const html = renderInline("see [the guidance](https://gov.example/a_b_c/**x**) now");
  assert.ok(html.includes('href="https://gov.example/a_b_c/**x**"'));
  assert.ok(!html.includes("<em>"));
  assert.ok(!html.includes("<strong>"));
});

test("a code span keeps its markdown literally and escapes its HTML", () => {
  const html = renderInline("run `**not bold** <b>` please");
  assert.ok(html.includes("<code>**not bold** &lt;b&gt;</code>"));
  assert.ok(!html.includes("<strong>"));
});

test("a document cannot forge the renderer's placeholders", () => {
  const html = renderInline("[a](https://x.example) 0 1");
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.equal((html.match(/<\/a>/g) ?? []).length, 1);
});

test("images: https by default, anything else shows its alt text", () => {
  assert.ok(renderInline("![logo](https://x.example/l.png)").includes('<img src="https://x.example/l.png" alt="logo">'));
  const local = renderInline("![key](file:///home/me/.ssh/id_rsa)");
  assert.ok(!local.includes("<img"));
  assert.ok(local.includes("[image: key]"));
  const resolved = renderInline("![x](logo.png)", { resolveImage: (s) => (s === "logo.png" ? "data:image/png;base64,AAAA" : null) });
  assert.ok(resolved.includes('src="data:image/png;base64,AAAA"'));
});

test("headings get levels and anchors", () => {
  const html = renderMarkdown("# Project plan\n\n## Risks & issues\n\n###### Small");
  assert.ok(html.includes('<h1 id="project-plan">Project plan</h1>'));
  assert.ok(html.includes('<h2 id="risks-issues">Risks &amp; issues</h2>'));
  assert.ok(html.includes("<h6"));
  assert.equal(slugify("Cyllideb y prosiect"), "cyllideb-y-prosiect");
});

test("a pipe table with alignment, escaped pipes and a ragged row", () => {
  const md = "| Item | Cost (£) | Note |\n|:-----|-----:|:---:|\n| Staff | 10,000 | a \\| b |\n| Kit | 2,500 |";
  const html = renderMarkdown(md);
  assert.ok(html.startsWith("<table><thead><tr><th style=\"text-align:left\">Item</th>"));
  assert.ok(html.includes('<td style="text-align:right">10,000</td>'));
  assert.ok(html.includes('<td style="text-align:center">a | b</td>'));
  // The short row is padded to the header's width, so the grid stays a grid.
  assert.equal((html.match(/<tr>/g) ?? []).length, 3);
  assert.equal((html.match(/<td/g) ?? []).length, 6);
});

test("lists: nesting, numbered starts, task boxes", () => {
  const html = renderMarkdown("- one\n  - one a\n  - one b\n- two\n\n3. third\n4. fourth\n\n- [x] done\n- [ ] to do");
  assert.ok(html.includes("<ul><li>one<ul><li>one a</li><li>one b</li></ul></li><li>two</li></ul>"));
  assert.ok(html.includes('<ol start="3"><li>third</li><li>fourth</li></ol>'));
  assert.ok(html.includes("☑</span> done"));
  assert.ok(html.includes("☐</span> to do"));
});

test("paragraphs join their lines; two trailing spaces break one", () => {
  const html = renderMarkdown("first line\nsame paragraph  \nnew line\n\nsecond paragraph");
  assert.equal(html, "<p>first line\nsame paragraph<br>\nnew line</p><p>second paragraph</p>");
});

test("fenced code is escaped and not formatted", () => {
  const html = renderMarkdown("```ts\nconst a = '<b>' ** 2;\n```");
  assert.equal(html, '<pre><code class="lang-ts">const a = &#39;&lt;b&gt;&#39; ** 2;</code></pre>');
});

test("quotes, rules, page breaks, bold, italic and strike", () => {
  const html = renderMarkdown("> quoted **line**\n\n---\n\n\\pagebreak\n\nA *b* _c_ **d** __e__ ~~f~~ snake_case_word");
  assert.ok(html.includes("<blockquote><p>quoted <strong>line</strong></p></blockquote>"));
  assert.ok(html.includes("<hr>"));
  assert.ok(html.includes('<div class="page-break"></div>'));
  assert.ok(html.includes("<em>b</em> <em>c</em> <strong>d</strong> <strong>e</strong> <del>f</del> snake_case_word"));
});

test("a thousand nested quotes are bounded, not a stack overflow", () => {
  const html = renderMarkdown(">".repeat(1000) + " deep");
  assert.ok(html.includes("deep"));
});

test("firstHeading and escapeHtml", () => {
  assert.equal(firstHeading("intro\n# **Bid** for X\n## sub"), "Bid for X");
  assert.equal(firstHeading("no heading"), null);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});
