import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  DEFAULT_HIDDEN,
  bwrapArgs,
  dotEnvNames,
  sandboxEnv,
  sessionSockets,
  decide,
  detectEngine,
  explainSandboxFailure,
  isLauncher,
  normalisePath,
  planHidden,
  planWrites,
  sandboxDoctor,
  sandboxSettings,
  sbplProfile,
  tooBroad,
  type DetectDeps,
  type Detection,
  type WriteSet,
} from "./sandbox.js";

const execFileAsync = promisify(execFile);
const HOME = "/home/owner";
const identity = (p: string) => p;

function writes(over: Partial<WriteSet> = {}): WriteSet {
  return { writable: ["/tmp", "/home/owner/proj"], readOnly: [], skipped: [], cwdNote: "", ...over };
}
const BWRAP: Detection = { engine: "bwrap", why: "", fix: "" };
const NONE: Detection = { engine: null, why: "bubblewrap is not installed", fix: "sudo apt install bubblewrap" };

test("a path with anything that could close a quote never reaches a bind", () => {
  for (const bad of ["~/sites/$(rm -rf ~)", '/tmp/a"b', "/tmp/a\\b", "/tmp/a\nb", "/tmp/`x`", "/tmp/a;b", "/tmp/*", "/tmp/café"]) {
    assert.ok("why" in normalisePath(bad, HOME), `refused: ${JSON.stringify(bad)}`);
  }
  assert.ok("why" in normalisePath("sites", HOME), "relative paths are refused, not resolved against wherever we are");
  assert.deepEqual(normalisePath("~/sites", HOME), { path: "/home/owner/sites" });
  assert.deepEqual(normalisePath("/home/owner/a/../b", HOME), { path: "/home/owner/b" });
});

test("nothing as wide as home, its parents or a system folder can be made writable", () => {
  assert.ok(tooBroad("/", HOME));
  assert.ok(tooBroad(HOME, HOME));
  assert.ok(tooBroad("/home", HOME));
  assert.ok(tooBroad("/etc/cron.d", HOME));
  assert.ok(tooBroad("/usr/local/bin", HOME));
  assert.equal(tooBroad("/home/owner/sites", HOME), null);
  assert.equal(tooBroad("/srv/www", HOME), null);
});

test("the working folder is writable only when it is an ordinary folder under home", () => {
  const plan = (cwd: string, configured: string[] = []) =>
    planWrites({ cwd, configured, home: HOME, tmpDirs: ["/tmp"], protectedPaths: [], real: identity });
  assert.ok(plan("/home/owner/proj").writable.includes("/home/owner/proj"));
  assert.equal(plan("/home/owner/proj").cwdNote, "");
  // The model picks cwd; cwd must never be how ~, a dotdir or /etc becomes writable.
  for (const cwd of [HOME, "/home/owner/.config/autostart", "/etc", "/opt/thing", "/"]) {
    const w = plan(cwd);
    assert.ok(!w.writable.includes(cwd), `${cwd} stays read-only`);
    assert.notEqual(w.cwdNote, "", `${cwd} says why`);
  }
  // Inside a configured folder needs no bind of its own.
  assert.deepEqual(plan("/home/owner/sites/garage", ["~/sites"]).writable, ["/tmp", "/home/owner/sites"]);
});

test("configured folders are realpath'd, so a symlink cannot smuggle / in", () => {
  const real = (p: string) => (p === "/home/owner/sites" ? "/" : p === "/home/owner/gone" ? null : p);
  const w = planWrites({
    cwd: "/tmp", configured: ["~/sites", "~", "~/gone", "~/ok", "bad$name"], home: HOME,
    tmpDirs: ["/tmp"], protectedPaths: [], real,
  });
  assert.deepEqual(w.writable, ["/tmp", "/home/owner/ok"]);
  const why = Object.fromEntries(w.skipped.map((k) => [k.path, k.why]));
  assert.match(why["~/sites"], /whole filesystem/);
  assert.match(why["~"], /whole home/);
  assert.match(why["~/gone"], /does not exist/);
  assert.match(why["bad$name"], /characters/);
});

test("the claw's own config, keys and workspace stay read-only inside a writable folder", () => {
  const w = planWrites({
    cwd: "/home/owner/cunning-claw", configured: [], home: HOME, tmpDirs: ["/tmp"],
    protectedPaths: ["/home/owner/cunning-claw/claw.config.json", "/home/owner/cunning-claw/workspace", "/home/owner/elsewhere/.env"],
    real: identity,
  });
  assert.ok(w.readOnly.includes("/home/owner/cunning-claw/claw.config.json"));
  assert.ok(w.readOnly.includes("/home/owner/cunning-claw/workspace"));
  assert.ok(!w.readOnly.includes("/home/owner/elsewhere/.env"), "outside every writable folder it is read-only already");

  const args = bwrapArgs({ writable: w.writable, readOnly: w.readOnly, network: true, shell: "/bin/bash", command: "true" });
  const lastWritable = args.lastIndexOf("--bind");
  const firstGuard = args.indexOf("--ro-bind-try");
  assert.ok(firstGuard > lastWritable, "guards are mounted over the writable binds, so they win");

  const sbpl = sbplProfile({ writable: w.writable, readOnly: w.readOnly, network: true });
  assert.match(sbpl, /\(require-not \(subpath "\/home\/owner\/cunning-claw\/claw\.config\.json"\)\)/);
});

test("bwrap argv: read-only root, chosen binds, real ps, and the command as one argument", () => {
  const command = "git status; echo done";
  const a = bwrapArgs({ writable: ["/tmp", "/home/owner/proj"], readOnly: [], network: true, shell: "/bin/bash", command });
  for (const flag of ["--die-with-parent", "--new-session", "--unshare-ipc"]) assert.ok(a.includes(flag), flag);
  assert.deepEqual(a.slice(a.indexOf("--ro-bind"), a.indexOf("--ro-bind") + 3), ["--ro-bind", "/", "/"]);
  assert.deepEqual(a.slice(a.indexOf("--dev"), a.indexOf("--dev") + 2), ["--dev", "/dev"]);
  assert.ok(a.join("\0").includes(["--bind", "/home/owner/proj", "/home/owner/proj"].join("\0")));
  assert.deepEqual(a.slice(-4), ["--", "/bin/bash", "-c", command], "the command is never split or spliced");
  // ps is auto-approved: a private PID namespace would make it report a quiet machine.
  assert.ok(!a.includes("--unshare-pid") && !a.includes("--unshare-all"));
  assert.ok(!a.includes("--unshare-net"), "network on by default");
  assert.ok(bwrapArgs({ writable: [], readOnly: [], network: false, shell: "/bin/sh", command: "x" }).includes("--unshare-net"));
  assert.throws(() => bwrapArgs({ writable: ['/tmp/a"b'], readOnly: [], network: true, shell: "/bin/sh", command: "x" }));
});

test("the macOS profile denies writes except the chosen folders, and the network on request", () => {
  const p = sbplProfile({ writable: ["/private/tmp", "/Users/owner/proj"], readOnly: [], network: false });
  assert.match(p, /\(allow default\)/);
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(allow file-write\* \(subpath "\/Users\/owner\/proj"\)\)/);
  assert.match(p, /\(deny network\*\)/);
  assert.ok(p.indexOf("(deny file-write*)") < p.indexOf('(subpath "/Users/owner/proj")'), "the allow comes after the deny, so it wins");
  assert.doesNotMatch(sbplProfile({ writable: [], readOnly: [], network: true }), /deny network/);
  assert.throws(() => sbplProfile({ writable: ['/x") (allow file-write* (subpath "/'], readOnly: [], network: true }));
});

test("decide: off, missing and required each say what happened, and only an escape asks", () => {
  const base = { unsandboxed: false, writes: writes(), shell: "/bin/bash", command: "npm test", home: HOME };
  const off = decide({ ...base, settings: { mode: "off", network: true, writable: [] }, detection: BWRAP });
  assert.equal(off.kind, "host");
  assert.match(off.kind === "host" ? off.label : "", /^\[unsandboxed: sandbox\.mode is "off"/);

  const missing = decide({ ...base, settings: { mode: "auto", network: true, writable: [] }, detection: NONE });
  assert.equal(missing.kind === "host" && missing.askFirst, false, "falling back is not the model's doing, so no extra card");
  assert.match(missing.kind === "host" ? missing.label : "", /unsandboxed: bubblewrap is not installed/);

  const required = decide({ ...base, settings: { mode: "required", network: true, writable: [] }, detection: NONE });
  assert.equal(required.kind, "refuse");
  assert.match(required.kind === "refuse" ? required.text : "", /Nothing ran.*sudo apt install bubblewrap/);

  const boxed = decide({ ...base, settings: { mode: "auto", network: true, writable: [] }, detection: BWRAP });
  assert.equal(boxed.kind, "sandboxed");
  assert.match(boxed.kind === "sandboxed" ? boxed.label : "", /^\[sandboxed by bubblewrap — writes only to: \/tmp, ~\/proj; network on\]$/);

  const escape = decide({ ...base, unsandboxed: true, settings: { mode: "auto", network: true, writable: [] }, detection: BWRAP });
  assert.equal(escape.kind === "host" && escape.askFirst, true);
  const noEscape = decide({ ...base, unsandboxed: true, settings: { mode: "required", network: true, writable: [] }, detection: BWRAP });
  assert.equal(noEscape.kind, "refuse", "required means required, approval or not");
});

test("the label is the same every time, so the Ouroboros guard still sees repeats", () => {
  const o = { unsandboxed: false, writes: writes(), shell: "/bin/bash", command: "ls", home: HOME,
    settings: { mode: "auto" as const, network: true, writable: [] }, detection: BWRAP };
  const a = decide(o);
  const b = decide(o);
  assert.equal(a.kind === "sandboxed" && a.label, b.kind === "sandboxed" && b.label);
});

test("a lone launcher leaves the box, a chained one does not", () => {
  assert.equal(isLauncher("xdg-open https://example.com"), true);
  assert.equal(isLauncher("gio open notes.pdf"), true);
  assert.equal(isLauncher("xdg-open x; rm -r ~/proj"), false);
  assert.equal(isLauncher("xdg-open $(cat list)"), false);
  assert.equal(isLauncher("opener run"), false);
});

test("a write the sandbox refused is explained, and the way out is the card", () => {
  const settings = { mode: "auto" as const, network: false, writable: [] };
  const plan = decide({ unsandboxed: false, writes: writes(), shell: "/bin/bash", command: "x", home: HOME, settings, detection: BWRAP });
  const erofs = explainSandboxFailure("touch: cannot touch '/etc/x': Read-only file system", plan, HOME);
  assert.match(erofs, /sandbox refusing a write/);
  assert.match(erofs, /unsandboxed: true/);
  assert.match(explainSandboxFailure("curl: (6) Could not resolve host: example.com", plan, HOME), /no network/);
  assert.match(explainSandboxFailure("bwrap: Creating new namespace failed", plan, HOME), /failed to start/);
  assert.equal(explainSandboxFailure("ordinary failure", plan, HOME), "");

  const strict = decide({ unsandboxed: false, writes: writes(), shell: "/bin/bash", command: "x", home: HOME,
    settings: { ...settings, mode: "required" }, detection: BWRAP });
  assert.doesNotMatch(explainSandboxFailure("Read-only file system", strict, HOME), /unsandboxed: true/,
    "required never offers an escape it will refuse");
  const host = decide({ unsandboxed: false, writes: writes(), shell: "/bin/bash", command: "x", home: HOME, settings, detection: NONE });
  assert.equal(explainSandboxFailure("Read-only file system", host, HOME), "");
});

function fakeDeps(h: "linux" | "darwin" | "win32", bins: string[], probeError: string | null = null) {
  const probes: string[][] = [];
  const deps: DetectDeps = {
    host: () => h,
    hasBin: async (b) => bins.includes(b),
    probe: async (file, args) => { probes.push([file, ...args]); return probeError; },
  };
  return { deps, probes };
}

test("detection is honest per platform, and probes bwrap with the real flags", async () => {
  const win = await detectEngine(fakeDeps("win32", []).deps);
  assert.equal(win.engine, null);
  assert.match(win.why, /Windows has no shell sandbox/);

  const bare = await detectEngine(fakeDeps("linux", []).deps);
  assert.equal(bare.engine, null);
  assert.match(bare.fix, /apt install bubblewrap/);

  const blocked = await detectEngine(fakeDeps("linux", ["bwrap"], "bwrap: setting up uid map: Permission denied").deps);
  assert.equal(blocked.engine, null, "installed is not the same as usable");
  assert.match(blocked.why, /cannot start here/);

  const { deps, probes } = fakeDeps("linux", ["bwrap"]);
  assert.equal((await detectEngine(deps)).engine, "bwrap");
  assert.ok(probes[0].includes("--die-with-parent"), "the probe uses the same argv builder as real runs");

  assert.equal((await detectEngine(fakeDeps("darwin", ["sandbox-exec"]).deps)).engine, "sandbox-exec");
});

test("doctor names the fix when bubblewrap is missing", async () => {
  const row = await sandboxDoctor(fakeDeps("linux", []).deps);
  assert.equal(row.status, "warn");
  assert.match(row.line, /sudo apt install bubblewrap/);
  const win = await sandboxDoctor(fakeDeps("win32", []).deps);
  assert.match(win.line, /unsandboxed/);
});

test("settings default to auto with the network on, and a typo is not off", () => {
  assert.deepEqual(sandboxSettings(undefined).mode, "auto");
  assert.equal(sandboxSettings(undefined).network, true);
  assert.ok(sandboxSettings(undefined).writable.includes("~/sites"));
  assert.equal(sandboxSettings({ mode: "of" }).mode, "auto");
  assert.equal(sandboxSettings({ mode: "required", network: false }).network, false);
});

// The real thing, where this machine can run it. Skipped (and saying so) where
// bubblewrap is absent or user namespaces are off, so the suite stays green on
// a Mac or a locked-down CI runner.
const live = await detectEngine();
test("bubblewrap really refuses a write outside the box and allows one inside", { skip: live.engine !== "bwrap" ? `no usable bubblewrap: ${live.why}` : false }, async () => {
  const inside = fs.mkdtempSync(path.join(os.tmpdir(), "claw-sbx-in-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "claw-sbx-out-"));
  const guarded = path.join(inside, "claw.config.json");
  fs.writeFileSync(guarded, "{}");
  try {
    // Only `inside` is writable here — /tmp itself deliberately is not.
    const run = (command: string) => execFileAsync("bwrap", bwrapArgs({
      writable: [fs.realpathSync(inside)], readOnly: [fs.realpathSync(guarded)], network: false,
      shell: "/bin/sh", command,
    }), { cwd: inside }).then(() => "ok", (e) => String(e.stderr));

    assert.equal(await run("echo hi > made.txt"), "ok");
    assert.equal(fs.readFileSync(path.join(inside, "made.txt"), "utf-8"), "hi\n");
    assert.match(await run(`echo no > ${other}/escaped.txt`), /Read-only file system/);
    assert.equal(fs.existsSync(path.join(other, "escaped.txt")), false);
    assert.match(await run(`echo '{"sandbox":{"mode":"off"}}' > claw.config.json`), /Read-only file system|Device or resource busy/);
    assert.equal(fs.readFileSync(guarded, "utf-8"), "{}", "the protected file inside the box is untouched");
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});


// --- Secrets hidden from the box -------------------------------------------
// The box first confined writes only, so `cat ~/.ssh/id_ed25519` worked inside
// it, and with the network on that key could be posted anywhere — the first
// known gap in docs/SECURITY-ARCHITECTURE.md.

const OWN = ["/home/owner/claw/.env", "/home/owner/claw/data/mcp-oauth.json", "/home/owner/.config/cunningclaw/chrome-profile"];
function hiddenFor(o: { exists: string[]; dirs: string[]; reveal?: string[]; extra?: string[]; links?: Record<string, string> }) {
  return planHidden({
    defaults: DEFAULT_HIDDEN, extra: o.extra ?? [], reveal: o.reveal ?? [], own: OWN, home: HOME,
    real: (p) => (o.links?.[p] ?? (o.exists.includes(p) ? p : null)),
    isDir: (p) => o.dirs.includes(p),
  });
}

test("ssh keys, credential files and the claw's own secrets are hidden; absent ones are skipped quietly", () => {
  const h = hiddenFor({
    exists: ["/home/owner/.ssh", "/home/owner/.netrc", "/home/owner/.aws", ...OWN],
    dirs: ["/home/owner/.ssh", "/home/owner/.aws", OWN[2]],
  });
  assert.ok(h.dirs.includes("/home/owner/.ssh"));
  assert.ok(h.dirs.includes("/home/owner/.aws"));
  assert.ok(h.files.includes("/home/owner/.netrc"));
  for (const own of OWN) assert.ok([...h.dirs, ...h.files].includes(own), own);
  assert.ok(!h.dirs.includes("/home/owner/.gnupg"), "absent folders are not mounted over");
  assert.deepEqual(h.skipped, []);
});

test("reveal can show ~/.ssh again for git over ssh, but never the claw's own keys", () => {
  const h = hiddenFor({
    exists: ["/home/owner/.ssh", ...OWN], dirs: ["/home/owner/.ssh"],
    reveal: ["~/.ssh", "/home/owner/claw/.env"],
  });
  assert.ok(!h.dirs.includes("/home/owner/.ssh"));
  assert.ok(h.files.includes("/home/owner/claw/.env"), "reveal must not reach the claw's own .env");
});

test("a symlinked key folder is hidden where it really lives, and an unpassable path is reported", () => {
  const h = hiddenFor({
    exists: ["/data/keys"], dirs: ["/data/keys"],
    links: { "/home/owner/.ssh": "/data/keys", "/home/owner/.netrc": '/home/owner/odd"name' },
  });
  assert.ok(h.dirs.includes("/data/keys"));
  assert.ok(h.skipped.some((k) => k.path === "~/.netrc"), "an unhideable secret must be said, not silently left visible");
});

test("bwrap hides secrets last, so a writable folder cannot uncover one; macOS denies reading them", () => {
  const hidden = { dirs: ["/home/owner/proj/.ssh"], files: ["/home/owner/proj/.env"] };
  const a = bwrapArgs({ writable: ["/home/owner/proj"], readOnly: [], hidden, network: true, shell: "/bin/sh", command: "true" });
  const bind = a.indexOf("--bind");
  const tmpfs = a.indexOf("--tmpfs");
  assert.ok(tmpfs > bind, "the hide must come after the writable bind it sits inside");
  assert.deepEqual(a.slice(tmpfs, tmpfs + 4), ["--tmpfs", "/home/owner/proj/.ssh", "--remount-ro", "/home/owner/proj/.ssh"]);
  const f = a.indexOf("/home/owner/proj/.env");
  assert.deepEqual(a.slice(f - 2, f + 1), ["--ro-bind", "/dev/null", "/home/owner/proj/.env"]);
  assert.throws(() => bwrapArgs({ writable: [], readOnly: [], hidden: { dirs: ['/x"y'], files: [] }, network: true, shell: "/bin/sh", command: "x" }));

  const p = sbplProfile({ writable: ["/Users/owner/proj"], readOnly: [], network: true, hidden: { dirs: ["/Users/owner/.ssh"], files: ["/Users/owner/.netrc"] } });
  const lines = p.split("\n");
  const deny = lines.findIndex((l) => l.includes('(deny file-read* file-write* (subpath "/Users/owner/.ssh"))'));
  assert.ok(deny > lines.findIndex((l) => l.includes('subpath "/Users/owner/proj"')), "the deny must follow the allows to win");
  assert.ok(p.includes('(deny file-read* file-write* (literal "/Users/owner/.netrc"))'));
});

test("the label says secrets are hidden, and a missing-key failure is explained as the box", () => {
  const hidden = { dirs: ["/home/owner/.ssh"], files: [], skipped: [] };
  const settings = { mode: "auto" as const, network: true, writable: [], hide: [], reveal: [] };
  const plan = decide({ settings, detection: BWRAP, unsandboxed: false, writes: writes(), hidden, shell: "/bin/bash", command: "git push", home: HOME });
  assert.equal(plan.kind, "sandboxed");
  assert.match((plan as { label: string }).label, /keys and sign-ins hidden/);
  const why = explainSandboxFailure("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", plan, HOME);
  assert.match(why, /missing key, and that is the sandbox/);
  assert.match(why, /~\/\.ssh/);
  assert.match(why, /unsandboxed: true/);
  assert.match(why, /sandbox\.reveal/);
});

test("bubblewrap really hides a key: cat fails inside the box and the secret never appears", { skip: live.engine !== "bwrap" ? `no usable bubblewrap: ${live.why}` : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-hide-"));
  try {
    const ssh = path.join(dir, ".ssh");
    const proj = path.join(dir, "proj");
    fs.mkdirSync(ssh);
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(ssh, "id_ed25519"), "SYNTHETIC-PRIVATE-KEY-0000");
    fs.writeFileSync(path.join(dir, ".netrc"), "SYNTHETIC-NETRC-TOKEN-0000");
    const run = async (command: string) => {
      try {
        const { stdout, stderr } = await execFileAsync("bwrap", bwrapArgs({
          writable: [proj], readOnly: [], network: false, shell: "/bin/sh", command,
          hidden: { dirs: [ssh], files: [path.join(dir, ".netrc")] },
        }));
        return stdout + stderr;
      } catch (err: any) {
        return `${err.stdout ?? ""}${err.stderr ?? ""}`;
      }
    };
    const out = await run(`cat ${ssh}/id_ed25519; cat ${dir}/.netrc; ls -A ${ssh}; touch ${ssh}/planted; echo done > ${proj}/w`);
    assert.doesNotMatch(out, /SYNTHETIC-PRIVATE-KEY|SYNTHETIC-NETRC-TOKEN/);
    assert.equal(fs.existsSync(path.join(ssh, "planted")), false, "nothing written into the stand-in reaches the real folder");
    assert.equal(fs.readFileSync(path.join(proj, "w"), "utf-8").trim(), "done", "ordinary work still writes");
    assert.equal(fs.readFileSync(path.join(ssh, "id_ed25519"), "utf-8"), "SYNTHETIC-PRIVATE-KEY-0000", "the real key is untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// --- Secrets kept out of the environment, and the session's sockets hidden ---

test("a boxed command's environment loses credentials, the claw's .env names and the session signposts", () => {
  const env = {
    PATH: "/usr/bin", HOME: "/home/owner", LANG: "en_GB.UTF-8", TERM: "xterm", XDG_RUNTIME_DIR: "/run/user/1000",
    OPENROUTER_API_KEY: "x", GEMINI_API_KEY: "x", CLAW_TOKEN: "x", GITHUB_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "x",
    NTFY_TOPIC: "x", DISCORD_BOT_TOKEN: "x", DB_PASSWORD: "x",
    SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", DISPLAY: ":0", XAUTHORITY: "/home/owner/.Xauthority",
  };
  const { env: out, removed } = sandboxEnv(env, ["NTFY_TOPIC"]);
  for (const k of ["PATH", "HOME", "LANG", "TERM", "XDG_RUNTIME_DIR"]) assert.equal(out[k], env[k as keyof typeof env], k);
  for (const k of ["OPENROUTER_API_KEY", "GEMINI_API_KEY", "CLAW_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "NTFY_TOPIC",
    "DISCORD_BOT_TOKEN", "DB_PASSWORD", "SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "XAUTHORITY"]) {
    assert.equal(out[k], undefined, `${k} must not reach the box`);
    assert.ok(removed.includes(k), k);
  }
  assert.equal(sandboxEnv(env, [], { keepSshAgent: true }).env.SSH_AUTH_SOCK, "/tmp/ssh-x/agent.1", "revealing ~/.ssh brings the agent with it");
});

test("the .env reader takes names only, export lines included, comments not", () => {
  assert.deepEqual(dotEnvNames("# A comment\nOPENROUTER_API_KEY=sk-x\nexport NTFY_TOPIC=abc\n  CUSTOM_THING = 1\nnot a line\n"), ["OPENROUTER_API_KEY", "NTFY_TOPIC", "CUSTOM_THING"]);
});

test("the session's sockets are listed for hiding: agents, keyring, bus and display", () => {
  const env = { XDG_RUNTIME_DIR: "/run/user/1000", SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1", WAYLAND_DISPLAY: "wayland-1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus,guid=1" };
  const s = sessionSockets(env, HOME);
  for (const p of ["/tmp/ssh-x/agent.1", "/run/user/1000/bus", "/run/user/1000/gnupg", "/run/user/1000/keyring", "/run/user/1000/wayland-1", "/tmp/.X11-unix", "/home/owner/.Xauthority"]) {
    assert.ok(s.includes(p), p);
  }
  assert.ok(!sessionSockets(env, HOME, { keepSshAgent: true }).includes("/tmp/ssh-x/agent.1"));
});

test("notify-send and playerctl alone leave the box (they need the desktop bus); chained, they do not", () => {
  assert.equal(isLauncher("notify-send 'Build done'"), true);
  assert.equal(isLauncher("playerctl pause"), true);
  assert.equal(isLauncher("playerctl pause; cat ~/.ssh/id_ed25519"), false);
});

test("bubblewrap really refuses a hidden agent socket and drops env secrets", { skip: live.engine !== "bwrap" ? `no usable bubblewrap: ${live.why}` : false }, async () => {
  const net = await import("node:net");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-sock-"));
  const sock = path.join(dir, "agent.sock");
  const server = net.createServer((c) => c.end("SYNTHETIC-AGENT-ANSWER\n"));
  await new Promise<void>((r) => server.listen(sock, () => r()));
  const client = `const c=require("net").connect(${JSON.stringify(sock)});c.on("data",d=>{process.stdout.write(String(d));process.exit(0)});c.on("error",e=>{console.log("refused",e.code);process.exit(0)});setTimeout(()=>process.exit(0),3000)`;
  const run = async (hidden: { dirs: string[]; files: string[] }) => {
    const { stdout } = await execFileAsync("bwrap", bwrapArgs({
      writable: [], readOnly: [], network: true, hidden, shell: "/bin/sh",
      command: `${process.execPath} -e '${client}'; printenv SYNTHETIC_AGENT_TOKEN || echo no-token`,
    }), { env: sandboxEnv({ ...process.env, SYNTHETIC_AGENT_TOKEN: "SYNTHETIC-ENV-0000" }, []).env });
    return stdout;
  };
  try {
    assert.match(await run({ dirs: [], files: [] }), /SYNTHETIC-AGENT-ANSWER/, "control: the socket answers when not hidden");
    const hidden = await run({ dirs: [], files: [sock] });
    assert.doesNotMatch(hidden, /SYNTHETIC-AGENT-ANSWER/);
    assert.match(hidden, /refused/);
    assert.match(hidden, /no-token/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
