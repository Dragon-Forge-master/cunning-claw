import assert from "node:assert/strict";
import test from "node:test";
import { signature, read, notice, repeatedAcrossTurns, dominantShape, admit, type CoherenceReading } from "./coherence.js";

/**
 * The repetition ratio comes from the Quantum Coherence Kernel:
 *   repetitionRatio = 1 - (uniqueSteps / totalSteps)
 *
 * The Ouroboros guard blocks a call repeated identically. This exists for the
 * commoner failure — circling, where every attempt is a distinct string and
 * exact-match detection never fires.
 */

const sig = (name: string, input: unknown) => signature(name, input);

test("flag variations collapse to one move", () => {
  // The case that motivated it: three distinct strings, one idea.
  const a = sig("run_command", { command: "ls" });
  const b = sig("run_command", { command: "ls -l" });
  const c = sig("run_command", { command: "ls -la" });
  assert.equal(a, b);
  assert.equal(b, c);
});

test("genuinely different work stays distinct", () => {
  assert.notEqual(
    sig("run_command", { command: "git status" }),
    sig("run_command", { command: "npm test" }),
  );
  assert.notEqual(sig("read_file", { path: "a" }), sig("write_file", { path: "a" }));
});

test("paging through indices is progress, not circling", () => {
  // read_email 1, 2, 3 must not read as repetition.
  const a = sig("read_email", { index: 1 });
  const b = sig("read_email", { index: 2 });
  assert.equal(a, b, "same shape…");
  const r = read([a, b, sig("read_email", { index: 3 }), sig("read_email", { index: 4 })]);
  assert.equal(r.verdict, "halt", "…so four in a row is caught, which is the intended trade");
});

test("a short run is never judged", () => {
  // Two calls that rhyme is not a pattern.
  assert.equal(read(["a", "a"]).verdict, "execute");
  assert.equal(read(["a", "a", "a"]).verdict, "execute");
});

test("varied work passes", () => {
  const r = read(["a", "b", "c", "d", "e"]);
  assert.equal(r.ratio, 0);
  assert.equal(r.verdict, "execute");
});

test("circling is nudged, then stopped", () => {
  // 6 calls, 3 unique → ratio 0.5 → over the 0.4 warn line.
  const nudged = read(["a", "b", "c", "a", "b", "c"]);
  assert.ok(nudged.ratio >= 0.4 && nudged.ratio < 0.6);
  assert.equal(nudged.verdict, "ruminate");

  // 6 calls, 2 unique → ratio 0.67 → past the 0.6 halt line.
  const stopped = read(["a", "b", "a", "b", "a", "b"]);
  assert.ok(stopped.ratio >= 0.6);
  assert.equal(stopped.verdict, "halt");
});

test("the ratio matches the kernel's formula", () => {
  const r = read(["a", "a", "b", "b", "c", "c"]);
  assert.equal(r.total, 6);
  assert.equal(r.unique, 3);
  assert.equal(r.ratio, 1 - 3 / 6);
});

test("the notice tells it what to do, not just that it is wrong", () => {
  const halt = notice(read(["a", "b", "a", "b", "a", "b"]));
  assert.match(halt, /Stop calling tools/);
  assert.match(halt, /what you need from them/, "must name the way out");

  const warn = notice(read(["a", "b", "c", "a", "b", "c"]));
  assert.match(warn, /change tack or ask/);
});

test("three turns of the same move is noticed, where the in-turn guard cannot see it", () => {
  // The real failure this exists for: "the controls don't work" → rewrite the
  // file, declare it fixed. "Still not working" → rewrite it again, declare it
  // fixed again. Three turns, three identical approaches, three confident
  // reports — and the in-turn guard saw nothing, because `shapes` starts empty
  // every time the operator speaks.
  assert.equal(repeatedAcrossTurns([]), "");
  assert.equal(repeatedAcrossTurns(["run_command:cat"]), "");
  assert.equal(repeatedAcrossTurns(["run_command:cat", "run_command:cat"]), "", "twice is not yet a pattern");

  const warning = repeatedAcrossTurns(["run_command:cat", "run_command:cat", "run_command:cat"]);
  assert.match(warning, /last 3 turns/);
  assert.match(warning, /did not work/);
  assert.match(warning, /rather than declaring it fixed/);
});

test("ordinary varied work raises nothing", () => {
  assert.equal(repeatedAcrossTurns(["run_command:git status", "read_file:{path}", "edit_file:{newString,oldString,path}"]), "");
  // Two the same then something else is not circling either.
  assert.equal(repeatedAcrossTurns(["run_command:cat", "run_command:cat", "browser_open:{url}"]), "");
});

test("a turn's shape is whatever it mostly did", () => {
  assert.equal(dominantShape([]), "");
  assert.equal(dominantShape(["a", "b", "a", "a"]), "a");
  assert.equal(dominantShape(["only"]), "only");
});

// ---------------------------------------------------------------------------
// Narrowed on 24 Oct: the operator's history showed the warning firing four
// times (40–50%) during productive coding, because file and search tools were
// identified by key names alone and refused calls kept counting. The sequences
// below are shaped like that day's work and like the loops the guard is for.
// ---------------------------------------------------------------------------

/** Feed calls through admit() in order, as runTurn does, and keep every reading. */
function play(calls: [string, unknown][]): { shapes: string[]; readings: CoherenceReading[] } {
  const shapes: string[] = [];
  const readings = calls.map(([name, input]) => admit(shapes, name, input));
  return { shapes, readings };
}

const todo = (n: number) => ["todo", {
  items: Array.from({ length: 4 }, (_, i) => ({ content: `step ${i + 1}`, status: i < n ? "completed" : "pending" })),
}] as [string, unknown];

test("the 24 Oct coding pattern — glob, grep, read, edit — is not circling", () => {
  const { readings } = play([
    todo(0),
    ["glob", { pattern: "src/**/*.ts" }],
    ["grep", { pattern: "repetition" }],
    ["grep", { pattern: "coherence\\.read" }],
    ["read_file", { path: "src/coherence.ts" }],
    ["grep", { pattern: "shapes.push" }],
    ["grep", { pattern: "signature\\(" }],
    ["read_file", { path: "src/agent.ts", offset: 820, limit: 80 }],
    todo(1),
    ["edit_file", { path: "src/coherence.ts", oldString: "a", newString: "b" }],
    ["edit_file", { path: "src/agent.ts", oldString: "c", newString: "d" }],
    todo(2),
    ["run_command", { command: "npm test" }],
    ["read_file", { path: "src/coherence.ts" }],
  ]);
  for (const r of readings) assert.equal(r.verdict, "execute", `ratio ${r.ratio} after ${r.total} calls`);
});

test("five greps and a read is research, not 67% repetition", () => {
  const { readings } = play([
    ["grep", { pattern: "runTurn" }],
    ["grep", { pattern: "executeTool", path: "src" }],
    ["grep", { pattern: "UNTRUSTED_TOOLS" }],
    ["grep", { pattern: "fenceUntrusted", glob: "**/*.ts" }],
    ["grep", { pattern: "requestApproval" }],
    ["read_file", { path: "src/server.ts" }],
  ]);
  assert.equal(readings.at(-1)!.ratio, 0);
  assert.ok(readings.every((r) => r.verdict === "execute"));
});

test("file and search tools are identified by their target, spelt any way", () => {
  assert.notEqual(sig("edit_file", { path: "src/a.ts" }), sig("edit_file", { path: "src/b.ts" }));
  assert.notEqual(sig("grep", { pattern: "a" }), sig("grep", { pattern: "b" }));
  assert.notEqual(sig("grep", { pattern: "a", path: "src" }), sig("grep", { pattern: "a", path: "docs" }));
  // Trivial respellings are still the same move.
  assert.equal(sig("read_file", { path: "./src/a.ts" }), sig("read_file", { path: "src//a.ts" }));
  assert.equal(sig("glob", { pattern: "src/**/*.ts", path: "src/" }), sig("glob", { pattern: "SRC/**/*.ts ", path: "src" }));
  assert.equal(sig("grep", { pattern: "handleClick" }), sig("grep", { pattern: " handleclick", path: "" }));
  // Paging through a long file is progress; the top of the file is the top.
  assert.notEqual(sig("read_file", { path: "a.ts", offset: 1 }), sig("read_file", { path: "a.ts", offset: 400 }));
  assert.equal(sig("read_file", { path: "a.ts", offset: 1 }), sig("read_file", { path: "a.ts" }));
});

test("a URL's query string never reaches the signature", () => {
  // Signatures are persisted by recordTurnShape; tokens live in query strings.
  const s = sig("http_request", { url: "https://api.example.test/v1/items?token=synthetic-abc123#x" });
  assert.equal(s, "http_request:api.example.test/v1/items");
  assert.notEqual(sig("browser_open", { url: "https://a.test/one" }), sig("browser_open", { url: "https://a.test/two" }));
});

test("repeated todo updates are bookkeeping, not a move", () => {
  const { readings, shapes } = play([
    ["read_file", { path: "src/coherence.ts" }],
    ["grep", { pattern: "signature" }],
    todo(0), todo(1), todo(2), todo(3),
  ]);
  for (const r of readings) assert.equal(r.verdict, "execute");
  assert.equal(readings.at(-1)!.total, 2, "only the real work is judged");
  assert.equal(shapes.length, 6, "…but the turn still knows tools ran");
  assert.equal(dominantShape(shapes), "read_file:src/coherence.ts");
});

test("the same grep, respelt, is still caught", () => {
  // Spelling variations get past the exact-match Ouroboros guard; this is the
  // circling the ratio exists for.
  const { readings } = play([
    ["grep", { pattern: "handleClick", path: "public" }],
    ["grep", { pattern: "handleclick", path: "public/" }],
    ["grep", { pattern: " handleClick ", path: "./public" }],
    ["grep", { pattern: "HANDLECLICK", path: "public" }],
    ["grep", { pattern: "handleClick", path: "public//" }],
  ]);
  assert.equal(readings.at(-1)!.verdict, "halt");
});

test("the same failing command, edited around, is still caught", () => {
  const { readings } = play([
    ["run_command", { command: "npm test" }],
    ["read_file", { path: "src/discord.ts" }],
    ["edit_file", { path: "src/discord.ts", oldString: "a", newString: "b" }],
    ["run_command", { command: "npm test -- --test-name-pattern=4014" }],
    ["edit_file", { path: "src/discord.ts", oldString: "b", newString: "c" }],
    ["run_command", { command: "npm test 2>&1 | tail -20" }],
    ["edit_file", { path: "src/discord.ts", oldString: "c", newString: "d" }],
    ["run_command", { command: "npm test" }],
  ]);
  assert.equal(readings[4].verdict, "ruminate", "nudged first");
  assert.equal(readings.at(-1)!.verdict, "halt", "then stopped");
});

test("a refused call does not count, so a real change of tack can still run", () => {
  const stuck: [string, unknown] = ["grep", { pattern: "handleClick" }];
  const { shapes, readings } = play([
    ["grep", { pattern: "handleClick" }],
    ["grep", { pattern: "handleclick" }],
    ["grep", { pattern: "HandleClick" }],
    stuck, stuck, stuck, stuck, stuck,
  ]);
  assert.equal(readings[3].verdict, "halt");
  assert.equal(shapes.length, 3, "five refusals added nothing to the tally");

  // A genuinely different approach is judged on its merits, not drowned by
  // the refusals before it…
  assert.notEqual(admit(shapes, "run_command", { command: "git log -S handleClick" }).verdict, "halt");
  // …while the same move again is refused again.
  assert.equal(admit(shapes, ...stuck).verdict, "halt");
});
