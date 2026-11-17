import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config, CONFIG_FILE, DATA_DIR, ROOT } from "./config.js";
import { cunningclawMcpPath } from "./mcp-config.js";
import { collapseHome } from "./paths.js";
import { hasBin, host, type Host } from "./platform.js";

const execFileAsync = promisify(execFile);

/**
 * A box around the shell.
 *
 * Until this existed, run_command ran straight on the host: HARD_DENY and the
 * approval card were the only things between the model and the machine, and
 * once a command was approved — or covered by a work order, or on the
 * auto-approve list — it could write anywhere the operator can. An approved
 * `npm install` whose postinstall appends to ~/.bashrc was indistinguishable
 * from one that did not. The sandbox confines WRITES: the command's own
 * folder, the temp dir and the folders named in config. It does not confine
 * reads (git over ssh needs ~/.ssh), and it is an extra layer under the floor
 * and the card, never a replacement for either.
 *
 * External binaries only, no npm dependency: bubblewrap on Linux, the
 * built-in sandbox-exec on macOS. Windows has nothing comparable, and the
 * result says "unsandboxed" there rather than pretending.
 *
 * The model never chooses a bind path or a flag. Paths come from config and
 * from the resolved working directory, are normalised and realpath'd, and are
 * refused outright if they hold a character outside a short whitelist — the
 * same rule remote.ts applies to scp paths, for the same reason: a builder
 * that splices a path into another program's language must not be handed one
 * that can close a quote.
 */

export type SandboxMode = "off" | "auto" | "required";

export interface SandboxSettings {
  /** off: never. auto: when available, else run on the host and say so. required: never run without it. */
  mode: SandboxMode;
  /** Whether sandboxed commands keep the network (git push, npm install, curl). */
  network: boolean;
  /** Extra folders sandboxed commands may write to. `~` expands; nothing broader than a subfolder of home. */
  writable: string[];
}

/**
 * The claw's own working folders, plus the two caches that `npm install` and
 * pip fail without. In claw.config.json too; this is the fallback for a
 * config copied before the sandbox existed.
 */
export const DEFAULT_WRITABLE = ["~/sites", "~/Documents/CunningClaw", "~/.npm", "~/.cache"];

export function sandboxSettings(raw: unknown = (config as { sandbox?: unknown }).sandbox): SandboxSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // An unrecognised mode is read as "auto": a typo must neither switch the
  // sandbox off nor make every command refuse to run.
  const mode: SandboxMode = s.mode === "off" || s.mode === "required" ? s.mode : "auto";
  const writable = Array.isArray(s.writable)
    ? s.writable.filter((p): p is string => typeof p === "string")
    : DEFAULT_WRITABLE;
  return { mode, network: s.network !== false, writable };
}

// ---------------------------------------------------------------------------
// Paths — pure, with home and realpath injected so tests can stand in.
// ---------------------------------------------------------------------------

/**
 * Letters, digits, space and a few punctuation marks. No quote, backslash,
 * dollar, backtick, glob, bracket or control character can reach a bwrap
 * argv or an SBPL string literal. Non-ASCII names are refused too — a cost
 * paid knowingly, because the alternative is reasoning about every encoding.
 */
const SAFE_PATH = /^[A-Za-z0-9 ._@+,:=~/-]+$/;

export function isSafePath(p: string): boolean {
  return SAFE_PATH.test(p) && !p.split("/").includes("..");
}

export type Normalised = { path: string } | { why: string };

export function normalisePath(raw: string, home: string): Normalised {
  const given = String(raw ?? "").trim();
  if (!given) return { why: "empty" };
  if (!SAFE_PATH.test(given)) return { why: "has characters the sandbox will not pass on" };
  const expanded = given === "~" ? home : given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
  if (!path.isAbsolute(expanded)) return { why: "not an absolute path" };
  return { path: path.resolve(expanded) };
}

const SYSTEM_DIRS = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/sbin",
  "/sys", "/usr", "/System", "/Library", "/private/etc",
];

/** Why a folder is too wide to be writable, or null if it is narrow enough. */
export function tooBroad(p: string, home: string): string | null {
  if (p === "/") return "the whole filesystem";
  if (p === home) return "your whole home folder";
  if (home.startsWith(p + "/")) return "a folder above your home";
  if (SYSTEM_DIRS.some((d) => p === d || p.startsWith(d + "/"))) return "a system folder";
  return null;
}

function inside(p: string, root: string): boolean {
  return p === root || p.startsWith(root === "/" ? "/" : root + "/");
}

export interface WriteSet {
  /** Folders (and the odd file) a sandboxed command may write, realpath'd, none inside another. */
  writable: string[];
  /** Paths inside a writable folder that stay read-only: the claw's own controls. */
  readOnly: string[];
  /** Configured entries that were dropped, and why — the doctor prints these. */
  skipped: { path: string; why: string }[];
  /** Set when the working folder itself is read-only, saying why. */
  cwdNote: string;
}

/**
 * Which paths a command run from `cwd` may write.
 *
 * The working folder is writable when it is an ordinary folder under home —
 * that is where a build, a commit or an install legitimately writes. It is
 * not when it is home itself, a hidden folder straight under home (autostart
 * entries and shell rc files live there), or outside home: the model picks
 * cwd, so cwd must never be the way to make ~ or /etc writable. Everything
 * is resolved through `real` first, so a symlink cannot smuggle `/` in under
 * an innocent name.
 */
export function planWrites(o: {
  cwd: string;
  configured: readonly string[];
  home: string;
  tmpDirs: readonly string[];
  protectedPaths: readonly string[];
  real: (p: string) => string | null;
}): WriteSet {
  const roots: string[] = [];
  const skipped: { path: string; why: string }[] = [];

  for (const t of o.tmpDirs) {
    const r = o.real(t);
    if (r && isSafePath(r) && !tooBroad(r, o.home)) roots.push(r);
  }

  for (const c of o.configured) {
    const n = normalisePath(c, o.home);
    if ("why" in n) { skipped.push({ path: c, why: n.why }); continue; }
    const r = o.real(n.path);
    if (!r) { skipped.push({ path: c, why: "does not exist" }); continue; }
    const broad = isSafePath(r) ? tooBroad(r, o.home) : "resolves to a path with characters the sandbox will not pass on";
    if (broad) { skipped.push({ path: c, why: broad }); continue; }
    roots.push(r);
  }

  let cwdNote = "";
  const realCwd = o.real(o.cwd);
  if (!realCwd || !isSafePath(realCwd)) {
    cwdNote = "this folder's path has characters the sandbox will not pass on";
  } else if (!roots.some((r) => inside(realCwd, r))) {
    const broad = tooBroad(realCwd, o.home);
    if (broad) cwdNote = `this folder is ${broad}`;
    else if (!inside(realCwd, o.home)) cwdNote = "this folder is outside your home folder";
    else if (path.relative(o.home, realCwd).split("/")[0].startsWith(".")) cwdNote = "this folder is a hidden folder in your home";
    else roots.push(realCwd);
  }

  // Nested entries add nothing to a bind and lengthen every label.
  const unique = [...new Set(roots)];
  const writable = unique.filter((r) => !unique.some((other) => other !== r && inside(r, other)));

  const readOnly: string[] = [];
  for (const p of o.protectedPaths) {
    const r = o.real(p) ?? path.resolve(p);
    if (isSafePath(r) && writable.some((w) => inside(r, w)) && !readOnly.includes(r)) readOnly.push(r);
  }
  return { writable, readOnly, skipped, cwdNote };
}

/**
 * What the claw reads back as configuration or instructions. A sandboxed
 * command running in this install may build and test it, but not rewrite the
 * config that sets the sandbox, the keys, the data dir (history, memory, the
 * schedule) or the workspace, whose SOUL.md and SCHEDULE.md are read as
 * standing orders — write_file guards those with a card; the shell must not
 * be the way round it.
 */
export function protectedPaths(): string[] {
  return [
    CONFIG_FILE,
    path.join(ROOT, ".env"),
    DATA_DIR,
    path.join(ROOT, "workspace"),
    cunningclawMcpPath(),
  ];
}

function assertSafe(paths: readonly string[]): void {
  for (const p of paths) {
    if (!isSafePath(p) || !path.isAbsolute(p)) throw new Error(`sandbox: refusing unsafe path ${JSON.stringify(p)}`);
  }
}

// ---------------------------------------------------------------------------
// Builders — pure.
// ---------------------------------------------------------------------------

export interface BoxSpec {
  writable: readonly string[];
  readOnly: readonly string[];
  network: boolean;
  shell: string;
  command: string;
}

/**
 * The bubblewrap argv. The command is one argument after `-c`, never spliced.
 *
 * Not --unshare-all: that includes the PID namespace, and inside one `ps`,
 * `top` and `pgrep` — auto-approved, and how the claw answers "what is eating
 * my CPU" — see three processes and report a quiet machine. A wrong answer
 * that looks right is worse than a refusal. Sharing PIDs also means no fresh
 * procfs can be mounted, so /proc comes in read-only with the root bind. The
 * rest is unshared; --die-with-parent makes the timeout's kill reach the
 * command, and --new-session stops it pushing keystrokes into a terminal
 * through TIOCSTI. /dev is a fresh minimal one: no disks, no camera. There is
 * no --chdir: with / bound whole, bwrap keeps the cwd it was spawned in, so a
 * working folder whose name the whitelist refuses still runs (read-only).
 */
export function bwrapArgs(o: BoxSpec): string[] {
  assertSafe([...o.writable, ...o.readOnly, o.shell]);
  const a = [
    "--die-with-parent", "--new-session",
    "--unshare-user-try", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
  ];
  if (!o.network) a.push("--unshare-net");
  a.push("--ro-bind", "/", "/", "--dev", "/dev");
  for (const w of o.writable) a.push("--bind", w, w);
  // After the writable binds, so a protected path inside one wins.
  for (const r of o.readOnly) a.push("--ro-bind-try", r, r);
  a.push("--", o.shell, "-c", o.command);
  return a;
}

/**
 * The macOS Seatbelt profile. Later rules override earlier ones, so: allow
 * everything, deny every write, allow writes under the chosen folders minus
 * the protected paths. Network off denies IP but leaves Unix sockets, which
 * is also what an unshared network namespace does on Linux.
 */
export function sbplProfile(o: Pick<BoxSpec, "writable" | "readOnly" | "network">): string {
  assertSafe([...o.writable, ...o.readOnly]);
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") ' +
      '(literal "/dev/dtracehelper") (regex #"^/dev/fd/[0-9]+$") (regex #"^/dev/ttys[0-9]+$"))',
  ];
  for (const w of o.writable) {
    const guards = o.readOnly.filter((r) => inside(r, w));
    lines.push(guards.length
      ? `(allow file-write* (require-all (subpath "${w}")${guards.map((g) => ` (require-not (subpath "${g}"))`).join("")}))`
      : `(allow file-write* (subpath "${w}"))`);
  }
  if (!o.network) lines.push("(deny network*)", "(allow network* (remote unix-socket))");
  return lines.join("\n");
}

export function sandboxExecArgs(o: BoxSpec): string[] {
  assertSafe([o.shell]);
  return ["-p", sbplProfile(o), o.shell, "-c", o.command];
}

// ---------------------------------------------------------------------------
// Detection — injected deps, cached for the running claw.
// ---------------------------------------------------------------------------

export type Engine = "bwrap" | "sandbox-exec";

export interface Detection {
  engine: Engine | null;
  /** Present when engine is null: why there is no sandbox, in the operator's words. */
  why: string;
  /** The fix, or what to expect when there is none. */
  fix: string;
}

export interface DetectDeps {
  host: () => Host;
  hasBin: (bin: string) => Promise<boolean>;
  /** Run the engine once; resolve null on success, or the first line of what went wrong. */
  probe: (file: string, args: string[]) => Promise<string | null>;
}

const BWRAP_FIX = "sudo apt install bubblewrap (Fedora: sudo dnf install bubblewrap; Arch: sudo pacman -S bubblewrap)";
const NO_FIX = "nothing to install — commands run on the host, behind the approval cards";

export const ENGINE_NAME: Record<Engine, string> = { bwrap: "bubblewrap", "sandbox-exec": "sandbox-exec" };

async function realProbe(file: string, args: string[]): Promise<string | null> {
  try {
    await execFileAsync(file, args, { timeout: 5000 });
    return null;
  } catch (err: any) {
    return String(err?.stderr || err?.message || err).trim().split("\n")[0].slice(0, 160) || "failed";
  }
}

const realDeps: DetectDeps = { host, hasBin, probe: realProbe };

/**
 * Is a sandbox usable here? Installed is not enough: bubblewrap needs
 * unprivileged user namespaces, which some kernels and AppArmor policies
 * switch off, so the probe runs the real flags once on `true`.
 */
export async function detectEngine(deps: DetectDeps = realDeps): Promise<Detection> {
  const h = deps.host();
  if (h === "linux") {
    if (!(await deps.hasBin("bwrap"))) return { engine: null, why: "bubblewrap is not installed", fix: BWRAP_FIX };
    const err = await deps.probe("bwrap", bwrapArgs({
      writable: [], readOnly: [], network: true, shell: "/bin/sh", command: "true",
    }));
    if (err) {
      return {
        engine: null,
        why: `bubblewrap is installed but cannot start here (${err})`,
        fix: "unprivileged user namespaces are probably switched off (on Ubuntu 24.04+, AppArmor's bwrap profile allows them); or set sandbox.mode to \"off\"",
      };
    }
    return { engine: "bwrap", why: "", fix: "" };
  }
  if (h === "darwin") {
    if (!(await deps.hasBin("sandbox-exec"))) return { engine: null, why: "sandbox-exec is missing from this Mac", fix: NO_FIX };
    const err = await deps.probe("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
    if (err) return { engine: null, why: `sandbox-exec cannot start here (${err})`, fix: NO_FIX };
    return { engine: "sandbox-exec", why: "", fix: "" };
  }
  if (h === "win32") return { engine: null, why: "Windows has no shell sandbox the claw can use", fix: NO_FIX };
  return { engine: null, why: "this OS has no supported shell sandbox", fix: NO_FIX };
}

let cached: Promise<Detection> | null = null;
let settled: Detection | null = null;

/** The detection for this running claw, probed once. */
export function detect(): Promise<Detection> {
  if (!cached) {
    cached = detectEngine().then((d) => (settled = d));
  }
  return cached;
}

/** Pin the detection (or clear it with null) so a test does not depend on what this machine has installed. */
export function setDetectionForTests(d: Detection | null): void {
  settled = d;
  cached = d ? Promise.resolve(d) : null;
}

// ---------------------------------------------------------------------------
// The decision — pure.
// ---------------------------------------------------------------------------

export type Plan =
  | { kind: "sandboxed"; engine: Engine; file: string; args: string[]; label: string; writes: WriteSet; network: boolean; mode: SandboxMode }
  | { kind: "host"; label: string; why: string; askFirst: boolean }
  | { kind: "refuse"; text: string };

/**
 * One program that opens something in the desktop session. A browser or
 * editor started inside the box inherits a read-only home and dies, often
 * after xdg-open has already exited 0 — a silent failure of a command that is
 * auto-approved today. A single launcher with nothing chained is exempt; the
 * open tool does the same job without a shell.
 */
export function isLauncher(command: string): boolean {
  const c = command.trim();
  if (/[;&|<>`$()\n\r\\]/.test(c)) return false;
  return /^(xdg-open|gio\s+open|gtk-launch|open)\s+\S/.test(c);
}

function show(paths: readonly string[], home: string): string {
  return paths.map((p) => collapseHome(p, home)).join(", ");
}

/**
 * Turn settings, detection and the write set into what actually runs.
 *
 * Every label is a pure function of its inputs — no clock, no counter — so
 * the Ouroboros guard still sees two identical runs as identical.
 */
export function decide(o: {
  settings: SandboxSettings;
  detection: Detection;
  unsandboxed: boolean;
  writes: WriteSet;
  shell: string;
  command: string;
  home: string;
}): Plan {
  const { settings, detection } = o;
  if (settings.mode === "off") {
    const why = 'sandbox.mode is "off" in claw.config.json';
    return { kind: "host", label: `[unsandboxed: ${why}]`, why, askFirst: false };
  }
  if (!detection.engine) {
    if (settings.mode === "required") {
      return {
        kind: "refuse",
        text:
          `Refused: sandbox.mode is "required", but ${detection.why}. Nothing ran. ` +
          `Fix: ${detection.fix} — or the operator can set sandbox.mode to "auto" in claw.config.json.`,
      };
    }
    return { kind: "host", label: `[unsandboxed: ${detection.why} — this ran directly on the host]`, why: detection.why, askFirst: false };
  }
  if (o.unsandboxed) {
    if (settings.mode === "required") {
      return {
        kind: "refuse",
        text:
          'Refused: sandbox.mode is "required", so nothing runs outside the sandbox, not even with approval. ' +
          "Nothing ran. If this must run on the host, the operator can run it in a terminal, or set sandbox.mode " +
          'to "auto" in claw.config.json.',
      };
    }
    const why = "the operator approved running this outside the sandbox";
    return { kind: "host", label: `[unsandboxed: ${why}]`, why, askFirst: true };
  }
  if (settings.mode === "auto" && isLauncher(o.command)) {
    const why = "it launches an app, which has to live in your desktop session";
    return { kind: "host", label: `[unsandboxed: ${why}]`, why, askFirst: false };
  }
  const spec: BoxSpec = {
    writable: o.writes.writable, readOnly: o.writes.readOnly, network: settings.network,
    shell: o.shell, command: o.command,
  };
  const engine = detection.engine;
  const args = engine === "bwrap" ? bwrapArgs(spec) : sandboxExecArgs(spec);
  const label =
    `[sandboxed by ${ENGINE_NAME[engine]} — writes only to: ${show(o.writes.writable, o.home) || "nowhere"}` +
    `${o.writes.cwdNote ? ` (read-only here: ${o.writes.cwdNote})` : ""}; network ${settings.network ? "on" : "off"}]`;
  return { kind: "sandboxed", engine, file: engine, args, label, writes: o.writes, network: settings.network, mode: settings.mode };
}

/** One line for the approval card, so the operator knows what a yes lets loose. */
export function cardNote(plan: Plan, home = os.homedir()): string {
  if (plan.kind === "sandboxed") {
    return `\n\nRuns sandboxed (${ENGINE_NAME[plan.engine]}): it can write only to ${show(plan.writes.writable, home) || "nowhere"}; network ${plan.network ? "on" : "off"}.`;
  }
  if (plan.kind === "host" && plan.askFirst) {
    return "\n\nRuns OUTSIDE the sandbox, directly on this machine: it can write anywhere you can.";
  }
  if (plan.kind === "host") return `\n\nRuns unsandboxed: ${plan.why}.`;
  return "";
}

/**
 * Say so when a failure is the sandbox's doing. Left unexplained, "Read-only
 * file system" sends a model hunting for a different path, a sudo, or a way
 * round — exactly the wrong lesson. The only way out is the card.
 */
export function explainSandboxFailure(output: string, plan: Plan, home = os.homedir()): string {
  if (plan.kind !== "sandboxed") return "";
  if (/^bwrap: |sandbox-exec: |spawn (bwrap|sandbox-exec) ENOENT/m.test(output)) {
    return (
      "\n\n[sandbox] The sandbox itself failed to start, so the command did not run. This is the machine, " +
      "not the command. Tell the operator; `npm run doctor` names the fix."
    );
  }
  const way = plan.mode === "required"
    ? 'sandbox.mode is "required", so there is no way round it from here: tell the operator which folder it ' +
      "needs, so they can add it to sandbox.writable in claw.config.json or run it themselves."
    : "If it genuinely has to, call run_command again with the same command and unsandboxed: true — the " +
      "operator is asked every time, and anything it did before the refusal has already happened. If that " +
      "folder is everyday work, they can add it to sandbox.writable in claw.config.json.";
  if (/Read-only file system|EROFS|Operation not permitted/.test(output)) {
    const guarded = plan.writes.readOnly.length
      ? " (inside those, the claw's own config, .env, data and workspace stay read-only)"
      : "";
    return (
      `\n\n[sandbox] That looks like the sandbox refusing a write, not a fault in the command: it may write only ` +
      `to ${show(plan.writes.writable, home) || "nowhere"}${guarded}. Do not hunt for another path or a workaround. ${way}`
    );
  }
  if (!plan.network && /Could not resolve host|Temporary failure in name resolution|Network is unreachable|EAI_AGAIN|ENOTFOUND|ENETUNREACH/.test(output)) {
    return `\n\n[sandbox] The sandbox has no network (sandbox.network is false), so that failure is the sandbox. ${way}`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// The impure edge tools.ts calls.
// ---------------------------------------------------------------------------

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Configured folders that do not exist yet are created when they are plain
 * folders under home: ~/sites is where the claw builds websites, and a fresh
 * install that has never built one would otherwise fail its first `mkdir -p
 * ~/sites/x` against a read-only home. Hidden ones (caches) are left alone.
 */
function ensureFolders(configured: readonly string[], home: string): void {
  for (const c of configured) {
    const n = normalisePath(c, home);
    if ("why" in n || fs.existsSync(n.path) || tooBroad(n.path, home)) continue;
    if (!inside(n.path, home) || path.relative(home, n.path).split("/").some((s) => s.startsWith("."))) continue;
    try { fs.mkdirSync(n.path, { recursive: true }); } catch { /* reported as skipped */ }
  }
}

export function currentWrites(cwd: string, settings = sandboxSettings(), home = os.homedir()): WriteSet {
  ensureFolders(settings.writable, home);
  return planWrites({
    cwd,
    configured: settings.writable,
    home,
    tmpDirs: [os.tmpdir(), "/tmp"],
    protectedPaths: protectedPaths(),
    real: realOrNull,
  });
}

/** Decide how `command` runs from `cwd`. HARD_DENY has already run; this never relaxes it. */
export async function prepareCommand(o: { command: string; cwd: string; shell?: string; unsandboxed: boolean }): Promise<Plan> {
  const settings = sandboxSettings();
  const home = os.homedir();
  const off: Detection = { engine: null, why: "", fix: "" };
  const detection = settings.mode === "off" ? off : await detect();
  const writes = detection.engine ? currentWrites(o.cwd, settings, home) : { writable: [], readOnly: [], skipped: [], cwdNote: "" };
  const shell = o.shell && isSafePath(o.shell) ? o.shell : "/bin/sh";
  return decide({ settings, detection, unsandboxed: o.unsandboxed, writes, shell, command: o.command, home });
}

/** One clause for the model's self-knowledge. Starts the probe if nothing has yet. */
export function sandboxSummary(): string {
  const s = sandboxSettings();
  if (s.mode === "off") return "shell unsandboxed (sandbox.mode off)";
  if (!settled) {
    void detect();
    return "shell sandbox still being checked";
  }
  return settled.engine
    ? `shell commands run sandboxed (${ENGINE_NAME[settled.engine]}) — pass unsandboxed: true only when one must write outside it`
    : `shell unsandboxed (${settled.why})`;
}

/** The doctor's row: what the shell runs in, and the fix. Probes fresh each time. */
export async function sandboxDoctor(deps: DetectDeps = realDeps): Promise<{ status: "ok" | "warn" | "fail"; line: string }> {
  const s = sandboxSettings();
  if (s.mode === "off") {
    return { status: "warn", line: 'Shell sandbox: off (sandbox.mode is "off") — commands run directly on the host, behind the approval cards' };
  }
  const d = await detectEngine(deps);
  if (!d.engine) {
    return s.mode === "required"
      ? { status: "fail", line: `Shell sandbox: required, but ${d.why} — every shell command will be refused. Fix: ${d.fix}` }
      : { status: "warn", line: `Shell sandbox: none — ${d.why}; commands run unsandboxed until then. Fix: ${d.fix}` };
  }
  const home = os.homedir();
  const w = planWrites({
    cwd: ROOT, configured: s.writable, home, tmpDirs: [os.tmpdir(), "/tmp"],
    protectedPaths: protectedPaths(), real: realOrNull,
  });
  // A folder that does not exist yet is not a mistake (it is created, or
  // bound, once it does); one refused as too broad or oddly named is.
  const refused = w.skipped.filter((k) => k.why !== "does not exist");
  const note = refused.length
    ? ` · ignored in sandbox.writable: ${refused.map((k) => `${k.path} (${k.why})`).join(", ")}`
    : "";
  return {
    status: refused.length ? "warn" : "ok",
    line: `Shell sandbox: ${ENGINE_NAME[d.engine]} (${s.mode}) — commands write only to their own folder, ` +
      `the temp dir and ${s.writable.join(", ") || "no other folders"}; network ${s.network ? "on" : "off"}${note}`,
  };
}
