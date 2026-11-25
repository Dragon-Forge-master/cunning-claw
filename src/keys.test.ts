import assert from "node:assert/strict";
import test from "node:test";
import { KEY_ROSTER, cleanValue, upsertEnvLine, removeEnvLine, setKey, listKeys } from "./keys.js";

test("only roster names can be written — this is never a set-any-env endpoint", () => {
  for (const name of ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "CLAW_TOKEN", "HOME"]) {
    const out = setKey(name, "anything");
    assert.equal(out.ok, false, `${name} must be refused`);
  }
  assert.ok(KEY_ROSTER.some((k) => k.name === "OPENROUTER_API_KEY"));
  assert.ok(KEY_ROSTER.some((k) => k.name === "DRAGONFORGE_TOKEN"));
});

test("a value is one line: newlines cannot smuggle a second env entry", () => {
  assert.equal(cleanValue("sk-or-abc\nPATH=/tmp").ok, false);
  assert.equal(cleanValue("sk-or-abc\r\nX=1").ok, false);
  assert.equal(cleanValue("   ").ok, false);
  assert.equal(cleanValue("x".repeat(600)).ok, false);
  const good = cleanValue('  "sk-or-abc123"  ');
  assert.ok(good.ok && good.value === "sk-or-abc123", "trims and unquotes");
});

test("upsert replaces in place and appends cleanly", () => {
  const base = "A=1\nOPENROUTER_API_KEY=old\nB=2\n";
  const replaced = upsertEnvLine(base, "OPENROUTER_API_KEY", "new");
  assert.match(replaced, /OPENROUTER_API_KEY=new/);
  assert.doesNotMatch(replaced, /old/);
  assert.match(replaced, /A=1/);
  assert.match(replaced, /B=2/);

  const appended = upsertEnvLine("A=1", "GITHUB_TOKEN", "ghp_x");
  assert.equal(appended, "A=1\nGITHUB_TOKEN=ghp_x\n");
});

test("remove drops exactly the named line", () => {
  const out = removeEnvLine("A=1\nGITHUB_TOKEN=x\nB=2", "GITHUB_TOKEN");
  assert.equal(out, "A=1\nB=2");
});

test("a pasted key is checked with the provider for free before it is kept", async () => {
  // A typo'd key used to surface three screens later as a 401 mid-turn. The
  // check is a read-only listing that costs nothing; an outage is "unchecked",
  // never a refusal, so a flaky network cannot lock a new owner out.
  const { checkKey } = await import("./keys.js");
  const seen: string[] = [];
  const answer = (status: number) => (async (url: unknown, init?: RequestInit) => {
    seen.push(`${url} ${JSON.stringify(init?.headers)}`);
    return new Response("{}", { status });
  }) as typeof fetch;

  assert.equal((await checkKey("OPENROUTER_API_KEY", "sk-or-good", answer(200))).status, "valid");
  assert.match(seen.at(-1)!, /openrouter\.ai\/api\/v1\/key .*Bearer sk-or-good/);
  assert.equal((await checkKey("OPENROUTER_API_KEY", "sk-or-typo", answer(401))).status, "invalid");
  assert.equal((await checkKey("GEMINI_API_KEY", "AIza-bad", answer(400))).status, "invalid");
  assert.match(seen.at(-1)!, /generativelanguage.*x-goog-api-key/);
  assert.equal((await checkKey("GEMINI_API_KEY", "AIza-x", answer(503))).status, "unchecked", "their outage is not your typo");
  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.equal((await checkKey("OPENROUTER_API_KEY", "sk-or-x", offline)).status, "unchecked");
  assert.equal((await checkKey("GITHUB_TOKEN", "ghp_x", answer(200))).status, "unchecked", "only the two brain keys are probed");
});

test("the voice passphrase is set from the Keys page, never shown back, and refused before writing if it would not work", () => {
  // The HUD's card links here (/keys#CLAW_SAY_PASSPHRASE). Fails with hideTail
  // or the refuse check taken off the roster entry.
  const saved = process.env.CLAW_SAY_PASSPHRASE;
  try {
    process.env.CLAW_SAY_PASSPHRASE = "crack on claw";
    const row = listKeys().find((k) => k.name === "CLAW_SAY_PASSPHRASE")!;
    assert.equal(row.set, true);
    assert.equal(row.tail, "", "not even the last four letters: on a short phrase that is half of it");
    assert.equal(row.applies, "live");
    for (const bad of ["yes", "cat", "no thanks"]) {
      const out = setKey("CLAW_SAY_PASSPHRASE", bad);
      assert.equal(out.ok, false, bad);
    }
    assert.equal(process.env.CLAW_SAY_PASSPHRASE, "crack on claw", "a refused phrase changes nothing");
  } finally {
    if (saved === undefined) delete process.env.CLAW_SAY_PASSPHRASE; else process.env.CLAW_SAY_PASSPHRASE = saved;
  }
});
