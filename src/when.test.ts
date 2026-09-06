import assert from "node:assert/strict";
import test from "node:test";
import { clockStamp, humanGap, stampUserMessage } from "./when.js";

test("stamps are the wall clock, zero-padded", () => {
  assert.equal(clockStamp(new Date(2026, 8, 3, 9, 5)), "[09:05]");
  assert.equal(clockStamp(new Date(2026, 8, 3, 14, 32)), "[14:32]");
});

test("gaps read like a human says them", () => {
  assert.equal(humanGap(42 * 60_000), "42m");
  assert.equal(humanGap(3 * 3_600_000 + 12 * 60_000), "3h 12m");
  assert.equal(humanGap(26 * 3_600_000), "1d 2h");
});

test("a quick reply gets a stamp but no silence note", () => {
  const now = new Date(2026, 8, 3, 14, 32);
  const fiveMinAgo = now.getTime() - 5 * 60_000;
  assert.equal(stampUserMessage("carry on", now, fiveMinAgo), "[14:32] carry on");
});

test("half an hour of silence gets said out loud", () => {
  const now = new Date(2026, 8, 3, 14, 32);
  const longAgo = now.getTime() - (3 * 3_600_000 + 12 * 60_000);
  assert.equal(
    stampUserMessage("I'm back", now, longAgo),
    "[3h 12m since the previous message] [14:32] I'm back",
  );
});

test("the first message of a process never invents a gap", () => {
  // After a restart we cannot know how long the silence was; a made-up
  // number would be a lie in the transcript, so null means stamp only.
  const now = new Date(2026, 8, 3, 9, 0);
  assert.equal(stampUserMessage("morning", now, null), "[09:00] morning");
});

test("a heartbeat between two operator messages does not shrink the silence", () => {
  // The claw pulses every thirty minutes. If that pulse counted as the
  // previous message, an operator away for three hours would be told "30m
  // since the previous message" on their return. agent.ts passes null for a
  // heartbeat turn and leaves lastMessageAt alone; this pins both halves.
  const t0 = new Date("2026-09-06T09:00:00").getTime();
  const later = new Date("2026-09-06T12:00:00");
  assert.doesNotMatch(stampUserMessage("[heartbeat]", later, null), /since the previous message/);
  assert.equal(stampUserMessage("morning", later, t0), "[3h 0m since the previous message] [12:00] morning");
});
