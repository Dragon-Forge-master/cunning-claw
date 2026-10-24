/**
 * When the brain's account runs out of credit, every beat fails the same way.
 * In October that was a failed request, a ⚠ in the HUD and a journal line
 * every thirty minutes, day and night, for three weeks. After a credit failure
 * the heartbeat now waits, doubling from two hours to a twelve-hour cap, says
 * so once, and resumes on its own; a beat that succeeds resets it.
 */
const BACKOFF_START_MS = 2 * 3600_000;
const BACKOFF_CAP_MS = 12 * 3600_000;
export const CREDIT_FAILURE = /out of credit|API 402\b|add more credits|insufficient (credits|balance|quota)/i;

export type Backoff = { pausedUntil: number; nextPauseMs: number };

export function freshBackoff(): Backoff {
  return { pausedUntil: 0, nextPauseMs: BACKOFF_START_MS };
}

/** Should this beat run at `now`? */
export function beatDue(b: Backoff, now: number): boolean {
  return now >= b.pausedUntil;
}

/** Record a beat's outcome; returns the notice to show, if any. */
export function recordBeat(b: Backoff, outcome: { creditFailure: boolean }, now: number): string | null {
  if (!outcome.creditFailure) {
    const wasPaused = b.nextPauseMs > BACKOFF_START_MS;
    b.pausedUntil = 0;
    b.nextPauseMs = BACKOFF_START_MS;
    return wasPaused ? "Heartbeat back to normal: the brain answered again." : null;
  }
  const pause = b.nextPauseMs;
  b.pausedUntil = now + pause;
  b.nextPauseMs = Math.min(pause * 2, BACKOFF_CAP_MS);
  const hours = Math.round(pause / 3600_000);
  return `Heartbeat paused for ${hours}h: the brain's account is out of credit. ` +
    `It tries again on its own; top up the account and it carries on as normal.`;
}
