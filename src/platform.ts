import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Host = "linux" | "darwin" | "other";

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
  return "other";
}

export function setHostForTests(value: Host | null): void {
  hostOverride = value;
}

export async function hasBin(bin: string): Promise<boolean> {
  if (hasBinOverride) return Boolean(await hasBinOverride(bin));
  try {
    await execFileAsync("which", [bin]);
    return true;
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
};

export function installHint(tool: string, forHost: Host = host()): string | undefined {
  return INSTALL[tool]?.[forHost];
}

/** Message that names the missing tool *and* how to get it. Never a silent no-op. */
export function missing(tool: string, forHost: Host = host()): string {
  if (forHost === "other") {
    return `${tool} is not available on this OS. JARVIS desktop tools currently support Linux and macOS.`;
  }
  const hint = installHint(tool, forHost);
  if (hint) return `${tool} is not installed. ${hint}`;
  return `${tool} is not installed.`;
}

export function unsupportedDesktop(): string {
  return "This desktop tool is not supported on this OS. JARVIS currently supports Linux and macOS.";
}
