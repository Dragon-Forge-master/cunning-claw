import fs from "node:fs";
import path from "node:path";

/**
 * Learn mode's pure half: the lesson file format, grading, the Leitner review
 * schedule and the progress file. A leaf — fs and path only, with the folder
 * and the clock handed in — so tools.ts (the read-only learn_progress tool)
 * and learn.ts (the lesson engine) can both use it without an import cycle,
 * and so every rule here is tested without a server or a model.
 *
 * Why the grading is code and not the model: the two AI-tutor trials that
 * matter most for this design found that a tutor improvising its own facts
 * was right about half the time (Bastani et al. 2025, PNAS: GPT Base correct
 * 51% of the time), and that "a system prompt could not reliably provide
 * enough structure" to sequence a multi-part problem (Kestin et al. 2025,
 * Scientific Reports). So the lesson file carries a teacher-written answer
 * key, the server owns the order of the steps, and a check is a small
 * deterministic function — the same idea as the graded exercises in
 * Anthropic's prompt-engineering tutorial. docs/LEARN-MODE.md has the sources.
 */

// ---------------------------------------------------------------------------
// Lesson files
// ---------------------------------------------------------------------------

/** The four-part shape every lesson follows, plus the steps inside each part. */
export const STEP_TYPES = ["why", "ask", "example", "real", "practice", "explain", "recall", "check"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const CONFIDENCE = ["sure", "think", "guess"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export interface Choice {
  text: string;
  correct: boolean;
}

export interface Step {
  type: StepType;
  /** Stable within the lesson: `cold`, `r1`. Review items are keyed lesson#id. */
  id: string;
  /** What the learner reads. Plain English, authored, never generated. */
  text: string;
  /** Short-answer key: groups of alternatives; a group is met when any alternative appears. */
  answer?: string[][];
  /** How many answer groups must be met. Defaults to all of them. */
  pass?: number;
  options?: Choice[];
  /** More than one option may be right; all right ones and no wrong ones must be picked. */
  multi?: boolean;
  /** T7: ask sure / think so / guessing before the answer is revealed. */
  confidence?: boolean;
  /** T3: the first rung of the hint ladder. */
  hint?: string;
  /** T3: after two misses, the worked example. */
  example?: string;
  /** Shown once the question is settled — the answer key in the learner's words. */
  reveal?: string;
  /** practice steps: which scenario; check steps: what the check reads. */
  scenario?: string;
  kind?: "question" | "scenario" | "status-map";
  /** real steps: a code check the server runs before the step counts. */
  verify?: "schedule-armed";
  critical?: boolean;
  /** check steps: the score needed, 0..1. Safety-critical checks set 1. */
  threshold?: number;
}

export interface Lesson {
  id: string;
  module: string;
  order: number;
  title: string;
  minutes: number;
  outcomes: string[];
  benchmark: string[];
  fluency: string[];
  requires: string[];
  critical: boolean;
  /** "needs-author" until a Welsh speaker writes learn/cy/<module>/<lesson>.md. */
  cy: string;
  /** Facts the tutor may state, each one asserted against the code by learn.test.ts. */
  claims: { key: string; value: string }[];
  steps: Step[];
  file: string;
}

export interface Module {
  id: string;
  order: number;
  title: string;
  /** The Swyn name of the ward this module teaches, if it has one (docs/SWYN.md). */
  ward?: string;
  summary: string;
}

/**
 * The seven core modules and the capstone, in course order. Titles are
 * English; the ward is the Swyn lexicon's own name for the subsystem, shown on
 * human-facing surfaces only — never in the model-facing step line.
 */
export const MODULES: Module[] = [
  { id: "talking", order: 1, title: "Talking to it", summary: "Bring a job, give it a finish line, check what came back." },
  { id: "turn", order: 2, title: "How a turn works", ward: "y sarff", summary: "Chips, states, STOP, and which brain answered." },
  { id: "consent", order: 3, title: "Consent", ward: "y llw", summary: "Reading a card, and what silence means." },
  { id: "floor", order: 4, title: "Plans and the floor", summary: "Work orders, the command floor and the sandbox." },
  { id: "strangers", order: 5, title: "Strangers' words", ward: "y ffens", summary: "How a planted instruction reaches an agent, and what catches it." },
  { id: "brains", order: 6, title: "Brains and money", summary: "Choosing a brain by privacy, cost and capability." },
  { id: "leaves", order: 7, title: "What leaves the machine", summary: "Where your words and alerts actually go." },
  { id: "capstone", order: 8, title: "Capstone: one standing order", ward: "swyn", summary: "Arm one real standing order safely, and know how to stop it." },
];

const LIST_KEYS = new Set(["outcomes", "benchmark", "fluency", "requires"]);

function splitList(v: string): string[] {
  return v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Frontmatter without a YAML dependency, the same way SKILL.md is read:
 * `key: value` lines, and `claims:` followed by `  - key = value` lines.
 */
function parseFrontmatter(block: string): { fields: Record<string, string>; claims: { key: string; value: string }[] } {
  const fields: Record<string, string> = {};
  const claims: { key: string; value: string }[] = [];
  let inClaims = false;
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.+)$/);
    if (inClaims && item) {
      const eq = item[1].indexOf("=");
      if (eq > 0) claims.push({ key: item[1].slice(0, eq).trim(), value: item[1].slice(eq + 1).trim() });
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    inClaims = kv[1] === "claims";
    if (!inClaims) fields[kv[1]] = kv[2].trim();
  }
  return { fields, claims };
}

const STEP_KEYS = new Set([
  "answer", "pass", "confidence", "hint", "example", "reveal", "kind", "verify", "critical", "threshold", "multi",
]);

function yes(v: string | undefined): boolean {
  return /^(yes|true|1)$/i.test(String(v ?? "").trim());
}

/** `send, email | to, recipient` → [["send","email"],["to","recipient"]], lower-cased. */
export function parseAnswerKey(v: string): string[][] {
  return v.split("|")
    .map((g) => g.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean))
    .filter((g) => g.length > 0);
}

function parseStep(heading: string, body: string, index: number): Step | string {
  const [typeWord, arg] = heading.trim().split(/\s+/, 2);
  const type = typeWord?.toLowerCase() as StepType;
  if (!STEP_TYPES.includes(type)) return `unknown step type "${typeWord}"`;
  const step: Step = { type, id: type === "practice" ? `practice` : arg || `${type}${index}`, text: "" };
  if (type === "practice") {
    if (!arg) return "a practice step names its scenario: ## practice <scenario-id>";
    step.scenario = arg;
  }
  const text: string[] = [];
  const options: Choice[] = [];
  // Only a question has options: an example may quote a standing order,
  // and "- [x] schedule: …" in it is text to read, not an answer to pick.
  const answerable = type === "ask" || type === "recall" || type === "explain" || type === "check";
  for (const line of body.split("\n")) {
    const opt = answerable ? line.match(/^- \[( |x|X)\] (.+)$/) : null;
    if (opt) {
      options.push({ text: opt[2].trim(), correct: opt[1].toLowerCase() === "x" });
      continue;
    }
    const kv = line.match(/^([a-z]+):\s*(.*)$/);
    if (kv && STEP_KEYS.has(kv[1])) {
      const [, k, v] = kv;
      if (k === "answer") step.answer = parseAnswerKey(v);
      else if (k === "pass") step.pass = Number(v);
      else if (k === "threshold") step.threshold = Number(v);
      else if (k === "confidence") step.confidence = yes(v);
      else if (k === "critical") step.critical = yes(v);
      else if (k === "multi") step.multi = yes(v);
      else if (k === "kind") step.kind = v as Step["kind"];
      else if (k === "verify") step.verify = v as Step["verify"];
      else (step as unknown as Record<string, string>)[k] = v;
      continue;
    }
    text.push(line);
  }
  step.text = text.join("\n").trim();
  if (options.length) step.options = options;
  if (type === "check" && !step.kind) step.kind = options.length || step.answer ? "question" : "scenario";
  return step;
}

/** Parse one lesson file. Returns the lesson, or a list of what is wrong with it. */
export function parseLesson(md: string, file = "(lesson)"): Lesson | { errors: string[] } {
  const errors: string[] = [];
  const m = md.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { errors: [`${file}: no frontmatter`] };
  const { fields, claims } = parseFrontmatter(m[1]);
  for (const k of ["id", "module", "title"]) if (!fields[k]) errors.push(`${file}: frontmatter needs ${k}`);
  const steps: Step[] = [];
  const parts = m[2].split(/^## /m).slice(1);
  parts.forEach((part, i) => {
    const nl = part.indexOf("\n");
    const heading = nl === -1 ? part : part.slice(0, nl);
    const body = nl === -1 ? "" : part.slice(nl + 1);
    const step = parseStep(heading, body, i);
    if (typeof step === "string") errors.push(`${file}: ${step}`);
    else steps.push(step);
  });
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) errors.push(`${file}: two steps share the id "${s.id}"`);
    ids.add(s.id);
    for (const g of s.answer ?? []) {
      for (const alt of g) if (!normaliseAnswer(alt).trim()) errors.push(`${file}: "${s.id}" has an answer alternative that is only punctuation ("${alt}")`);
    }
    if ((s.type === "ask" || s.type === "recall" || s.type === "explain") && !s.answer && !s.options) {
      errors.push(`${file}: ${s.type} "${s.id}" has no answer key`);
    }
    if (s.type === "check" && s.kind === "question" && !s.answer && !s.options) {
      errors.push(`${file}: check "${s.id}" has no answer key`);
    }
  }
  if (!steps.some((s) => s.type === "check")) errors.push(`${file}: a lesson ends in a mastery check`);
  if (errors.length) return { errors };
  const list = (k: string) => (LIST_KEYS.has(k) ? splitList(fields[k] ?? "") : []);
  return {
    id: fields.id,
    module: fields.module,
    order: Number(fields.order ?? 1) || 1,
    title: fields.title,
    minutes: Number(fields.minutes ?? 10) || 10,
    outcomes: list("outcomes"),
    benchmark: list("benchmark"),
    fluency: list("fluency"),
    requires: list("requires"),
    critical: yes(fields.critical),
    cy: fields.cy || "needs-author",
    claims,
    steps,
    file,
  };
}

/** Every lesson under learn/<lang>/, sorted by module then order. Bad files are reported, not thrown. */
export function loadLessons(root: string, lang = "en"): { lessons: Lesson[]; errors: string[] } {
  const dir = path.join(root, lang);
  const lessons: Lesson[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(dir)) return { lessons, errors };
  for (const mod of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, mod.name))) {
      if (!f.endsWith(".md")) continue;
      const file = path.join(dir, mod.name, f);
      const parsed = parseLesson(fs.readFileSync(file, "utf-8"), path.relative(root, file));
      if ("errors" in parsed) errors.push(...parsed.errors);
      else lessons.push(parsed);
    }
  }
  const modOrder = (id: string) => MODULES.find((m) => m.id === id)?.order ?? 99;
  lessons.sort((a, b) => modOrder(a.module) - modOrder(b.module) || a.order - b.order);
  return { lessons, errors };
}

/** Does a Welsh lesson exist for this one? The marker stays until a Welsh speaker writes it. */
export function welshStatus(root: string, lesson: Lesson): "authored" | "needs-author" {
  const rel = path.relative(path.join(root, "en"), path.join(root, lesson.file));
  return fs.existsSync(path.join(root, "cy", rel)) ? "authored" : "needs-author";
}

/**
 * What the HUD may see of a step before it is answered: the prompt, the
 * options' text and nothing that gives the answer away (T4 — the tutor never
 * answers its own question). The key, the hint and the worked example leave
 * the server only through grade().
 */
export function publicStep(step: Step): Record<string, unknown> {
  return {
    type: step.type,
    id: step.id,
    text: step.text,
    confidence: Boolean(step.confidence),
    options: step.options?.map((o) => o.text),
    multi: Boolean(step.multi),
    scenario: step.scenario,
    kind: step.kind,
    verify: step.verify,
    critical: Boolean(step.critical),
    answerable: Boolean(step.answer || step.options),
  };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export function normaliseAnswer(s: string): string {
  return ` ${String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9@.'£\s-]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does one key alternative appear in a normalised answer? A whole word, or the
 * word with a common ending ("limit" meets "limits", "to" does not meet
 * "tomato"); a trailing * makes it a stem ("rephras*" meets "rephrased").
 * An alternative made only of punctuation normalises to nothing and nothing
 * is in every answer, so it never matches — parseLesson refuses one as well.
 */
export function altMatches(text: string, alt: string): boolean {
  const stem = alt.trim().endsWith("*");
  const want = normaliseAnswer(alt.replace(/\*$/, "")).trim();
  if (!want) return false;
  if (stem) return text.includes(` ${want}`);
  return new RegExp(` ${escapeRe(want)}(?:s|es|ed|d|ing|er|ers|ly|'s|n't)?(?= )`).test(text);
}

export interface Grade {
  correct: boolean;
  /** 0..1 — groups met, or 1/0 for a choice. */
  score: number;
  /** Which answer groups the answer met, for task-focused feedback. */
  met: number;
  needed: number;
}

/**
 * A short answer passes when enough of its key's groups are met; a group is
 * met when any one of its alternatives appears in the answer. A choice passes
 * when exactly the right options are picked. Deterministic and explainable —
 * a learner who disagrees can read the key in the lesson file.
 */
export function grade(step: Step, answer: { text?: string; choice?: number[] }): Grade {
  if (step.options) {
    const picked = new Set((answer.choice ?? []).filter((i) => Number.isInteger(i)));
    const right = step.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0);
    const ok = right.length === picked.size && right.every((i) => picked.has(i));
    return { correct: ok, score: ok ? 1 : 0, met: ok ? 1 : 0, needed: 1 };
  }
  const groups = step.answer ?? [];
  const text = normaliseAnswer(answer.text ?? "");
  const met = groups.filter((g) => g.some((alt) => altMatches(text, alt))).length;
  const needed = Math.min(groups.length, step.pass && step.pass > 0 ? step.pass : groups.length);
  return { correct: needed > 0 && met >= needed, score: needed ? Math.min(1, met / needed) : 0, met, needed };
}

/**
 * The hint ladder (T3): a miss earns the hint, a second miss the worked
 * example, and after that the reveal — the learner is never stuck at a
 * question. Feedback is about the task, never about the person (T5:
 * Kluger & DeNisi found over a third of feedback interventions made
 * performance worse, most often when the feedback was about the self).
 */
export function ladder(step: Step, misses: number): { rung: "hint" | "example" | "reveal"; text: string } {
  if (misses <= 1 && step.hint) return { rung: "hint", text: step.hint };
  if (misses <= 2 && step.example) return { rung: "example", text: step.example };
  return { rung: "reveal", text: step.reveal ?? "" };
}

/** Task-focused feedback for a short answer: what it covered, what it missed. Never praise or blame. */
export function feedback(step: Step, g: Grade): string {
  if (step.options) return g.correct ? "That matches the key." : "That does not match the key.";
  if (g.correct) return `That covers ${g.met} of the ${step.answer?.length ?? g.needed} points in the key.`;
  return `That covers ${g.met} of the ${g.needed} points this needs.`;
}

// ---------------------------------------------------------------------------
// Spaced review: Leitner boxes
// ---------------------------------------------------------------------------

/**
 * Box intervals in days. 0 is "again this session". An expanding schedule
 * inside the ridge Cepeda et al. (2008) found — the best gap is roughly 5–40%
 * of how long the thing must be remembered — without needing a fitted model.
 */
export const BOX_DAYS = [0, 1, 3, 7, 16, 35] as const;
export const HISTORY_CAP = 20;

export interface ReviewItem {
  box: number;
  due: string;
  lesson: string;
  step: string;
  critical?: boolean;
  history: { at: string; correct: boolean; confidence: Confidence }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Move an item after an answer: right goes up one box, wrong drops to box 1.
 * A confident wrong answer on a safety-critical item also reports that its
 * lesson's practice should be re-opened, because "sure and wrong" about a card
 * is the exact miscalibration the practice ground exists to fix.
 */
export function scheduleItem(
  prev: ReviewItem | undefined,
  base: { lesson: string; step: string; critical?: boolean },
  correct: boolean,
  confidence: Confidence,
  now: Date,
): { item: ReviewItem; reopen: boolean } {
  const box = correct ? Math.min(BOX_DAYS.length - 1, (prev?.box ?? 0) + 1) : prev ? 1 : 0;
  const due = new Date(now.getTime() + BOX_DAYS[box] * DAY_MS).toISOString();
  const history = [...(prev?.history ?? []), { at: now.toISOString(), correct, confidence }].slice(-HISTORY_CAP);
  return {
    item: { box, due, lesson: base.lesson, step: base.step, critical: base.critical || undefined, history },
    reopen: Boolean(base.critical) && !correct && confidence === "sure",
  };
}

/**
 * Due items, interleaved (T10): never two from the same lesson in a row when
 * another lesson has one waiting, because mixing beats blocking even though
 * learners rate blocking as better (Kornell & Bjork 2008).
 */
export function dueItems(items: Record<string, ReviewItem>, now: Date, limit = 2): string[] {
  const due = Object.entries(items)
    .filter(([, it]) => Date.parse(it.due) <= now.getTime())
    .sort((a, b) => Date.parse(a[1].due) - Date.parse(b[1].due) || a[0].localeCompare(b[0]));
  const out: string[] = [];
  const pool = [...due];
  while (out.length < limit && pool.length) {
    const lastLesson = out.length ? items[out[out.length - 1]].lesson : "";
    const idx = pool.findIndex(([, it]) => it.lesson !== lastLesson);
    const [key] = pool.splice(idx === -1 ? 0 : idx, 1)[0];
    out.push(key);
  }
  return out;
}

export function dueCount(items: Record<string, ReviewItem>, now: Date): number {
  return Object.values(items).filter((it) => Date.parse(it.due) <= now.getTime()).length;
}

// ---------------------------------------------------------------------------
// Progress: data/learn/progress.json
// ---------------------------------------------------------------------------

export type LessonStatus = "new" | "started" | "practised" | "mastered";

export interface ScenarioResult {
  at: string;
  attempt: number;
  score: number;
  criticalPassed: boolean;
  passed: boolean;
  items: { beat: string; expected?: string; got?: string; correct: boolean; critical: boolean; ms?: number }[];
}

export interface LessonProgress {
  status: LessonStatus;
  attempts: number;
  step: number;
  startedAt?: string;
  masteredAt?: string;
  bestScore?: number;
  /** Set when a confident wrong answer on a critical item says "practise this again". */
  reopen?: boolean;
  /** Code-checked real-task steps that have passed, by step id. */
  verified?: string[];
  /** Baseline for a code check, taken when the step was reached (e.g. armed standing orders). */
  baseline?: string[];
}

export interface CheckResult {
  at: string;
  score: number;
}

export interface Progress {
  version: 1;
  lang: "en" | "cy";
  startedAt: string;
  placement: { testedOut: string[] };
  /** The learner's own job, their words, redacted before it is saved. */
  realTask?: string;
  lessons: Record<string, LessonProgress>;
  items: Record<string, ReviewItem>;
  practice: Record<string, { attempts: number; best?: number; last?: ScenarioResult }>;
  checks: { pre?: CheckResult; post?: CheckResult; delayed?: CheckResult };
  firstRealTaskAt?: string;
  capstone?: { kind: "standing-order" | "connector"; doneAt: string; reviewed?: boolean };
  /** T11: one opt-in reminder a day at most, through the heartbeat. Off until the operator turns it on. */
  nudges: boolean;
  lastNudge?: string;
}

export const PROGRESS_FILE = path.join("learn", "progress.json");

export function freshProgress(now: Date): Progress {
  return {
    version: 1,
    lang: "en",
    startedAt: now.toISOString(),
    placement: { testedOut: [] },
    lessons: {},
    items: {},
    practice: {},
    checks: {},
    nudges: false,
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Anything unrecognised falls back field by field, so a hand-edited or older file never stops the course. */
export function normaliseProgress(raw: unknown, now: Date): Progress {
  const r = obj(raw);
  const base = freshProgress(now);
  const lessons: Record<string, LessonProgress> = {};
  for (const [id, v] of Object.entries(obj(r.lessons))) {
    const l = obj(v);
    const status = (["new", "started", "practised", "mastered"] as const).find((s) => s === l.status) ?? "new";
    lessons[id] = {
      status,
      attempts: Number(l.attempts) || 0,
      step: Math.max(0, Number(l.step) || 0),
      startedAt: typeof l.startedAt === "string" ? l.startedAt : undefined,
      masteredAt: typeof l.masteredAt === "string" ? l.masteredAt : undefined,
      bestScore: typeof l.bestScore === "number" ? l.bestScore : undefined,
      reopen: l.reopen === true || undefined,
      verified: Array.isArray(l.verified) ? l.verified.filter((x): x is string => typeof x === "string") : undefined,
      baseline: Array.isArray(l.baseline) ? l.baseline.filter((x): x is string => typeof x === "string") : undefined,
    };
  }
  const items: Record<string, ReviewItem> = {};
  for (const [id, v] of Object.entries(obj(r.items))) {
    const it = obj(v);
    if (typeof it.due !== "string" || Number.isNaN(Date.parse(it.due))) continue;
    items[id] = {
      box: Math.max(0, Math.min(BOX_DAYS.length - 1, Number(it.box) || 0)),
      due: it.due,
      lesson: String(it.lesson ?? id.split("#")[0]),
      step: String(it.step ?? id.split("#")[1] ?? ""),
      critical: it.critical === true || undefined,
      history: (Array.isArray(it.history) ? it.history : []).slice(-HISTORY_CAP).map((h) => {
        const e = obj(h);
        return {
          at: String(e.at ?? ""),
          correct: e.correct === true,
          confidence: CONFIDENCE.find((c) => c === e.confidence) ?? "guess",
        };
      }),
    };
  }
  const practice: Progress["practice"] = {};
  for (const [id, v] of Object.entries(obj(r.practice))) {
    const p = obj(v);
    practice[id] = {
      attempts: Number(p.attempts) || 0,
      best: typeof p.best === "number" ? p.best : undefined,
      last: p.last && typeof p.last === "object" ? (p.last as ScenarioResult) : undefined,
    };
  }
  const placement = obj(r.placement);
  return {
    ...base,
    lang: r.lang === "cy" ? "cy" : "en",
    startedAt: typeof r.startedAt === "string" ? r.startedAt : base.startedAt,
    placement: { testedOut: Array.isArray(placement.testedOut) ? placement.testedOut.filter((x): x is string => typeof x === "string") : [] },
    realTask: typeof r.realTask === "string" ? r.realTask.slice(0, 500) : undefined,
    lessons,
    items,
    practice,
    checks: obj(r.checks) as Progress["checks"],
    firstRealTaskAt: typeof r.firstRealTaskAt === "string" ? r.firstRealTaskAt : undefined,
    capstone: r.capstone && typeof r.capstone === "object" ? (r.capstone as Progress["capstone"]) : undefined,
    nudges: r.nudges === true,
    lastNudge: typeof r.lastNudge === "string" ? r.lastNudge : undefined,
  };
}

export function loadProgress(dataDir: string, now: Date): Progress {
  try {
    return normaliseProgress(JSON.parse(fs.readFileSync(path.join(dataDir, PROGRESS_FILE), "utf-8")), now);
  } catch {
    return freshProgress(now);
  }
}

/** Written whole and renamed into place, so a crash mid-write never leaves half a file. */
export function saveProgress(dataDir: string, p: Progress): void {
  const file = path.join(dataDir, PROGRESS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Local calendar day, YYYY-MM-DD — "once a day" means the operator's day, not UTC's. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Should the heartbeat offer a review? Only when the operator turned
 * reminders on, only when something is actually due, and at most once a
 * local day (T11: offer, don't nag — engagement is the binding constraint,
 * Oreopoulos & Low 2026, but streak-shaming is not the answer to it).
 */
export function shouldNudge(p: Progress, now: Date): boolean {
  if (!p.nudges) return false;
  if (dueCount(p.items, now) === 0) return false;
  return p.lastNudge !== localDay(now);
}

/** The one-line summary the read-only learn_progress tool and the HUD both show. */
export function progressSummary(p: Progress, lessons: Lesson[], now: Date): string {
  const mastered = lessons.filter((l) => p.lessons[l.id]?.status === "mastered");
  const started = lessons.filter((l) => p.lessons[l.id] && p.lessons[l.id].status !== "new" && p.lessons[l.id].status !== "mastered");
  const lines = [
    `Learn mode: ${mastered.length} of ${lessons.length} lessons mastered; ${dueCount(p.items, now)} review question(s) due.`,
  ];
  for (const m of MODULES) {
    const mine = lessons.filter((l) => l.module === m.id);
    if (!mine.length) continue;
    const done = mine.filter((l) => p.lessons[l.id]?.status === "mastered").length;
    lines.push(`- ${m.title}: ${done}/${mine.length}${done === mine.length ? " passed" : ""}`);
  }
  if (started.length) lines.push(`In progress: ${started.map((l) => l.title).join(", ")}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// T8: plain English, checked
// ---------------------------------------------------------------------------

/** Words GOV.UK-style plain English avoids, and the model tells docs/BRAND.md already bans. */
export const BANNED_WORDS = [
  "utilise", "utilize", "leverage", "delve", "furthermore", "moreover", "synergy", "seamless",
  "cutting-edge", "world-class", "revolutionary", "best-in-class", "game-changing", "unparalleled",
  "world's most", "guaranteed", "foolproof",
];

/** A sentence longer than this is two sentences. */
export const MAX_SENTENCE_WORDS = 32;
/** A paragraph longer than this is two paragraphs (one idea per message). */
export const MAX_PARAGRAPH_WORDS = 80;

export function lintLesson(lesson: Lesson): string[] {
  const out: string[] = [];
  const texts = lesson.steps.flatMap((s) => [s.text, s.hint ?? "", s.example ?? "", s.reveal ?? "", ...(s.options ?? []).map((o) => o.text)]);
  for (const t of texts) {
    const lower = t.toLowerCase();
    for (const w of BANNED_WORDS) if (lower.includes(w)) out.push(`${lesson.id}: avoid "${w}"`);
    for (const para of t.split(/\n\s*\n/)) {
      const words = para.split(/\s+/).filter(Boolean).length;
      if (words > MAX_PARAGRAPH_WORDS) out.push(`${lesson.id}: a paragraph of ${words} words ("${para.slice(0, 40)}…")`);
      for (const sentence of para.replace(/`[^`]*`/g, "x").split(/(?<=[.!?])\s+/)) {
        const n = sentence.split(/\s+/).filter(Boolean).length;
        if (n > MAX_SENTENCE_WORDS) out.push(`${lesson.id}: a sentence of ${n} words ("${sentence.slice(0, 40)}…")`);
      }
    }
  }
  return out;
}
