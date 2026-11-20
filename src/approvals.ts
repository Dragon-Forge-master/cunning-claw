import crypto from "node:crypto";

/**
 * The approval registry — y llw's bookkeeping. Moved out of server.ts so the
 * rules about where a card goes can be tested: server.ts listens on a port at
 * import, which no unit test can load.
 *
 * Two kinds of card share one registry and one set of buttons, because the
 * skill Learn mode teaches is reading a real card:
 *
 *   - a REAL card is broadcast to the HUD, pushed to Telegram and Discord,
 *     alerted through ntfy, and denied by itself when the timeout runs out;
 *   - a PRACTICE card (Learn mode's practice ground) is broadcast to the HUD
 *     only, carries `practice: true` and the label below, never reaches a
 *     phone line or ntfy (practice cards on the real phone would train the
 *     reflex the course exists to break), has no timeout (WCAG 2.2.1 — a
 *     learner reading slowly must not fail by the clock), and cannot be
 *     answered from a phone.
 *
 * Only server code asks for a practice card: the method is reached through the
 * Learn controller, which only the operator's HUD routes drive. A tool's
 * ToolContext has requestApproval(summary, detail) and nothing else, so no tool
 * and no tool result can raise one. And because a stranger's email can contain
 * any words at all, a REAL card has the practice label's words taken out of it
 * before anyone sees it — text cannot make a real card look like practice.
 */

/** The stripe every practice card carries. A lesson states it; a test holds the HUD and the lesson to it. */
export const PRACTICE_LABEL = "PRACTICE · nothing real will happen";

/** What replaces a practice claim found inside a real card's text. */
export const PRACTICE_CLAIM_REMOVED = "[text claiming this is practice was removed — this card is REAL]";

export type SettledBy = "hud" | "phone" | "timeout" | "cancel";

export interface PracticeDecision {
  approved: boolean;
  scope?: "task";
  /** How long the card was on the glass before the decision — a habituation signal. */
  ms: number;
  by: SettledBy;
}

export interface PhoneLine {
  sendCard(id: string, summary: string, detail: string): void | Promise<unknown>;
  settled(id: string, approved: boolean): void;
}

export interface ApprovalDeps {
  broadcast(event: string, data: unknown): void;
  /** Telegram and Discord: they carry a card with buttons. */
  phones: PhoneLine[];
  /** ntfy: outbound only, it says where to answer and never carries a button. */
  alert: { send(id: string, summary: string): void; settled(id: string): void };
  timeoutMs(): number;
  /** "Allow for this task" on a real card. Never called for a practice card. */
  grantForTask(): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Pending {
  practice: boolean;
  finish(approved: boolean, by: SettledBy, scope?: "task"): void;
}

/**
 * Strip format characters (zero-width joiners, Unicode tags, bidi controls)
 * before looking for the label, so "nothing​real will happen" is still found.
 */
function visible(s: string): string {
  return s.replace(/\p{Cf}/gu, "");
}

const PRACTICE_CLAIMS = [
  /nothing\s+real\s+will\s+happen/gi,
  /\bPRACTICE\s*[·•|:—–-]/g,
  /\bthis\s+is\s+(?:only\s+)?(?:a\s+)?practice\b/gi,
  /\bpractice\s+(?:card|mode|scenario|ground)\b/gi,
];

/** A real card's text with every claim to be practice taken out. */
export function defusePracticeClaim(text: string): string {
  let out = visible(String(text ?? ""));
  for (const re of PRACTICE_CLAIMS) out = out.replace(re, PRACTICE_CLAIM_REMOVED);
  return out;
}

export function createApprovals(deps: ApprovalDeps) {
  const pending = new Map<string, Pending>();
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));

  /** A real card: the HUD, both phone lines, ntfy, and the timeout. */
  function request(summary: string, detail: string): Promise<boolean> {
    const s = defusePracticeClaim(summary);
    const d = defusePracticeClaim(detail);
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      let timer: unknown;
      const finish = (approved: boolean, by: SettledBy, scope?: "task") => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimer(timer);
        // "Allow for this task" widens scope until the turn ends; it never
        // covers an irreversible action (consequence.ts decides that).
        if (approved && scope === "task") deps.grantForTask();
        deps.broadcast("approval_resolved", { id, approved, timedOut: by === "timeout" });
        for (const p of deps.phones) p.settled(id, approved);
        deps.alert.settled(id);
        resolve(approved);
      };
      timer = setTimer(() => finish(false, "timeout"), deps.timeoutMs());
      pending.set(id, { practice: false, finish });
      deps.broadcast("approval_request", { id, summary: s, detail: d });
      for (const p of deps.phones) void p.sendCard(id, s, d);
      deps.alert.send(id, s);
    });
  }

  /**
   * A practice card: the HUD only, labelled, no timeout, no phone. The
   * decision is reported to the practice ground for the mastery check.
   */
  function requestPractice(
    summary: string,
    detail: string,
    onDecision?: (d: PracticeDecision) => void,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const shownAt = now();
      const finish = (approved: boolean, by: SettledBy, scope?: "task") => {
        if (!pending.has(id)) return;
        pending.delete(id);
        deps.broadcast("approval_resolved", { id, approved, timedOut: false, practice: true });
        onDecision?.({ approved, scope, ms: Math.max(0, now() - shownAt), by });
        resolve(approved);
      };
      pending.set(id, { practice: true, finish });
      deps.broadcast("approval_request", { id, summary, detail, practice: true, label: PRACTICE_LABEL });
    });
  }

  /**
   * Settle a card. A phone may answer only the real cards it was sent — a
   * practice id never left the HUD, and a phone that somehow names one is
   * refused rather than trusted.
   */
  function settle(id: string, approved: boolean, opts: { by?: SettledBy; scope?: "task" } = {}): boolean {
    const p = pending.get(String(id ?? ""));
    if (!p) return false;
    const by = opts.by ?? "hud";
    if (p.practice && by === "phone") return false;
    p.finish(Boolean(approved), by, opts.scope === "task" ? "task" : undefined);
    return true;
  }

  /** A new instruction from the operator denies everything pending, practice included. */
  function cancelAll(): number {
    const ids = [...pending.keys()];
    for (const id of ids) pending.get(id)?.finish(false, "cancel");
    return ids.length;
  }

  /** End of practice: its cards go, real ones stay. */
  function cancelPractice(): number {
    const ids = [...pending.entries()].filter(([, p]) => p.practice).map(([id]) => id);
    for (const id of ids) pending.get(id)?.finish(false, "cancel");
    return ids.length;
  }

  return {
    request,
    requestPractice,
    settle,
    cancelAll,
    cancelPractice,
    isPractice: (id: string) => pending.get(id)?.practice === true,
    pendingCount: () => pending.size,
  };
}

export type Approvals = ReturnType<typeof createApprovals>;
