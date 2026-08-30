import path from "node:path";
import { ROOT } from "./config.js";

/**
 * The pure half of the schedule: the format, and what counts as a NEW standing
 * order. Kept in its own leaf module with no imports beyond config so that
 * tools.ts can consult it — schedule.ts imports runTurn from agent.ts, and
 * agent.ts imports tools.ts at module scope, so a direct import would close a
 * tools -> schedule -> agent -> tools cycle through bindings that are read
 * during initialisation.
 */

export const SCHEDULE_FILE = path.join(ROOT, "workspace", "SCHEDULE.md");

export interface ScheduleEntry {
  raw: string;
  enabled: boolean;
  hh: number;
  mm: number;
  days: number[]; // 0=Sun … 6=Sat
  date?: { d: number; mo: number }; // annual: fire only on this day/month
  target: string;
  instruction: string;
}

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
  // Y Gymraeg — the schedule speaks Welsh as a first-class tongue. `08:00:llun-gwe`
  // is not a joke entry; it parses, fires, and is documented in docs/SWYN.md.
  sul: 0, llun: 1, maw: 2, mawrth: 2, mer: 3, mercher: 3,
  iau: 4, gwe: 5, gwener: 5, sad: 6, sadwrn: 6,
};

function parseDays(spec: string): number[] | null {
  const out = new Set<number>();
  for (const part of spec.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const range = part.split("-");
    if (range.length === 2 && range[0] in DAY_NAMES && range[1] in DAY_NAMES) {
      let d = DAY_NAMES[range[0]];
      const end = DAY_NAMES[range[1]];
      for (let i = 0; i < 8; i++) {
        out.add(d);
        if (d === end) break;
        d = (d + 1) % 7;
      }
    } else if (part in DAY_NAMES) {
      out.add(DAY_NAMES[part]);
    } else {
      return null;
    }
  }
  return out.size ? [...out] : null;
}

/**
 * `08:00` · `17:00:fri` · `09:30:mon-fri` · `friday` — and annual dates:
 * `20/04` (fires 09:00) or `09:00:20/04`. Birthdays taught the spellbook
 * about years.
 */
function parseWhen(spec: string): { hh: number; mm: number; days: number[]; date?: { d: number; mo: number } } | null {
  const s = spec.trim().toLowerCase();
  if (s in DAY_NAMES) return { hh: 9, mm: 0, days: [DAY_NAMES[s]] };
  const annual = s.match(/^(?:(\d{1,2}):(\d{2}):)?(\d{1,2})\/(\d{1,2})$/);
  if (annual) {
    const hh = annual[1] ? Number(annual[1]) : 9;
    const mm = annual[2] ? Number(annual[2]) : 0;
    const d = Number(annual[3]);
    const mo = Number(annual[4]);
    if (hh > 23 || mm > 59 || d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    return { hh, mm, days: [0, 1, 2, 3, 4, 5, 6], date: { d, mo } };
  }
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(.+))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  const days = m[3] ? parseDays(m[3]) : [0, 1, 2, 3, 4, 5, 6];
  if (!days) return null;
  return { hh, mm, days };
}

export function parseSchedule(md: string): { entries: ScheduleEntry[]; bad: string[] } {
  const entries: ScheduleEntry[] = [];
  const bad: string[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*schedule:\s*`?([^`|]+)`?\s*\|\s*target:\s*`?([^`|]+)`?\s*\|\s*instruction:\s*(.+)$/);
    if (!m) continue;
    const when = parseWhen(m[2]);
    if (!when) {
      bad.push(line.trim().slice(0, 90));
      continue;
    }
    entries.push({
      raw: line.trim(),
      enabled: m[1].toLowerCase() === "x",
      ...when,
      target: m[3].trim().replace(/`/g, ""),
      instruction: m[4].trim().replace(/^`|`$/g, ""),
    });
  }
  return { entries, bad };
}

/** Identity of an entry, for telling an edit from an addition. */
export function entryKey(e: ScheduleEntry): string {
  return `${e.hh}:${e.mm}|${e.days.join(",")}|${e.instruction.slice(0, 60)}`;
}

/**
 * Which entries in `after` are standing orders that were not already armed?
 *
 * A scheduled entry fires unattended, on its own, forever — so ARMING one is a
 * consequential act even though writing a file usually is not. This is the
 * diff that decides whether a write needs a human: pausing an entry, deleting
 * one, reordering, or editing the prose around them all return nothing, so the
 * schedule-keeper skill's routine work raises no card and approval fatigue is
 * not manufactured. Flipping [ ] to [x] counts — re-arming is arming.
 */
export function newStandingOrders(before: string, after: string): ScheduleEntry[] {
  const armed = (md: string) =>
    new Set(parseSchedule(md).entries.filter((e) => e.enabled).map(entryKey));
  const had = armed(before);
  return parseSchedule(after).entries.filter((e) => e.enabled && !had.has(entryKey(e)));
}
