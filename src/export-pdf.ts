import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CdpSession, findChromeBinary } from "./browser.js";
import { resolveWorkPath } from "./coding.js";
import { HOME_ROOT } from "./config.js";
import { escapeHtml, firstHeading, renderMarkdown } from "./markdown.js";
import { collapseHome, isSensitivePath } from "./paths.js";

/**
 * export_pdf: a Desk document or a page the claw wrote, printed to PDF by
 * Chrome itself (CDP `Page.printToPDF`) — the finished file a funder, a panel
 * or a client is actually sent.
 *
 * Why a second, throwaway Chrome and not the claw's own: that one is the
 * operator's logged-in profile (Gmail, WhatsApp). A document rendered there
 * would fetch its images and fonts with those cookies, and a page that ran
 * script would run it beside them. The print Chrome is headless, starts with
 * an empty profile in a temp folder, has JavaScript switched off, and gets a
 * Content-Security-Policy written into the document before a byte of it is
 * parsed: no frames, no objects, no scripts, images only from https or
 * inlined data, fonts only from Google Fonts. The document is loaded with
 * Page.setDocumentContent into about:blank, not opened as a file:// URL —
 * a file:// page may frame other local files, and an `<iframe src=~/.env>`
 * printed to PDF and then read back with read_document would walk straight
 * round the denylist. Local images are the one thing a deck needs from disk,
 * so they are read here, under the same denylist, and inlined.
 *
 * Writing obeys write_file's rules, never weaker: the denylist blocks, a new
 * file in the claw's own ground (the Desk, ~/sites, workspace) or a new
 * non-hidden file under home is free, and overwriting a PDF that exists
 * always asks — a PDF is binary, the file watcher's snapshot cannot undo it.
 * The output always ends in .pdf, so it can never land on SOUL.md, a policy
 * file or SCHEDULE.md — the files write_file guards with cards of their own.
 */

export const DESK_DIR = path.join(os.homedir(), "Documents", "CunningClaw");

/** Where generate_image saves — a deck's pictures are usually painted there. */
export const IMAGES_DIR = path.join(HOME_ROOT, "workspace", "images");

/** The Desk's name jail — the same rule the Docs page's API uses (server.ts). */
export const DESK_NAME = /^[A-Za-z0-9][A-Za-z0-9 _'()&-]{0,80}$/;

export function deskDocPath(name: string, dir = DESK_DIR): string | null {
  if (!DESK_NAME.test(name)) return null;
  const p = path.join(dir, `${name}.md`);
  return p.startsWith(dir + path.sep) ? p : null;
}

const MARKDOWN_EXT = new Set([".md", ".markdown", ".txt"]);
const HTML_EXT = new Set([".html", ".htm"]);
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml",
};

/**
 * The policy every render carries, first thing in the document. A meta CSP
 * cannot be loosened by a later one — browsers enforce every policy they see.
 */
export const RENDER_CSP =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src data: https://fonts.gstatic.com; script-src 'none'; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

/** One slide of a 16:9 deck, in CSS pixels: 13.333in × 7.5in at 96 per inch. */
export const SLIDE_W = 1280;
export const SLIDE_H = 720;

export const DOCUMENT_CSS = `
@page { size: A4; margin: 18mm 17mm 20mm 17mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Source Sans 3", "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt;
  line-height: 1.5; color: #1a1a1a; margin: 0; }
h1, h2, h3, h4, h5, h6 { font-weight: 650; line-height: 1.25; color: #111; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 20pt; margin: 0 0 10pt; padding-bottom: 4pt; border-bottom: 1.5pt solid #1a1a1a; }
h2 { font-size: 14.5pt; margin: 18pt 0 6pt; }
h3 { font-size: 12pt; margin: 14pt 0 4pt; }
h4, h5, h6 { font-size: 10.5pt; margin: 12pt 0 4pt; }
p { margin: 0 0 7pt; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 7pt; padding-left: 18pt; }
li { margin: 1.5pt 0; }
li > ul, li > ol { margin: 2pt 0 0; }
.task { font-family: "DejaVu Sans", "Segoe UI Symbol", sans-serif; }
li:has(> .task:first-child) { list-style: none; margin-left: -12pt; }
a { color: #0b5394; text-decoration: none; }
code { font-family: "JetBrains Mono", "DejaVu Sans Mono", Consolas, monospace; font-size: 9pt;
  background: #f2f2f2; padding: 0 2pt; border-radius: 2pt; }
pre { background: #f5f5f5; border: 0.75pt solid #ddd; padding: 7pt 9pt; white-space: pre-wrap;
  word-wrap: break-word; break-inside: avoid; margin: 0 0 8pt; }
pre code { background: none; padding: 0; }
blockquote { margin: 0 0 8pt; padding: 2pt 0 2pt 10pt; border-left: 2.5pt solid #bbb; color: #444; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0 10pt; font-size: 9.5pt; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 0.75pt solid #bdbdbd; padding: 3.5pt 6pt; vertical-align: top; text-align: left; }
th { background: #eeeeee; font-weight: 650; }
hr { border: 0; border-top: 0.75pt solid #bbb; margin: 12pt 0; }
img { max-width: 100%; }
.img-missing { color: #8a6d00; font-style: italic; }
.page-break { break-after: page; page-break-after: always; height: 0; }
`;

export const BREAK_BEFORE_H1_CSS = `h1:not(:first-child) { break-before: page; page-break-before: always; }`;

/**
 * Added to an HTML deck when landscape is asked for: each `.slide` becomes
 * exactly one 16:9 page. A deck's own @page rule still wins, because the
 * print call prefers CSS page size.
 */
export const SLIDE_CSS = `
@page { size: ${SLIDE_W}px ${SLIDE_H}px; margin: 0; }
html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.slide { width: ${SLIDE_W}px; height: ${SLIDE_H}px; overflow: hidden; box-sizing: border-box;
  position: relative; break-after: page; page-break-after: always; break-inside: avoid; }
.slide:last-of-type { break-after: auto; page-break-after: auto; }
`;

export type SourceKind = "markdown" | "html";

export interface ResolvedSource {
  path: string;
  kind: SourceKind;
}

/**
 * What the model named, as a file. A bare name is a Desk document first
 * ("Grant draft" → ~/Documents/CunningClaw/Grant draft.md); anything else is
 * a path, resolved exactly as read_file and write_file resolve one.
 */
export function resolveSource(
  source: string,
  opts: { desk?: string; resolve?: (p: string) => string } = {},
): ResolvedSource | { error: string } {
  const raw = String(source ?? "").trim();
  if (!raw) return { error: "export_pdf needs a source: a Desk document name or a .md/.html path." };
  const desk = opts.desk ?? DESK_DIR;
  const bare = raw.replace(/\.md$/i, "");
  const fromDesk = deskDocPath(bare, desk);
  let p: string;
  if (fromDesk && fs.existsSync(fromDesk)) p = fromDesk;
  else p = (opts.resolve ?? resolveWorkPath)(raw);
  if (fromDesk && !path.extname(raw) && !fs.existsSync(p)) {
    return { error: `No such document on the Desk: "${bare}". Desk documents are named without the .md, e.g. "Grant draft".` };
  }
  if (isSensitivePath(p)) return { error: "BLOCKED: that path is on the sensitive-file denylist and will never be read." };
  const ext = path.extname(p).toLowerCase();
  const kind: SourceKind | null = MARKDOWN_EXT.has(ext) ? "markdown" : HTML_EXT.has(ext) ? "html" : null;
  if (!kind) {
    return { error: `export_pdf renders markdown (.md) or HTML (.html) — not ${ext || "a file with no extension"}.` };
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return { error: `No such document: ${collapseHome(p)}. Desk documents are named without the .md, e.g. "Grant draft".` };
  }
  if (!st.isFile()) return { error: `${collapseHome(p)} is not a file.` };
  if (st.size > MAX_SOURCE_BYTES) return { error: `${collapseHome(p)} is over 5 MB — too large to print here.` };
  return { path: p, kind };
}

/**
 * Where the PDF goes. Default: the Desk, named after the source. A bare name
 * lands on the Desk too; a path is resolved like write_file's. Always .pdf —
 * an `output` of "notes.md" is refused rather than quietly overwriting prose
 * with binary.
 */
export function resolveOutput(
  output: string | undefined,
  sourcePath: string,
  opts: { desk?: string; resolve?: (p: string) => string } = {},
): string | { error: string } {
  const desk = opts.desk ?? DESK_DIR;
  let raw = String(output ?? "").trim();
  let p: string;
  if (!raw) {
    p = path.join(desk, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
  } else {
    const ext = path.extname(raw).toLowerCase();
    if (ext && ext !== ".pdf") return { error: `export_pdf writes .pdf files — "${raw}" ends in ${ext}.` };
    if (!ext) raw += ".pdf";
    const bareName = !/[\\/]/.test(raw) && !raw.startsWith("~") && !raw.startsWith(".");
    p = bareName ? path.join(desk, raw) : (opts.resolve ?? resolveWorkPath)(raw);
  }
  if (isSensitivePath(p)) return { error: "BLOCKED: that path is on the sensitive-file denylist and will never be written." };
  return p;
}

/**
 * Whether writing the PDF needs a card — write_file's decision, made for a
 * binary file. The difference is the overwrite: write_file lets the claw
 * overwrite its own Desk freely because every text write is snapshotted for
 * undo; a PDF is not, so replacing one that exists asks, wherever it is.
 */
export function pdfWriteNeedsApproval(
  p: string,
  exists: boolean,
  rules: { freeWriteZone: (p: string, exists: boolean) => boolean; taskGrant: boolean },
): boolean {
  if (rules.taskGrant) return false;
  if (exists) return true;
  return !rules.freeWriteZone(p, false);
}

/** Page count from the PDF's own page objects — enough to report, not a parser. */
export function countPdfPages(pdf: Buffer): number {
  const text = pdf.toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

export interface ImageReport {
  embedded: number;
  skipped: string[];
}

/**
 * Turn a local image reference into a data: URI, or refuse it. Only image
 * types, only under the source's own folder, the Desk or generate_image's
 * folder, never a denylisted path, never over 8 MB. Remote https images pass
 * through for the CSP to judge.
 */
export function localImageResolver(
  sourcePath: string,
  report: ImageReport,
  desk = DESK_DIR,
  imagesDir = IMAGES_DIR,
): (src: string) => string | null {
  const base = path.dirname(sourcePath);
  const skip = (why: string): null => {
    report.skipped.push(why);
    return null;
  };
  return (src: string) => {
    const s = String(src ?? "").trim();
    if (/^https:\/\//i.test(s) || /^data:image\/(png|jpeg|gif|webp);base64,/i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^file:/i.test(s)) {
      return skip(`${s.slice(0, 60)} (only https or local images)`);
    }
    let local = s.replace(/^file:\/\//i, "");
    try {
      local = decodeURIComponent(local.split(/[?#]/)[0]);
    } catch { /* keep it as written */ }
    const abs = path.resolve(base, local.startsWith("~/") ? path.join(os.homedir(), local.slice(2)) : local);
    const label = collapseHome(abs);
    const inside = [base, desk, imagesDir].some((d) => abs.startsWith(d + path.sep));
    const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
    if (!inside) return skip(`${label} (outside the document's folder, the Desk and workspace/images)`);
    if (isSensitivePath(abs)) return skip(`${label} (denylisted)`);
    if (!type) return skip(`${label} (not an image type)`);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return skip(`${label} (missing or over 8 MB)`);
      report.embedded++;
      return `data:${type};base64,${fs.readFileSync(abs).toString("base64")}`;
    } catch {
      return skip(`${label} (not found)`);
    }
  };
}

/** A whole printable document from markdown. */
export function markdownDocument(
  md: string,
  opts: { title?: string; landscape?: boolean; breakBeforeH1?: boolean; resolveImage?: (src: string) => string | null } = {},
): string {
  const title = opts.title || firstHeading(md) || "Document";
  const body = renderMarkdown(md, { resolveImage: opts.resolveImage });
  const css = DOCUMENT_CSS + (opts.breakBeforeH1 ? BREAK_BEFORE_H1_CSS : "") +
    (opts.landscape ? "@page { size: A4 landscape; }" : "");
  return `<!doctype html>\n<html lang="en-GB"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">` +
    `<title>${escapeHtml(title)}</title><style>${css}</style></head><body>${body}</body></html>`;
}

/**
 * Make an HTML file safe to print: the CSP goes in before anything else (after
 * a doctype, so the page keeps standards mode), meta refreshes are removed so
 * the render cannot navigate away, and local <img> sources are inlined
 * through the resolver or dropped.
 */
export function prepareHtml(
  html: string,
  opts: { landscape?: boolean; resolveImage: (src: string) => string | null },
): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">`;
  let doc = String(html ?? "");
  doc = doc.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, "");
  doc = doc.replace(/(<img\b[^>]*?\ssrc\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (_m, pre: string, _q, dq, sq, bare) => {
    const src = String(dq ?? sq ?? bare ?? "").replace(/&amp;/g, "&");
    const url = opts.resolveImage(src);
    return `${pre}"${url ? escapeHtml(url) : ""}"`;
  });
  const slideCss = opts.landscape ? `<style>${SLIDE_CSS}</style>` : "";
  const doctype = doc.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return doctype[0] + csp + doc.slice(doctype[0].length).replace(/<\/head>/i, `${slideCss}</head>`);
  const withCss = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, `${slideCss}</head>`) : slideCss + doc;
  return `<!doctype html>${csp}${withCss}`;
}

// ---------------------------------------------------------------------------
// The render: a throwaway headless Chrome, driven over the same CDP client.
// ---------------------------------------------------------------------------

export interface RenderOptions {
  landscape: boolean;
  kind: SourceKind;
  pageNumbers: boolean;
}

export interface RenderResult {
  pdf: Buffer;
  /** 1-based indexes of .slide elements whose content runs past the slide. */
  overflow: number[];
  slides: number;
}

export interface RenderDeps {
  /** Chrome binary; default the same search the claw's browser uses. */
  binary?: string | null;
  /** Extra Chrome flags — the tests' `--no-sandbox` when they run as root. Never set in production. */
  extraArgs?: string[];
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(dir: string, child: ChildProcess, timeoutMs: number): Promise<number> {
  const file = path.join(dir, "DevToolsActivePort");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        "the print Chrome exited at start-up" +
          (process.getuid?.() === 0 ? " — Chrome will not run as root with its sandbox on, and export_pdf will not turn it off" : ""),
      );
    }
    try {
      const port = Number(fs.readFileSync(file, "utf-8").split("\n")[0]);
      if (port > 0) return port;
    } catch { /* not written yet */ }
    await sleep(100);
  }
  throw new Error("the print Chrome did not open its debug port in time");
}

const MEASURE_JS = `(() => {
  const slides = Array.from(document.querySelectorAll('.slide'));
  const overflow = [];
  slides.forEach((el, i) => {
    if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) overflow.push(i + 1);
  });
  return { slides: slides.length, overflow };
})()`;

export async function renderPdf(html: string, opts: RenderOptions, deps: RenderDeps = {}): Promise<RenderResult> {
  const bin = deps.binary !== undefined ? deps.binary : await findChromeBinary();
  if (!bin) throw new Error("no Chrome or Chromium found — install Chrome, or set browser.binary in claw.config.json");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-print-"));
  const child = spawn(
    bin,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--mute-audio",
      "--hide-scrollbars",
      ...(deps.extraArgs ?? []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  child.on("error", () => { /* reported through exitCode / the port wait */ });
  let session: CdpSession | null = null;
  try {
    const timeoutMs = deps.timeoutMs ?? 20000;
    const port = await waitForPort(dir, child, timeoutMs);
    let wsUrl = "";
    for (let i = 0; i < 50 && !wsUrl; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
        const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        wsUrl = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? "";
      } catch { /* not ready */ }
      if (!wsUrl) await sleep(100);
    }
    if (!wsUrl) throw new Error("the print Chrome opened no page");
    session = new CdpSession(wsUrl);
    const s = session;
    await s.call("Page.enable");
    // Page scripts off: a printed document has no business running code.
    // DevTools' own Runtime.evaluate still works, which is how it is measured.
    await s.call("Emulation.setScriptExecutionDisabled", { value: true });
    await s.call("Emulation.setEmulatedMedia", { media: "print" });
    const tree = await s.call("Page.getFrameTree");
    const frameId = tree?.frameTree?.frame?.id;
    await s.call("Page.setDocumentContent", { frameId, html });
    // Images and web fonts load after the parse; wait for both, bounded.
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await s.call("Runtime.evaluate", {
        expression: "document.readyState === 'complete' && document.fonts.status === 'loaded' && " +
          "Array.from(document.images).every((i) => i.complete)",
        returnByValue: true,
      });
      if (r?.result?.value === true) break;
      await sleep(150);
    }
    const where = await s.call("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    if (where?.result?.value !== "about:blank") throw new Error("the document tried to navigate away while rendering; nothing was printed");
    const measured = await s.call("Runtime.evaluate", { expression: MEASURE_JS, returnByValue: true });
    const m = measured?.result?.value ?? { slides: 0, overflow: [] };
    const slideDeck = opts.landscape && opts.kind === "html";
    const numbers = opts.pageNumbers && !slideDeck;
    const printed = await s.call("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      landscape: opts.landscape,
      // A4 unless the document's @page says otherwise (decks do, via SLIDE_CSS).
      paperWidth: 8.27,
      paperHeight: 11.69,
      displayHeaderFooter: numbers,
      headerTemplate: "<span></span>",
      footerTemplate: numbers
        ? '<div style="font-size:8px;width:100%;text-align:center;color:#777;font-family:sans-serif">' +
          '<span class="pageNumber"></span> / <span class="totalPages"></span></div>'
        : "<span></span>",
    });
    const data = String(printed?.data ?? "");
    if (!data) throw new Error("Chrome returned an empty PDF");
    return { pdf: Buffer.from(data, "base64"), overflow: m.overflow ?? [], slides: m.slides ?? 0 };
  } finally {
    session?.close();
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    // Chrome may still hold the profile for a moment after the kill.
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(100);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface ExportInput {
  source: string;
  output?: string;
  landscape?: boolean;
  page_break_h1?: boolean;
  page_numbers?: boolean;
  title?: string;
}

export interface ExportDeps {
  /** The card. `match` is the output path, for work orders. */
  approve: (summary: string, detail: string, match: string) => Promise<boolean>;
  /** write_file's free-write rule, handed in so this module never imports tools.ts. */
  freeWriteZone: (p: string, exists: boolean) => boolean;
  taskGrant: () => boolean;
  render?: (html: string, opts: RenderOptions) => Promise<RenderResult>;
  desk?: string;
  imagesDir?: string;
  resolve?: (p: string) => string;
}

export async function exportPdf(input: ExportInput, deps: ExportDeps): Promise<string> {
  const pathOpts = { desk: deps.desk, resolve: deps.resolve };
  const src = resolveSource(input.source, pathOpts);
  if ("error" in src) return src.error;
  const out = resolveOutput(input.output, src.path, pathOpts);
  if (typeof out !== "string") return out.error;

  const landscape = Boolean(input.landscape);
  const images: ImageReport = { embedded: 0, skipped: [] };
  const resolveImage = localImageResolver(src.path, images, deps.desk ?? DESK_DIR, deps.imagesDir ?? IMAGES_DIR);
  const text = fs.readFileSync(src.path, "utf-8");
  const html = src.kind === "markdown"
    ? markdownDocument(text, {
        title: input.title,
        landscape,
        breakBeforeH1: Boolean(input.page_break_h1),
        resolveImage,
      })
    : prepareHtml(text, { landscape, resolveImage });

  const exists = fs.existsSync(out);
  if (pdfWriteNeedsApproval(out, exists, { freeWriteZone: deps.freeWriteZone, taskGrant: deps.taskGrant() })) {
    const ok = await deps.approve(
      exists ? `Overwrite ${collapseHome(out)} with a new PDF` : `Write PDF ${collapseHome(out)}`,
      `From ${collapseHome(src.path)}` +
        (exists ? "\n\nThe existing PDF is replaced and cannot be undone from here." : ""),
      out,
    );
    if (!ok) return "The user declined the PDF export.";
  }

  let result: RenderResult;
  try {
    result = await (deps.render ?? renderPdf)(html, {
      landscape,
      kind: src.kind,
      pageNumbers: input.page_numbers !== false,
    });
  } catch (err: any) {
    return `PDF export failed: ${String(err?.message ?? err)}. Nothing was written.`;
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, result.pdf);
  fs.renameSync(tmp, out);

  const pages = countPdfPages(result.pdf);
  const layout = landscape && src.kind === "html" ? "16:9 slides" : landscape ? "A4 landscape" : "A4 portrait";
  const lines = [
    `Exported ${collapseHome(out)} — ${pages} page${pages === 1 ? "" : "s"}, ${layout}, ${Math.max(1, Math.round(result.pdf.length / 1024))} KB.`,
  ];
  if (landscape && src.kind === "html") {
    if (!result.slides) {
      lines.push("No .slide elements were found, so pages are cut from the flowing page. Wrap each slide in <section class=\"slide\">.");
    } else if (result.slides !== pages) {
      lines.push(`${result.slides} slides became ${pages} pages — a slide's content is spilling onto an extra page.`);
    }
  }
  if (result.overflow.length) {
    lines.push(`Text runs past the edge of slide ${result.overflow.join(", ")} — cut words or shrink the type there, then export again.`);
  }
  if (images.embedded) lines.push(`${images.embedded} local image${images.embedded === 1 ? "" : "s"} embedded.`);
  if (images.skipped.length) lines.push(`Images left out: ${images.skipped.slice(0, 8).join("; ")}.`);
  lines.push("Check it with read_document before sending it anywhere; open shows it to the operator.");
  return lines.join("\n");
}
