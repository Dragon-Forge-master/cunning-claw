import assert from "node:assert/strict";
import test from "node:test";
import { parseSchedule } from "./schedule.js";

test("parses the claw's own SCHEDULE.md format, exactly as he designed it", () => {
  const md = [
    "- [x] schedule: `08:00:mon-fri` | target: `briefing` | instruction: Gather morning weather.",
    "- [x] schedule: `17:00:fri` | target: `nudge` | instruction: Friday review note.",
    "- [ ] schedule: `12:00:wed` | target: `reminder` | instruction: Stretch.",
    "- [x] schedule: `friday` | target: `nudge` | instruction: Bare day name fires at 09:00.",
    "- [x] schedule: `26:99` | target: `broken` | instruction: nonsense time.",
    "not a schedule line at all",
  ].join("\n");
  const { entries, bad } = parseSchedule(md);
  assert.equal(entries.length, 4);
  assert.equal(bad.length, 1, "the nonsense time is reported, not silently dropped");

  const [briefing, nudge, reminder, bare] = entries;
  assert.deepEqual({ hh: briefing.hh, mm: briefing.mm }, { hh: 8, mm: 0 });
  assert.deepEqual(briefing.days, [1, 2, 3, 4, 5], "mon-fri is the working week");
  assert.equal(briefing.target, "briefing");
  assert.ok(briefing.enabled);

  assert.deepEqual(nudge.days, [5]);
  assert.equal(reminder.enabled, false, "[ ] means paused");
  assert.deepEqual({ hh: bare.hh, mm: bare.mm, days: bare.days }, { hh: 9, mm: 0, days: [5] });
});

test("day ranges wrap and lists mix names and abbreviations", () => {
  const { entries } = parseSchedule(
    "- [x] schedule: `07:30:sat-mon` | target: `t` | instruction: weekend wrap.\n" +
    "- [x] schedule: `10:00:monday,wed,friday` | target: `t` | instruction: mwf.",
  );
  assert.deepEqual([...entries[0].days].sort(), [0, 1, 6], "sat-mon wraps through sunday");
  assert.deepEqual(entries[1].days, [1, 3, 5]);
});

test("no-days spec means every day", () => {
  const { entries } = parseSchedule("- [x] schedule: `06:15` | target: `t` | instruction: daily.");
  assert.equal(entries[0].days.length, 7);
});

test("y Gymraeg: Welsh day names parse and fire as first-class syntax", () => {
  const { entries } = parseSchedule(
    "- [x] schedule: `08:00:llun-gwe` | target: `briefing` | instruction: Bore da.\n" +
    "- [x] schedule: `17:00:gwener` | target: `nudge` | instruction: Gwener.\n" +
    "- [x] schedule: `07:00:sad-llun` | target: `t` | instruction: weekend wrap, yn Gymraeg.",
  );
  assert.deepEqual(entries[0].days, [1, 2, 3, 4, 5], "llun-gwe is the working week");
  assert.deepEqual(entries[1].days, [5], "gwener is Friday");
  assert.deepEqual([...entries[2].days].sort(), [0, 1, 6], "sad-llun wraps through Sunday");
});

test("penblwydd: annual DD/MM dates parse, with and without a time", () => {
  const { entries, bad } = parseSchedule(
    "- [x] schedule: `08:30:20/04` | target: `penblwydd` | instruction: Penblwydd hapus.\n" +
    "- [x] schedule: `25/12` | target: `nadolig` | instruction: Nadolig llawen.\n" +
    "- [x] schedule: `09:00:32/04` | target: `bad` | instruction: no such day.\n" +
    "- [x] schedule: `09:00:20/13` | target: `bad` | instruction: no such month.",
  );
  assert.equal(entries.length, 2, "impossible dates are rejected, real ones parse");
  assert.equal(bad.length, 2);
  assert.deepEqual(entries[0].date, { d: 20, mo: 4 });
  assert.equal(entries[0].hh, 8);
  assert.equal(entries[0].mm, 30);
  assert.deepEqual(entries[1].date, { d: 25, mo: 12 }, "bare DD/MM works");
  assert.equal(entries[1].hh, 9, "bare date defaults to 09:00");
});
