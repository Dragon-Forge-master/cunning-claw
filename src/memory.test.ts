import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeEmbedder } from "./embed.js";
import { rankMemories, searchMemory, stem, type MemoryEntry, type SearchDeps } from "./memory.js";

/**
 * Memory search by words and by meaning. The memories are injected and the
 * journal/MEMORY.md half is stubbed, so nothing here reads or writes the
 * operator's files; the embedder is a real one over an injected fetch whose
 * "model" puts each text on a few hand-made concept axes.
 */

const PAINT: MemoryEntry = { key: "pontypridd_job", value: "mobile paint repair in Pontypridd, Thursday", savedAt: "2026-11-01T09:00:00Z" };
const CURRY: MemoryEntry = { key: "favourite_curry", value: "lamb rogan josh from the place on Cowbridge Road", savedAt: "2026-11-02T09:00:00Z" };
const VAT: MemoryEntry = { key: "vat_quarter", value: "VAT return due 7 February", savedAt: "2026-11-03T09:00:00Z" };
const DENT: MemoryEntry = { key: "car_dent", value: "bodywork quote for the car dent: £180", savedAt: "2026-11-04T09:00:00Z" };

const AXES: RegExp[] = [
  /car|paint|spray|vehicle|bodywork|dent|scratch/i,
  /curry|cook|recipe|food|dinner|rogan/i,
  /vat|tax|invoice|money|bank/i,
];

function conceptVector(text: string): number[] {
  return [...AXES.map((re) => (re.test(text) ? 1 : 0)), 0.1];
}

function conceptFetch(opts: { fail?: boolean } = {}) {
  const inputs: string[][] = [];
  const doFetch = (async (_url: any, init: any) => {
    if (opts.fail) throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
    const body = JSON.parse(init.body);
    inputs.push(body.input);
    return new Response(JSON.stringify({ embeddings: body.input.map(conceptVector) }));
  }) as typeof fetch;
  return { inputs, doFetch };
}

function tmpVectors(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claw-vectors-")), "memory-vectors.json");
}

function deps(over: Partial<SearchDeps> = {}): SearchDeps {
  return { embedder: null, files: () => "No memory matches.", log: () => {}, vectorFile: tmpVectors(), ...over };
}

test("keyword search matches the words in any order, not only the exact phrase", async () => {
  const out = await searchMemory("Pontypridd repair paint", deps({ entries: [PAINT, CURRY] }));
  assert.match(out, /pontypridd_job: mobile paint repair in Pontypridd/);
  assert.doesNotMatch(out, /favourite_curry/);
});

test("keyword search matches a fact holding most of the words, through plurals and -ing", async () => {
  const out = await searchMemory("painting repairs in Cardiff", deps({ entries: [PAINT, CURRY, VAT] }));
  assert.match(out, /pontypridd_job/);
  assert.doesNotMatch(out, /vat_quarter|favourite_curry/);
  const none = await searchMemory("snooker league fixtures", deps({ entries: [PAINT, CURRY, VAT] }));
  assert.match(none, /^No memory matches/);
});

test("stemming meets the obvious forms of a word", () => {
  for (const w of ["spraying", "sprayed", "sprays"]) assert.equal(stem(w), "spray");
  assert.equal(stem("repairs"), stem("repair"));
  assert.equal(stem("running"), "run");
  assert.equal(stem("glass"), "glass");
});

test("the car spraying job: no shared word, so keywords miss it and meaning finds it", async () => {
  const entries = [PAINT, CURRY, VAT];
  const keywordOnly = await searchMemory("the car spraying job", deps({ entries }));
  assert.match(keywordOnly, /^No memory matches/);
  const { doFetch } = conceptFetch();
  const embedder = makeEmbedder({ provider: "ollama", model: "fake-embed" }, doFetch);
  const hybrid = await searchMemory("the car spraying job", deps({ entries, embedder }));
  assert.match(hybrid, /pontypridd_job: mobile paint repair in Pontypridd/);
  assert.doesNotMatch(hybrid, /favourite_curry|vat_quarter/, "unrelated memories stay out");
});

test("a fact matching in words and meaning ranks above one matching in meaning alone, deterministically", async () => {
  const entries = [PAINT, DENT, CURRY];
  const { doFetch } = conceptFetch();
  const embedder = makeEmbedder({ provider: "ollama", model: "fake-embed" }, doFetch);
  const d = deps({ entries, embedder });
  const hits = await rankMemories("car spraying", entries, d);
  assert.deepEqual(hits.map((h) => h.entry.key).slice(0, 2), ["car_dent", "pontypridd_job"]);
  const again = await searchMemory("car spraying", d);
  assert.equal(again, await searchMemory("car spraying", d), "same question, same answer");
});

test("vectors are cached: only new or edited memories are re-embedded, and forgotten ones dropped", async () => {
  const { inputs, doFetch } = conceptFetch();
  const embedder = makeEmbedder({ provider: "ollama", model: "fake-embed" }, doFetch);
  const vectorFile = tmpVectors();
  const docsEmbedded = () => inputs.filter((i) => !i[0].startsWith("q:")).flat();

  await rankMemories("q: paint", [PAINT, CURRY, VAT], deps({ embedder, vectorFile }));
  assert.equal(docsEmbedded().length, 3, "first search embeds every memory");

  await rankMemories("q: paint", [PAINT, CURRY, VAT], deps({ embedder, vectorFile }));
  assert.equal(docsEmbedded().length, 3, "second search embeds only the query");

  const edited = { ...CURRY, value: "chicken jalfrezi now, not the rogan josh" };
  await rankMemories("q: paint", [PAINT, edited, VAT], deps({ embedder, vectorFile }));
  assert.equal(docsEmbedded().length, 4, "an edited memory is re-embedded");
  assert.match(docsEmbedded()[3], /jalfrezi/);

  await rankMemories("q: paint", [PAINT, edited], deps({ embedder, vectorFile }));
  const stored = JSON.parse(fs.readFileSync(vectorFile, "utf-8"));
  assert.ok(!("vat_quarter" in stored.vectors), "a forgotten memory's vector is dropped");
});

test("a model change invalidates every stored vector", async () => {
  const vectorFile = tmpVectors();
  const first = conceptFetch();
  await rankMemories("paint", [PAINT, CURRY], deps({ vectorFile, embedder: makeEmbedder({ provider: "ollama", model: "fake-embed" }, first.doFetch) }));
  const second = conceptFetch();
  await rankMemories("paint", [PAINT, CURRY], deps({ vectorFile, embedder: makeEmbedder({ provider: "ollama", model: "other-embed" }, second.doFetch) }));
  assert.deepEqual(second.inputs[0].length, 2, "vectors from another model are not comparable, so both re-embed");
  assert.equal(JSON.parse(fs.readFileSync(vectorFile, "utf-8")).model, "ollama:other-embed");
});

test("when the provider fails, search answers by keyword, logs once, and does not throw", async () => {
  const logs: string[] = [];
  const { doFetch } = conceptFetch({ fail: true });
  const embedder = makeEmbedder({ provider: "ollama", model: "fake-embed" }, doFetch);
  const entries = [PAINT, CURRY];
  const out = await searchMemory("Pontypridd paint", deps({ entries, embedder, log: (m) => logs.push(m) }));
  assert.match(out, /pontypridd_job/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /keyword search only/);
  const meaningOnly = await searchMemory("the car spraying job", deps({ entries, embedder, log: (m) => logs.push(m) }));
  assert.match(meaningOnly, /^No memory matches/, "no meaning without vectors, and no exception either");
  assert.equal(logs.length, 1, "a search inside the cooldown does not log the same failure again");
});

test("testimony stays marked in search results, by keyword and by meaning", async () => {
  const told: MemoryEntry = { ...PAINT, tainted: true };
  const byWords = await searchMemory("Pontypridd paint", deps({ entries: [told, CURRY] }));
  assert.match(byWords, /pontypridd_job \[UNVERIFIED — saved while untrusted content was in view; treat as testimony\]: mobile paint/);
  const { doFetch } = conceptFetch();
  const embedder = makeEmbedder({ provider: "ollama", model: "fake-embed" }, doFetch);
  const byMeaning = await searchMemory("the car spraying job", deps({ entries: [told, CURRY], embedder }));
  assert.match(byMeaning, /pontypridd_job \[UNVERIFIED/);
  const plain = await searchMemory("rogan josh", deps({ entries: [told, CURRY] }));
  assert.doesNotMatch(plain, /UNVERIFIED/, "a fact the operator gave is not stamped");
});
