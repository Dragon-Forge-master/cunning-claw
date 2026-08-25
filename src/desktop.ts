import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { hasBin, host, missing, unsupportedDesktop } from "./platform.js";
import type { ToolResultContent } from "./tools.js";

const execFileAsync = promisify(execFile);
const TMP = path.join(os.tmpdir(), "jarvis-shots");

async function runOsa(script: string): Promise<string> {
  if (!(await hasBin("osascript"))) throw new Error(missing("osascript"));
  return await new Promise<string>((resolve, reject) => {
    const child = execFile("osascript", [], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || "").trim() || "osascript failed"));
      else resolve(stdout.trim());
    });
    child.stdin?.end(script);
  });
}

/** Quote a JS string as an AppleScript string literal. */
export function appleString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  escape: 53,
  esc: 53,
  space: 49,
  backspace: 51,
  delete: 51,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  home: 115,
  end: 119,
  page_up: 116,
  page_down: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

const MOD_MAP: Record<string, string> = {
  ctrl: "command",
  control: "command",
  alt: "option",
  option: "option",
  shift: "shift",
  super: "command",
  meta: "command",
  cmd: "command",
  command: "command",
  win: "command",
};

export interface DarwinChord {
  mods: string[];
  keystroke?: string;
  keyCode?: number;
}

/**
 * Translate an xdotool chord list (`ctrl+s`, `alt+Tab`, `Return`) into
 * System Events AppleScript. Linux ctrl → macOS command, because that is
 * the shortcut the user actually means.
 */
export function parseLinuxChord(chord: string): DarwinChord {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const rawKey = parts.pop() ?? "";
  let mods = parts.map((p) => MOD_MAP[p.toLowerCase()]).filter((m): m is string => Boolean(m));

  // Linux alt+Tab is the app switcher; on macOS that is command+tab.
  if (rawKey.toLowerCase() === "tab" && mods.includes("option") && !mods.includes("command")) {
    mods = mods.map((m) => (m === "option" ? "command" : m));
  }
  mods = [...new Set(mods)];

  const named = KEY_CODES[rawKey.toLowerCase()];
  if (named !== undefined) return { mods, keyCode: named };
  if (rawKey.length === 1) return { mods, keystroke: rawKey.toLowerCase() };
  const symbols: Record<string, string> = { plus: "+", minus: "-", equal: "=", comma: ",", period: "." };
  if (symbols[rawKey.toLowerCase()]) return { mods, keystroke: symbols[rawKey.toLowerCase()] };
  return { mods, keystroke: rawKey };
}

function chordToApple(chord: DarwinChord): string {
  const using = chord.mods.length ? ` using ${chord.mods.map((m) => `${m} down`).join(", ")}` : "";
  if (chord.keyCode !== undefined) return `key code ${chord.keyCode}${using}`;
  return `keystroke ${appleString(chord.keystroke ?? "")}${using}`;
}

export function keysToDarwinScript(keys: string): string {
  const lines = keys.trim().split(/\s+/).filter(Boolean).map((c) => `  ${chordToApple(parseLinuxChord(c))}`);
  return `tell application "System Events"\n${lines.join("\n")}\nend tell`;
}

export function textToDarwinScript(text: string): string {
  const chunks = text.split("\n");
  const lines: string[] = ["tell application \"System Events\""];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]) lines.push(`  keystroke ${appleString(chunks[i])}`);
    if (i < chunks.length - 1) lines.push("  key code 36");
  }
  lines.push("end tell");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

async function captureLinux(raw: string, target: "screen" | "window"): Promise<boolean> {
  if (await hasBin("gnome-screenshot")) {
    try {
      await execFileAsync("gnome-screenshot", target === "window" ? ["-w", "-f", raw] : ["-f", raw], {
        timeout: 15000,
      });
      if (fs.existsSync(raw)) return true;
    } catch { /* fall through */ }
  }
  if (await hasBin("ffmpeg")) {
    let geom = "1920x1080";
    try {
      const { stdout } = await execFileAsync("xdotool", ["getdisplaygeometry"]);
      geom = stdout.trim().replace(/\s+/g, "x");
    } catch { /* use default */ }
    await execFileAsync("ffmpeg", [
      "-f", "x11grab", "-video_size", geom, "-i", process.env.DISPLAY || ":0",
      "-frames:v", "1", "-y", raw,
    ], { timeout: 20000 });
    return fs.existsSync(raw);
  }
  return false;
}

async function captureDarwin(raw: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await hasBin("screencapture"))) return { ok: false, error: missing("screencapture") };
  try {
    await execFileAsync("screencapture", ["-x", raw], { timeout: 20000 });
    if (fs.existsSync(raw) && fs.statSync(raw).size > 0) return { ok: true };
    return {
      ok: false,
      error:
        "Screen capture produced an empty file. Grant Screen Recording to your terminal in System Settings → Privacy & Security → Screen Recording.",
    };
  } catch (err) {
    return {
      ok: false,
      error:
        `Screen capture failed. Grant Screen Recording to your terminal in System Settings → Privacy & Security → Screen Recording. ${(err as Error).message}`,
    };
  }
}

async function downscale(raw: string, out: string): Promise<string> {
  const width = String(config.desktop.maxImageWidth);
  if (await hasBin("ffmpeg")) {
    try {
      await execFileAsync("ffmpeg", [
        "-i", raw, "-vf", `scale='min(${width},iw)':-1`, "-y", out,
      ], { timeout: 20000 });
      if (fs.existsSync(out)) return out;
    } catch { /* keep the original */ }
  }
  if (host() === "darwin" && (await hasBin("sips"))) {
    try {
      await execFileAsync("sips", ["-Z", width, raw, "--out", out], { timeout: 20000 });
      if (fs.existsSync(out)) return out;
    } catch { /* keep the original */ }
  }
  return raw;
}

/**
 * Capture the screen (or one window) and return it as an image content block,
 * so Claude can actually look at it. Downscaled first — a raw 4K frame costs
 * far more tokens than it adds detail.
 */
export async function screenshot(target: "screen" | "window" = "screen", windowName?: string):
  Promise<ToolResultContent[]> {
  if (host() === "other") return [{ type: "text", text: unsupportedDesktop() }];

  fs.mkdirSync(TMP, { recursive: true });
  const raw = path.join(TMP, "raw.png");
  const out = path.join(TMP, "shot.png");
  for (const f of [raw, out]) if (fs.existsSync(f)) fs.unlinkSync(f);

  if (target === "window" && windowName) {
    try { await focusWindow(windowName); } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 600));
  }

  let captured = false;
  if (host() === "darwin") {
    const result = await captureDarwin(raw);
    if (!result.ok) return [{ type: "text", text: result.error ?? missing("screencapture") }];
    captured = true;
  } else {
    captured = await captureLinux(raw, target);
  }

  if (!captured) {
    const hint = host() === "linux"
      ? `${missing("gnome-screenshot")} (or ${installOr("ffmpeg")})`
      : missing("screencapture");
    return [{ type: "text", text: `Screen capture failed — no working screenshot tool. ${hint}` }];
  }

  const final = await downscale(raw, out);
  const data = fs.readFileSync(final).toString("base64");
  const kb = Math.round(fs.statSync(final).size / 1024);
  return [
    { type: "image", source: { type: "base64", media_type: "image/png", data } },
    { type: "text", text: `[screenshot of ${target === "window" ? windowName ?? "active window" : "the screen"}, ${kb}KB]` },
  ];
}

function installOr(tool: string): string {
  return missing(tool).replace(`${tool} is not installed. `, "");
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const LIST_WINDOWS_OSA = `
tell application "System Events"
  set out to ""
  repeat with proc in (application processes whose background only is false)
    try
      repeat with w in windows of proc
        set out to out & name of proc & " — " & name of w & linefeed
      end repeat
    end try
  end repeat
  return out
end tell
`.trim();

function focusWindowOsa(name: string): string {
  return `
tell application "System Events"
  set needle to ${appleString(name)}
  repeat with proc in (application processes whose background only is false)
    if name of proc contains needle then
      set frontmost of proc to true
      return "ok"
    end if
    try
      repeat with w in windows of proc
        if name of w contains needle then
          set frontmost of proc to true
          return "ok"
        end if
      end repeat
    end try
  end repeat
  error "no match"
end tell
`.trim();
}

export async function listWindows(): Promise<string> {
  if (host() === "other") return unsupportedDesktop();
  if (host() === "darwin") {
    try {
      const stdout = await runOsa(LIST_WINDOWS_OSA);
      const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => `- ${l}`);
      return lines.length ? `Open windows:\n${lines.join("\n")}` : "No windows open.";
    } catch (err) {
      return (err as Error).message;
    }
  }
  if (!(await hasBin("wmctrl"))) return missing("wmctrl");
  const { stdout } = await execFileAsync("wmctrl", ["-l"]);
  const lines = stdout.trim().split("\n").filter(Boolean).map((l) => {
    const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    return m ? `- ${m[4]}` : `- ${l}`;
  });
  return lines.length ? `Open windows:\n${lines.join("\n")}` : "No windows open.";
}

export async function focusWindow(name: string): Promise<string> {
  if (host() === "other") return unsupportedDesktop();
  if (host() === "darwin") {
    try {
      await runOsa(focusWindowOsa(name));
      return `Focused window matching "${name}".`;
    } catch (err) {
      const msg = (err as Error).message;
      if (/osascript is not installed/i.test(msg)) return msg;
      return `No window matching "${name}".`;
    }
  }
  if (!(await hasBin("wmctrl"))) return missing("wmctrl");
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
  if (host() === "other") return unsupportedDesktop();
  const chords = keys.trim().split(/\s+/).filter(Boolean);
  if (host() === "darwin") {
    try {
      await runOsa(keysToDarwinScript(keys));
      return `Pressed: ${chords.join(" ")}`;
    } catch (err) {
      return `Could not send keystrokes: ${(err as Error).message}`;
    }
  }
  if (!(await hasBin("xdotool"))) return missing("xdotool");
  await execFileAsync("xdotool", ["key", "--clearmodifiers", ...chords], { timeout: 10000 });
  return `Pressed: ${chords.join(" ")}`;
}

export async function typeOnDesktop(text: string): Promise<string> {
  if (host() === "other") return unsupportedDesktop();
  if (host() === "darwin") {
    try {
      await runOsa(textToDarwinScript(text));
      return `Typed ${text.length} characters into the focused window.`;
    } catch (err) {
      return `Could not type: ${(err as Error).message}`;
    }
  }
  if (!(await hasBin("xdotool"))) return missing("xdotool");
  await execFileAsync("xdotool", ["type", "--clearmodifiers", "--delay", "12", text], { timeout: 30000 });
  return `Typed ${text.length} characters into the focused window.`;
}

// ---------------------------------------------------------------------------
// Notifications, clipboard, media, volume
// ---------------------------------------------------------------------------

export async function notify(title: string, body: string): Promise<string> {
  if (host() === "other") return unsupportedDesktop();
  if (host() === "darwin") {
    try {
      await runOsa(`display notification ${appleString(body)} with title ${appleString(title)}`);
      return `Notification shown: ${title}`;
    } catch (err) {
      return `Could not show a notification: ${(err as Error).message}`;
    }
  }
  if (!(await hasBin("notify-send"))) return missing("notify-send");
  await execFileAsync("notify-send", ["-a", "JARVIS", "-i", "dialog-information", title, body]);
  return `Notification shown: ${title}`;
}

export async function clipboardRead(): Promise<string> {
  if (host() === "other") return unsupportedDesktop();
  if (host() === "darwin") {
    if (!(await hasBin("pbpaste"))) return missing("pbpaste");
    try {
      const { stdout } = await execFileAsync("pbpaste", [], { timeout: 5000 });
      return stdout ? `Clipboard:\n${stdout.slice(0, 6000)}` : "Clipboard is empty.";
    } catch {
      return "Clipboard is empty or holds non-text data.";
    }
  }
  if (!(await hasBin("xclip"))) return missing("xclip");
  try {
    const { stdout } = await execFileAsync("bash", ["-c", "xclip -selection clipboard -o"], { timeout: 5000 });
    return stdout ? `Clipboard:\n${stdout.slice(0, 6000)}` : "Clipboard is empty.";
  } catch {
    return "Clipboard is empty or holds non-text data.";
  }
}

export async function clipboardWrite(text: string): Promise<string> {
  if (host() === "other") return unsupportedDesktop();
  const write = (bin: string, args: string[]) => new Promise<void>((resolve, reject) => {
    const child = execFile(bin, args, (err) => err ? reject(err) : resolve());
    child.stdin?.end(text);
  });
  if (host() === "darwin") {
    if (!(await hasBin("pbcopy"))) return missing("pbcopy");
    await write("pbcopy", []);
    return `Copied ${text.length} characters to the clipboard.`;
  }
  if (!(await hasBin("xclip"))) return missing("xclip");
  await write("xclip", ["-selection", "clipboard"]);
  return `Copied ${text.length} characters to the clipboard.`;
}

const MEDIA_KEYS: Record<string, string> = {
  play: "XF86AudioPlay", pause: "XF86AudioPlay", playpause: "XF86AudioPlay",
  next: "XF86AudioNext", previous: "XF86AudioPrev", stop: "XF86AudioStop",
};

const MEDIA_OSA: Record<string, string> = {
  play: "play",
  pause: "pause",
  playpause: "playpause",
  next: "next track",
  previous: "previous track",
  stop: "pause",
};

export async function media(action: string): Promise<string> {
  if (host() === "other") return unsupportedDesktop();
  const key = MEDIA_KEYS[action.toLowerCase()];
  if (!key) return `Unknown media action "${action}".`;

  if (await hasBin("playerctl")) {
    const cmd = action === "previous" ? "previous" : action === "next" ? "next" : "play-pause";
    try {
      await execFileAsync("playerctl", [cmd], { timeout: 5000 });
      return `Media: ${action}`;
    } catch { /* fall through */ }
  }

  if (host() === "darwin") {
    const osa = MEDIA_OSA[action.toLowerCase()];
    const script = `
set acted to ""
if application "Spotify" is running then
  tell application "Spotify" to ${osa}
  set acted to "Spotify"
else if application "Music" is running then
  tell application "Music" to ${osa}
  set acted to "Music"
end if
if acted is "" then error "no player"
return acted
`.trim();
    try {
      const via = await runOsa(script);
      return `Media: ${action} (via ${via})`;
    } catch (err) {
      const msg = (err as Error).message;
      if (/osascript is not installed/i.test(msg)) return msg;
      if (/no player/i.test(msg)) {
        return `No media player is running. Open Music or Spotify, or ${installOr("playerctl")}.`;
      }
      return `Could not control media: ${msg}`;
    }
  }

  if (!(await hasBin("xdotool"))) return `No media control available. ${missing("playerctl")}`;
  await execFileAsync("xdotool", ["key", key], { timeout: 5000 });
  return `Media: ${action} (via ${key})`;
}

export async function setVolume(input: { level?: number; adjust?: number; mute?: boolean }): Promise<string> {
  if (host() === "other") return unsupportedDesktop();
  if (host() === "darwin") return setVolumeDarwin(input);
  if (!(await hasBin("pactl"))) return missing("pactl");
  try {
    if (typeof input.mute === "boolean") {
      await execFileAsync("pactl", ["set-sink-mute", "@DEFAULT_SINK@", input.mute ? "1" : "0"]);
      return input.mute ? "Muted." : "Unmuted.";
    }
    if (typeof input.level === "number") {
      const lvl = Math.max(0, Math.min(150, input.level));
      await execFileAsync("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${lvl}%`]);
      return `Volume set to ${lvl}%.`;
    }
    if (typeof input.adjust === "number") {
      const sign = input.adjust >= 0 ? "+" : "-";
      await execFileAsync("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${sign}${Math.abs(input.adjust)}%`]);
      return `Volume adjusted by ${input.adjust}%.`;
    }
    const { stdout } = await execFileAsync("pactl", ["get-sink-volume", "@DEFAULT_SINK@"]);
    return stdout.trim();
  } catch (err: any) {
    return `Volume control failed: ${err.message}`;
  }
}

async function setVolumeDarwin(input: { level?: number; adjust?: number; mute?: boolean }): Promise<string> {
  try {
    if (typeof input.mute === "boolean") {
      await runOsa(`set volume ${input.mute ? "with" : "without"} output muted`);
      return input.mute ? "Muted." : "Unmuted.";
    }
    const currentRaw = await runOsa("output volume of (get volume settings)");
    const current = Number.parseInt(currentRaw, 10);
    const now = Number.isFinite(current) ? current : 50;
    if (typeof input.level === "number") {
      const lvl = Math.max(0, Math.min(100, Math.round(input.level)));
      await runOsa(`set volume output volume ${lvl}`);
      return `Volume set to ${lvl}%.`;
    }
    if (typeof input.adjust === "number") {
      const lvl = Math.max(0, Math.min(100, Math.round(now + input.adjust)));
      await runOsa(`set volume output volume ${lvl}`);
      return `Volume adjusted by ${input.adjust}% (now ${lvl}%).`;
    }
    return `Volume is ${now}%.`;
  } catch (err) {
    return `Volume control failed: ${(err as Error).message}`;
  }
}
