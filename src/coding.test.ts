import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planEdit, commitEdit, grepFiles, globFiles } from "./coding.js";
import { parsePreviewUrl, openPreview, closePreview } from "./preview.js";

test("preview URLs rewrite 0.0.0.0 and reject script/file schemes", () => {
  const ok = parsePreviewUrl("http://0.0.0.0:5173/app");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.match(ok.url, /127\.0\.0\.1:5173/);
  assert.equal(parsePreviewUrl("javascript:alert(1)").ok, false);
  assert.equal(parsePreviewUrl("file:///etc/passwd").ok, false);
  const opened = openPreview("http://127.0.0.1:3900/");
  assert.equal(opened.ok, true);
  closePreview();
});

test("edit_file requires a unique snippet unless replaceAll", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cunningclaw-edit-"));
  const file = path.join(dir, "a.ts");
  fs.writeFileSync(file, "const a = 1;\nconst b = 1;\n");
  const amb = planEdit({ path: file, oldString: " = 1", newString: " = 2" });
  assert.equal(amb.ok, false);
  const one = planEdit({ path: file, oldString: "const a = 1;", newString: "const a = 2;" });
  assert.equal(one.ok, true);
  const done = commitEdit({ path: file, oldString: "const a = 1;", newString: "const a = 2;" });
  assert.match(done, /Edited/);
  assert.match(fs.readFileSync(file, "utf-8"), /const a = 2/);
  fs.rmSync(dir, { recursive: true });
});

test("grep and glob find a file without shelling out", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cunningclaw-grep-"));
  fs.writeFileSync(path.join(dir, "hit.ts"), "export const cardiff = true;\n");
  fs.writeFileSync(path.join(dir, "miss.md"), "nothing here\n");
  const g = globFiles("**/*.ts", dir);
  assert.match(g, /hit\.ts/);
  const hits = grepFiles({ pattern: "cardiff", path: dir, glob: "*.ts" });
  assert.match(hits, /hit\.ts:1:/);
  fs.rmSync(dir, { recursive: true });
});
