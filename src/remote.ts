import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config, DATA_DIR } from "./config.js";
import { redact } from "./redact.js";
import { fenceUntrusted } from "./browser-ax.js";

const execFileAsync = promisify(execFile);

/**
 * A second computer.
 *
 * The claw has always been one practitioner on one machine, and that machine
 * has one hard limit the code states to the model itself: run_command WAITS,
 * and reaps at the timeout. Servers, builds, watchers and long scrapes cannot
 * run here at all. A box fixes that — and it is the substrate for the office
 * block, because a worker is a claw on its own machine.
 *
 * Transport is plain ssh, shelled out to the system binary. That is a choice
 * with three reasons behind it, not a shortcut:
 *
 *   - It is universal. A spare PC in the cupboard, an EC2 instance, a GCE VM,
 *     a Hetzner box, Oracle's free tier — all of them speak ssh on port 22.
 *     No provider SDK, no per-cloud adapter, no vendor to be locked to.
 *   - It adds no dependency. The two-runtime-dependency budget holds.
 *   - The private key is read by ssh itself and never enters this process's
 *     memory. Same principle as ${VAR} injection in http.ts: the secret is
 *     used, never seen.
 *
 * The rule the whole safety story rests on: THE MODEL NEVER SUPPLIES A HOST,
 * A USER, OR AN SSH OPTION. Boxes are chosen by id from config. `-o
 * ProxyCommand=...` is local arbitrary code execution, and `-o LocalForward`
 * opens the operator's whole network; neither is reachable if the only thing
 * the model picks is which named box to talk to.
 */

export interface Box {
  id: string;
  label?: string;
  host: string;
  user: string;
  port?: number;
  identityFile?: string;
  workdir: string;
  jobsDir?: string;
  allowSudo?: boolean;
  allowReboot?: boolean;
  note?: string;
}

/** Config is a bare JSON.parse with no schema, so coerce and drop rubbish. */
export function boxes(): Box[] {
  const raw = (config as any).remote?.boxes;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b: any) => b && typeof b.id === "string" && typeof b.host === "string" && typeof b.user === "string")
    .map((b: any) => ({
      id: String(b.id),
      label: b.label ? String(b.label) : undefined,
      host: String(b.host),
      user: String(b.user),
      port: Number(b.port) || 22,
      identityFile: b.identityFile ? String(b.identityFile) : undefined,
      workdir: b.workdir ? String(b.workdir) : `/home/${b.user}`,
      jobsDir: b.jobsDir ? String(b.jobsDir) : undefined,
      allowSudo: b.allowSudo === true,
      allowReboot: b.allowReboot === true,
      note: b.note ? String(b.note) : undefined,
    }));
}

export function remoteEnabled(): boolean {
  return (config as any).remote?.enabled !== false && boxes().length > 0;
}

/** Pick a box by id, or the configured default, or the only one there is. */
export function findBox(id?: string): Box | null {
  const all = boxes();
  if (!all.length) return null;
  const want = String(id ?? "").trim();
  if (want) return all.find((b) => b.id === want) ?? null;
  const dflt = (config as any).remote?.defaultBox;
  if (dflt) return all.find((b) => b.id === dflt) ?? null;
  return all.length === 1 ? all[0] : null;
}

export function noBoxMessage(id?: string): string {
  const all = boxes();
  if (!all.length) {
    return (
      "No remote box is configured. Add one to claw.config.json under remote.boxes " +
      '({ "id": "forge", "host": "…", "user": "…", "identityFile": "~/.ssh/claw_forge", ' +
      '"workdir": "/home/claw/work" }), put the public key in that machine\'s authorized_keys, ' +
      "and run `ssh <user>@<host> true` once by hand so its host key is verified by a person. " +
      "Then `npm run doctor` will check it."
    );
  }
  return `No box called "${id}". Configured: ${all.map((b) => b.id).join(", ")}.`;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * The ssh argv. Fixed options only — nothing here is model-supplied.
 *
 * BatchMode=yes matters more than it looks: without it, an unknown host key or
 * a passphrase prompt blocks forever on a TTY that does not exist, and the
 * tool call hangs until the turn watchdog kills it.
 */
export function sshArgs(box: Box, command: string): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${(config as any).remote?.connectTimeoutSec ?? 10}`,
    // Not accept-new: trust-on-first-use silently deletes the only
    // authentication the operator has OF the server. First contact is a
    // human act, done once, by hand.
    "-o", "StrictHostKeyChecking=yes",
    // A compromised box must not be able to borrow the operator's own keys
    // and walk to every other host they can reach.
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "LogLevel=ERROR",
    "-p", String(box.port ?? 22),
  ];
  if (box.identityFile) args.push("-i", expandHome(box.identityFile));
  args.push(`${box.user}@${box.host}`, "--", command);
  return args;
}

export function scpArgs(box: Box, from: string, to: string): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${(config as any).remote?.connectTimeoutSec ?? 10}`,
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ForwardAgent=no",
    "-P", String(box.port ?? 22),
  ];
  if (box.identityFile) args.push("-i", expandHome(box.identityFile));
  args.push("--", from, to);
  return args;
}

export type Verdict = "auto" | "approve" | "deny";

/**
 * The command floor, applied to the box exactly as it is applied here.
 *
 * classifyCommand is injected rather than imported: tools.ts owns it and
 * imports this module, so importing it back would close a cycle. Same shape as
 * workorder.ts.
 *
 * One deliberate exception. HARD_DENY refuses shutdown/reboot, which is right
 * for the machine under the operator's desk and arguable for a VM they own —
 * rebooting a droplet is cheap and reversible. But it is NOT cheap for the
 * spare box in a cupboard with no remote console, where a failed reboot is a
 * physical trip, and a reboot kills every detached job, which is state the
 * model cannot see. So a box may opt in, and even then the verdict is
 * "approve" and never "auto": a human confirms, having been told what dies.
 * Everything else in the floor is untouched — rm -rf stays denied remotely.
 */
export function classifyRemoteCommand(
  command: string,
  box: Box,
  classify: (c: string) => Verdict,
): { verdict: Verdict; why?: string } {
  const local = classify(command);
  if (local === "deny") {
    const rebootOnly =
      /\b(shutdown|reboot|poweroff|halt)\b/i.test(command) &&
      classify(command.replace(/\b(shutdown|reboot|poweroff|halt)\b/gi, "echo")) !== "deny";
    if (rebootOnly && box.allowReboot) {
      return { verdict: "approve", why: `restarts ${box.id} and kills every job running on it` };
    }
    return { verdict: "deny" };
  }
  if (/\bsudo\b/.test(command) && !box.allowSudo) {
    return { verdict: "deny", why: `sudo is not enabled for ${box.id} (set allowSudo on the box to permit it)` };
  }
  return { verdict: local };
}

/** Run something short and wait for it. */
export async function runOnBox(box: Box, command: string, cwd?: string): Promise<string> {
  const dir = cwd?.trim() || box.workdir;
  const wrapped = `cd ${shQuote(dir)} 2>/dev/null || cd /; ${command}`;
  const timeout = (config as any).remote?.runTimeoutMs ?? 120000;
  try {
    const { stdout, stderr } = await execFileAsync("ssh", sshArgs(box, wrapped), {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return formatRemoteOutput(box, stdout, stderr, 0);
  } catch (err: any) {
    if (err?.killed) {
      return (
        `The command ran for ${timeout}ms on ${box.id} and was stopped. ssh waits for the command ` +
        `to finish, exactly as run_command does locally — for anything long, or anything that serves ` +
        `or watches, use remote_job start instead. That is what a box is for.`
      );
    }
    if (isSshFailure(err)) return sshFailureMessage(box, err);
    return formatRemoteOutput(box, err?.stdout ?? "", err?.stderr ?? "", err?.code ?? 1);
  }
}

function isSshFailure(err: any): boolean {
  const text = String(err?.stderr ?? err?.message ?? "");
  return /Permission denied|Host key verification failed|Could not resolve|Connection (refused|timed out)|No route to host|ssh: /i.test(text);
}

function sshFailureMessage(box: Box, err: any): string {
  const text = String(err?.stderr ?? err?.message ?? "").trim().slice(0, 400);
  let fix = "";
  if (/Host key verification failed|not known/i.test(text)) {
    fix =
      ` Run \`ssh -p ${box.port ?? 22} ${box.user}@${box.host} true\` once by hand and confirm the ` +
      `fingerprint — that first-contact check is deliberately a human act, not something to automate away.`;
  } else if (/Permission denied/i.test(text)) {
    fix =
      ` The key was refused. Check the public half of ${box.identityFile ?? "(no identityFile set)"} ` +
      `is in ${box.user}@${box.host}:~/.ssh/authorized_keys, and that the private key is mode 600.`;
  } else if (/Connection refused|timed out|No route/i.test(text)) {
    fix = ` ${box.host} did not answer on port ${box.port ?? 22}. Is the machine up, and is its firewall open?`;
  }
  return `Could not reach ${box.id} (${box.user}@${box.host}): ${text}${fix}`;
}

/**
 * Everything a box prints is untrusted, and gets redacted first.
 *
 * run_command's local output is deliberately unfenced — a trusted machine
 * talking to itself. A box running `npm install` is not that: a build log is
 * other people's code and other people's READMEs talking, which is precisely
 * the category the fence exists for. Redaction matters too: a deploy log that
 * echoes a token would otherwise land in the model's context in clear.
 */
export function formatRemoteOutput(box: Box, stdout: string, stderr: string, code: number): string {
  const cap = (config as any).remote?.maxOutputChars ?? 20000;
  const body = [
    stdout && `stdout:\n${stdout}`,
    stderr && `stderr:\n${stderr}`,
  ].filter(Boolean).join("\n") || "(no output)";
  const head = `exit ${code} on ${box.id} (${box.user}@${box.host})`;
  return `${head}\n${fenceUntrusted(`remote:${box.id}`, redact(body).slice(0, cap))}`;
}

/** POSIX single-quote, so a path with a space or a quote cannot break out. */
export function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Detached jobs
// ---------------------------------------------------------------------------

/**
 * A job is a directory on the box, not a daemon.
 *
 * Nothing is installed and nothing has to be kept up to date: a job dir plus
 * POSIX sh runs on a Raspberry Pi in a cupboard and on a fresh Ubuntu droplet
 * alike. The directory is the source of truth precisely because it survives
 * this process restarting, the laptop sleeping and the network dropping —
 * which is the entire reason a box exists.
 *
 * The command is never interpolated into the launcher. It is delivered on
 * ssh's stdin and written to a file, so a command containing quotes, newlines
 * or `; rm -rf /` is data the whole way and never becomes syntax.
 */
export function jobsDirFor(box: Box): string {
  return box.jobsDir?.trim() || `${box.workdir.replace(/\/+$/, "")}/.claw-jobs`;
}

export function startJobScript(box: Box, jobDir: string): string {
  const d = shQuote(jobDir);
  const w = shQuote(box.workdir);
  return [
    `set -e`,
    `mkdir -p ${d}`,
    // stdin is the command itself.
    `cat > ${d}/cmd`,
    `date +%s > ${d}/started`,
    // setsid detaches from this ssh session so the job outlives the connection.
    // The runner is a fixed string taking the dir and workdir as arguments —
    // nothing from the command is spliced into it.
    `setsid sh -c 'cd "$2" 2>/dev/null || cd /; sh "$1/cmd" > "$1/out" 2> "$1/err"; echo $? > "$1/exit"; date +%s > "$1/ended"' sh ${d} ${w} </dev/null >/dev/null 2>&1 &`,
    `echo $! > ${d}/pid`,
    `cat ${d}/pid`,
  ].join("\n");
}

export function statusScript(jobDir: string, tailLines = 1): string {
  const d = shQuote(jobDir);
  return [
    `printf 'exit=%s\\n' "$(cat ${d}/exit 2>/dev/null)"`,
    `p="$(cat ${d}/pid 2>/dev/null)"`,
    `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then printf 'alive=1\\n'; else printf 'alive=0\\n'; fi`,
    `printf 'out=%s\\n' "$(wc -c < ${d}/out 2>/dev/null || echo 0)"`,
    `printf 'err=%s\\n' "$(wc -c < ${d}/err 2>/dev/null || echo 0)"`,
    `printf 'last=%s\\n' "$(tail -n ${Number(tailLines) || 1} ${d}/out 2>/dev/null | tr '\\n' ' ')"`,
  ].join("\n");
}

export type JobState = "running" | "finished" | "died" | "unknown";

export interface JobStatus {
  state: JobState;
  exit?: number;
  outBytes: number;
  errBytes: number;
  last: string;
}

/**
 * Liveness is two facts, not one.
 *
 * "No exit file" alone means running; but a job killed by the OOM reaper, a
 * box reboot or a logind reap leaves no exit file either, and its pid is gone.
 * Telling the model that a corpse is "running" makes it wait forever, so that
 * case gets its own name.
 */
export function parseJobStatus(raw: string): JobStatus {
  const field = (k: string) => {
    const m = new RegExp(`^${k}=(.*)$`, "m").exec(raw ?? "");
    return m ? m[1].trim() : "";
  };
  const exitRaw = field("exit");
  const alive = field("alive") === "1";
  const outBytes = Number(field("out")) || 0;
  const errBytes = Number(field("err")) || 0;
  const last = field("last");
  // No recognisable fields means the box answered with something we cannot
  // read — a broken pipe, a login banner, an ssh error on stdout. That is NOT
  // the same as the job having died, and saying "died" would report a crash
  // that never happened.
  if (!raw?.trim() || !/^alive=/m.test(raw)) {
    return { state: "unknown", outBytes, errBytes, last };
  }
  if (exitRaw !== "") {
    return { state: "finished", exit: Number(exitRaw), outBytes, errBytes, last };
  }
  return { state: alive ? "running" : "died", outBytes, errBytes, last };
}

/**
 * Status text that does NOT tick.
 *
 * The Ouroboros guard (agent.ts) stops a loop when a repeated call keeps
 * answering identically, and relaxes when answers change. A free-running clock
 * in here would make every answer different, permanently disabling that
 * detection and handing a wedged job the full poll budget. Bytes-and-last-line
 * is exactly right: a job genuinely producing output earns more polls, and a
 * silent one returns byte-identical text and gets stopped at the limit.
 */
export function statusText(name: string, box: Box, s: JobStatus): string {
  const head = `job ${name} on ${box.id}`;
  if (s.state === "finished") {
    return `${head}: finished, exit ${s.exit}. out ${s.outBytes} bytes, err ${s.errBytes} bytes.` +
      (s.last ? `\nlast: ${s.last}` : "");
  }
  if (s.state === "died") {
    return (
      `${head}: DIED with no exit code — the process is gone and never wrote one. ` +
      `That usually means the box rebooted, the kernel killed it for memory, or the login ` +
      `session was reaped. out ${s.outBytes} bytes, err ${s.errBytes} bytes.` +
      (s.last ? `\nlast: ${s.last}` : "")
    );
  }
  if (s.state === "unknown") return `${head}: could not be read — the box did not answer.`;
  return `${head}: running. out ${s.outBytes} bytes, err ${s.errBytes} bytes.` +
    (s.last ? `\nlast: ${s.last}` : "");
}

/**
 * Is this remote path inside the box's declared workdir?
 *
 * Worth being honest about what this buys. Once a command runs, the model has
 * a shell on that box and can read anything that user can read; no path list
 * changes that. What this genuinely protects is the FILE TRANSFER tools, where
 * there is no shell and the path really is the whole payload — a pull that
 * walks up to ~/.ssh, a push that lands outside the working area.
 */
export function remotePathOk(box: Box, p: string): boolean {
  const raw = String(p ?? "").trim();
  if (!raw) return false;
  // No quotes or newlines: those are argument-injection shapes, not filenames.
  if (/["'\n\r]/.test(raw)) return false;
  const base = box.workdir.replace(/\/+$/, "");
  const abs = raw.startsWith("/") ? raw : `${base}/${raw}`;
  const norm = path.posix.normalize(abs);
  return norm === base || norm.startsWith(base + "/");
}

/** Absolute form of a remote path, resolved against the workdir. */
export function remoteResolve(box: Box, p: string): string {
  const raw = String(p ?? "").trim();
  const base = box.workdir.replace(/\/+$/, "");
  return path.posix.normalize(raw.startsWith("/") ? raw : `${base}/${raw}`);
}

// ---------------------------------------------------------------------------
// The local job index
// ---------------------------------------------------------------------------

/**
 * An index, never the truth.
 *
 * The job directory on the box is authoritative; this file exists so `list`
 * still works when the box is unreachable, and so the watcher knows what it
 * has already reported. Written through redact() because a command line can
 * carry a token, and registered in paths.ts as a sensitive file for the same
 * reason.
 */
export interface JobRecord {
  id: string;
  name: string;
  box: string;
  dir: string;
  command: string;
  startedAt: number;
  lastState?: JobState;
  reportedAt?: number;
}

const INDEX = path.join(DATA_DIR, "remote-jobs.json");

export function loadJobs(): JobRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveJobs(jobs: JobRecord[]): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INDEX, JSON.stringify(jobs.map((j) => ({ ...j, command: redact(j.command) })), null, 2));
  } catch { /* the box is the source of truth; the index is a convenience */ }
}

export function rememberJob(rec: JobRecord): void {
  const jobs = loadJobs().filter((j) => j.id !== rec.id);
  jobs.push(rec);
  saveJobs(jobs);
}

export function findJob(nameOrId: string): JobRecord | null {
  const want = String(nameOrId ?? "").trim();
  if (!want) return null;
  const jobs = loadJobs();
  return jobs.find((j) => j.id === want) ?? jobs.find((j) => j.name === want) ?? null;
}
