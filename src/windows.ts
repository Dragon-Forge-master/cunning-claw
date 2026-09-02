import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { POWERSHELL, psArgs } from "./platform.js";

const execFileAsync = promisify(execFile);

/**
 * Windows desktop control via PowerShell.
 *
 * PowerShell ships with Windows, so screenshots, windows, keystrokes, clipboard
 * and notifications need nothing installed — unlike Linux, where half of this
 * is an apt away. Volume is the exception: Windows has no built-in volume CLI,
 * so it falls back to synthesising the media keys.
 *
 * NOTE: written against the documented PowerShell and .NET APIs but *not* yet
 * exercised on a real Windows machine. The pure logic below (key translation,
 * escaping) is unit-tested; the shell calls are not.
 */

export async function runPs(script: string, timeout = 20000): Promise<string> {
  const { stdout } = await execFileAsync(POWERSHELL, psArgs(script), { timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Single-quoted PowerShell strings escape a quote by doubling it. */
export function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** SendKeys' modifier sigils. */
const MODIFIERS: Record<string, string> = { ctrl: "^", control: "^", alt: "%", shift: "+" };

/** Named keys SendKeys expects in braces. */
const NAMED: Record<string, string> = {
  return: "ENTER", enter: "ENTER", tab: "TAB", esc: "ESC", escape: "ESC",
  backspace: "BACKSPACE", delete: "DEL", del: "DEL", home: "HOME", end: "END",
  pageup: "PGUP", pagedown: "PGDN", up: "UP", down: "DOWN", left: "LEFT",
  right: "RIGHT", space: " ", insert: "INSERT",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

/** Characters SendKeys treats as syntax and therefore must be braced. */
const LITERAL = new Set(["+", "^", "%", "~", "(", ")", "{", "}", "[", "]"]);

/**
 * Translate an xdotool-style chord ("ctrl+s", "alt+Tab") into SendKeys syntax
 * ("^s", "%{TAB}"), so callers use one vocabulary across every platform.
 */
export function chordToSendKeys(chord: string): string {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "";

  let prefix = "";
  let key = parts[parts.length - 1];
  for (const part of parts.slice(0, -1)) {
    const sigil = MODIFIERS[part.toLowerCase()];
    if (sigil) prefix += sigil;
  }

  const named = NAMED[key.toLowerCase()];
  if (named) return `${prefix}{${named}}`;
  if (key.length === 1 && LITERAL.has(key)) return `${prefix}{${key}}`;
  return prefix + key;
}

/** Escape ordinary text so SendKeys types it rather than interpreting it. */
export function escapeSendKeysText(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
}

const SENDKEYS_PRELUDE = "Add-Type -AssemblyName System.Windows.Forms;";

export async function pressKeys(keys: string): Promise<string> {
  const chords = keys.trim().split(/\s+/).filter(Boolean);
  const sequence = chords.map(chordToSendKeys).join("");
  if (!sequence) return "No keys given.";
  await runPs(`${SENDKEYS_PRELUDE}[System.Windows.Forms.SendKeys]::SendWait(${psQuote(sequence)})`);
  return `Pressed: ${chords.join(" ")}`;
}

export async function typeText(text: string): Promise<string> {
  await runPs(`${SENDKEYS_PRELUDE}[System.Windows.Forms.SendKeys]::SendWait(${psQuote(escapeSendKeysText(text))})`, 40000);
  return `Typed ${text.length} characters into the focused window.`;
}

// ---------------------------------------------------------------------------
// Screen and windows
// ---------------------------------------------------------------------------

export function screenshotScript(outPath: string): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
    "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
    "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
    "$g=[System.Drawing.Graphics]::FromImage($bmp);",
    "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
    `$bmp.Save(${psQuote(outPath)},[System.Drawing.Imaging.ImageFormat]::Png);`,
    "$g.Dispose();$bmp.Dispose();",
  ].join("");
}

export async function screenshot(outPath: string): Promise<void> {
  await runPs(screenshotScript(outPath), 30000);
}

/**
 * Primary screen bounds — the same rectangle screenshotScript captures, so a
 * coordinate read off that image converts against the right numbers.
 */
export async function displaySize(): Promise<{ w: number; h: number } | null> {
  const stdout = await runPs(
    "Add-Type -AssemblyName System.Windows.Forms;" +
      "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;" +
      'Write-Output "$($b.Width) $($b.Height)"',
    10000,
  );
  const [w, h] = stdout.trim().split(/\s+/).map(Number);
  return w && h ? { w, h } : null;
}

export async function listWindows(): Promise<string> {
  const stdout = await runPs(
    "Get-Process | Where-Object {$_.MainWindowTitle} | ForEach-Object {$_.MainWindowTitle}",
  );
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => `- ${l}`);
  return lines.length ? `Open windows:\n${lines.join("\n")}` : "No windows open.";
}

export async function focusWindow(name: string): Promise<string> {
  // AppActivate is subject to the foreground lock — a background process may
  // not steal focus, the taskbar button merely flashes — and it reported "ok"
  // for FINDING the window, not for raising it. A claw once told its operator
  // four times that Chrome was focused while nothing on screen moved. The
  // real dance: restore the window, tap Alt (which legally unlocks a
  // foreground change), SetForegroundWindow — then CHECK, and say what
  // actually happened.
  const script = [
    `$sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);` +
      `[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);` +
      `[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();` +
      `[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);';`,
    `$W = Add-Type -MemberDefinition $sig -Name ClawFocus -Namespace Claw -PassThru;`,
    `$p = Get-Process | Where-Object {$_.MainWindowTitle -like ${psQuote("*" + name + "*")}} | Select-Object -First 1;`,
    `if (-not $p) { 'none' } else {`,
    `$h = $p.MainWindowHandle;`,
    `$W::ShowWindow($h, 9) | Out-Null;`, // SW_RESTORE — un-minimise first
    `$W::keybd_event(0x12,0,0,[UIntPtr]::Zero); $W::keybd_event(0x12,0,2,[UIntPtr]::Zero);`, // Alt tap
    `$W::SetForegroundWindow($h) | Out-Null;`,
    `Start-Sleep -Milliseconds 200;`,
    `if ($W::GetForegroundWindow() -eq $h) { 'ok' } else { 'found-not-front' } }`,
  ].join(" ");
  const out = (await runPs(script, 30000)).trim();
  if (out.endsWith("ok")) return `Focused window matching "${name}" — it is in front now.`;
  if (out.endsWith("found-not-front")) {
    return (
      `Found a window matching "${name}" and asked Windows to raise it, but the foreground ` +
      `lock refused — its taskbar button should be flashing. Tell the user one click on it ` +
      `finishes the job; do not claim it is visible.`
    );
  }
  return `No window matching "${name}".`;
}

// ---------------------------------------------------------------------------
// Clipboard, notifications, audio
// ---------------------------------------------------------------------------

export async function clipboardRead(): Promise<string> {
  const out = await runPs("Get-Clipboard -Raw");
  return out.trim() ? `Clipboard:\n${out.slice(0, 6000)}` : "Clipboard is empty.";
}

export async function clipboardWrite(text: string): Promise<string> {
  await runPs(`Set-Clipboard -Value ${psQuote(text)}`);
  return `Copied ${text.length} characters to the clipboard.`;
}

export async function notify(title: string, body: string): Promise<string> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
    "$n=New-Object System.Windows.Forms.NotifyIcon;",
    "$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;",
    `$n.ShowBalloonTip(5000,${psQuote(title)},${psQuote(body)},[System.Windows.Forms.ToolTipIcon]::Info);`,
    "Start-Sleep -Milliseconds 5200;$n.Dispose();",
  ].join("");
  await runPs(script, 12000);
  return `Notification shown: ${title}`;
}

/** Windows exposes no volume CLI, so the media keys are the portable route. */
const VOLUME_KEYS = { up: "{VOLUME_UP}", down: "{VOLUME_DOWN}", mute: "{VOLUME_MUTE}" } as const;

export async function adjustVolume(direction: "up" | "down" | "mute", steps = 1): Promise<string> {
  const key = VOLUME_KEYS[direction];
  const sequence = direction === "mute" ? key : key.repeat(Math.max(1, Math.min(50, steps)));
  await runPs(`${SENDKEYS_PRELUDE}[System.Windows.Forms.SendKeys]::SendWait(${psQuote(sequence)})`);
  return direction === "mute" ? "Toggled mute." : `Volume ${direction} ×${steps}.`;
}

const MEDIA_KEYS: Record<string, string> = {
  play: "{MEDIA_PLAY_PAUSE}", pause: "{MEDIA_PLAY_PAUSE}", playpause: "{MEDIA_PLAY_PAUSE}",
  next: "{MEDIA_NEXT_TRACK}", previous: "{MEDIA_PREV_TRACK}", stop: "{MEDIA_STOP}",
};

export async function media(action: string): Promise<string> {
  const key = MEDIA_KEYS[action.toLowerCase()];
  if (!key) return `Unknown media action "${action}".`;
  await runPs(`${SENDKEYS_PRELUDE}[System.Windows.Forms.SendKeys]::SendWait(${psQuote(key)})`);
  return `Media: ${action}`;
}

/** Play a WAV synchronously — used for Piper output. */
export async function playWav(file: string): Promise<void> {
  await runPs(
    `$p=New-Object System.Media.SoundPlayer ${psQuote(file)};$p.PlaySync();`,
    120000,
  );
}

/** Windows' own speech synthesis, as the fallback when Piper is absent. */
export async function speakSapi(text: string): Promise<void> {
  await runPs(
    `Add-Type -AssemblyName System.Speech;` +
    `$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.Speak(${psQuote(text)});`,
    120000,
  );
}
