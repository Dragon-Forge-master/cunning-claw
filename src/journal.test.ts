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
