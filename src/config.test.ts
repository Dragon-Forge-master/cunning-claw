import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ROOT, DATA_DIR, CONFIG_FILE } from "./config.js";

const execFileAsync = promisify(execFile);

test("an ordinary install resolves its own directory, as it always did", () => {
  assert.equal(DATA_DIR, path.join(ROOT, "data"));
  assert.equal(CONFIG_FILE, path.join(ROOT, "claw.config.json"));
});

test("a second claw can run beside the first with its own state", { timeout: 60_000 }, async () => {
  // The worker blocker: DATA_DIR and the config path were derived from this
  // file's own location with no override, so a second claw on one machine
  // would share history.json, memory, the journal and the brain pin with the
  // first. A worker is a claw with its own state, so both must be movable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-second-"));
  try {
    const cfgPath = path.join(dir, "worker.json");
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "claw.config.json"), "utf-8"));
    cfg.server.port = 3901;
    cfg.persona.name = "Worker One";
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    const { stdout } = await execFileAsync(
      "npx",
      ["tsx", "-e", `import("${path.join(ROOT, "src/config.js")}").then((m) => console.log(JSON.stringify({ data: m.DATA_DIR, port: m.config.server.port, name: m.config.persona.name })))`],
      {
        cwd: ROOT,
        timeout: 50_000,
        env: { ...process.env, CLAW_DATA_DIR: path.join(dir, "data"), CLAW_CONFIG: cfgPath },
      },
    );
    const got = JSON.parse(String(stdout).trim().split("\n").pop() ?? "{}");
    assert.equal(got.data, path.join(dir, "data"), "its state is its own");
    assert.equal(got.port, 3901, "and so is its config");
    assert.equal(got.name, "Worker One");
    // The first claw's own paths are untouched by any of that.
    assert.equal(DATA_DIR, path.join(ROOT, "data"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
