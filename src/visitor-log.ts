import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * The visitor log: who came to the door, as events, never as identities.
 *
 * One markdown line per event on the Desk (~/Documents/CunningClaw, the same
 * folder the HUD's Docs page edits), so the operator reads and edits it like
 * any other document. The stills it points at stay in DATA_DIR/visitors —
 * never the Desk, which people sync and share, and never git.
 *
 * What it deliberately is not: a register of faces. A doorbell camera sees the
 * pavement, the postman and the neighbour's children. The ICO's guidance on
 * domestic CCTV is that once a camera captures people beyond your own
 * boundary, UK GDPR applies to you as a controller: say you record, keep only
 * what you need, delete on a schedule, answer a subject-access request. And
 * recognising a person from their face is biometric processing to identify
 * them — special-category data under Article 9, which a household has no
 * lawful basis to build. So the log records a time, what happened, an
 * optional still kept on this machine, and an optional generic caption
 * ("a courier holding a parcel"); household presence comes from Home
 * Assistant's own person.* entities, which the household set up on their own
 * phones. Retention is the "delete on a schedule" half: lines and stills older
 * than visitorRetentionDays go.
 */

export const VISITOR_LOG_NAME = "Visitor log";
export const DEFAULT_RETENTION_DAYS = 30;

export function deskDir(home: string = os.homedir()): string {
  return path.join(home, "Documents", "CunningClaw");
}

export function visitorLogFile(desk: string = deskDir()): string {
  return path.join(desk, `${VISITOR_LOG_NAME}.md`);
}

export function snapshotRoot(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, "visitors");
}

const HEADER = [
  `# ${VISITOR_LOG_NAME}`,
  "",
  "Written by Cunning Claw from Home Assistant events: one line per event, newest last.",
  "Stills are kept on this machine only (data/visitors), and lines and stills older than the retention period are deleted.",
  "Nobody is identified here — a caption, where there is one, is an automatic guess about a camera image, never a name.",
  "",
].join("\n");

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local date and minute, the way the operator reads a clock. */
export function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A caption is a model's words about a stranger's image. One line, no angle
 * brackets (so it can neither close a fence nor open one), capped.
 */
export function cleanCaption(raw: string, cap = 160): string {
  const one = String(raw ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return one.length > cap ? `${one.slice(0, cap - 1).trimEnd()}…` : one;
}

/** A label from HA (a friendly name) on one line, with nothing that reads as markup. */
export function cleanLabel(raw: string, cap = 60): string {
  return String(raw ?? "").replace(/[<>\[\]`|]/g, "").replace(/\s+/g, " ").trim().slice(0, cap);
}

export interface VisitorEntry {
  at: Date;
  /** "Front door — doorbell pressed". Ours, built from the event, not from a stranger. */
  what: string;
  /** Path relative to DATA_DIR, e.g. visitors/2026-11-20/143201-front_door.jpg. */
  snapshot?: string;
  caption?: string;
}

/**
 * The line. The caption is fenced in place — the same <untrusted> tag the
 * rest of the claw uses — because the model reads this file back (read_file,
 * home_status), and a caption is the one part of it a stranger could have
 * influenced, by holding a sign up to the camera.
 */
export function formatEntry(e: VisitorEntry): string {
  const parts = [`- ${stamp(e.at)} · ${cleanLabel(e.what, 120)}`];
  if (e.snapshot) parts.push(`still: ${e.snapshot}`);
  const caption = e.caption ? cleanCaption(e.caption) : "";
  if (caption) parts.push(`camera caption (automatic, may be wrong): <untrusted source="camera caption">${caption}</untrusted>`);
  return parts.join(" · ");
}

export function appendEntry(e: VisitorEntry, file: string = visitorLogFile()): string {
  const line = formatEntry(e);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER);
  fs.appendFileSync(file, `${line}\n`);
  return line;
}

const LINE_TIME = /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) · /;

function lineTime(line: string): Date | null {
  const m = LINE_TIME.exec(line);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/** The newest event line that passes `want`, for home_status. */
export function lastEntry(want: (line: string) => boolean = () => true, file: string = visitorLogFile()): string | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf-8"); } catch { return null; }
  const lines = text.split("\n").filter((l) => LINE_TIME.test(l) && want(l));
  return lines.length ? lines[lines.length - 1] : null;
}

/** Save one still under DATA_DIR/visitors/<day>/. Returns the path relative to DATA_DIR. */
export function saveStill(
  bytes: Buffer,
  mediaType: "image/jpeg" | "image/png",
  at: Date,
  entityId: string,
  dataDir: string = DATA_DIR,
): string {
  const day = stamp(at).slice(0, 10);
  const dir = path.join(snapshotRoot(dataDir), day);
  fs.mkdirSync(dir, { recursive: true });
  const ext = mediaType === "image/png" ? "png" : "jpg";
  const base = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${entityId.replace(/[^a-z0-9_]/g, "_")}`;
  let name = `${base}.${ext}`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}.${ext}`;
  fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 });
  return path.posix.join("visitors", day, name);
}

/**
 * Delete what is older than the retention period: log lines by their own
 * time, stills by their file's age. Lines that are not events (the header,
 * anything the operator wrote) are kept. Returns what went, for the log.
 */
export function prune(opts: {
  retentionDays?: number;
  now?: Date;
  file?: string;
  dataDir?: string;
} = {}): { lines: number; stills: number } {
  const days = Math.max(1, Number(opts.retentionDays ?? DEFAULT_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS);
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - days * 86_400_000;
  const file = opts.file ?? visitorLogFile();
  let lines = 0;
  let stills = 0;

  try {
    const text = fs.readFileSync(file, "utf-8");
    const kept = text.split("\n").filter((l) => {
      const t = lineTime(l);
      if (t && t.getTime() < cutoff) { lines++; return false; }
      return true;
    });
    if (lines) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, kept.join("\n"));
      fs.renameSync(tmp, file);
    }
  } catch { /* no log yet */ }

  const root = snapshotRoot(opts.dataDir ?? DATA_DIR);
  let dayDirs: string[] = [];
  try { dayDirs = fs.readdirSync(root); } catch { /* no stills yet */ }
  for (const day of dayDirs) {
    const dir = path.join(root, day);
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); stills++; }
      } catch { /* gone already */ }
    }
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* not empty, or gone */ }
  }
  return { lines, stills };
}
