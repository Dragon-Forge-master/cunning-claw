import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Host = "linux" | "darwin" | "win32" | "other";

let hostOverride: Host | null = null;
let hasBinOverride: ((bin: string) => boolean | Promise<boolean>) | null = null;

/**
 * Detect the OS once, behind a table. A third platform is a new row in
 * INSTALL, not a rewrite of every desktop function.
 */
export function host(): Host {
  if (hostOverride) return hostOverride;
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "other";
}

export function setHostForTests(value: Host | null): void {
  hostOverride = value;
}

export async function hasBin(bin: string): Promise<boolean> {
  if (hasBinOverride) return Boolean(await hasBinOverride(bin));
  try {
    // `which` is not a thing on Windows; `where` is.
    await execFileAsync(host() === "win32" ? "where" : "which", [bin]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows ships PowerShell, so most desktop work needs no install at all —
 * screenshots, clipboard, windows, keystrokes and notifications are all
 * built in. Callers run a script through here rather than hunting for a binary.
 */
export const POWERSHELL = "powershell";

export function psArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];
}

/**
 * Under WSL, process.platform is "linux" but there is usually no X server,
 * audio device or Chrome. Worth saying so plainly rather than failing oddly.
 */
export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(require("node:fs").readFileSync("/proc/version", "utf-8"));
  } catch {
    return false;
  }
}

export function setHasBinForTests(fn: ((bin: string) => boolean | Promise<boolean>) | null): void {
  hasBinOverride = fn;
}

/**
 * How to get a missing binary. Keyed by tool name, then host, so adding
 * Windows later is a column rather than a branch through desktop.ts.
 */
const INSTALL: Record<string, Partial<Record<Host, string>>> = {
  "gnome-screenshot": { linux: "sudo apt install gnome-screenshot" },
  ffmpeg: { linux: "sudo apt install ffmpeg", darwin: "brew install ffmpeg" },
  sips: { darwin: "sips is part of macOS." },
  wmctrl: { linux: "sudo apt install wmctrl" },
  xdotool: { linux: "sudo apt install xdotool" },
  xclip: { linux: "sudo apt install xclip" },
  "notify-send": { linux: "sudo apt install libnotify-bin" },
  pactl: { linux: "sudo apt install pulseaudio-utils" },
  paplay: { linux: "sudo apt install pulseaudio-utils" },
  playerctl: { linux: "sudo apt install playerctl", darwin: "brew install playerctl" },
  "spd-say": { linux: "sudo apt install speech-dispatcher" },
  piper: {
    linux: "run ./setup-voice.sh",
    darwin: "run ./setup-voice.sh",
  },
  screencapture: {
    darwin:
      "screencapture is part of macOS. Grant Screen Recording to your terminal in System Settings → Privacy & Security → Screen Recording.",
  },
  osascript: { darwin: "osascript is part of macOS." },
  pbcopy: { darwin: "pbcopy is part of macOS." },
  pbpaste: { darwin: "pbpaste is part of macOS." },
  afplay: { darwin: "afplay is part of macOS." },
  say: { darwin: "say is part of macOS." },
  "google-chrome": {
    linux: "sudo apt install google-chrome-stable  (or set browser.binary in claw.config.json)",
    darwin: "install Google Chrome, or: brew install --cask google-chrome",
    win32: "install Google Chrome, or: winget install Google.Chrome",
  },
  powershell: { win32: "PowerShell ships with Windows." },
  nircmd: {
    win32: "Windows has no volume CLI. Download nircmd from nirsoft.net and put it on PATH.",
  },
  ffplay: { win32: "winget install Gyan.FFmpeg" },
};

export function installHint(tool: string, forHost: Host = host()): string | undefined {
  return INSTALL[tool]?.[forHost];
}

/** Message that names the missing tool *and* how to get it. Never a silent no-op. */
export function missing(tool: string, forHost: Host = host()): string {
  if (forHost === "other") {
    return `${tool} is not available on this OS. CUNNING CLAW desktop tools support Linux, macOS and Windows.`;
  }
  const hint = installHint(tool, forHost);
  if (hint) return `${tool} is not installed. ${hint}`;
  return `${tool} is not installed.`;
}

export function unsupportedDesktop(): string {
  return "This desktop tool is not supported on this OS. CUNNING CLAW supports Linux, macOS and Windows.";
}
