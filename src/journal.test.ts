import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { JOURNAL_DIR, searchJournal, searchMemoryFiles } from "./journal.js";
import { parseChatAllowlist } from "./telegram.js";

test("parseChatAllowlist splits and trims ids", () => {
  assert.deepEqual([...parseChatAllowlist(" 111, 222,,333 ")].sort(), ["111", "222", "333"]);
});

test("journal search finds a day file and ignores misses", () => {
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  const file = path.join(JOURNAL_DIR, "2099-12-31.md");
  const token = "zz-cunningclaw-journal-probe";
  fs.writeFileSync(file, `- 12:00:00 operator: ${token} about the Cardiff brief\n`);
  try {
    const hits = searchJournal(token);
    assert.equal(hits.length, 1);
    assert.match(hits[0], /2099-12-31/);
    assert.match(hits[0], /Cardiff/);
    assert.deepEqual(searchJournal("this-string-is-not-in-any-journal-zzz"), []);
    const files = searchMemoryFiles(token);
    assert.match(files, /Memory hits/);
    assert.match(files, /Cardiff/);
  } finally {
    fs.unlinkSync(file);
  }
});

test("the journal is kept in local time: 00:30 BST belongs to the new day's file", { timeout: 60_000 }, async () => {
  // Under BST every line sat an hour behind the HUD and 00:00-00:59 went into
  // yesterday's file. Run in a subprocess pinned to Europe/London so the test
  // bites on a UTC CI machine too; fails with toISOString put back.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { ROOT } = await import("./config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-journal-"));
  try {
    const probe = path.join(dir, "probe.mjs");
    fs.writeFileSync(probe, `
      const j = await import(${JSON.stringify(path.join(ROOT, "src/journal.ts"))});
      j.appendJournal("operator", "late one", new Date("2026-10-24T23:30:00Z"));
      process.exit(0);
    `);
    await promisify(execFile)("npx", ["tsx", probe], {
      cwd: ROOT, timeout: 50_000, env: { ...process.env, TZ: "Europe/London", CLAW_DATA_DIR: path.join(dir, "data") },
    });
    const files = fs.readdirSync(path.join(dir, "data", "journal"));
    assert.deepEqual(files, ["2026-10-25.md"]);
    assert.match(fs.readFileSync(path.join(dir, "data", "journal", files[0]), "utf-8"), /^- 00:30:00 operator: late one/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
