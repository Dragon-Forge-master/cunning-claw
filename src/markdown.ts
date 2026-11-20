/**
 * Markdown to HTML, server-side, for documents that leave the machine as PDFs.
 *
 * The Desk page has its own renderer (public/docs.html), but it lives in a
 * browser script and knows no tables — and a grant application without a
 * budget table is not one. This is the same idea, made careful enough to
 * print: a fixed subset (headings, paragraphs, nested lists, pipe tables,
 * fenced code, quotes, rules, links, images, bold/italic/strike), and every
 * byte of the source escaped before any of it becomes markup. HTML written
 * into the markdown comes out as visible text, never as tags — a document
 * the claw drafted from a stranger's web page must not be able to smuggle an
 * <iframe> or a <script> into the render.
 *
 * A leaf: no imports, so anything may use it.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface MarkdownOptions {
  /**
   * Decide what an image's src becomes. Return a URL to use, or null to show
   * the alt text instead. The default allows https only — local files need a
   * caller that knows which folders are safe to read (export-pdf.ts does).
   */
  resolveImage?: (src: string) => string | null;
}

// Private-use code points stand in for finished markup while the rest of a
// line is formatted, so `**` inside a URL or a code span is never read as
// bold. They are stripped from the source first, so a document cannot forge one.
const PH_OPEN = "";
const PH_CLOSE = "";
const PH_STRIP = /[]/g;

const SAFE_LINK = /^(https?:\/\/|mailto:|#)/i;

function defaultImage(src: string): string | null {
  return /^https:\/\//i.test(src) ? src : null;
}

/** A heading's anchor: lowercase words joined by hyphens, letters of any script kept. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z0-9#]+;/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

/** Inline formatting for one run of text. Input is raw markdown; output is safe HTML. */
export function renderInline(raw: string, opts: MarkdownOptions = {}): string {
  const held: string[] = [];
  const hold = (html: string) => {
    held.push(html);
    return `${PH_OPEN}${held.length - 1}${PH_CLOSE}`;
  };
  const resolveImage = opts.resolveImage ?? defaultImage;

  let s = raw.replace(PH_STRIP, "");
  // Code spans first: nothing inside them is formatting.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks, body: string) =>
    hold(`<code>${escapeHtml(body.trim() || body)}</code>`),
  );
  // Backslash escapes: \* is a literal asterisk.
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~>])/g, (_m, ch: string) => hold(escapeHtml(ch)));

  // Images before links — `![a](b)` contains `[a](b)`.
  s = s.replace(/!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/g, (_m, alt: string, src: string) => {
    const url = resolveImage(src);
    if (!url) return hold(`<span class="img-missing">[image: ${escapeHtml(alt || src)}]</span>`);
    return hold(`<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`);
  });
  // Links: only schemes a reader should follow. Anything else keeps its text and loses the link.
  s = s.replace(/\[([^\]]+)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/g, (_m, text: string, href: string) => {
    if (!SAFE_LINK.test(href)) return text;
    return `${hold(`<a href="${escapeHtml(href)}">`)}${text}${hold("</a>")}`;
  });
  // Bare autolinks in angle brackets.
  s = s.replace(/<(https?:\/\/[^\s<>]+)>/g, (_m, href: string) => hold(`<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`));

  s = escapeHtml(s);
  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, "$1<strong>$2</strong>")
    .replace(/\*(?=\S)([^*]*?\S)\*/g, "<em>$1</em>")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}_])/gu, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");

  // Restore, innermost first: a held link may itself contain a held escape.
  const restore = new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g");
  for (let i = 0; i < 4 && s.includes(PH_OPEN); i++) {
    s = s.replace(restore, (_m, n: string) => held[Number(n)] ?? "");
  }
  return s;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const PAGE_BREAK = /^\s*\\(pagebreak|newpage)\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i].includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes("-");
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || PAGE_BREAK.test(line) ||
    QUOTE.test(line) || LIST_ITEM.test(line) || isTableStart(lines, i)
  );
}

interface ListFrame {
  tag: "ul" | "ol";
  indent: number;
  open: boolean; // an <li> is open
}

function renderList(lines: string[], start: number, opts: MarkdownOptions): { html: string; next: number } {
  const stack: ListFrame[] = [];
  let out = "";
  let i = start;
  const closeTo = (indent: number) => {
    while (stack.length && stack[stack.length - 1].indent > indent) {
      const f = stack.pop()!;
      out += (f.open ? "</li>" : "") + `</${f.tag}>`;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST_ITEM);
    if (!m) {
      if (!line.trim()) {
        // A blank line ends the list unless the next line carries on with it.
        const nxt = lines[i + 1];
        if (nxt !== undefined && (LIST_ITEM.test(nxt) || (/^\s{2,}\S/.test(nxt) && stack.length))) {
          i++;
          continue;
        }
        break;
      }
      // A lazy continuation line joins the open item.
      if (stack.length && !startsBlock(lines, i)) {
        out += " " + renderInline(line.trim(), opts);
        i++;
        continue;
      }
      break;
    }
    const indent = m[1].replace(/\t/g, "    ").length;
    const tag: "ul" | "ol" = /^\d/.test(m[2]) ? "ol" : "ul";
    closeTo(indent);
    const startAt = tag === "ol" ? parseInt(m[2], 10) : 1;
    const opener = tag === "ol" && startAt !== 1 ? `<ol start="${startAt}">` : `<${tag}>`;
    let top = stack[stack.length - 1];
    if (!top || indent > top.indent) {
      out += opener;
      stack.push({ tag, indent, open: false });
      top = stack[stack.length - 1];
    } else if (top.tag !== tag) {
      // Bullets then numbers at the same depth are two lists, not one.
      out += (top.open ? "</li>" : "") + `</${top.tag}>${opener}`;
      top.tag = tag;
      top.open = false;
    }
    if (top.open) out += "</li>";
    let body = m[3];
    let box = "";
    const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
    if (task) {
      box = task[1] === " " ? '<span class="task">☐</span> ' : '<span class="task">☑</span> ';
      body = task[2];
    }
    out += `<li>${box}${renderInline(body, opts)}`;
    top.open = true;
    i++;
  }
  closeTo(-1);
  return { html: out, next: i };
}

function renderTable(lines: string[], start: number, opts: MarkdownOptions): { html: string; next: number } {
  const head = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((d) => {
    const l = d.startsWith(":");
    const r = d.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : "";
  });
  const cell = (tag: "th" | "td", text: string, col: number) => {
    const a = aligns[col];
    return `<${tag}${a ? ` style="text-align:${a}"` : ""}>${renderInline(text, opts)}</${tag}>`;
  };
  let out = "<table><thead><tr>" + head.map((h, c) => cell("th", h, c)).join("") + "</tr></thead><tbody>";
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
    const cells = splitRow(lines[i]);
    const row: string[] = [];
    for (let c = 0; c < head.length; c++) row.push(cell("td", cells[c] ?? "", c));
    out += `<tr>${row.join("")}</tr>`;
    i++;
  }
  return { html: out + "</tbody></table>", next: i };
}

function renderBlocks(lines: string[], opts: MarkdownOptions, depth: number): string {
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].toLowerCase().replace(/[^a-z0-9+-]/g, "");
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      out += `<pre><code${lang ? ` class="lang-${lang}"` : ""}>${escapeHtml(body.join("\n"))}</code></pre>`;
      continue;
    }
    if (PAGE_BREAK.test(line)) {
      out += '<div class="page-break"></div>';
      i++;
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      const level = h[1].length;
      const inner = renderInline(h[2], opts);
      const id = slugify(inner);
      out += `<h${level}${id ? ` id="${escapeHtml(id)}"` : ""}>${inner}</h${level}>`;
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out += "<hr>";
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines, i))) {
        inner.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      // Nesting is bounded: a document of a thousand '>' is a stack, not a quote.
      out += depth < 8
        ? `<blockquote>${renderBlocks(inner, opts, depth + 1)}</blockquote>`
        : `<blockquote><p>${renderInline(inner.join(" "), opts)}</p></blockquote>`;
      continue;
    }
    if (isTableStart(lines, i)) {
      const t = renderTable(lines, i, opts);
      out += t.html;
      i = t.next;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const l = renderList(lines, i, opts);
      out += l.html;
      i = l.next;
      continue;
    }
    // A paragraph runs until a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) {
      para.push(lines[i]);
      i++;
    }
    const html = para
      .map((l, n) => {
        const hard = n < para.length - 1 && (/ {2,}$/.test(l) || /\\$/.test(l));
        return renderInline(l.replace(/\\$/, "").trim(), opts) + (hard ? "<br>" : "");
      })
      .join("\n");
    out += `<p>${html}</p>`;
  }
  return out;
}

/** Render a markdown document's body. The result is safe to place inside <body>. */
export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").replace(PH_STRIP, "").split("\n");
  return renderBlocks(lines, opts, 0);
}

/** The first top-level heading's text, for a document title. */
export function firstHeading(src: string): string | null {
  const m = String(src ?? "").match(/^ {0,3}#\s+(.+?)\s*#*\s*$/m);
  return m ? m[1].replace(/[*_`]/g, "").trim() : null;
}
