import fs from "node:fs";
import path from "node:path";

/**
 * How the HUD looks to the person reading it, remembered per install.
 *
 * The first preference is the typeface. The operator reads with dyslexia and
 * asked for OpenDyslexic on 25 Sept; it is vendored under public/fonts (SIL
 * OFL, licence beside it) because the HUD is loopback and must not phone a
 * font host. It is a choice, not the default: the evidence that a special
 * face helps is mixed, and plenty of readers with dyslexia prefer a plain
 * sans. So the switch lives in the header and the choice lives here, in the
 * data dir, so it follows the install across every browser that opens the
 * HUD rather than living in one browser's localStorage.
 *
 * A leaf: fs and path only, directory injected so tests need no DATA_DIR.
 */

export const FONTS = ["standard", "dyslexic"] as const;
export type HudFont = (typeof FONTS)[number];
export type HudPrefs = { font: HudFont };

export const DEFAULT_PREFS: HudPrefs = { font: "standard" };

const FILE = "hud-prefs.json";

/** Anything not recognised falls back to the default, field by field. */
export function normalisePrefs(raw: unknown): HudPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const font = FONTS.includes(r.font as HudFont) ? (r.font as HudFont) : DEFAULT_PREFS.font;
  return { font };
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
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, FILE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, path.join(dir, FILE));
  return next;
}
