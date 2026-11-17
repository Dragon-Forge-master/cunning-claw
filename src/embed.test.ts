import assert from "node:assert/strict";
import test from "node:test";
import { chooseEmbedding, cosine, DEFAULT_MODELS, FAILURE_COOLDOWN_MS, makeEmbedder, ollamaRoot } from "./embed.js";

/**
 * Every provider is driven through an injected fetch: no key, no network, and
 * the request each one would really send is what gets asserted.
 */

type Call = { url: string; headers: Record<string, string>; body: any };

function fakeFetch(reply: (call: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const doFetch = (async (url: any, init: any) => {
    const call = { url: String(url), headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? "null") };
    calls.push(call);
    return new Response(JSON.stringify(reply(call)), { status });
  }) as typeof fetch;
  return { calls, doFetch };
}

test("off means no provider, whatever is keyed", () => {
  assert.equal(chooseEmbedding("off", { geminiKey: "k", openrouterKey: "k", ollamaUrl: "http://127.0.0.1:11434" }), null);
});

test("auto prefers a keyed Gemini, then OpenRouter, then a configured Ollama, else nothing", () => {
  assert.equal(chooseEmbedding("auto", { geminiKey: "g", openrouterKey: "o" })?.provider, "gemini");
  assert.equal(chooseEmbedding(undefined, { openrouterKey: "o" })?.provider, "openrouter");
  assert.equal(chooseEmbedding("auto", { ollamaUrl: "http://127.0.0.1:11434" })?.provider, "ollama");
  assert.equal(chooseEmbedding("auto", {}), null, "nothing keyed and no Ollama: keyword search only");
});

test("auto keeps an install with a local default brain on Ollama, even with a cloud key present", () => {
  const spec = chooseEmbedding("auto", { geminiKey: "g", preferLocal: true });
  assert.equal(spec?.provider, "ollama");
  assert.equal(spec?.model, DEFAULT_MODELS.ollama);
});

test("an explicit cloud provider without its key is no provider", () => {
  assert.equal(chooseEmbedding("gemini", { openrouterKey: "o" }), null);
  assert.equal(chooseEmbedding("openrouter", { geminiKey: "g" }), null);
  assert.equal(chooseEmbedding("gemini", { geminiKey: "g", model: "custom-embed" })?.model, "custom-embed");
});

test("an OpenAI-compatible Ollama URL becomes Ollama's native root", () => {
  assert.equal(ollamaRoot("http://localhost:11434/v1"), "http://localhost:11434");
  assert.equal(ollamaRoot("http://localhost:11434/v1/"), "http://localhost:11434");
});

test("Gemini: batchEmbedContents with the key in a header, retrieval task types, batches of 100", async () => {
  const { calls, doFetch } = fakeFetch((c) => ({
    embeddings: c.body.requests.map((_: unknown, i: number) => ({ values: [i, 1] })),
  }));
  const e = makeEmbedder({ provider: "gemini", model: "gemini-embedding-001", apiKey: "test-key" }, doFetch);
  const texts = Array.from({ length: 150 }, (_, i) => `fact ${i}`);
  const out = await e.embed(texts, "document");
  assert.equal(out.length, 150);
  assert.equal(calls.length, 2, "150 texts are two requests, not one oversized one");
  assert.equal(calls[0].body.requests.length, 100);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-embedding-001:batchEmbedContents$/);
  assert.equal(calls[0].headers["x-goog-api-key"], "test-key");
  assert.ok(!calls[0].url.includes("test-key"), "the key never rides in the URL, where logs keep it");
  assert.equal(calls[0].body.requests[0].taskType, "RETRIEVAL_DOCUMENT");
  assert.equal(calls[0].body.requests[0].content.parts[0].text, "fact 0");
  await e.embed(["q"], "query");
  assert.equal(calls[2].body.requests[0].taskType, "RETRIEVAL_QUERY");
  assert.ok(e.id.startsWith("gemini:gemini-embedding-001"));
});

test("OpenRouter: OpenAI-shaped /embeddings, bearer key, rows put back in input order", async () => {
  const { calls, doFetch } = fakeFetch(() => ({
    data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }],
  }));
  const e = makeEmbedder({ provider: "openrouter", model: "openai/text-embedding-3-small", apiKey: "or-key" }, doFetch);
  const out = await e.embed(["first", "second"], "document");
  assert.deepEqual(out, [[1, 0], [0, 1]]);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/embeddings");
  assert.equal(calls[0].headers.Authorization, "Bearer or-key");
  assert.deepEqual(calls[0].body, { model: "openai/text-embedding-3-small", input: ["first", "second"] });
});

test("Ollama: /api/embed on the local root, with nomic's task prefixes", async () => {
  const { calls, doFetch } = fakeFetch((c) => ({ embeddings: c.body.input.map(() => [1, 2, 3]) }));
  const e = makeEmbedder({ provider: "ollama", model: "nomic-embed-text", baseUrl: "http://localhost:11434/v1" }, doFetch);
  await e.embed(["a fact"], "document");
  await e.embed(["a question"], "query");
  assert.equal(calls[0].url, "http://localhost:11434/api/embed");
  assert.deepEqual(calls[0].body.input, ["search_document: a fact"]);
  assert.deepEqual(calls[1].body.input, ["search_query: a question"]);
});

test("text bound for a cloud provider is redacted; text for Ollama stays on the machine as written", async () => {
  // Built at runtime so the source holds no credential-shaped literal.
  const fake = "ghp_" + "EXAMPLEfake".padEnd(36, "0");
  const memory = `deploy token is ${fake}`;
  const cloud = fakeFetch(() => ({ data: [{ index: 0, embedding: [1] }] }));
  await makeEmbedder({ provider: "openrouter", model: "m", apiKey: "k" }, cloud.doFetch).embed([memory], "document");
  assert.ok(!JSON.stringify(cloud.calls[0].body).includes(fake));
  const local = fakeFetch(() => ({ embeddings: [[1]] }));
  await makeEmbedder({ provider: "ollama", model: "m" }, local.doFetch).embed([memory], "document");
  assert.deepEqual(local.calls[0].body.input, [memory]);
});

test("a failure throws, then fails fast for the cooldown instead of paying the timeout every search", async () => {
  let clock = 1_000_000;
  const { calls, doFetch } = fakeFetch(() => ({ error: "model not found" }), 404);
  const e = makeEmbedder({ provider: "ollama", model: "m" }, doFetch, () => clock);
  await assert.rejects(e.embed(["x"], "query"), /HTTP 404/);
  await assert.rejects(e.embed(["x"], "query"), /cooling down/);
  assert.equal(calls.length, 1, "the cooldown must not touch the network");
  clock += FAILURE_COOLDOWN_MS + 1;
  await assert.rejects(e.embed(["x"], "query"), /HTTP 404/);
  assert.equal(calls.length, 2, "after the cooldown it tries again");
});

test("a reply with the wrong number of vectors, or junk in them, is a failure, not a silent mismatch", async () => {
  const short = fakeFetch(() => ({ embeddings: [[1]] }));
  await assert.rejects(makeEmbedder({ provider: "ollama", model: "m" }, short.doFetch).embed(["a", "b"], "document"), /expected 2 vectors/);
  const junk = fakeFetch(() => ({ embeddings: [["x"]] }));
  await assert.rejects(makeEmbedder({ provider: "ollama", model: "m" }, junk.doFetch).embed(["a"], "document"), /not a list of numbers/);
});

test("cosine: parallel is 1, orthogonal is 0, mismatched sizes are 0 rather than NaN", () => {
  assert.equal(cosine([1, 2], [2, 4]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [1, 0, 0]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});
