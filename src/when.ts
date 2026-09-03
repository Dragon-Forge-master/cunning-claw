/**
 * A sense of elapsed time — leaf module, no imports.
 *
 * History carries no clocks, so ten minutes and ten hours read identically:
 * the model calls last turn's work "earlier today" and the operator notices.
 * The fix is a wall-clock stamp written into each user message ONCE at
 * storage. Absolute, never relative: a stored "[14:02]" is byte-stable across
 * turns (prompt cache and the Ouroboros guard both need history that does not
 * shimmer), while the volatile system header already says what time it is
 * now — subtraction is the model's job.
 *
 * A long silence also gets said out loud: past half an hour, the next message
 * carries how much time passed, because "the operator went to bed and came
 * back" is context the stamps alone make the model work for.
 */

const GAP_WORTH_NOTING_MS = 30 * 60_000;

export function clockStamp(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[${hh}:${mm}]`;
}

/** "3h 12m" / "42m" — for the gap note only, written once, never recomputed. */
export function humanGap(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h - d * 24}h`;
  return `${h}h ${mins - h * 60}m`;
}

/**
 * Prefix a user message with its clock time, and — after a long silence —
 * with how long that silence was. lastAt null means "first message this
 * process": no gap note, we cannot know.
 */
export function stampUserMessage(text: string, now: Date, lastAt: number | null): string {
  const gap = lastAt !== null && now.getTime() - lastAt >= GAP_WORTH_NOTING_MS
    ? `[${humanGap(now.getTime() - lastAt)} since the previous message] `
    : "";
  return `${gap}${clockStamp(now)} ${text}`;
}
