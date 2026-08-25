import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  applyBrainCommand,
  brainChain,
  catalog,
  defaultBrainId,
  formatCost,
  heartbeatBrainId,
  isFailoverError,
  lastTurnCost,
  pickBrain,
  pinBrain,
  pinnedBrainId,
  priceForModel,
  recordUsage,
  resetSpendForTests,
  sessionSpend,
} from "./brain.js";

before(() => { pinBrain(null); });
after(() => { pinBrain(null); });

test("ships a named roster including core, pulse, cheap", () => {
  const ids = catalog().map((b) => b.id);
  // The roster is meant to grow — assert the required brains are present
  // rather than pinning an exclusive list, so adding one is not a failure.
  for (const required of ["core", "pulse", "cheap"]) {
    assert.ok(ids.includes(required), `roster must include ${required}`);
  }
  assert.equal(defaultBrainId(), "core");
  assert.equal(heartbeatBrainId(), "pulse");
  assert.equal(catalog().find((b) => b.id === "core")?.provider, "anthropic");
  assert.equal(catalog().find((b) => b.id === "cheap")?.provider, "openai");
});

test("heartbeat uses pulse even when conversation is pinned to core", () => {
  try {
    const msg = pinBrain("core");
    assert.match(msg, /Pinned to Core/);
    assert.equal(pinnedBrainId(), "core");
    assert.equal(pickBrain("user").id, "core");
    assert.equal(pickBrain("heartbeat").id, "pulse");
    assert.equal(brainChain("user").length, 1, "a pin is strict — no fallbacks");
    assert.ok(brainChain("heartbeat").map((b) => b.id).includes("pulse"));
  } finally {
    pinBrain(null);
  }
});

test("/brain commands pin, list, and clear without a model call", () => {
  try {
    assert.match(applyBrainCommand("/brain") ?? "", /core:/);
    assert.equal(applyBrainCommand("hello"), null);
    assert.match(applyBrainCommand("/brain cheap") ?? "", /Pinned to Cheap/);
    assert.equal(pinnedBrainId(), "cheap");
    assert.match(applyBrainCommand("/brain auto") ?? "", /automatic/);
    assert.equal(pinnedBrainId(), null);
    assert.match(applyBrainCommand("/brain no-such") ?? "", /No brain named/);
  } finally {
    pinBrain(null);
  }
});

test("unpinned conversation walks default then fallbacks", () => {
  pinBrain(null);
  assert.deepEqual(brainChain("user").map((b) => b.id), ["core", "pulse", "cheap"]);
  assert.equal(brainChain("heartbeat")[0].id, "pulse");
});

test("failover classifier catches outages and rate limits, not refusals", () => {
  assert.equal(isFailoverError(new Error("OpenAI-compatible API 429: slow down")), true);
  assert.equal(isFailoverError(new Error("OpenAI-compatible API 503: overloaded")), true);
  assert.equal(isFailoverError(new Error("fetch failed")), true);
  assert.equal(isFailoverError(new Error("Missing OPENAI_API_KEY for the OpenAI-compatible provider.")), true);
  assert.equal(isFailoverError(new Error("I'm afraid I must decline that one, sir.")), false);
  assert.equal(isFailoverError(new Error("tool failed: no such file")), false);
});

test("pricing table covers the shipped brains and prefix-matches dated ids", () => {
  for (const id of ["claude-opus-5", "claude-haiku-4-5", "gpt-4o-mini"]) {
    assert.ok(priceForModel(id), `pricing.models must include ${id}`);
  }
  const dated = priceForModel("claude-haiku-4-5-20251001");
  assert.ok(dated);
  assert.equal(dated!.inputPerMillion, priceForModel("claude-haiku-4-5")!.inputPerMillion);
  assert.equal(priceForModel("totally-unknown-model-xyz"), null);
});

test("recordUsage prices a turn from the config table and other modules can read it", () => {
  resetSpendForTests();
  const opus = catalog().find((b) => b.id === "core");
  const haiku = catalog().find((b) => b.id === "pulse");
  assert.ok(opus && haiku);
  const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const expensive = recordUsage(opus!, tokens);
  const cheap = recordUsage(haiku!, tokens);
  assert.equal(expensive.unpriced, false);
  assert.equal(cheap.unpriced, false);
  assert.ok(expensive.usd > cheap.usd, "core should cost more than pulse for the same tokens");
  assert.equal(lastTurnCost()?.brainId, "pulse");
  assert.equal(sessionSpend().turns, 2);
  assert.equal(sessionSpend().inputTokens, 2_000_000);
  assert.match(formatCost(expensive), /\$/);
  const local = catalog().find((b) => b.id === "local");
  if (local) {
    const free = recordUsage(local, tokens);
    assert.equal(free.usd, 0);
  }
});

test("an unknown model records tokens but does not invent a price", () => {
  resetSpendForTests();
  const cost = recordUsage(
    { id: "mystery", label: "Mystery", provider: "openai", model: "mystery-model-9" },
    { inputTokens: 100, outputTokens: 20 },
  );
  assert.equal(cost.unpriced, true);
  assert.equal(cost.usd, 0);
  assert.match(formatCost(cost), /unpriced/);
});
