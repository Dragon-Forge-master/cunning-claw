import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { config } from "./config.js";
import { collapseHome, isSensitivePath } from "./paths.js";
import { resolveWorkPath } from "./coding.js";
import { fenceUntrusted } from "./browser-ax.js";
import { defuse } from "./workspace.js";
import { hasBin, missing } from "./platform.js";

/**
 * read_document: any document the operator is handed, as text for the model.
 *
 * Documents are the commonest thing a stranger sends — an invoice, a CV, the
 * attachment on a cold email — so everything this returns is fenced as
 * untrusted, and the parsers that touch the bytes are either our own (bounded,
 * in-process, no code execution) or an external tool run with a fixed argv, no
 * shell, a timeout, an output cap and an environment with the keys taken out.
 *
 * The order is "best text first": markitdown understands Office files and PDFs
 * properly, pdftotext is the reliable PDF fallback, tesseract reads pictures
 * of text. With none of them installed, the built-in zip reader still opens
 * .docx/.xlsx/.pptx and the OpenDocument trio, and plain formats are read
 * directly — a fresh clone can read a Word file the moment it starts.
 */

// ---------------------------------------------------------------------------
// Settings — claw.config.json `documents`, with defaults that suit a 20MB Desk
// upload and a context window that should not be spent on one spreadsheet.
// ---------------------------------------------------------------------------

export interface DocSettings {
  maxChars: number;
  maxFileBytes: number;
  timeoutMs: number;
  ocrMaxPages: number;
  ocrLang: string;
}

export function docSettings(): DocSettings {
  const d = config.documents ?? {};
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : fallback;
  // The language code goes into tesseract's argv. No shell is involved, but a
  // value starting with "-" would still be read as an option, so only the
  // shape tesseract's own codes have ("eng", "eng+cym", "chi_sim") is allowed.
  const lang = typeof d.ocrLang === "string" && /^[a-z]{3}(?:_[a-z]+)?(?:\+[a-z]{3}(?:_[a-z]+)?)*$/.test(d.ocrLang)
    ? d.ocrLang
    : "eng";
  return {
    maxChars: num(d.maxChars, 40_000, 1_000, 400_000),
    maxFileBytes: num(d.maxFileMB, 50, 1, 500) * 1024 * 1024,
    timeoutMs: num(d.timeoutMs, 60_000, 1_000, 600_000),
    ocrMaxPages: num(d.ocrMaxPages, 20, 1, 200),
    ocrLang: lang,
  };
}

/** The external tools, for the doctor and for the "how to fix it" lines. */
export const DOCUMENT_TOOLS = [
  { bin: "markitdown", for: "PDF and Office documents as clean Markdown (tables kept)" },
  { bin: "pdftotext", for: "PDF text when markitdown is not installed" },
  { bin: "tesseract", for: "OCR of images and scanned PDFs" },
] as const;

// ---------------------------------------------------------------------------
// Running an external converter
// ---------------------------------------------------------------------------

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Why it failed, in words that do not change between identical calls. */
  failure?: "timeout" | "exit" | "spawn";
  /** stdout hit the byte cap and was cut — still usable, but incomplete. */
  capped?: boolean;
}

export interface DocDeps {
  hasBin(bin: string): Promise<boolean>;
  run(bin: string, args: string[], opts: { timeoutMs: number; maxBytes: number }): Promise<RunResult>;
}

/**
 * The environment a converter sees. process.env carries every provider key
 * (config.ts loads .env into it), and a converter is exactly the process a
 * malicious file is trying to exploit — so it gets what it needs to find its
 * own libraries and temp space, and nothing it could send anywhere.
 */
export function converterEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = [
    "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "WINDIR",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TESSDATA_PREFIX",
  ];
  const out: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

function runConverter(bin: string, args: string[], opts: { timeoutMs: number; maxBytes: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBytes,
        killSignal: "SIGKILL",
        windowsHide: true,
        encoding: "utf8",
        env: converterEnv(),
      },
      (err: any, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errText = String(stderr ?? "");
        if (!err) return resolve({ ok: true, stdout: out, stderr: errText });
        // Too much output is not a failure of the document — keep what came.
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return resolve({ ok: true, stdout: out, stderr: errText, capped: true });
        }
        if (err.killed) return resolve({ ok: false, stdout: out, stderr: errText, failure: "timeout" });
        if (typeof err.code === "string") return resolve({ ok: false, stdout: "", stderr: errText, failure: "spawn" });
        resolve({ ok: false, stdout: out, stderr: errText, failure: "exit" });
      },
    );
  });
}

export const defaultDeps: DocDeps = { hasBin, run: runConverter };

/**
 * Far more than one read shows, so that `start` can page through a long
 * report — but a converter that streams forever is still stopped.
 */
const CONVERTER_MAX_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// A small, careful zip reader
//
// Office Open XML and OpenDocument files are zips of XML. Node has inflate
// and nothing else, which is enough — but a zip is also the classic hostile
// container, so every number in it is checked against the buffer before it is
// used, and nothing expands past a fixed budget whatever its header claims.
// These caps are a floor, not a preference: they live in code, like HARD_DENY.
// ---------------------------------------------------------------------------

export const ZIP_LIMITS = {
  /** A real .xlsx with a few hundred sheets and images is well under this. */
  maxEntries: 10_000,
  /** One XML part. A huge sheet is ~100MB; we only ever show 40k chars of it. */
  maxEntryBytes: 32 * 1024 * 1024,
  /** Everything we inflate from one file, summed. */
  maxTotalBytes: 64 * 1024 * 1024,
};

export class ZipRefused extends Error {}

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compSize: number;
  size: number;
  localOffset: number;
}

/**
 * Names a zip may not carry. We never write entries to disk, so traversal
 * cannot land a file anywhere — but a document that names one is crafted,
 * not saved by an office suite, and the honest answer is to not open it.
 */
export function unsafeEntryName(name: string): boolean {
  if (!name || name.includes("\0") || name.includes("\\")) return true;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((seg) => seg === "..");
}

export class ZipReader {
  private entries = new Map<string, ZipEntry>();
  private spent = 0;

  constructor(private buf: Buffer, private limits = ZIP_LIMITS) {
    const eocd = this.findEocd();
    const disk = buf.readUInt16LE(eocd + 4);
    const cdDisk = buf.readUInt16LE(eocd + 6);
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0) throw new ZipRefused("a multi-part zip");
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipRefused("a ZIP64 archive, which the built-in reader does not open");
    }
    if (count > limits.maxEntries) throw new ZipRefused(`${count} entries (the cap is ${limits.maxEntries})`);
    if (cdOffset + cdSize > eocd) throw new ZipRefused("a central directory that points past the end of the file");

    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipRefused("a damaged central directory");
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOffset = buf.readUInt32LE(p + 42);
      if (p + 46 + nameLen > eocd) throw new ZipRefused("a damaged central directory");
      // Bit 11 says UTF-8; otherwise the name is CP437, which for the ASCII
      // part names office suites write is the same bytes.
      const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
      if (unsafeEntryName(name)) throw new ZipRefused(`an entry named ${JSON.stringify(name.slice(0, 80))} (path traversal)`);
      // Two entries with one name is how a file shows one parser one thing and
      // another parser something else. Nothing legitimate does it.
      if (this.entries.has(name)) throw new ZipRefused(`two entries both named ${JSON.stringify(name.slice(0, 80))}`);
      this.entries.set(name, { name, method, flags, compSize, size, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  private findEocd(): number {
    const buf = this.buf;
    if (buf.length < 22) throw new ZipRefused("too short to be a zip");
    const floor = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= floor; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new ZipRefused("no zip directory — the file is not a zip, or is truncated");
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Inflate one entry, charged against the file's budget. */
  read(name: string): Buffer {
    const e = this.entries.get(name);
    if (!e) throw new ZipRefused(`no ${name} inside`);
    if (e.flags & 0x1) throw new ZipRefused("an encrypted entry");
    if (e.size > this.limits.maxEntryBytes) {
      throw new ZipRefused(`${name} claims ${e.size} bytes uncompressed (the cap is ${this.limits.maxEntryBytes})`);
    }
    if (this.spent + e.size > this.limits.maxTotalBytes) {
      throw new ZipRefused(`more than ${this.limits.maxTotalBytes} bytes uncompressed in total — a zip bomb, or near enough`);
    }
    const buf = this.buf;
    const lh = e.localOffset;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) throw new ZipRefused(`a damaged local header for ${name}`);
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    if (start + e.compSize > buf.length) throw new ZipRefused(`${name} runs past the end of the file`);
    const raw = buf.subarray(start, start + e.compSize);
    let out: Buffer;
    if (e.method === 0) {
      out = raw;
    } else if (e.method === 8) {
      try {
        // The header's size is a claim, not a fact. One byte of headroom over
        // the claim means a lying entry either overflows here or fails the
        // length check below — it never gets to expand into memory.
        out = zlib.inflateRawSync(raw, { maxOutputLength: e.size + 1 });
      } catch (err: any) {
        if (err?.code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
          throw new ZipRefused(`${name} expands past the size its header declares — a zip bomb`);
        }
        throw new ZipRefused(`${name} does not inflate (${String(err?.code ?? "corrupt data")})`);
      }
    } else {
      throw new ZipRefused(`${name} uses compression method ${e.method}`);
    }
    if (out.length !== e.size) throw new ZipRefused(`${name} is not the size its header declares`);
    this.spent += out.length;
    return out;
  }

  text(name: string): string {
    return this.read(name).toString("utf8").replace(/^﻿/, "");
  }
}

// ---------------------------------------------------------------------------
// XML and HTML to text
// ---------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", pound: "£", euro: "€", copy: "©", reg: "®", trade: "™", lsquo: "‘",
  rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", deg: "°",
};

/** One pass, so "&amp;lt;" becomes "&lt;" and not "<". */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "";
      return String.fromCodePoint(n);
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Attributes of one start tag, by their full (prefixed) names. */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
  return out;
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Word: only what is inside <w:t>, plus the breaks — so formatting XML never leaks in as text. */
export function docxText(xml: string): string {
  // lastRenderedPageBreak is where Word last drew a page boundary; an explicit
  // page break is the fallback. Using both counts the same boundary twice.
  // Tab-stop definitions (<w:tabs><w:tab …/>) are layout, not tabs in the
  // text; mc:Fallback repeats a text box's words for older readers.
  xml = xml
    .replace(/<w:tabs\b[\s\S]*?<\/w:tabs>/g, "")
    .replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, "");
  const rendered = /<w:lastRenderedPageBreak\b/.test(xml);
  let out = "";
  let page = 1;
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr|lastRenderedPageBreak)\b([^>]*)\/>|<\/w:(p|tc|tr)>/g;
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else if (m[2] === "tab") out += "\t";
    else if (m[2] === "cr") out += "\n";
    else if (m[2] === "br") {
      if (!rendered && /w:type="page"/.test(m[3])) out += `\n--- page ${++page} ---\n`;
      else out += "\n";
    } else if (m[2] === "lastRenderedPageBreak") out += `\n--- page ${++page} ---\n`;
    else if (m[4] === "p") out += "\n";
    // A table row is one line: a cell's closing paragraph gives way to a tab.
    else if (m[4] === "tc") out = out.replace(/\n$/, "") + "\t";
    else if (m[4] === "tr") out += "\n";
  }
  const body = tidy(out);
  return page > 1 ? `--- page 1 ---\n${body}` : body;
}

/** PowerPoint and DrawingML text: <a:t> runs, paragraphs on their own lines. */
export function drawingText(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\b[^>]*\/>|<\/a:p>/g)) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else out += "\n";
  }
  return tidy(out);
}

/** xl/sharedStrings.xml → the table cells refer into, by index. */
export function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g)) {
    // Phonetic runs (<rPh>) are reading aids for Japanese, not cell text.
    const body = (si[1] ?? "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    let s = "";
    for (const t of body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) s += decodeEntities(t[1]);
    out.push(s);
  }
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^([A-Z]{1,3})/.exec(ref)?.[1];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** One worksheet as tab-separated rows, blanks kept so columns stay lined up. */
export function sheetText(xml: string, strings: string[]): string {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(c[1]);
      const inner = c[2] ?? "";
      let value = "";
      if (a.t === "inlineStr") {
        for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) value += decodeEntities(t[1]);
      } else {
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        if (v !== undefined) {
          if (a.t === "s") value = strings[Number(v)] ?? "";
          else if (a.t === "b") value = v === "1" ? "TRUE" : "FALSE";
          else value = decodeEntities(v);
        }
      }
      const col = a.r ? columnIndex(a.r) : cells.length;
      // A cell at XFD1 would otherwise mean sixteen thousand tabs.
      if (col >= cells.length && col < cells.length + 256) {
        while (cells.length < col) cells.push("");
      }
      cells.push(value.replace(/[\t\n]+/g, " "));
    }
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (cells.length) rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

/** A part's relationships: rId → zip path, resolved against the part's folder. */
function relTargets(zip: ZipReader, relsPath: string, baseDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!zip.has(relsPath)) return out;
  for (const m of zip.text(relsPath).matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!a.Id || !a.Target || a.TargetMode === "External") continue;
    const target = a.Target.startsWith("/")
      ? a.Target.slice(1)
      : path.posix.normalize(path.posix.join(baseDir, a.Target));
    out.set(a.Id, target);
  }
  return out;
}

function byNumber(names: string[], re: RegExp): string[] {
  return names
    .filter((n) => re.test(n))
    .sort((x, y) => Number(re.exec(x)?.[1] ?? 0) - Number(re.exec(y)?.[1] ?? 0));
}

export function xlsxText(zip: ZipReader): string {
  const strings = zip.has("xl/sharedStrings.xml") ? sharedStrings(zip.text("xl/sharedStrings.xml")) : [];
  const rels = relTargets(zip, "xl/_rels/workbook.xml.rels", "xl");
  const sheets: { name: string; part: string; hidden: boolean }[] = [];
  if (zip.has("xl/workbook.xml")) {
    for (const m of zip.text("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
      const a = attrs(m[0]);
      const rid = a["r:id"] ?? Object.entries(a).find(([k]) => k.endsWith(":id"))?.[1];
      const part = rid ? rels.get(rid) : undefined;
      if (part && zip.has(part)) sheets.push({ name: a.name ?? part, part, hidden: Boolean(a.state && a.state !== "visible") });
    }
  }
  if (!sheets.length) {
    for (const part of byNumber(zip.names(), /^xl\/worksheets\/sheet(\d+)\.xml$/)) {
      sheets.push({ name: path.posix.basename(part, ".xml"), part, hidden: false });
    }
  }
  // Hidden sheets are shown and labelled: a sheet the operator cannot see in
  // Excel is exactly where an injected instruction would be put.
  return sheets
    .map((s, i) => `--- sheet ${i + 1}: ${s.name}${s.hidden ? " (hidden)" : ""} ---\n${sheetText(zip.text(s.part), strings)}`)
    .join("\n\n");
}

export function pptxText(zip: ZipReader): string {
  const rels = relTargets(zip, "ppt/_rels/presentation.xml.rels", "ppt");
  let parts: string[] = [];
  if (zip.has("ppt/presentation.xml")) {
    for (const m of zip.text("ppt/presentation.xml").matchAll(/<p:sldId\b[^>]*>/g)) {
      const a = attrs(m[0]);
      const part = a["r:id"] ? rels.get(a["r:id"]) : undefined;
      if (part && zip.has(part)) parts.push(part);
    }
  }
  if (!parts.length) parts = byNumber(zip.names(), /^ppt\/slides\/slide(\d+)\.xml$/);
  return parts.map((p, i) => `--- slide ${i + 1} ---\n${drawingText(zip.text(p))}`).join("\n\n");
}

/** OpenDocument content.xml. Slides and sheets are marked; text documents are just text. */
export function odfText(xml: string, kind: "odt" | "ods" | "odp"): string {
  // \x01 marks a cell end until the paragraph breaks are in; strip any the
  // file brought with it first. The (?=[\s/>]) lookaheads stop "table:table"
  // matching table:table-row, which \b would not.
  let body = xml
    .replace(/\x01/g, "")
    .replace(/^[\s\S]*?<office:body\b[^>]*>/, "")
    .replace(/<\/office:body>[\s\S]*$/, "")
    // An annotation is a reviewer's comment, not the document.
    .replace(/<office:annotation(?=[\s/>])[\s\S]*?<\/office:annotation>/g, "");
  let n = 0;
  if (kind === "odp") body = body.replace(/<draw:page(?=[\s/>])[^>]*>/g, () => `\n--- slide ${++n} ---\n`);
  if (kind === "ods") {
    body = body.replace(/<table:table(?=[\s/>])([^>]*)>/g, (_w, a: string) => `\n--- sheet ${++n}: ${attrs(a)["table:name"] ?? n} ---\n`);
  }
  body = body
    .replace(/<text:s(?=[\s/>])[^>]*\/>/g, " ")
    .replace(/<text:tab(?=[\s/>])[^>]*\/>/g, "\t")
    .replace(/<text:line-break(?=[\s/>])[^>]*\/>/g, "\n")
    .replace(/<\/table:table-cell>/g, "\x01")
    .replace(/<\/text:(p|h)>/g, "\n")
    .replace(/<\/table:table-row>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n?\x01/g, "\t");
  return tidy(decodeEntities(body).replace(/\t+\n/g, "\n"));
}

/** HTML to readable text. Scripts and styles are dropped whole, not stripped of their tags. */
export function htmlText(html: string): string {
  return tidy(
    decodeEntities(
      html
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre|dt|dd)\s*>/gi, "\n")
        .replace(/<\/(td|th)\s*>/gi, "\t")
        .replace(/<li\b[^>]*>/gi, "• ")
        .replace(/<[^>]*>/g, ""),
    )
      .replace(/[  ]{2,}/g, " ")
      .replace(/\n[ \t]+/g, "\n"),
  );
}

/** A text file whatever its byte-order mark. Excel's "Unicode text" export is UTF-16. */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8").replace(/^﻿/, "");
}

/** pdftotext separates pages with a form feed; so does pdfminer under markitdown. */
export function markPages(text: string): { text: string; pages: number } {
  const parts = text.split("\f");
  if (parts.length > 1 && parts[parts.length - 1].trim() === "") parts.pop();
  if (parts.length < 2) return { text: tidy(text), pages: parts.length };
  return { text: parts.map((p, i) => `--- page ${i + 1} ---\n${tidy(p)}`).join("\n\n"), pages: parts.length };
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export type DocKind =
  | "pdf" | "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp"
  | "html" | "text" | "image" | "legacy" | "unknown";

const BY_EXT: Record<string, DocKind> = {
  ".pdf": "pdf",
  ".docx": "docx", ".docm": "docx", ".dotx": "docx",
  ".xlsx": "xlsx", ".xlsm": "xlsx",
  ".pptx": "pptx", ".pptm": "pptx", ".ppsx": "pptx",
  ".odt": "odt", ".ods": "ods", ".odp": "odp",
  ".html": "html", ".htm": "html", ".xhtml": "html",
  ".txt": "text", ".md": "text", ".markdown": "text", ".csv": "text", ".tsv": "text",
  ".json": "text", ".xml": "text", ".log": "text", ".eml": "text", ".ics": "text", ".vcf": "text",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".bmp": "image",
  ".tif": "image", ".tiff": "image", ".webp": "image", ".pnm": "image",
  ".doc": "legacy", ".xls": "legacy", ".ppt": "legacy",
};

/** By extension, then by the bytes — Desk uploads and saved attachments lose their names. */
export function kindOf(file: string, head: Buffer): DocKind {
  const ext = BY_EXT[path.extname(file).toLowerCase()];
  if (ext) return ext;
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return "image";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image";
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return "unknown"; // a zip: sniffed inside, below
  if (/^\s*<(!doctype html|html)\b/i.test(head.toString("latin1", 0, 200))) return "html";
  return "unknown";
}

function zipKind(zip: ZipReader): DocKind {
  if (zip.has("word/document.xml")) return "docx";
  if (zip.has("xl/workbook.xml")) return "xlsx";
  if (zip.has("ppt/presentation.xml")) return "pptx";
  if (zip.has("mimetype") && zip.has("content.xml")) {
    const mime = zip.text("mimetype");
    if (mime.includes("opendocument.spreadsheet")) return "ods";
    if (mime.includes("opendocument.presentation")) return "odp";
    return "odt";
  }
  return "unknown";
}

function builtinZip(buf: Buffer, kind: DocKind): { text: string; kind: DocKind } {
  const zip = new ZipReader(buf);
  const k = kind === "unknown" ? zipKind(zip) : kind;
  switch (k) {
    case "docx":
      if (!zip.has("word/document.xml")) throw new ZipRefused("a .docx with no word/document.xml");
      return { kind: k, text: docxText(zip.text("word/document.xml")) };
    case "xlsx": return { kind: k, text: xlsxText(zip) };
    case "pptx": return { kind: k, text: pptxText(zip) };
    case "odt": case "ods": case "odp":
      if (!zip.has("content.xml")) throw new ZipRefused("an OpenDocument file with no content.xml");
      return { kind: k, text: odfText(zip.text("content.xml"), k) };
    default:
      return { kind: "unknown", text: "" };
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

const LABEL: Record<DocKind, string> = {
  pdf: "PDF", docx: "Word document", xlsx: "Excel workbook", pptx: "PowerPoint deck",
  odt: "OpenDocument text", ods: "OpenDocument spreadsheet", odp: "OpenDocument presentation",
  html: "HTML page", text: "text file", image: "image", legacy: "legacy Office file", unknown: "file",
};

interface Extracted {
  text: string;
  via: string;
  kind: DocKind;
  capped?: boolean;
}

/** Enough letters to call it a text layer — a scanned PDF yields a few stray glyphs at most. */
function hasText(s: string): boolean {
  return s.replace(/\s+/g, "").length >= 16;
}

/** markitdown marks slides with an HTML comment; make them match ours. */
function normaliseMarkitdown(text: string): string {
  return text.replace(/<!--\s*Slide number:\s*(\d+)\s*-->/g, "--- slide $1 ---");
}

/**
 * Why a converter failed, in our words. Its stderr is not quoted: a parser
 * complaining about a hostile file can echo the file's own text, and this line
 * sits outside the fence. No temp path and no timing either — see readDocument.
 */
function failed(bin: string, r: RunResult, s: DocSettings): string {
  if (r.failure === "timeout") return `${bin} did not finish within ${s.timeoutMs / 1000}s`;
  if (r.failure === "spawn") return `${bin} could not be started`;
  // markitdown 0.1 split its readers into extras; a bare install reads
  // almost nothing and says so with this exception.
  if (bin === "markitdown" && /MissingDependency|markitdown\[/.test(r.stderr)) {
    return "markitdown is installed without the reader for this format — reinstall it with the extras: pipx install --force 'markitdown[all]'";
  }
  return `${bin} exited with an error`;
}

async function viaMarkitdown(p: string, kind: DocKind, deps: DocDeps, s: DocSettings, notes: string[]): Promise<Extracted | null> {
  if (!(await deps.hasBin("markitdown"))) return null;
  const r = await deps.run("markitdown", [p], { timeoutMs: s.timeoutMs, maxBytes: CONVERTER_MAX_BYTES });
  if (r.ok && hasText(r.stdout)) {
    const marked = markPages(normaliseMarkitdown(r.stdout));
    return { text: marked.text, via: "markitdown", kind, capped: r.capped };
  }
  notes.push(r.ok ? "markitdown found no text" : failed("markitdown", r, s));
  return null;
}

async function viaPdftotext(p: string, deps: DocDeps, s: DocSettings, notes: string[]): Promise<Extracted | null> {
  if (!(await deps.hasBin("pdftotext"))) return null;
  // "-" is stdout. -layout keeps columns and tables roughly where they were.
  const r = await deps.run("pdftotext", ["-layout", "-enc", "UTF-8", p, "-"], { timeoutMs: s.timeoutMs, maxBytes: CONVERTER_MAX_BYTES });
  if (r.ok && hasText(r.stdout)) {
    return { text: markPages(r.stdout).text, via: "pdftotext", kind: "pdf", capped: r.capped };
  }
  notes.push(r.ok ? "pdftotext found no text layer" : failed("pdftotext", r, s));
  return null;
}

async function ocrImage(p: string, deps: DocDeps, s: DocSettings): Promise<RunResult> {
  return deps.run("tesseract", [p, "stdout", "-l", s.ocrLang], { timeoutMs: s.timeoutMs, maxBytes: CONVERTER_MAX_BYTES });
}

/** A scanned PDF: render pages with pdftoppm, OCR each. The temp folder never reaches the output. */
async function ocrPdf(p: string, deps: DocDeps, s: DocSettings, notes: string[]): Promise<Extracted | null> {
  if (!(await deps.hasBin("tesseract")) || !(await deps.hasBin("pdftoppm"))) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-ocr-"));
  try {
    const r = await deps.run(
      "pdftoppm",
      ["-r", "200", "-png", "-f", "1", "-l", String(s.ocrMaxPages), p, path.join(dir, "page")],
      { timeoutMs: s.timeoutMs, maxBytes: 64 * 1024 },
    );
    if (!r.ok) {
      notes.push(failed("pdftoppm", r, s));
      return null;
    }
    const pages = byNumber(fs.readdirSync(dir), /^page-(\d+)\.png$/);
    const out: string[] = [];
    for (const [i, img] of pages.entries()) {
      const t = await ocrImage(path.join(dir, img), deps, s);
      out.push(`--- page ${i + 1} ---\n${t.ok ? tidy(t.stdout) : `(${failed("tesseract", t, s)})`}`);
    }
    const text = out.join("\n\n");
    if (!hasText(text)) {
      notes.push("OCR found no readable text");
      return null;
    }
    const note = pages.length >= s.ocrMaxPages ? ` (first ${s.ocrMaxPages} pages — documents.ocrMaxPages)` : "";
    return { text, via: `tesseract OCR${note}`, kind: "pdf" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function extract(p: string, buf: Buffer, kind: DocKind, deps: DocDeps, s: DocSettings): Promise<Extracted | string> {
  const notes: string[] = [];
  const why = () => (notes.length ? ` (${notes.join("; ")})` : "");

  switch (kind) {
    case "text":
      return { text: decodeText(buf), via: "read directly", kind };
    case "html":
      return { text: htmlText(decodeText(buf)), via: "built-in HTML reader", kind };
    case "image": {
      if (!(await deps.hasBin("tesseract"))) {
        return `This is an image, and reading text out of a picture needs OCR. ${missing("tesseract")}`;
      }
      const r = await ocrImage(p, deps, s);
      if (r.ok && hasText(r.stdout)) return { text: tidy(r.stdout), via: "tesseract OCR", kind, capped: r.capped };
      return `tesseract found no readable text in this image${r.ok ? "" : ` (${failed("tesseract", r, s)})`}.`;
    }
    case "pdf": {
      const got = (await viaMarkitdown(p, kind, deps, s, notes))
        ?? (await viaPdftotext(p, deps, s, notes))
        ?? (await ocrPdf(p, deps, s, notes));
      if (got) return got;
      const have = await Promise.all(["markitdown", "pdftotext", "tesseract", "pdftoppm"].map((b) => deps.hasBin(b)));
      if (!have[0] && !have[1]) {
        return `PDFs need an external reader, and none is installed. ${missing("markitdown")} Or: ${missing("pdftotext")}`;
      }
      if (!have[2] || !have[3]) {
        return (
          `No text layer could be read from this PDF${why()} — it is probably a scan. ` +
          `Reading a scan needs OCR: ${!have[2] ? missing("tesseract") : ""} ${!have[3] ? missing("pdftoppm") : ""}`.trim()
        );
      }
      return `No text could be read from this PDF${why()}.`;
    }
    case "docx": case "xlsx": case "pptx": case "odt": case "ods": case "odp": case "unknown": {
      // markitdown does not read OpenDocument; for the Office trio it keeps
      // tables as Markdown, which reads better than our tab-separated rows.
      const isZip = buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
      // An unnamed file with no NUL bytes is text — no converter needed.
      if (kind === "unknown" && !isZip && !buf.subarray(0, 8192).includes(0)) {
        return { text: decodeText(buf), via: "read directly", kind: "text" };
      }
      if (kind === "docx" || kind === "xlsx" || kind === "pptx" || (kind === "unknown" && !isZip)) {
        const got = await viaMarkitdown(p, kind, deps, s, notes);
        if (got) return got;
      }
      // A named .docx that is not a zip still goes to the zip reader, whose
      // refusal says what is wrong with it.
      if (isZip || kind !== "unknown") {
        const b = builtinZip(buf, kind);
        if (b.kind !== "unknown") {
          return { text: b.text, via: `built-in ${b.kind} reader${notes.length ? ` (${notes.join("; ")})` : ""}`, kind: b.kind };
        }
        return `This is a zip archive, not a document read_document understands.`;
      }
      return (
        `read_document does not know this format${why()}. It reads PDF, Word, Excel, PowerPoint, ` +
        `OpenDocument, HTML, CSV/text and images. ${(await deps.hasBin("markitdown")) ? "" : missing("markitdown")}`
      ).trim();
    }
    case "legacy": {
      const got = await viaMarkitdown(p, kind, deps, s, notes);
      if (got) return got;
      return (
        `This is an old binary Office file (.doc/.xls/.ppt)${why()}, which the built-in reader cannot open. ` +
        `Convert it to the modern format first — LibreOffice does it: soffice --headless --convert-to docx (or xlsx, pptx) ` +
        `<file> — then read the converted file.` +
        ((await deps.hasBin("markitdown")) ? "" : ` For .xls, markitdown can also read it: ${missing("markitdown")}`)
      );
    }
  }
}

export interface ReadDocumentInput {
  path: string;
  /** Character offset to continue from, after a truncated read. */
  start?: number;
}

/**
 * The output is deterministic for a given file and start: no timings, no temp
 * paths, no clock. The coherence guard recognises a model re-reading the same
 * document by identical results, and a ticking status would blind it.
 */
export async function readDocument(input: ReadDocumentInput, deps: DocDeps = defaultDeps): Promise<string> {
  const s = docSettings();
  // The same two calls read_file makes, in the same order: resolve the way
  // every file tool resolves, then the sensitive-file denylist. A converter is
  // not a way round it — a key renamed key.pdf is still on the list by path.
  const p = path.resolve(resolveWorkPath(String(input.path ?? "")));
  const shown = collapseHome(p);
  if (isSensitivePath(p)) {
    return (
      "BLOCKED: that path is on the sensitive-file denylist and will never be read. " +
      "It holds credentials — keys, tokens, cookies or a private key."
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return `No such file: ${shown}`;
  }
  if (stat.isDirectory()) return `${shown} is a folder, not a document. Use glob to find the file inside it.`;
  if (!stat.isFile()) return `${shown} is not a regular file.`;
  if (stat.size > s.maxFileBytes) {
    return `${shown} is ${(stat.size / 1024 / 1024).toFixed(1)}MB — over the ${s.maxFileBytes / 1024 / 1024}MB cap (documents.maxFileMB in claw.config.json).`;
  }
  const buf = fs.readFileSync(p);
  const kind = kindOf(p, buf.subarray(0, 512));

  let got: Extracted | string;
  try {
    got = await extract(p, buf, kind, deps, s);
  } catch (err) {
    if (err instanceof ZipRefused) {
      return `Refused to open ${shown}: it is ${err.message}. It may be damaged or deliberately malformed; nothing inside it was read.`;
    }
    throw err;
  }
  if (typeof got === "string") return `${shown}: ${got}`;

  const full = got.text;
  if (!full.trim()) return `${shown}: ${LABEL[got.kind]}, read with ${got.via} — it contains no text.`;
  const start = Math.max(0, Math.floor(Number(input.start ?? 0)) || 0);
  if (start >= full.length) {
    return `${shown} is ${full.length} characters long; there is nothing from character ${start} on.`;
  }
  const end = Math.min(full.length, start + s.maxChars);
  const slice = full.slice(start, end);
  const units = full.match(/^--- (page|sheet|slide) \d+/gm) ?? [];
  const unit = units[0]?.split(" ")[1];
  const unitWord = unit ? `, ${units.length} ${unit}${units.length === 1 ? "" : "s"}` : "";
  const head = `${shown} — ${LABEL[got.kind]}${unitWord}, read with ${got.via}. ${full.length} characters` +
    (got.capped ? " (the converter's output was cut at its size cap)" : "") + ".";
  const tail = end < full.length
    ? `\n[Showing characters ${start}–${end} of ${full.length}, truncated. To continue, call read_document with start: ${end}.]`
    : start > 0 ? `\n[Showing characters ${start}–${end} of ${full.length}; this is the end.]` : "";
  const marked = end < full.length ? slice + "\n…[truncated]" : slice;
  return `${head}\n${fenceUntrusted(`document:${path.basename(p)}`, defuse(marked))}${tail}`;
}
