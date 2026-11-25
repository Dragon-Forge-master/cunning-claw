import fs from "node:fs";
import path from "node:path";

/**
 * How the HUD looks to the person reading it, remembered per install.
 *
 * The first preference is the typeface. The operator asked for OpenDyslexic
 * on 25 Sept because it is easier to read; it is vendored under public/fonts (SIL
 * OFL, licence beside it) because the HUD is loopback and must not phone a
 * font host. It is a choice, not the default: the evidence that a special
 * face helps is mixed, and plenty of readers with dyslexia prefer a plain
 * sans. So the switch lives in the header and the choice lives here, in the
 * data dir, so it follows the install across every browser that opens the
 * HUD rather than living in one browser's localStorage.
 *
 * "plain" was added on 20 Nov 2026 when the operator asked for "normal text
 * as well": the HUD's own face is a monospace, which reads as code to most
 * people, and the only alternative was OpenDyslexic. Plain is the system's
 * everyday sans — what every other app on the machine uses.
 *
 * A leaf: fs and path only, directory injected so tests need no DATA_DIR.
 */

export const FONTS = ["standard", "plain", "dyslexic"] as const;
export type HudFont = (typeof FONTS)[number];
/**
 * How fast the claw speaks, as a multiple of the voice as configured. Asked
 * for on 25 November 2026: once approval cards are read aloud, a voice that
 * dawdles is a voice in the way. One number for every engine (src/voice.ts
 * turns it into each engine's own setting), in tenths so the HUD's button can
 * step through it.
 */
export const VOICE_SPEED_MIN = 0.7;
export const VOICE_SPEED_MAX = 1.6;
export function normaliseVoiceSpeed(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n < VOICE_SPEED_MIN - 1e-9 || n > VOICE_SPEED_MAX + 1e-9) return null;
  return Math.round(n * 10) / 10;
}

export type HudPrefs = { font: HudFont; voiceSpeed: number };

export const DEFAULT_PREFS: HudPrefs = { font: "standard", voiceSpeed: 1 };

const FILE = "hud-prefs.json";

/** Anything not recognised falls back to the default, field by field. */
export function normalisePrefs(raw: unknown): HudPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const font = FONTS.includes(r.font as HudFont) ? (r.font as HudFont) : DEFAULT_PREFS.font;
  return { font, voiceSpeed: normaliseVoiceSpeed(r.voiceSpeed) ?? DEFAULT_PREFS.voiceSpeed };
}

export function loadPrefs(dir: string): HudPrefs {
  try {
    return normalisePrefs(JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf-8")));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Merge a partial update over what is stored; unknown values are refused, not saved. */
export function savePrefs(dir: string, update: unknown): HudPrefs {
  const current = loadPrefs(dir);
  const u = (update && typeof update === "object" ? update : {}) as Record<string, unknown>;
  const next: HudPrefs = { ...current };
  if (FONTS.includes(u.font as HudFont)) next.font = u.font as HudFont;
  const speed = normaliseVoiceSpeed(u.voiceSpeed);
  if (speed !== null) next.voiceSpeed = speed;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, FILE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, path.join(dir, FILE));
  return next;
}
