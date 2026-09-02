import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ROOT } from "./config.js";

const execFileAsync = promisify(execFile);

test("a renamed claw's system prompt says so — no hardcoded identity line", { timeout: 60_000 }, async () => {
  // "Name your claw": persona.name in claw.config.json renames the individual
  // butler, and the prompt's identity lines ("You are …") are the butler, not
  // the brand. SYSTEM_PROMPT is baked at import, so the rename has to happen
  // before the module loads — hence a subprocess with CLAW_CONFIG, the same
  // road config.test.ts drives. On a default install the name IS Cunning
  // Claw, so only a renamed config can tell interpolation from a hardcode:
  // this fails with "You are Cunning Claw." put back on the landscape line.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-rename-"));
  try {
    const cfgPath = path.join(dir, "renamed.json");
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "claw.config.json"), "utf-8"));
    cfg.persona.name = "Vera Vex";
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    const { stdout } = await execFileAsync(
      "npx",
      [
        "tsx",
        "-e",
        // agent.js arms module-level timers, so the probe must exit explicitly.
        `import("${path.join(ROOT, "src/agent.js")}").then((m) => { console.log(JSON.stringify({ renamed: /You are Vera Vex/.test(m.SYSTEM_PROMPT), brand: /You are Cunning Claw/.test(m.SYSTEM_PROMPT) })); process.exit(0); })`,
      ],
      {
        cwd: ROOT,
        timeout: 50_000,
        env: { ...process.env, CLAW_DATA_DIR: path.join(dir, "data"), CLAW_CONFIG: cfgPath },
      },
    );
    const got = JSON.parse(String(stdout).trim().split("\n").pop() ?? "{}");
    assert.equal(got.renamed, true, "every identity line follows persona.name");
    assert.equal(got.brand, false, "no identity line is stuck on the brand");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
