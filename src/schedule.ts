import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ROOT } from "./config.js";
import { runTurn, turnInFlight, type AgentEvents } from "./agent.js";

/**
 * Scheduled tasks — the assistant's licence to act unprompted.
 *
 * The format is Cunning Claw's own design (workspace/SCHEDULE.md, maintained
 * by the schedule-keeper skill); this engine reads it exactly as he wrote it:
 *
 *   - [x] schedule: `08:00:mon-fri` | target: `briefing` | instruction: …
 *
 * [x] is enabled, [ ] is paused. The schedule spec is HH:MM (daily),
 * HH:MM:days (mon-fri, mon,wed,sat, full names welcome), or a bare day name
 * (fires at 09:00). The file is re-read every tick, so the claw appending an
 * entry mid-conversation needs no restart. What fires is a normal turn — it
 * journals, it speaks, and anything consequential still raises an approval,
 * exactly as the Law of Schedules in his skill demands.
 */

export interface ScheduleEntry {
  raw: string;
  enabled: boolean;
  hh: number;
  mm: number;
  days: number[]; // 0=Sun … 6=Sat
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

/** `08:00` · `17:00:fri` · `09:30:mon-fri` · `friday` */
function parseWhen(spec: string): { hh: number; mm: number; days: number[] } | null {
  const s = spec.trim().toLowerCase();
  if (s in DAY_NAMES) return { hh: 9, mm: 0, days: [DAY_NAMES[s]] };
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

// ---------------------------------------------------------------------------

const SCHEDULE_FILE = path.join(ROOT, "workspace", "SCHEDULE.md");
const STATE_FILE = path.join(DATA_DIR, "schedule-state.json");

function loadState(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state: Record<string, string>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* a missed dedupe is survivable; a crash here is not worth it */ }
}

function entryKey(e: ScheduleEntry): string {
  return `${e.hh}:${e.mm}|${e.days.join(",")}|${e.instruction.slice(0, 60)}`;
}

export function readSchedule(): { entries: ScheduleEntry[]; bad: string[] } {
  try {
    return parseSchedule(fs.readFileSync(SCHEDULE_FILE, "utf-8"));
  } catch {
    return { entries: [], bad: [] };
  }
}

export function scheduleStatus(): { entries: number; enabled: number; next: string | null } {
  const { entries } = readSchedule();
  const enabled = entries.filter((e) => e.enabled);
  let best: Date | null = null;
  const now = new Date();
  for (const e of enabled) {
    for (let ahead = 0; ahead < 8; ahead++) {
      const d = new Date(now);
      d.setDate(d.getDate() + ahead);
      d.setHours(e.hh, e.mm, 0, 0);
      if (d <= now || !e.days.includes(d.getDay())) continue;
      if (!best || d < best) best = d;
      break;
    }
  }
  return { entries: entries.length, enabled: enabled.length, next: best ? best.toISOString() : null };
}

export function startSchedule(events: AgentEvents): void {
  const boot = readSchedule();
  const st = scheduleStatus();
  console.log(
    boot.entries.length
      ? `  Schedule: ${st.enabled}/${st.entries} task(s) armed${st.next ? ` — next ${new Date(st.next).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}`
      : "  Schedule: no SCHEDULE.md tasks",
  );
  for (const b of boot.bad) console.log(`  Schedule: could not parse — ${b}`);

  setInterval(() => {
    const { entries } = readSchedule(); // live re-read: the claw edits this file
    if (!entries.length) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const state = loadState();
    for (const e of entries) {
      if (!e.enabled) continue;
      if (!e.days.includes(now.getDay())) continue;
      // Fire in the minute it is due, or catch up within the following ten —
      // a busy turn or a restart at 08:00 must not silently eat the briefing.
      const dueMs = new Date(now).setHours(e.hh, e.mm, 0, 0);
      const late = now.getTime() - dueMs;
      if (late < 0 || late > 10 * 60_000) continue;
      const key = entryKey(e);
      if (state[key] === today) continue;
      if (turnInFlight().busy) continue; // retry next tick, still inside the window
      state[key] = today;
      saveState(state);
      void runTurn(
        `[scheduled:${e.target}] ${e.instruction}\n` +
          `(This fired from workspace/SCHEDULE.md — the schedule you keep for Chris. ` +
          `Prepare and inform; anything consequential still needs his approval now.)`,
        events,
        { kind: "user" },
      );
    }
  }, 30_000);
}
