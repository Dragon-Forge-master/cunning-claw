import fs from "node:fs";
import path from "node:path";

/**
 * Who the operator is: their name, how to address them, and their town.
 *
 * These used to live only in claw.config.json, so a new owner had to edit a
 * JSON file before the claw stopped calling them "Owner" and reporting
 * Cardiff's weather — and an edited tracked file is exactly what makes `git
 * pull` refuse to update. They now live in the data dir, written by the setup
 * page, and laid over the config at load. The config keeps its defaults for
 * anyone who never runs setup.
 *
 * A leaf: fs and path only, directory injected, so config.ts can import it.
 */

export type Owner = { userName?: string; addressUserAs?: string; weatherPlace?: string };

const FILE = "owner.json";
const MAX = 60;

/** One short line of plain text, or nothing. Newlines and control characters are refused, not kept. */
function field(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || t.length > MAX || /[\u0000-\u001f\u007f`<>]/.test(t)) return undefined;
  return t;
}

export function normaliseOwner(raw: unknown): Owner {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Owner = {};
  for (const k of ["userName", "addressUserAs", "weatherPlace"] as const) {
    const v = field(r[k]);
    if (v) out[k] = v;
  }
  return out;
}

export function loadOwner(dir: string): Owner {
  try {
    return normaliseOwner(JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf-8")));
  } catch {
    return {};
  }
}

/** Merge an update over what is stored; anything invalid is dropped, not saved. */
export function saveOwner(dir: string, update: unknown): Owner {
  const next = { ...loadOwner(dir), ...normaliseOwner(update) };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, FILE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, path.join(dir, FILE));
  return next;
}

/** Lay the owner's details over a loaded config, in place. */
export function applyOwner(
  cfg: { persona: { userName: string; addressUserAs: string }; board?: { weatherPlace?: string } },
  owner: Owner,
): void {
  if (owner.userName) cfg.persona.userName = owner.userName;
  if (owner.addressUserAs) cfg.persona.addressUserAs = owner.addressUserAs;
  if (owner.weatherPlace) cfg.board = { ...(cfg.board ?? {}), weatherPlace: owner.weatherPlace };
}
