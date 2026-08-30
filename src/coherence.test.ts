import assert from "node:assert/strict";
import test from "node:test";
import { signature, read, notice } from "./coherence.js";

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
