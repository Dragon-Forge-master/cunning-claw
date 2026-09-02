// Unit tests for the relay's pure helpers. Plain Node, no dependencies —
// run with `node relay/test.mjs`. Imports the TypeScript directly via Node's
// built-in type stripping (Node 22.18+), which is why src/lib.ts keeps to
// erasable syntax and why the Worker-API-touching code lives in index.ts
// where these tests cannot reach it.

import { strict as assert } from "node:assert";

let lib;
try {
  lib = await import(new URL("./src/lib.ts", import.meta.url));
} catch (err) {
  console.error("Could not import src/lib.ts — Node 22.18+ (built-in type stripping) is required.");
  console.error(String(err?.message ?? err));
  process.exit(1);
}

const {
  parseBearer,
  parseTokenRecord,
  monthKey,
  usageKey,
  parseModels,
  isModelAllowed,
  isOverBudget,
  estimateStreamedTokens,
  errorBody,
  DEFAULT_MODELS,
} = lib;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
  }
}

// --- parseBearer -----------------------------------------------------------

test("parseBearer extracts the token", () => {
  assert.equal(parseBearer("Bearer df_abc123"), "df_abc123");
});

test("parseBearer accepts lowercase scheme and stray whitespace", () => {
  assert.equal(parseBearer("  bearer   df_abc123  "), "df_abc123");
});

test("parseBearer rejects missing header, wrong scheme, empty token", () => {
  assert.equal(parseBearer(null), null);
  assert.equal(parseBearer(""), null);
  assert.equal(parseBearer("Basic df_abc123"), null);
  assert.equal(parseBearer("Bearer"), null);
  assert.equal(parseBearer("df_abc123"), null);
});

test("parseBearer rejects a token containing spaces", () => {
  assert.equal(parseBearer("Bearer df_abc 123"), null);
});

// --- parseTokenRecord ------------------------------------------------------

test("parseTokenRecord accepts the documented shape", () => {
  const rec = parseTokenRecord('{"plan":"starter","monthlyBudgetTokens":2000000}');
  assert.deepEqual(rec, { plan: "starter", monthlyBudgetTokens: 2000000, disabled: false });
});

test("parseTokenRecord carries disabled through", () => {
  const rec = parseTokenRecord('{"plan":"starter","monthlyBudgetTokens":1,"disabled":true}');
  assert.equal(rec.disabled, true);
});

test("parseTokenRecord rejects garbage, wrong types, and non-objects", () => {
  assert.equal(parseTokenRecord(null), null);
  assert.equal(parseTokenRecord("not json"), null);
  assert.equal(parseTokenRecord('"a string"'), null);
  assert.equal(parseTokenRecord('{"plan":1,"monthlyBudgetTokens":5}'), null);
  assert.equal(parseTokenRecord('{"plan":"x","monthlyBudgetTokens":"5"}'), null);
  assert.equal(parseTokenRecord('{"plan":"x"}'), null);
});

// --- month / usage keys ----------------------------------------------------

test("monthKey is UTC YYYY-MM with zero padding", () => {
  assert.equal(monthKey(new Date(Date.UTC(2026, 8, 1))), "2026-09");
  assert.equal(monthKey(new Date(Date.UTC(2026, 11, 31, 23, 59))), "2026-12");
});

test("usageKey composes token and month", () => {
  assert.equal(usageKey("df_x", new Date(Date.UTC(2026, 0, 15))), "use:df_x:2026-01");
});

// --- model allowlist -------------------------------------------------------

test("parseModels defaults when unset or blank", () => {
  assert.deepEqual(parseModels(undefined), [DEFAULT_MODELS]);
  assert.deepEqual(parseModels("   "), [DEFAULT_MODELS]);
});

test("parseModels splits and trims a comma list", () => {
  assert.deepEqual(
    parseModels("google/gemini-3.5-flash-lite, openai/gpt-4.1-nano ,"),
    ["google/gemini-3.5-flash-lite", "openai/gpt-4.1-nano"],
  );
});

test("isModelAllowed is exact-match only", () => {
  const allowed = parseModels("google/gemini-3.5-flash-lite");
  assert.equal(isModelAllowed("google/gemini-3.5-flash-lite", allowed), true);
  assert.equal(isModelAllowed("anthropic/claude-opus-4", allowed), false);
  assert.equal(isModelAllowed("google/gemini", allowed), false);
  assert.equal(isModelAllowed(undefined, allowed), false);
  assert.equal(isModelAllowed(42, allowed), false);
});

// --- budget ----------------------------------------------------------------

test("isOverBudget refuses at the cap, allows under it", () => {
  assert.equal(isOverBudget(0, 100), false);
  assert.equal(isOverBudget(99, 100), false);
  assert.equal(isOverBudget(100, 100), true);
  assert.equal(isOverBudget(250, 100), true);
});

test("a zero-budget record never gets a request through", () => {
  assert.equal(isOverBudget(0, 0), true);
});

// --- streamed-token estimate -----------------------------------------------

test("estimateStreamedTokens is bytes/4 rounded up", () => {
  assert.equal(estimateStreamedTokens(100, 300), 100);
  assert.equal(estimateStreamedTokens(1, 0), 1);
  assert.equal(estimateStreamedTokens(0, 0), 0);
  assert.equal(estimateStreamedTokens(2, 3), 2); // 5/4 rounds up
});

// --- error body ------------------------------------------------------------

test("errorBody is JSON with an error.message", () => {
  const parsed = JSON.parse(errorBody("hello"));
  assert.equal(parsed.error.message, "hello");
});

// --- summary ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
