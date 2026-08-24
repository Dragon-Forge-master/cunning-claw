import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  applyBrainCommand,
  brainChain,
  catalog,
  defaultBrainId,
  heartbeatBrainId,
  isFailoverError,
  pickBrain,
  pinBrain,
  pinnedBrainId,
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
