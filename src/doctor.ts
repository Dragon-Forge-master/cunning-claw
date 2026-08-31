import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, DATA_DIR, ROOT } from "./config.js";
import { allowedDeskDevice, eyesSettings } from "./eyes.js";
import { brainHasKey, brainKeyEnv, catalog, envLooksSet, isLocalEndpoint } from "./brain.js";
import { hasBin, host, missing } from "./platform.js";
import { findChromeBinary } from "./browser.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { boxes as remoteBoxes, sshArgs, shQuote, type Box as RemoteBox } from "./remote.js";
import { expandHome } from "./paths.js";

const execFileAsync = promisify(execFile);
import { detect } from "./voice.js";

export type CheckStatus = "ok" | "fail" | "warn";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  /** Essential failures make `cunningclaw doctor` exit non-zero. */
  essential: boolean;
  line: string;
}

export function keyDashboard(envName: string): string {
  if (envName === "ANTHROPIC_API_KEY") return "https://console.anthropic.com/settings/keys";
  if (envName === "OPENROUTER_API_KEY") return "https://openrouter.ai/keys";
  if (envName === "OPENAI_API_KEY") return "https://platform.openai.com/api-keys";
  return "the provider dashboard";
}

function sampleKey(envName: string): string {
  if (envName === "ANTHROPIC_API_KEY") return "sk-ant-...";
  if (envName === "OPENROUTER_API_KEY") return "sk-or-...";
  return "...";
}

/** The first non-local catalog brain — what a fresh install actually needs. */
export function preferredCloudKey(): { envName: string; sample: string; url: string } {
  const cloud = catalog().find((b) => !(b.provider === "openai" && isLocalEndpoint(b.baseUrl)));
  const envName = cloud ? brainKeyEnv(cloud) : "OPENROUTER_API_KEY";
  return { envName, sample: sampleKey(envName), url: keyDashboard(envName) };
}

function mark(status: CheckStatus): string {
  if (status === "ok") return "✓";
  if (status === "warn") return "!";
  return "✗";
}

function row(id: string, status: CheckStatus, essential: boolean, text: string): DoctorCheck {
  return { id, status, essential, line: `${mark(status)} ${text}` };
}

export function nodeMajor(version = process.versions.node): number {
  return Number.parseInt(version.split(".")[0] ?? "0", 10) || 0;
}

/**
 * Exact copy a first-run should print: where the key comes from, and which
 * line to add. Shared by doctor and the boot path.
 */
export function noKeyGuide(): string {
  const key = preferredCloudKey();
  return [
    "CUNNING CLAW has no usable API key, so starting the server would give you a dead assistant.",
    "",
    "Copy the example if you have not already:",
    "  cp .env.example .env",
    "",
    "Then add this line to .env:",
    `  ${key.envName}=${key.sample}`,
    `Get a key: ${key.url}`,
    "",
    "Or point a catalog brain at a local runtime (Ollama on 11434 needs no key)",
    "and pull a model:  ollama pull llama3.1:8b",
    "",
    "Then: npm run doctor && npm run dev",
  ].join("\n");
}

export function checkHistoryJson(raw: string | null, file = "data/history.json"): DoctorCheck {
  if (raw === null) {
    return row("history", "ok", false, `${file} is absent (a fresh start is fine)`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return row(
        "history",
        "fail",
        true,
        `${file} is JSON but not an array — delete it or restore a transcript array`,
      );
    }
    return row("history", "ok", false, `${file} is well-formed JSON (${parsed.length} messages)`);
  } catch {
    return row(
      "history",
      "fail",
      true,
      `${file} is not valid JSON — delete it or restore a backup so the next turn can persist`,
    );
  }
}

async function portFree(port: number, listenHost: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, listenHost);
  });
}

/**
 * Is this box actually reachable, and is its workdir writable?
 *
 * One ssh call answers both, and each failure gets the line that fixes it —
 * an unreachable box with a bare "failed" is the doctor doing nothing useful.
 */
async function probeBox(box: RemoteBox): Promise<{ ok: boolean; line: string }> {
  if (!(await hasBin("ssh"))) return { ok: false, line: `ssh is not installed. ${missing("ssh")}` };
  try {
    const { stdout } = await execFileAsync(
      "ssh",
      sshArgs(box, `test -w ${shQuote(box.workdir)} && echo WRITABLE || echo NOWRITE`),
      { timeout: 12000 },
    );
    if (/NOWRITE/.test(String(stdout))) {
      return { ok: false, line: `reachable, but ${box.user} cannot write to ${box.workdir}` };
    }
    return { ok: true, line: `reachable, ${box.workdir} writable` };
  } catch (err: any) {
    const text = String(err?.stderr ?? err?.message ?? "").trim();
    if (/Host key verification failed|not known/i.test(text)) {
      return { ok: false, line: `host key not verified. Run once by hand: ssh -p ${box.port ?? 22} ${box.user}@${box.host} true` };
    }
    if (/Permission denied/i.test(text)) {
      return { ok: false, line: `key refused — check the public key is in ${box.user}@${box.host}:~/.ssh/authorized_keys` };
    }
    if (/timed out|Connection refused|No route/i.test(text)) {
      return { ok: false, line: `no answer on ${box.host}:${box.port ?? 22} — is the machine up?` };
    }
    return { ok: false, line: text.slice(0, 140) || "unreachable" };
  }
}

// The doctor once kept its own private Chrome finder with no Windows paths in
// it, and told a machine with Chrome visibly running that Chrome was not
// installed. One finder, the real one, shared with the launcher.
async function findChrome(): Promise<string | null> {
  return findChromeBinary();
}

/**
 * Is a running Chrome still accepting DevTools handshakes from any origin?
 *
 * The launch flag is fixed, but ensureBrowser() reuses a Chrome that is already
 * up — so a machine that had the wildcard keeps it until that window closes,
 * and nothing would say so. Probe with a foreign Origin: a refusal is the
 * hardened behaviour, a 101 upgrade means the old flag is still in force.
 * "unknown" covers the ordinary case where no debug port is listening at all.
 */
async function debugPortAcceptsForeignOrigin(
  port: number,
): Promise<"open" | "hardened" | "unknown"> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/devtools/browser",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.from("cunningclaw-probe").toString("base64"),
          Origin: "https://claw-probe.invalid",
        },
      },
      (res) => {
        // Anything but an upgrade means the handshake was turned away.
        resolve(res.statusCode === 101 ? "open" : "hardened");
        res.destroy();
      },
    );
    req.on("upgrade", (_res, socket) => {
      resolve("open");
      socket.destroy();
    });
    req.on("error", () => resolve("unknown"));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve("unknown");
    });
    req.end();
  });
}

async function ollamaUp(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const h = host();

  const major = nodeMajor();
  if (major >= 22) {
    out.push(row("node", "ok", true, `Node.js ${process.versions.node}`));
  } else {
    out.push(row(
      "node",
      "fail",
      true,
      `Node.js ${process.versions.node} is too old — install 22+ from https://nodejs.org`,
    ));
  }

  const envPath = path.join(ROOT, ".env");
  if (fs.existsSync(envPath)) {
    out.push(row("env", "ok", true, `.env present`));
  } else {
    const anyKey = catalog().some(brainHasKey);
    const key = preferredCloudKey();
    out.push(row(
      "env",
      anyKey ? "warn" : "fail",
      !anyKey,
      `.env is missing — cp .env.example .env and add ${key.envName} (${key.url})`,
    ));
  }

  const brains = catalog();
  let anyBrain = false;
  for (const b of brains) {
    const ready = brainHasKey(b);
    if (ready) anyBrain = true;
    if (b.provider === "openai" && isLocalEndpoint(b.baseUrl)) {
      out.push(row(
        `brain-${b.id}`,
        "ok",
        false,
        `Brain ${b.id} (${b.model}) is a local runtime — no API key required`,
      ));
      continue;
    }
    const envName = brainKeyEnv(b);
    if (ready) {
      out.push(row(`brain-${b.id}`, "ok", false, `Brain ${b.id} (${b.model}): ${envName} present`));
    } else if (process.env[envName]?.trim() && !envLooksSet(envName)) {
      out.push(row(
        `brain-${b.id}`,
        "warn",
        false,
        `Brain ${b.id}: ${envName} looks like a placeholder — put a real key in .env`,
      ));
    } else {
      out.push(row(
        `brain-${b.id}`,
        "warn",
        false,
        `Brain ${b.id} has no ${envName} — add ${envName}=... to .env (${keyDashboard(envName)})`,
      ));
    }
  }
  if (!anyBrain) {
    const key = preferredCloudKey();
    out.push(row("brains", "fail", true, noKeyGuide().split("\n")[0] + ` — ${key.url}`));
  } else {
    out.push(row("brains", "ok", true, "At least one brain can run"));
  }

  const piperBin = path.join(ROOT, ".venv", "bin", "piper");
  const modelRel = config.voice.piper.model;
  const modelAbs = path.isAbsolute(modelRel) ? modelRel : path.join(ROOT, modelRel);
  const voice = await detect();
  if (voice.engine === "none") {
    out.push(row(
      "voice",
      "warn",
      false,
      `Voice engine: none — ${voice.detail}`,
    ));
  } else {
    out.push(row("voice", "ok", false, `Voice engine: ${voice.engine} · ${voice.detail}`));
  }
  if (!fs.existsSync(piperBin)) {
    // setup-voice.sh is a bash script; telling a Windows user to run it is a
    // wild goose chase when SAPI already covers them.
    out.push(h === "win32"
      ? row("piper", "ok", false, "Piper not set up — Windows speech synthesis (SAPI) speaks instead")
      : row("piper", "warn", false, `Piper venv missing — run ./setup-voice.sh`));
  } else if (!fs.existsSync(modelAbs)) {
    out.push(row(
      "piper-model",
      "warn",
      false,
      `Piper model missing at ${modelRel} — run ./setup-voice.sh`,
    ));
  }
  const player = h === "darwin" ? "afplay" : config.voice.piper.player;
  if (!(await hasBin(player)) && voice.engine === "piper") {
    out.push(row("player", "warn", false, missing(player)));
  }

  if (await ollamaUp()) {
    out.push(row("ollama", "ok", false, "Ollama reachable on 11434"));
  } else {
    out.push(row(
      "ollama",
      "warn",
      false,
      "Ollama not reachable on 11434 — install from https://ollama.com and run: ollama serve",
    ));
  }

  if (h === "darwin") {
    out.push(await binCheck("screencapture", "screenshot", false));
    out.push(await binCheck("osascript", "osascript", false));
    out.push(await binCheck("pbcopy", "pbcopy", false));
  } else if (h === "linux") {
    const shot = (await hasBin("gnome-screenshot")) || (await hasBin("ffmpeg"));
    out.push(shot
      ? row("screenshot", "ok", false, "Screenshot tool present")
      : row("screenshot", "warn", false, `${missing("gnome-screenshot")} (or ${missing("ffmpeg")})`));
    out.push(await binCheck("xdotool", "xdotool", false));
    out.push(await binCheck("wmctrl", "wmctrl", false));
    out.push(await binCheck("xclip", "xclip", false));
    out.push(await binCheck("pactl", "pactl", false));
  } else if (h === "win32") {
    // The desktop tools on Windows are PowerShell all the way down —
    // screenshots via System.Drawing, keys via SendKeys, clipboard built in.
    out.push((await hasBin("powershell"))
      ? row("desktop", "ok", false, "Desktop tools: PowerShell (screenshots, keys, clipboard) — nothing to install")
      : row("desktop", "warn", false, "powershell.exe not on PATH — desktop tools need it"));
  } else {
    out.push(row("desktop", "warn", false, "Desktop tools support Linux, macOS and Windows — this platform is unknown"));
  }

  const eyes = eyesSettings();
  if (eyes.enabled) {
    const cam = await hasBin("ffmpeg");
    const deviceOk = h === "linux"
      ? allowedDeskDevice(eyes.device, "linux") && fs.existsSync(eyes.device)
      : allowedDeskDevice(eyes.device, h === "darwin" ? "darwin" : "linux");
    if (cam && (h === "darwin" || deviceOk)) {
      out.push(row("eyes", "ok", false, `Butler eyes: ${eyes.device}`));
    } else if (!cam) {
      out.push(row("eyes", "warn", false, `${missing("ffmpeg")} Needed for a webcam glance.`));
    } else {
      out.push(row("eyes", "warn", false, `No webcam at ${eyes.device} — set eyes.device in claw.config.json or plug a camera in`));
    }
  } else {
    out.push(row("eyes", "ok", false, "Butler eyes off (eyes.enabled is not true)"));
  }

  const chrome = await findChrome();
  if (chrome) {
    out.push(row("chrome", "ok", false, `Chrome: ${chrome}`));
  } else {
    out.push(row("chrome", "warn", false, missing("google-chrome")));
  }

  // A Chrome already running from before the origin fix keeps the old flag
  // until it is closed, and ensureBrowser() reuses it rather than relaunching —
  // so the hole would stay open silently on exactly the machines that had it.
  const origins = await debugPortAcceptsForeignOrigin(config.browser.debugPort);
  if (origins === "open") {
    out.push(row(
      "chrome-origins",
      "warn",
      false,
      "Cunning Claw's Chrome is running with the old --remote-allow-origins=* flag, so any " +
        "page could drive its logged-in Gmail/WhatsApp session. Close that Chrome window; " +
        "the next launch drops the flag.",
    ));
  } else if (origins === "hardened") {
    out.push(row("chrome-origins", "ok", false, "Chrome's debug port refuses foreign origins"));
  }

  // Boxes are optional, so every check here warns and none is essential.
  for (const box of remoteBoxes()) {
    const id = `box-${box.id}`;
    const key = box.identityFile ? expandHome(box.identityFile) : "";
    if (key && !fs.existsSync(key)) {
      out.push(row(id, "warn", false, `Box ${box.id}: identity file ${key} is missing`));
      continue;
    }
    if (key) {
      try {
        const mode = fs.statSync(key).mode & 0o777;
        if (mode & 0o077) {
          // ssh refuses a group- or world-readable key with a confusing error;
          // catching it here saves the afternoon that costs.
          const fix = host() === "win32"
            ? `icacls "${key}" /inheritance:r /grant:r "%USERNAME%:R"`
            : `chmod 600 ${key}`;
          out.push(row(id, "warn", false, `Box ${box.id}: ${key} is mode ${mode.toString(8)} — ssh will refuse it. Fix: ${fix}`));
          continue;
        }
      } catch { /* unreadable stat is not worth failing over */ }
    }
    const probe = await probeBox(box);
    out.push(row(id, probe.ok ? "ok" : "warn", false, `Box ${box.id}: ${probe.line}`));
  }

  const { port, host: listenHost } = config.server;
  const free = await portFree(port, listenHost);
  out.push(free
    ? row("port", "ok", true, `Port ${port} on ${listenHost} is free`)
    : row(
      "port",
      "fail",
      true,
      `Port ${port} on ${listenHost} is in use — stop the other process or change server.port in claw.config.json`,
    ));

  const historyFile = path.join(DATA_DIR, "history.json");
  let raw: string | null = null;
  if (fs.existsSync(historyFile)) {
    try { raw = fs.readFileSync(historyFile, "utf-8"); } catch { raw = ""; }
  }
  out.push(checkHistoryJson(raw, "data/history.json"));

  return out;
}

async function binCheck(bin: string, id: string, essential: boolean): Promise<DoctorCheck> {
  if (await hasBin(bin)) return row(id, "ok", essential, `${bin} present`);
  return row(id, essential ? "fail" : "warn", essential, missing(bin));
}

export function hasEssentialFailure(checks: DoctorCheck[]): boolean {
  return checks.some((c) => c.essential && c.status === "fail");
}

export async function main(): Promise<number> {
  console.log(`CUNNING CLAW doctor  ·  ${host()}  ·  ${ROOT}\n`);
  const checks = await runDoctor();
  for (const c of checks) console.log(c.line);
  const failed = hasEssentialFailure(checks);
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log("");
  if (failed) {
    console.log("Essential checks failed. Fix the ✗ lines above before npm run dev.");
    return 1;
  }
  if (warns) console.log(`${warns} optional warning(s). The assistant can still start.`);
  else console.log("All checks passed.");
  return 0;
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] && path.resolve(process.argv[1]) === thisFile;
if (invoked) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(1);
  });
}
