import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  findOldInstall, importOldInstall, INSTALL_MARKER, mergeEnv, resolveHomeRoot, SEED_MANIFEST, seedHome, shippedFiles, userFolder,
} from "./home-root.js";

const execFileAsync = promisify(execFile);
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * The installers' read-only code and the owner's own folder. An installed
 * app's code cannot hold the owner's keys and memory — it is a squashfs, a
 * mounted .app, a folder upgrades replace — so these pin which folder each
 * system gets, that a first run seeds it without ever overwriting, and that
 * an old download's things can be brought across.
 */

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/** A code root shaped like a built bundle's app/ folder. */
function codeRoot(over: Record<string, string> = {}): string {
  const root = tmp("claw-code-");
  const files: Record<string, string> = {
    "claw.config.json": '{"server":{"port":3900}}',
    "workspace/SOUL.md": "# SOUL v1",
    "workspace/skills/shipped/SKILL.md": "shipped skill v1",
    "workspace/tax/uk.json": '{"v":1}',
    ...over,
  };
  for (const [rel, text] of Object.entries(files)) write(path.join(root, rel), text);
  return root;
}

test("each system's installed claw keeps the owner's things in the per-user folder that system expects", () => {
  assert.equal(
    userFolder("win32", { LOCALAPPDATA: "C:\\Users\\Ann\\AppData\\Local" }, "C:\\Users\\Ann"),
    "C:\\Users\\Ann\\AppData\\Local\\CunningClaw",
  );
  assert.equal(userFolder("win32", {}, "C:\\Users\\Ann"), "C:\\Users\\Ann\\AppData\\Local\\CunningClaw", "no LOCALAPPDATA: the same place, from home");
  assert.equal(userFolder("darwin", {}, "/Users/ann"), "/Users/ann/Library/Application Support/cunningclaw");
  assert.equal(userFolder("linux", {}, "/home/ann"), "/home/ann/.local/share/cunningclaw");
  assert.equal(userFolder("linux", { XDG_DATA_HOME: "/data/ann" }, "/home/ann"), "/data/ann/cunningclaw");
  assert.equal(userFolder("linux", { XDG_DATA_HOME: "relative/share" }, "/home/ann"), "/home/ann/.local/share/cunningclaw", "the XDG spec: a relative value is ignored");
});

test("only the installers' marker moves the owner's things; CLAW_HOME overrides either way", () => {
  const base = { platform: "linux" as const, homedir: "/home/ann", codeRoot: "/opt/claw/app" };
  const marker = path.join("/opt/claw/app", INSTALL_MARKER);
  const clone = resolveHomeRoot({ ...base, env: {}, exists: () => false });
  assert.deepEqual(clone, { home: "/opt/claw/app", installed: false, source: "code" }, "a clone or a download is its own folder, as it always was");

  const installed = resolveHomeRoot({ ...base, env: {}, exists: (p) => p === marker });
  assert.deepEqual(installed, { home: "/home/ann/.local/share/cunningclaw", installed: true, source: "installed" });

  const pinned = resolveHomeRoot({ ...base, env: { CLAW_HOME: "/srv/second-claw" }, exists: (p) => p === marker });
  assert.equal(pinned.home, "/srv/second-claw");
  assert.equal(pinned.installed, true, "the code is still read-only, whoever chose the home");
  assert.equal(resolveHomeRoot({ ...base, env: { CLAW_HOME: "  " }, exists: () => false }).home, "/opt/claw/app", "a blank CLAW_HOME is no CLAW_HOME");
});

test("a first run seeds the defaults; an existing file is never overwritten", () => {
  const code = codeRoot();
  const home = tmp("claw-home-");
  try {
    write(path.join(home, "workspace", "SOUL.md"), "# my own soul");
    const first = seedHome(code, home);
    assert.ok(first.copied.includes("claw.config.json"));
    assert.ok(first.copied.includes("workspace/skills/shipped/SKILL.md"));
    assert.ok(!first.copied.includes("workspace/SOUL.md"), "theirs before we arrived");
    assert.equal(fs.readFileSync(path.join(home, "workspace", "SOUL.md"), "utf-8"), "# my own soul");
    assert.equal(fs.readFileSync(path.join(home, "claw.config.json"), "utf-8"), '{"server":{"port":3900}}');

    // The owner edits the config and deletes a skill; a restart changes neither.
    write(path.join(home, "claw.config.json"), '{"server":{"port":3999}}');
    fs.rmSync(path.join(home, "workspace", "tax", "uk.json"));
    const again = seedHome(code, home);
    assert.deepEqual(again, { copied: [], updated: [] });
    assert.equal(fs.readFileSync(path.join(home, "claw.config.json"), "utf-8"), '{"server":{"port":3999}}');
    assert.equal(fs.existsSync(path.join(home, "workspace", "tax", "uk.json")), false, "deleted stays deleted");
  } finally {
    fs.rmSync(code, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an upgrade refreshes what the owner never touched, keeps what they changed, and adds what is new", () => {
  const v1 = codeRoot();
  const home = tmp("claw-home-");
  try {
    seedHome(v1, home);
    write(path.join(home, "claw.config.json"), '{"server":{"port":3999}}');

    // Version 2 changes the shipped skill and the config, and ships a new skill.
    const v2 = codeRoot({
      "claw.config.json": '{"server":{"port":3900},"new":true}',
      "workspace/skills/shipped/SKILL.md": "shipped skill v2",
      "workspace/skills/brand-new/SKILL.md": "new in v2",
    });
    try {
      const r = seedHome(v2, home);
      assert.deepEqual(r.updated, ["workspace/skills/shipped/SKILL.md"]);
      assert.deepEqual(r.copied, ["workspace/skills/brand-new/SKILL.md"]);
      assert.equal(fs.readFileSync(path.join(home, "workspace/skills/shipped/SKILL.md"), "utf-8"), "shipped skill v2");
      assert.equal(fs.readFileSync(path.join(home, "claw.config.json"), "utf-8"), '{"server":{"port":3999}}', "an edited config is theirs");
    } finally {
      fs.rmSync(v2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(v1, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a clone or a download seeds nothing: its code root is its home", () => {
  const code = codeRoot();
  try {
    assert.deepEqual(seedHome(code, code), { copied: [], updated: [] });
    assert.equal(fs.existsSync(path.join(code, SEED_MANIFEST)), false);
  } finally {
    fs.rmSync(code, { recursive: true, force: true });
  }
});

test("shipped files are the config and the workspace tree, and a symlink is not followed out of it", () => {
  const code = codeRoot();
  const outside = tmp("claw-outside-");
  try {
    write(path.join(outside, "secret.txt"), "not ours");
    fs.symlinkSync(outside, path.join(code, "workspace", "linked"));
    const files = shippedFiles(code);
    assert.ok(files.includes("claw.config.json"));
    assert.ok(files.includes("workspace/SOUL.md"));
    assert.ok(!files.some((f) => f.includes("secret")), "a link inside the shipped tree must not copy something from outside it");
  } finally {
    fs.rmSync(code, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("mergeEnv: the old .env wins a clash, the new one's other names are kept", () => {
  const { text, added } = mergeEnv("OPENROUTER_API_KEY=old\nCLAW_TOKEN=a", "CLAW_TOKEN=b\nGEMINI_API_KEY=new\n# a comment\n");
  assert.match(text, /^OPENROUTER_API_KEY=old$/m);
  assert.match(text, /^CLAW_TOKEN=a$/m);
  assert.doesNotMatch(text, /CLAW_TOKEN=b/);
  assert.match(text, /^GEMINI_API_KEY=new$/m);
  assert.deepEqual(added, ["GEMINI_API_KEY"]);
});

test("an old download's keys, config, memory and own notes come across; shipped skills stay this version's", () => {
  const code = codeRoot({ "workspace/skills/shipped/SKILL.md": "shipped skill v2", "workspace/skills/brand-new/SKILL.md": "new in v2" });
  const home = tmp("claw-home-");
  const old = tmp("claw-old-");
  try {
    seedHome(code, home);
    write(path.join(home, ".env"), "CLAW_TOKEN=new\nGEMINI_API_KEY=g\n");
    // The old download: a bundle folder with app/ inside, an older skill and the owner's own things.
    const app = path.join(old, "app");
    write(path.join(app, "claw.config.json"), '{"server":{"port":3901}}');
    write(path.join(app, ".env"), "OPENROUTER_API_KEY=sk-or-synthetic\nCLAW_TOKEN=old\n");
    write(path.join(app, "data", "history.json"), "[1,2,3]");
    write(path.join(app, "workspace", "USER.md"), "I am the owner");
    write(path.join(app, "workspace", "SOUL.md"), "# SOUL as I wrote it");
    write(path.join(app, "workspace", "skills", "shipped", "SKILL.md"), "shipped skill v1");
    write(path.join(app, "workspace", "skills", "shipped", "LESSONS.md"), "- a lesson");
    write(path.join(app, "workspace", "skills", "mine", "SKILL.md"), "my own skill");

    assert.equal(findOldInstall(old), app, "pointed at the download folder, it finds app/");
    const r = importOldInstall({ from: old, codeRoot: code, homeRoot: home, now: new Date("2026-11-20T10:00:00Z") });

    assert.deepEqual(r.keys, ["OPENROUTER_API_KEY", "CLAW_TOKEN"], "names reported, never values");
    const env = fs.readFileSync(path.join(home, ".env"), "utf-8");
    assert.match(env, /^OPENROUTER_API_KEY=sk-or-synthetic$/m);
    assert.match(env, /^CLAW_TOKEN=old$/m);
    assert.match(env, /^GEMINI_API_KEY=g$/m, "a key added in the new one survives");
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(home, ".env")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(home, "claw.config.json"), "utf-8"), '{"server":{"port":3901}}');
    assert.equal(fs.readFileSync(path.join(home, "data", "history.json"), "utf-8"), "[1,2,3]");
    assert.equal(fs.readFileSync(path.join(home, "workspace", "USER.md"), "utf-8"), "I am the owner");
    assert.equal(fs.readFileSync(path.join(home, "workspace", "SOUL.md"), "utf-8"), "# SOUL as I wrote it");
    assert.equal(fs.readFileSync(path.join(home, "workspace", "skills", "mine", "SKILL.md"), "utf-8"), "my own skill");
    assert.equal(fs.readFileSync(path.join(home, "workspace", "skills", "shipped", "LESSONS.md"), "utf-8"), "- a lesson");
    assert.equal(fs.readFileSync(path.join(home, "workspace", "skills", "shipped", "SKILL.md"), "utf-8"), "shipped skill v2",
      "an old download's copy of a shipped skill would shadow every future update");

    // Nothing lost: what was replaced waits in the backup.
    assert.ok(r.backup);
    assert.equal(fs.readFileSync(path.join(r.backup!, "claw.config.json"), "utf-8"), '{"server":{"port":3900}}');
    assert.equal(fs.readFileSync(path.join(r.backup!, ".env"), "utf-8"), "CLAW_TOKEN=new\nGEMINI_API_KEY=g\n");

    // The next upgrade: what was imported is the owner's and stays; what is
    // still exactly as shipped is refreshed; what is new arrives.
    const v3 = codeRoot({
      "claw.config.json": '{"server":{"port":3900},"v":3}',
      "workspace/SOUL.md": "# SOUL v3",
      "workspace/skills/shipped/SKILL.md": "shipped skill v3",
      "workspace/skills/brand-new/SKILL.md": "new in v2",
      "workspace/skills/newer/SKILL.md": "new in v3",
    });
    try {
      const next = seedHome(v3, home);
      assert.deepEqual(next.copied, ["workspace/skills/newer/SKILL.md"]);
      assert.deepEqual(next.updated, ["workspace/skills/shipped/SKILL.md"]);
      assert.equal(fs.readFileSync(path.join(home, "claw.config.json"), "utf-8"), '{"server":{"port":3901}}');
      assert.equal(fs.readFileSync(path.join(home, "workspace", "SOUL.md"), "utf-8"), "# SOUL as I wrote it");
    } finally {
      fs.rmSync(v3, { recursive: true, force: true });
    }
  } finally {
    for (const d of [code, home, old]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("import refuses a folder that is not a claw, and the folder already in use", () => {
  const code = codeRoot();
  const home = tmp("claw-home-");
  const stray = tmp("claw-stray-");
  try {
    assert.throws(() => importOldInstall({ from: stray, codeRoot: code, homeRoot: home }), /does not look like a Cunning Claw folder/);
    seedHome(code, home);
    assert.throws(() => importOldInstall({ from: home, codeRoot: code, homeRoot: home }), /already uses/);
  } finally {
    for (const d of [code, home, stray]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("an installed claw's keys, config, data, workspace and shell all follow the owner's folder", { timeout: 60_000, skip: process.platform === "win32" ? "the subprocess uses XDG paths" : false }, async () => {
  // A code root with the installers' marker, as the AppImage, the .app and
  // the Windows installer ship it. Everything that writes beside ROOT today
  // must land in the owner's folder instead, and the code must be protected.
  const fakeHome = tmp("claw-userhome-");
  const code = path.join(fakeHome, "Applications", "claw-app");
  try {
    fs.mkdirSync(code, { recursive: true });
    fs.copyFileSync(path.join(HERE, "claw.config.json"), path.join(code, "claw.config.json"));
    fs.cpSync(path.join(HERE, "workspace", "SOUL.md"), path.join(code, "workspace", "SOUL.md"), { recursive: true });
    write(path.join(code, INSTALL_MARKER), "{}");
    const owner = path.join(fakeHome, ".local", "share", "cunningclaw");
    write(path.join(owner, ".env"), "TELEGRAM_CHAT_ID=4242\n");

    const env: NodeJS.ProcessEnv = { ...process.env, CLAW_ROOT: code, HOME: fakeHome, XDG_DATA_HOME: "" };
    delete env.CLAW_DATA_DIR;
    delete env.CLAW_CONFIG;
    delete env.CLAW_HOME;
    delete env.TELEGRAM_CHAT_ID;
    const probe = [
      `const c = await import("${path.join(HERE, "src/config.js")}");`,
      `const k = await import("${path.join(HERE, "src/keys.js")}");`,
      `const w = await import("${path.join(HERE, "src/workspace.js")}");`,
      `const s = await import("${path.join(HERE, "src/sandbox.js")}");`,
      `const t = await import("${path.join(HERE, "src/tools.js")}");`,
      "console.log(JSON.stringify({ home: c.HOME_ROOT, installed: c.INSTALLED, data: c.DATA_DIR, config: c.CONFIG_FILE,",
      "  env: k.envPath(), chat: process.env.TELEGRAM_CHAT_ID, workspace: w.WORKSPACE, protected: s.protectedPaths(), cwd: t.resolveCommandCwd() }));",
    ].join("\n");
    const { stdout } = await execFileAsync("npx", ["tsx", "-e", `(async () => { ${probe} })()`], { cwd: HERE, timeout: 50_000, env });
    const got = JSON.parse(String(stdout).trim().split("\n").pop() ?? "{}");

    assert.equal(got.home, owner);
    assert.equal(got.installed, true);
    assert.equal(got.data, path.join(owner, "data"));
    assert.equal(got.config, path.join(owner, "claw.config.json"), "the config is read from the owner's seeded copy");
    assert.ok(fs.existsSync(path.join(owner, "claw.config.json")), "seeded on first run");
    assert.ok(fs.existsSync(path.join(owner, "workspace", "SOUL.md")));
    assert.equal(got.env, path.join(owner, ".env"), "the setup page and the Keys page write here");
    assert.equal(got.chat, "4242", ".env is read from the owner's folder");
    assert.equal(got.workspace, path.join(owner, "workspace"));
    assert.equal(got.cwd, owner, "shell commands start in the owner's folder, not in read-only code");
    assert.ok(got.protected.includes(code), "the code is read-only to boxed commands");
    assert.ok(got.protected.includes(owner), "and so is the owner's folder");
    assert.equal(fs.existsSync(path.join(code, ".env")), false, "nothing is written beside the code");
    assert.equal(fs.existsSync(path.join(code, "data")), false);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
