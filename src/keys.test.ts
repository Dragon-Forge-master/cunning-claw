import assert from "node:assert/strict";
import test from "node:test";
import { KEY_ROSTER, cleanValue, upsertEnvLine, removeEnvLine, setKey } from "./keys.js";

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
