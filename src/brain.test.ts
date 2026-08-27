import assert from "node:assert/strict";
import { config } from "./config.js";
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

test("the roster spans a real price ladder", () => {
  // Which brains exist is config and will change. What must hold is that there
  // is a ladder to choose from, that every rung is priced so the picker can
  // show what a choice costs, and that a frontier brain exists for the turns
  // the guard will insist on.
  const all = catalog();
  assert.ok(all.length >= 3, "a picker needs something to pick between");

  for (const b of all) {
    assert.ok(b.price, `${b.id} must carry a price for the picker`);
    assert.equal(typeof b.price!.in, "number");
    assert.equal(typeof b.price!.out, "number");
  }

  const cheapest = Math.min(...all.map((b) => b.price!.in));
  const dearest = Math.max(...all.map((b) => b.price!.in));
  assert.ok(dearest > cheapest, "a ladder, not a single rung");

  // Which provider sits at the top is the operator's choice. What must hold is
  // that the brains cleared to handle untrusted content are not the cheapest
  // thing on the shelf.
  const trusted = all.filter((b) => (config.routing?.trustedBrains ?? []).includes(b.id));
  assert.ok(trusted.length > 0, "at least one brain must be cleared for untrusted content");
  assert.ok(
    Math.max(...trusted.map((b) => b.price!.in)) > cheapest,
    "the trusted brain must not be the cheapest rung",
  );
});

test("the default is a working brain, and the heartbeat is not the dear one", () => {
  const all = catalog();
  const def = all.find((b) => b.id === defaultBrainId());
  const hb = all.find((b) => b.id === heartbeatBrainId());
  assert.ok(def, "the default must name a brain that exists");
  assert.ok(hb, "the heartbeat must name a brain that exists");
  // A quiet tick every 30 minutes should not cost what hard reasoning costs.
  assert.ok(hb!.price!.in <= def!.price!.in, "heartbeat must not be dearer than the default");
});

test("a pin never drags the heartbeat with it", () => {
  try {
    const target = catalog().find((b) => b.id !== heartbeatBrainId())!;
    const msg = pinBrain(target.id);
    assert.match(msg, new RegExp(target.label, "i"));
    assert.equal(pinnedBrainId(), target.id);
    assert.equal(pickBrain("user").id, target.id);
    assert.equal(pickBrain("heartbeat").id, heartbeatBrainId(),
      "the heartbeat keeps its own brain regardless of the pin");
    assert.equal(brainChain("user").length, 1, "a pin is strict — no fallbacks");
    assert.ok(brainChain("heartbeat").map((b) => b.id).includes(heartbeatBrainId()));
  } finally {
    pinBrain(null);
  }
});

test("/brain commands pin, list, and clear without a model call", () => {
  try {
    const some = catalog()[0];
    assert.match(applyBrainCommand("/brain") ?? "", new RegExp(some.id + ":"));
    assert.equal(applyBrainCommand("hello"), null);
    assert.match(applyBrainCommand(`/brain ${some.id}`) ?? "", new RegExp(`Pinned to ${some.label}`, "i"));
    assert.equal(pinnedBrainId(), some.id);
    assert.match(applyBrainCommand("/brain auto") ?? "", /automatic/);
    assert.equal(pinnedBrainId(), null);
    assert.match(applyBrainCommand("/brain no-such") ?? "", /No brain named/);
  } finally {
    pinBrain(null);
  }
});

test("unpinned conversation walks default then fallbacks", () => {
  pinBrain(null);
  const chain = brainChain("user").map((b) => b.id);
  // Which brains are in the chain is config; the shape is not. The default
  // leads, the chain has somewhere to fall back to, and nothing repeats.
  assert.equal(chain[0], defaultBrainId(), "the default must lead");
  assert.ok(chain.length > 1, "a chain of one is not a fallback chain");
  assert.equal(new Set(chain).size, chain.length, "no brain appears twice");
  assert.equal(brainChain("heartbeat")[0].id, heartbeatBrainId());
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
  // Whichever brains are in the roster, the dearest must price higher than the
  // cheapest for identical tokens.
  const priced = catalog().filter((b) => b.price && b.price.in > 0)
    .sort((a, b) => a.price!.in - b.price!.in);
  assert.ok(priced.length >= 2, "need two priced brains to compare");
  const cheapest = priced[0], dearest = priced[priced.length - 1];
  const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const expensive = recordUsage(dearest, tokens);
  const cheap = recordUsage(cheapest, tokens);
  assert.equal(expensive.unpriced, false);
  assert.equal(cheap.unpriced, false);
  assert.ok(expensive.usd > cheap.usd, `${dearest.id} should cost more than ${cheapest.id}`);
  assert.equal(lastTurnCost()?.brainId, cheapest.id, "the last recorded turn is the one just recorded");
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
