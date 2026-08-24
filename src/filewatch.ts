import fs from "node:fs";
import path from "node:path";

/**
 * Tracks what JARVIS writes during a session so the HUD can show the work, not
 * just the result. Watching a diff land is the difference between trusting the
 * agent and hoping.
 *
 * Content is capped and held in memory only — this is a view of the current
 * session, not a version-control system.
 */

export interface FileChange {
  path: string;
  name: string;
  action: "write" | "append" | "edit";
  at: string;
  bytes: number;
  /** Unified-ish diff for edits, or the body for a new file. */
  diff: string;
  added: number;
  removed: number;
}

const MAX_CHANGES = 40;
const MAX_DIFF_CHARS = 6000;

let changes: FileChange[] = [];

export function recentChanges(): FileChange[] {
  return changes;
}

export function clearChanges(): void {
  changes = [];
}

/** Line-level diff. Enough to read at a glance; not trying to be `git diff`. */
function makeDiff(before: string, after: string): { diff: string; added: number; removed: number } {
  const a = before.split("\n");
  const b = after.split("\n");

  // Trim the common prefix and suffix so only the changed region is shown.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

  const removedLines = a.slice(start, endA + 1);
  const addedLines = b.slice(start, endB + 1);

  const context = 2;
  const lead = a.slice(Math.max(0, start - context), start);
  const tail = a.slice(endA + 1, endA + 1 + context);

  const out: string[] = [];
  if (start > 0) out.push(`@@ line ${start + 1} @@`);
  for (const l of lead) out.push(`  ${l}`);
  for (const l of removedLines) out.push(`- ${l}`);
  for (const l of addedLines) out.push(`+ ${l}`);
  for (const l of tail) out.push(`  ${l}`);

  return {
    diff: out.join("\n").slice(0, MAX_DIFF_CHARS),
    added: addedLines.length,
    removed: removedLines.length,
  };
}

/** Capture a file's state before a write, so the change can be diffed after. */
export function snapshot(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

export function record(
  filePath: string,
  action: FileChange["action"],
  before: string,
): FileChange | null {
  let after = "";
  let bytes = 0;
  try {
    after = fs.readFileSync(filePath, "utf-8");
    bytes = fs.statSync(filePath).size;
  } catch {
    return null;
  }

  const isNew = before === "";
  const { diff, added, removed } = isNew
    ? {
        diff: after.split("\n").slice(0, 200).map((l) => `+ ${l}`).join("\n").slice(0, MAX_DIFF_CHARS),
        added: after.split("\n").length,
        removed: 0,
      }
    : makeDiff(before, after);

  const change: FileChange = {
    path: filePath,
    name: path.basename(filePath),
    action: isNew ? "write" : action,
    at: new Date().toISOString(),
    bytes,
    diff,
    added,
    removed,
  };

  changes = [change, ...changes.filter((c) => c.path !== filePath)].slice(0, MAX_CHANGES);
  return change;
}
