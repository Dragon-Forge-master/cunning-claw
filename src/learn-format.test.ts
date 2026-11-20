import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BOX_DAYS,
  dueCount,
  dueItems,
  freshProgress,
  grade,
  ladder,
  lintLesson,
  loadLessons,
  loadProgress,
  localDay,
  normaliseProgress,
  parseLesson,
  publicStep,
  saveProgress,
  scheduleItem,
  shouldNudge,
  welshStatus,
  type Lesson,
  type ReviewItem,
} from "./learn-format.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LEARN = path.join(ROOT, "learn");

const LESSON = `---
id: demo.one
module: consent
order: 2
title: Demo
outcomes: O3
benchmark: 5
critical: true
claims:
  - approvalTimeoutMs = 180000
  - asksTool = send_email
---

## why
Why it matters.

## ask cold
confidence: yes
What three things would you check?
answer: send, action | to, recipient | asked, request
pass: 2
hint: The action, the target, you.
example: Send · To: elin@example · did I ask?
reveal: Action, target, and whether you asked.

## recall pick
- [ ] EXECUTE
- [x] DENY

## check mastery
kind: scenario
critical: yes
`;

function parsed(md = LESSON): Lesson {
  const l = parseLesson(md, "demo.md");
  assert.ok(!("errors" in l), JSON.stringify(l));
  return l as Lesson;
}

test("a lesson file parses: frontmatter, claims, and steps in order", () => {
  const l = parsed();
  assert.equal(l.id, "demo.one");
  assert.equal(l.critical, true);
  assert.deepEqual(l.claims, [
    { key: "approvalTimeoutMs", value: "180000" },
    { key: "asksTool", value: "send_email" },
  ]);
  assert.deepEqual(l.steps.map((s) => `${s.type}:${s.id}`), ["why:why0", "ask:cold", "recall:pick", "check:mastery"]);
  const ask = l.steps[1];
  assert.deepEqual(ask.answer, [["send", "action"], ["to", "recipient"], ["asked", "request"]]);
  assert.equal(ask.pass, 2);
  assert.equal(ask.confidence, true);
  assert.equal(l.steps[3].kind, "scenario");
  assert.equal(l.cy, "needs-author", "the Welsh slot is marked until a Welsh speaker fills it");
});

test("a question with no answer key, or a lesson with no mastery check, is refused", () => {
  const noKey = parseLesson(LESSON.replace("answer: send, action | to, recipient | asked, request\n", ""), "x.md");
  assert.ok("errors" in noKey && noKey.errors.some((e) => /no answer key/.test(e)));
  const noCheck = parseLesson(LESSON.replace(/## check mastery[\s\S]*$/, ""), "x.md");
  assert.ok("errors" in noCheck && noCheck.errors.some((e) => /mastery check/.test(e)));
});

test("an answer alternative made only of punctuation is refused — it would match every answer", () => {
  const bad = parseLesson(LESSON.replace("answer: send, action", "answer: send, &&"), "x.md");
  assert.ok("errors" in bad && bad.errors.some((e) => /only punctuation/.test(e)));
  // And the grader never counts one, whatever the file says.
  const step = { ...parsed().steps[1], answer: [["&&"]], pass: 1 };
  assert.equal(grade(step, { text: "no idea" }).correct, false);
});

test("options are only read in a question: an example quoting a standing order keeps its text", () => {
  const md = LESSON.replace("## why\nWhy it matters.", "## example\n- [x] schedule: `08:00:llun-gwe` | target: `briefing` | instruction: Hi.");
  const step = parsed(md).steps[0];
  assert.equal(step.options, undefined);
  assert.match(step.text, /llun-gwe/);
});

test("short answers pass on enough key groups, matched at the start of a word", () => {
  const ask = parsed().steps[1];
  assert.equal(grade(ask, { text: "What it will send and who it is to" }).correct, true);
  assert.equal(grade(ask, { text: "the sending" }).correct, false, "one group is not two");
  // "to" must not be met by "tomato" — alternatives start a word.
  const one = { ...ask, answer: [["to"]], pass: 1 };
  assert.equal(grade(one, { text: "a tomato" }).correct, false);
  assert.equal(grade(one, { text: "sent to Elin" }).correct, true);
});

test("a choice passes only on exactly the right options", () => {
  const pick = parsed().steps[2];
  assert.equal(grade(pick, { choice: [1] }).correct, true);
  assert.equal(grade(pick, { choice: [0] }).correct, false);
  assert.equal(grade(pick, { choice: [0, 1] }).correct, false);
});

test("the hint ladder: hint, then the worked example, then the reveal", () => {
  const ask = parsed().steps[1];
  assert.equal(ladder(ask, 1).rung, "hint");
  assert.equal(ladder(ask, 2).rung, "example");
  assert.equal(ladder(ask, 3).rung, "reveal");
});

test("the HUD never receives the key, the hint or the example before an answer", () => {
  const pub = JSON.stringify(parsed().steps.map(publicStep));
  for (const secret of ["recipient", "The action, the target", "elin@example", "Action, target", "correct"]) {
    assert.ok(!pub.includes(secret), `leaked: ${secret}`);
  }
});

test("Leitner boxes: right moves up one, wrong drops to box 1, on the 1/3/7/16/35-day schedule", () => {
  assert.deepEqual([...BOX_DAYS], [0, 1, 3, 7, 16, 35]);
  const now = new Date("2026-11-20T10:00:00Z");
  const base = { lesson: "demo.one", step: "pick" };
  let it = scheduleItem(undefined, base, true, "sure", now).item;
  assert.equal(it.box, 1);
  assert.equal(it.due, "2026-11-21T10:00:00.000Z");
  for (const days of [3, 7, 16, 35]) {
    it = scheduleItem(it, base, true, "sure", now).item;
    assert.equal(Date.parse(it.due) - now.getTime(), days * 86_400_000);
  }
  it = scheduleItem(it, base, true, "sure", now).item;
  assert.equal(it.box, 5, "box 5 is the top");
  it = scheduleItem(it, base, false, "guess", now).item;
  assert.equal(it.box, 1);
  assert.equal(scheduleItem(undefined, base, false, "guess", now).item.box, 0, "a first miss is due again this session");
});

test("a confident wrong answer on a critical item re-opens its practice; an unsure one does not", () => {
  const now = new Date();
  const base = { lesson: "consent.reading-a-card", step: "recipient", critical: true };
  assert.equal(scheduleItem(undefined, base, false, "sure", now).reopen, true);
  assert.equal(scheduleItem(undefined, base, false, "guess", now).reopen, false);
  assert.equal(scheduleItem(undefined, { ...base, critical: false }, false, "sure", now).reopen, false);
});

test("review history is capped at twenty answers", () => {
  const now = new Date();
  let it: ReviewItem | undefined;
  for (let i = 0; i < 30; i++) it = scheduleItem(it, { lesson: "a", step: "b" }, true, "sure", now).item;
  assert.equal(it!.history.length, 20);
});

test("due reviews are interleaved across lessons, oldest first", () => {
  const now = new Date("2026-11-20T10:00:00Z");
  const item = (lesson: string, due: string): ReviewItem => ({ box: 1, due, lesson, step: "x", history: [] });
  const items = {
    "a#1": item("a", "2026-11-18T00:00:00Z"),
    "a#2": item("a", "2026-11-18T01:00:00Z"),
    "b#1": item("b", "2026-11-19T00:00:00Z"),
    "c#1": item("c", "2026-12-01T00:00:00Z"),
  };
  assert.equal(dueCount(items, now), 3);
  assert.deepEqual(dueItems(items, now, 2), ["a#1", "b#1"], "never two from one lesson when another is waiting");
});

test("the heartbeat offers a review only when switched on, only when due, and once a local day", () => {
  const now = new Date(2026, 10, 20, 9, 0);
  const p = freshProgress(now);
  p.items["a#1"] = { box: 1, due: new Date(2026, 10, 19).toISOString(), lesson: "a", step: "1", history: [] };
  assert.equal(shouldNudge(p, now), false, "off until the operator turns reminders on");
  p.nudges = true;
  assert.equal(shouldNudge(p, now), true);
  p.lastNudge = localDay(now);
  assert.equal(shouldNudge(p, now), false, "once a day at most");
  p.lastNudge = undefined;
  p.items = {};
  assert.equal(shouldNudge(p, now), false, "silent when nothing is due");
});

test("progress round-trips through data/learn/progress.json and survives a hand-edited file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-learn-progress-"));
  try {
    const now = new Date();
    const p = freshProgress(now);
    p.lessons["demo.one"] = { status: "mastered", attempts: 1, step: 0, masteredAt: now.toISOString() };
    saveProgress(dir, p);
    assert.ok(fs.existsSync(path.join(dir, "learn", "progress.json")));
    assert.equal(loadProgress(dir, now).lessons["demo.one"].status, "mastered");
    fs.writeFileSync(path.join(dir, "learn", "progress.json"), "{ not json");
    assert.equal(loadProgress(dir, now).version, 1, "a broken file starts fresh rather than stopping the course");
    const odd = normaliseProgress({ lessons: { x: { status: "wizard" } }, items: { y: { due: "never" } }, nudges: "yes" }, now);
    assert.equal(odd.lessons.x.status, "new");
    assert.deepEqual(odd.items, {});
    assert.equal(odd.nudges, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every shipped lesson parses, has the four-part shape, and reads as plain English (T8)", () => {
  const { lessons, errors } = loadLessons(LEARN);
  assert.deepEqual(errors, []);
  assert.ok(lessons.length >= 8, `${lessons.length} lessons`);
  const modules = new Set(lessons.map((l) => l.module));
  for (const m of ["talking", "turn", "consent", "floor", "strangers", "brains", "leaves", "capstone"]) {
    assert.ok(modules.has(m), `module ${m} has a lesson`);
  }
  for (const l of lessons) {
    const types = l.steps.map((s) => s.type);
    assert.equal(types[0], "why", `${l.id} opens with why`);
    assert.ok(types.includes("ask"), `${l.id} has a cold question`);
    assert.ok(types.includes("real"), `${l.id} has a real task`);
    assert.equal(types[types.length - 1], "check", `${l.id} ends in its mastery check`);
    assert.deepEqual(lintLesson(l), [], `${l.id} lint`);
  }
});

test("the three safety-critical checks are scenario checks that need every critical item", () => {
  const { lessons } = loadLessons(LEARN);
  const critical = lessons.filter((l) => l.critical).map((l) => l.id);
  for (const id of ["consent.reading-a-card", "strangers.how-injection-works", "capstone.standing-order"]) {
    assert.ok(critical.includes(id), `${id} is safety-critical`);
    const check = lessons.find((l) => l.id === id)!.steps.at(-1)!;
    assert.equal(check.kind, "scenario");
    assert.equal(check.threshold, 1);
  }
});

test("Welsh lessons are marked as needing a Welsh-speaking author until one is written", () => {
  const { lessons } = loadLessons(LEARN);
  for (const l of lessons) {
    assert.equal(l.cy, "needs-author", `${l.id}`);
    assert.equal(welshStatus(LEARN, l), "needs-author");
  }
  assert.ok(fs.readFileSync(path.join(LEARN, "cy", "README.md"), "utf-8").includes("needs a Welsh-speaking author"));
});

test("learn-format.ts is a leaf: node built-ins only, so tools.ts and learn.ts can both import it", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "learn-format.ts"), "utf-8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.filter((i) => !i.startsWith("node:")), []);
});
