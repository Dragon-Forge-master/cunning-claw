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
 * collapse together and the circling becomes visible.
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
 * Collapse an argument to its shape.
 *
 * For a shell command the verb is the identity: `ls -l` and `ls -la /tmp`
 * collapse to one move, while `git status` and `npm test` stay apart. For
 * structured input the keys are the shape — read_file{path} repeated is
 * circling whichever path it names.
 */
export function signature(name: string, input: unknown): string {
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

  // For structured input the keys are the shape: read_file{path} repeated is
  // circling whichever path it names, and read_email 1,2,3 is the same move.
  const keys = Object.keys(obj).sort().join(",");
  return `${name}:{${keys}}`;
}

export function read(signatures: string[]): CoherenceReading {
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
  if (!signatures.length) return "";
  const counts = new Map<string, number>();
  for (const s of signatures) counts.set(s, (counts.get(s) ?? 0) + 1);
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
