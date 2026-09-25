// Preloaded by `npm test` before any module is imported.
//
// DATA_DIR is fixed at import (src/config.ts), and without an override the
// test run shared it with the operator's live claw. The brain tests pin and
// unpin brains through the real pin file, so an interrupted run could leave
// a pin that the next restart of the live claw obeyed, silently, for weeks;
// a finished run deleted whatever pin the operator had chosen. The tax tests
// wrote data/tax.json. Every run now gets a throwaway data dir of its own.
// node --test runs each file in a child process that inherits this env, so
// the whole run shares one directory, removed when the run ends.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.CLAW_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cunningclaw-test-data-"));
  process.env.CLAW_DATA_DIR = dir;
  process.on("exit", () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
