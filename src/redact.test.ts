import assert from "node:assert/strict";
import test from "node:test";
import { redact, containsSecret, redactDeep } from "./redact.js";

/**
 * Every one of these shapes reaches history.json and the SSE stream in normal
 * use — pasted by the user, or returned by a tool reading a config file or an
 * HTTP response.
 *
 * The fixtures below are synthetic. They match the real formats so the patterns
 * are genuinely exercised, but no working credential belongs in a repository,
 * least of all in the tests for the thing that redacts credentials.
 */

const SAMPLES: [string, string][] = [
  ["anthropic", "sk-ant-api03-EXAMPLEfakeKEY0000111122223333444455556666777788889999aa"],
  ["github", "ghp_EXAMPLEfake000011112222333344445555"],
  ["google-oauth", "AQ.Ab8EXAMPLEfake0000111122223333444455556666"],
  ["google-api", "AIzaSyA1234567890abcdefghijklmnopqrstuvw"],
  ["aws", "AKIAIOSFODNN7EXAMPLE"],
  ["slack", "xoxb-123456789012-abcdefghijklmnop"],
  ["stripe", "sk_live_51H8xKfGhIjKlMnOpQrStUvWx"],
  ["openrouter", "sk-or-v1-0123456789abcdef0123456789abcdef"],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdefgh"],
];

for (const [label, secret] of SAMPLES) {
  test(`redacts ${label}`, () => {
    const out = redact(`here is my key: ${secret} — use it`);
    assert.ok(!out.includes(secret), `${label} survived redaction`);
    assert.match(out, /REDACTED/);
    assert.ok(out.includes("here is my key"), "surrounding text is preserved");
  });
}

test("redacts an unfamiliar provider via the generic assignment rule", () => {
  const out = redact("SOME_VENDOR_API_KEY=zzzz1111yyyy2222xxxx3333");
  assert.ok(!out.includes("zzzz1111yyyy2222xxxx3333"));
  assert.match(out, /SOME_VENDOR_API_KEY=\[REDACTED\]/);
});

test("redacts Authorization headers and JSON credential fields", () => {
  assert.match(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"), /Bearer \[REDACTED\]/);
  assert.match(redact('{"api_key": "abcdefghijklmnopqrst"}'), /"api_key": "\[REDACTED\]"/);
});

test("redacts private key blocks whole", () => {
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----";
  assert.equal(redact(pem), "[private-key:REDACTED]");
});

test("leaves innocent text alone", () => {
  for (const clean of [
    "Good evening, sir. All systems nominal.",
    "run: git status && npm test",
    "the disk is 28% full and uptime is 8.6h",
  ]) {
    assert.equal(redact(clean), clean, clean);
    assert.equal(containsSecret(clean), false);
  }
});

test("is idempotent — redacting twice changes nothing further", () => {
  const once = redact(`key ${SAMPLES[0][1]}`);
  assert.equal(redact(once), once);
});

test("redactDeep reaches strings inside message content blocks", () => {
  const msg = {
    role: "user",
    content: [
      { type: "text", text: `token ${SAMPLES[1][1]}` },
      { type: "tool_result", content: [{ type: "text", text: `and ${SAMPLES[2][1]}` }] },
    ],
  };
  const out = JSON.stringify(redactDeep(msg));
  assert.ok(!out.includes(SAMPLES[1][1]), "nested text redacted");
  assert.ok(!out.includes(SAMPLES[2][1]), "doubly-nested tool_result redacted");
  assert.match(out, /"role":"user"/, "structure preserved");
});

test("containsSecret flags a pasted credential", () => {
  assert.equal(containsSecret(`my key is ${SAMPLES[0][1]}`), true);
});

test("local endpoints are recognised so offline models need no key", async () => {
  const { isLocalEndpoint } = await import("./brain.js");
  for (const local of ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1",
                       "http://192.168.1.50:11434/v1", "http://box.local:1234/v1"]) {
    assert.equal(isLocalEndpoint(local), true, local);
  }
  for (const remote of ["https://api.openai.com/v1", "https://openrouter.ai/api/v1"]) {
    assert.equal(isLocalEndpoint(remote), false, remote);
  }
});

test("redaction never touches image data, and never emits non-ASCII", async () => {
  const { redactDeep, isCleanBase64 } = await import("./redact.js");

  // A long base64 run will eventually look like a token. Replacing part of it
  // produces an image the API rejects, poisoning every later turn.
  // Valid base64, but containing a run the generic APIKEY= rule matches — which
  // is exactly how a real screenshot gets mangled.
  const payload = "iVBORw0KGgoAAAANSUhEUgAA" + "QUJD".repeat(30) +
    "APIKEY=AAAABBBBCCCCDDDDEEEE" + "Zm9v".repeat(30);
  const msg = {
    role: "user",
    content: [{
      type: "tool_result",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: payload } }],
    }],
  };
  const out: any = redactDeep(msg);
  const data = out.content[0].content[0].source.data;
  assert.equal(data, payload, "image payload must be returned untouched");
  assert.ok(isCleanBase64(data), "and must remain valid base64");
});

test("every redaction marker is ASCII", async () => {
  const { redact } = await import("./redact.js");
  const out = redact("key sk-ant-api03-EXAMPLEfakeKEY0000111122223333444455556666777788889999aa");
  // A non-ASCII character inside a base64 payload invalidates the whole request.
  assert.ok(/^[\x00-\x7F]*$/.test(out), `marker must be ASCII-only, got: ${out}`);
  assert.match(out, /REDACTED/);
});

test("replicate and huggingface tokens are redacted (synthetic)", () => {
  // Synthetic tokens, never real: a live r8_ token once sailed through this
  // list into a config file, the history, and a day's journal.
  const r8 = redact("REPLICATE_API_TOKEN=r8_SyntheticTestTokenAbc123Def456Ghi789");
  assert.doesNotMatch(r8, /r8_Synthetic/);
  assert.match(r8, /REDACTED/);
  const hf = redact("token: hf_SyntheticTestTokenAbc123Def456Ghi789");
  assert.doesNotMatch(hf, /hf_Synthetic/);
  assert.match(hf, /REDACTED/);
});
