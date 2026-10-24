import fs from "node:fs";
import path from "node:path";
import { config, DATA_DIR } from "./config.js";

/**
 * Repetition ratio, from the Quantum Coherence Kernel.
 *
 *   repetitionRatio = 1 - (uniqueSteps / totalSteps)
 *
 * The Ouroboros guard already blocks a tool call repeated *identically*. This
 * catches the commoner and slipperier failure: circling. An agent that runs
 * `ls`, then `ls -l`, then `ls -la`, then `ls` again is not repeating itself by
 * the strict test and is plainly getting nowhere. Every one of those is a
 * distinct string, so exact-match detection never fires.
 *
 * Signature is deliberately coarser than the Ouroboros key — the tool name plus
 * the *shape* of its argument rather than the argument itself — so near-misses
 * collapse together and the circling becomes visible. Coarse is not the same as
 * blind, though: for file and search tools the shape includes WHICH file or
 * pattern, because four greps for four different things is research, not
 * circling (see FOCUS below for how that was learned).
 *
 * A high ratio is a smell, not a crime: re-reading the same file while editing
 * it is legitimate. So this nudges first and only refuses when the turn is
 * clearly stuck.
 */

export interface CoherenceReading {
  total: number;
  unique: number;
  ratio: number;
  verdict: "execute" | "ruminate" | "halt";
}

/**
 * Tools that keep the books on the work rather than doing it.
 *
 * Updating the todo list after every step is exactly what the system prompt
 * asks for, and each update has the same shape, so counting them made a
 * well-organised turn look like a stuck one. They are left out of the ratio
 * altogether — they can neither trip the guard nor dilute a real loop.
 */
const BOOKKEEPING = new Set(["todo"]);

/**
 * For file and search tools, the arguments that say what the call is ABOUT.
 *
 * Until 24 Oct these tools were identified by their key names alone, so
 * grep{pattern:"a"} and grep{pattern:"b"} were "the same move". The operator's
 * history that day showed the warning firing four times (40–50%) through
 * ordinary coding — four greps for four different things, two edit_file calls
 * on two different files — and five greps plus one read is already 67%, past
 * the halt line, on precisely the glob/grep/read pattern the system prompt
 * tells the claw to use. The path or pattern is the work; the same one
 * repeated is still circling, and still caught.
 *
 * read_file's offset is part of the identity because paging through a long
 * file is progress, like turning pages; reading the same window again is not.
 */
const FOCUS: Record<string, readonly string[]> = {
  read_file: ["path", "offset"],
  write_file: ["path"],
  edit_file: ["path"],
  grep: ["pattern", "path", "glob"],
  glob: ["pattern", "path"],
  memory_search: ["query"],
  browser_open: ["url"],
  http_request: ["url"],
};

/** Longest slice of an argument kept in a signature — they are persisted. */
const FOCUS_MAX = 120;

/**
 * Make trivially different spellings of one argument compare equal, so that
 * `./src/a.ts` vs `src/a.ts/`, or "Foo " vs "foo", are still one move.
 *
 * URLs keep only host and path: the query string is where tokens live, and
 * signatures are written to disk by recordTurnShape.
 */
function normalise(key: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  // Reading from line 1 is reading from the top, however it was spelt.
  if (key === "offset") return Number(value) > 1 ? String(Number(value)) : "";
  if (typeof value !== "string") return String(value);
  let v = value.trim();
  if (key === "url") {
    try {
      const u = new URL(v);
      v = `${u.host}${u.pathname}`.replace(/\/+$/, "");
    } catch { /* not a URL — fall through and treat it as text */ }
    return v.toLowerCase().slice(0, FOCUS_MAX);
  }
  if (key === "path") {
    v = v.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "");
    if (v.length > 1) v = v.replace(/\/+$/, "");
    return v.slice(0, FOCUS_MAX);
  }
  // Patterns and queries: case and spacing are not a different idea.
  return v.toLowerCase().replace(/\s+/g, " ").slice(0, FOCUS_MAX);
}

/**
 * Collapse an argument to its shape.
 *
 * For a shell command the verb is the identity: `ls -l` and `ls -la /tmp`
 * collapse to one move, while `git status` and `npm test` stay apart. For file
 * and search tools the target is the identity (FOCUS). For other structured
 * input the keys are the shape — read_email 1, 2, 3 is the same move.
 *
 * Returns "" for a bookkeeping call: it ran, but it is not a move.
 */
export function signature(name: string, input: unknown): string {
  if (BOOKKEEPING.has(name)) return "";
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  // For a shell command the verb *is* the identity — "git status" and
  // "npm test" are different work, while "ls -l" and "ls -la" are one move.
  // Keep the program and its subcommand; drop flags, paths and arguments.
  const cmd = typeof obj.command === "string" ? obj.command : null;
  if (cmd) {
    const words = cmd
      .toLowerCase()
      .split(/[|;&]/)[0]                       // only the first stage of a pipe
      .trim()
      .split(/\s+/)
      .filter((w) => !w.startsWith("-"))        // flags are not the idea
      .filter((w) => !/[/~.]/.test(w));         // nor are paths
    return `${name}:${words.slice(0, 2).join(" ")}`;
  }

  const focus = FOCUS[name];
  if (focus) {
    const parts = focus.map((k) => normalise(k, obj[k]));
    // Trailing empties are dropped so grep{pattern} and grep{pattern, path:""}
    // agree; the separator keeps "a" + "b" from meeting "ab" + "".
    while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    return `${name}:${parts.join(" @ ")}`;
  }

  // For other structured input the keys are the shape: read_email 1,2,3 is the
  // same move.
  const keys = Object.keys(obj).sort().join(",");
  return `${name}:{${keys}}`;
}

export function read(all: string[]): CoherenceReading {
  // Bookkeeping calls are recorded (so the turn knows tools ran) but not
  // judged.
  const signatures = all.filter((s) => s !== "");
  const total = signatures.length;
  const unique = new Set(signatures).size;
  const ratio = total === 0 ? 0 : 1 - unique / total;

  const warn = config.coherence?.repetitionWarn ?? 0.4;
  const halt = config.coherence?.repetitionHalt ?? 0.6;
  const floor = config.coherence?.minStepsBeforeJudging ?? 4;

  // Two calls that happen to rhyme is not a pattern. Wait for enough of them.
  if (total < floor) return { total, unique, ratio, verdict: "execute" };
  if (ratio >= halt) return { total, unique, ratio, verdict: "halt" };
  if (ratio >= warn) return { total, unique, ratio, verdict: "ruminate" };
  return { total, unique, ratio, verdict: "execute" };
}

/**
 * Judge the next call, and record it only if it is allowed to run.
 *
 * A refused call must not count. It used to: agent.ts pushed the signature,
 * then read the ratio, so once a turn reached the halt line every further
 * attempt — even a genuinely different one — was added to the tally and
 * refused, and the ratio could never come back down. A guard with no way out
 * is not a guard, it is the end of the turn. Now a refused attempt leaves the
 * tally untouched, so a real change of tack is judged on its merits while the
 * same move again is refused again.
 */
export function admit(shapes: string[], name: string, input: unknown): CoherenceReading {
  const sig = signature(name, input);
  const reading = read([...shapes, sig]);
  if (reading.verdict !== "halt") shapes.push(sig);
  return reading;
}

/** What to tell the model when it is going round in circles. */
export function notice(r: CoherenceReading): string {
  const pct = Math.round(r.ratio * 100);
  if (r.verdict === "halt") {
    return (
      `[Coherence] ${pct}% of this turn's ${r.total} tool calls have been variations of ` +
      `the same move. That is circling, not progress. Stop calling tools. Tell the user ` +
      `plainly what you were trying to do, what happened instead, and what you need from ` +
      `them — a different approach or a piece of information you do not have.`
    );
  }
  return (
    `[Coherence] ${pct}% of this turn's ${r.total} tool calls have been variations of the ` +
    `same move. Before the next one: is this actually a different approach, or the same ` +
    `one wearing a different flag? If it is the same one, change tack or ask.`
  );
}

// ---------------------------------------------------------------------------
// Across turns
// ---------------------------------------------------------------------------

/**
 * The same guard, but with a memory.
 *
 * Everything above is scoped to ONE turn: `shapes` is local to runTurn, so it
 * starts empty every time the operator speaks. That leaves the commonest real
 * failure completely invisible — the operator says "the controls don't work",
 * the claw rewrites the file and declares it fixed; the operator says "still
 * not working", and the claw rewrites the same file the same way and declares
 * it fixed again. Three turns, three identical approaches, three confident
 * reports, and not one guard fired, because each turn was a fresh start.
 *
 * This remembers what shape of work each turn was mostly made of, and says so
 * when the same shape comes round for the third time. It is a NUDGE and never
 * a block: repeating an edit across turns is often exactly right, and the cost
 * of a false positive must stay at one sentence of advice.
 */
const SHAPES_FILE = path.join(DATA_DIR, "turn-shapes.json");
const KEEP_TURNS = 6;

/** The move a turn was mostly made of, or "" when it did nothing much. */
export function dominantShape(signatures: string[]): string {
  const counts = new Map<string, number>();
  // A turn that mostly ticked off its todo list was not "mostly todo".
  for (const s of signatures) if (s !== "") counts.set(s, (counts.get(s) ?? 0) + 1);
  let best = "";
  let n = 0;
  for (const [sig, count] of counts) {
    if (count > n) { best = sig; n = count; }
  }
  return best;
}

function loadShapes(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(SHAPES_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function recordTurnShape(signatures: string[]): void {
  const shape = dominantShape(signatures);
  if (!shape) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SHAPES_FILE, JSON.stringify([...loadShapes(), shape].slice(-KEEP_TURNS)));
  } catch { /* advisory only — never fail a turn over it */ }
}

export function forgetTurnShapes(): void {
  try { fs.rmSync(SHAPES_FILE, { force: true }); } catch { /* ignore */ }
}

/**
 * Has the claw spent the last few turns doing the same thing?
 *
 * Returns the line to put in front of the model, or "" when there is nothing
 * to say. Deliberately phrased as a question about diagnosis rather than an
 * instruction to stop — the operator may well want a fourth attempt, just an
 * informed one.
 */
export function repeatedAcrossTurns(recent = loadShapes()): string {
  const need = config.coherence?.repeatTurnsBeforeWarning ?? 3;
  if (recent.length < need) return "";
  const tail = recent.slice(-need);
  if (new Set(tail).size !== 1) return "";
  const [what] = tail;
  const verb = what.split(":").slice(1).join(":") || what;
  return (
    ` Careful — the last ${need} turns have all been the same move (${verb}), which means ` +
    `the previous ${need - 1} attempts did not work. Do NOT simply do it again: say what you ` +
    `actually changed last time, what you expected, and what happened instead. If you cannot ` +
    `test it yourself, say so and ask ${config.persona.userName} what they are seeing rather ` +
    `than declaring it fixed a third time.`
  );
}
