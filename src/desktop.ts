import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { ToolResultContent } from "./tools.js";

const execFileAsync = promisify(execFile);
const TMP = path.join(os.tmpdir(), "jarvis-shots");

async function has(bin: string): Promise<boolean> {
  try { await execFileAsync("which", [bin]); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

/**
 * Capture the screen (or one window) and return it as an image content block,
 * so Claude can actually look at it. Downscaled first — a raw 4K frame costs
 * far more tokens than it adds detail.
 */
export async function screenshot(target: "screen" | "window" = "screen", windowName?: string):
  Promise<ToolResultContent[]> {
  fs.mkdirSync(TMP, { recursive: true });
  const raw = path.join(TMP, "raw.png");
  const out = path.join(TMP, "shot.png");
  for (const f of [raw, out]) if (fs.existsSync(f)) fs.unlinkSync(f);

  if (target === "window" && windowName) {
    try { await execFileAsync("wmctrl", ["-a", windowName]); } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 600));
  }

  let captured = false;
  if (await has("gnome-screenshot")) {
    try {
      await execFileAsync("gnome-screenshot", target === "window" ? ["-w", "-f", raw] : ["-f", raw],
        { timeout: 15000 });
      captured = fs.existsSync(raw);
    } catch { /* fall through */ }
  }
  if (!captured && (await has("ffmpeg"))) {
    let geom = "1920x1080";
    try {
      const { stdout } = await execFileAsync("xdotool", ["getdisplaygeometry"]);
      geom = stdout.trim().replace(/\s+/g, "x");
    } catch { /* use default */ }
    await execFileAsync("ffmpeg", [
      "-f", "x11grab", "-video_size", geom, "-i", process.env.DISPLAY || ":0",
      "-frames:v", "1", "-y", raw,
    ], { timeout: 20000 });
    captured = fs.existsSync(raw);
  }
  if (!captured) return [{ type: "text", text: "Screen capture failed — no working screenshot tool." }];

  // Downscale to keep the image within a sensible token budget.
  let final = raw;
  if (await has("ffmpeg")) {
    try {
      await execFileAsync("ffmpeg", [
        "-i", raw, "-vf", `scale='min(${config.desktop.maxImageWidth},iw)':-1`, "-y", out,
      ], { timeout: 20000 });
      if (fs.existsSync(out)) final = out;
    } catch { /* keep the original */ }
  }

  const data = fs.readFileSync(final).toString("base64");
  const kb = Math.round(fs.statSync(final).size / 1024);
  return [
    { type: "image", source: { type: "base64", media_type: "image/png", data } },
    { type: "text", text: `[screenshot of ${target === "window" ? windowName ?? "active window" : "the screen"}, ${kb}KB]` },
  ];
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export async function listWindows(): Promise<string> {
  if (!(await has("wmctrl"))) return "wmctrl is not installed.";
  const { stdout } = await execFileAsync("wmctrl", ["-l"]);
  const lines = stdout.trim().split("\n").filter(Boolean).map((l) => {
    const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    return m ? `- ${m[4]}` : `- ${l}`;
  });
  return lines.length ? `Open windows:\n${lines.join("\n")}` : "No windows open.";
}

export async function focusWindow(name: string): Promise<string> {
  if (!(await has("wmctrl"))) return "wmctrl is not installed.";
  try {
    await execFileAsync("wmctrl", ["-a", name]);
    return `Focused window matching "${name}".`;
  } catch {
    return `No window matching "${name}".`;
  }
}

// ---------------------------------------------------------------------------
// Input synthesis
// ---------------------------------------------------------------------------

export async function pressKeys(keys: string): Promise<string> {
  if (!(await has("xdotool"))) return "xdotool is not installed.";
  // xdotool key accepts space-separated chords: "ctrl+s", "alt+Tab", "Return"
  const chords = keys.trim().split(/\s+/);
  await execFileAsync("xdotool", ["key", "--clearmodifiers", ...chords], { timeout: 10000 });
  return `Pressed: ${chords.join(" ")}`;
}

export async function typeOnDesktop(text: string): Promise<string> {
  if (!(await has("xdotool"))) return "xdotool is not installed.";
  await execFileAsync("xdotool", ["type", "--clearmodifiers", "--delay", "12", text], { timeout: 30000 });
  return `Typed ${text.length} characters into the focused window.`;
}

// ---------------------------------------------------------------------------
// Notifications, clipboard, media
// ---------------------------------------------------------------------------

export async function notify(title: string, body: string): Promise<string> {
  if (!(await has("notify-send"))) return "notify-send is not installed.";
  await execFileAsync("notify-send", ["-a", "JARVIS", "-i", "dialog-information", title, body]);
  return `Notification shown: ${title}`;
}

export async function clipboardRead(): Promise<string> {
  if (!(await has("xclip"))) return "xclip is not installed.";
  try {
    const { stdout } = await execFileAsync("bash", ["-c", "xclip -selection clipboard -o"], { timeout: 5000 });
    return stdout ? `Clipboard:\n${stdout.slice(0, 6000)}` : "Clipboard is empty.";
  } catch {
    return "Clipboard is empty or holds non-text data.";
  }
}

export async function clipboardWrite(text: string): Promise<string> {
  if (!(await has("xclip"))) return "xclip is not installed.";
  await new Promise<void>((resolve, reject) => {
    const child = execFile("xclip", ["-selection", "clipboard"], (err) => err ? reject(err) : resolve());
    child.stdin?.end(text);
  });
  return `Copied ${text.length} characters to the clipboard.`;
}

const MEDIA_KEYS: Record<string, string> = {
  play: "XF86AudioPlay", pause: "XF86AudioPlay", playpause: "XF86AudioPlay",
  next: "XF86AudioNext", previous: "XF86AudioPrev", stop: "XF86AudioStop",
};

export async function media(action: string): Promise<string> {
  const key = MEDIA_KEYS[action.toLowerCase()];
  if (!key) return `Unknown media action "${action}".`;
  if (await has("playerctl")) {
    const cmd = action === "previous" ? "previous" : action === "next" ? "next" : "play-pause";
    try {
      await execFileAsync("playerctl", [cmd], { timeout: 5000 });
      return `Media: ${action}`;
    } catch { /* fall back to key synthesis */ }
  }
  if (!(await has("xdotool"))) return "No media control available (install playerctl).";
  await execFileAsync("xdotool", ["key", key], { timeout: 5000 });
  return `Media: ${action} (via ${key})`;
}
