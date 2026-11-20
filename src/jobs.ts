import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";
import { redact } from "./redact.js";

/**
 * Mission control: one list of the long work in flight.
 *
 * Before this, each kind of long work kept its own books — remote jobs in
 * remote-jobs.json, the schedule in SCHEDULE.md, a foreman job in its own
 * report — and the operator had no single place to see what was running, what
 * was waiting on them and what had finished. The registry is that place. It is
 * deliberately dumb: it holds what each piece of work SAYS about itself and
 * broadcasts changes; it never runs anything, and the work that registers
 * stays the authority on its own state.
 *
 * Rules every registrant keeps, because the HUD shows this list and the model
 * reads it through the `jobs` tool:
 *
 *   - The status line is OUR fact about the work ("running — 4 of 40 turns"),
 *     never text the work produced. A foreman job's child writes code from
 *     third-party files; its words go behind a fence in a report that the
 *     result pointer names, and never into this list unfenced.
 *   - The status line does not tick. The Ouroboros guard (coherence.ts) spots
 *     a model re-asking the same question by identical answers; a clock in
 *     here would make every answer different. Progress changes the line;
 *     time passing does not. remote.ts statusText is the model to copy.
 *
 * A leaf: config and redact only. The SSE stream is injected (setEmitter), so
 * nothing here imports server.ts, and tools.ts can import it freely.
 */

export type JobState = "queued" | "running" | "needs-approval" | "done" | "failed" | "cancelled";

export const TERMINAL_STATES: readonly JobState[] = ["done", "failed", "cancelled"];

export interface Job {
  id: string;
  /** What sort of work: "foreman", later "schedule", "research", "shell". */
  kind: string;
  title: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** One line, our own words, non-volatile. */
  status: string;
  /** Where the full result lives, e.g. "foreman:<id>". Never the result itself. */
  result?: string;
  /** Whether the HUD may offer Review: there is a report to read. */
  reviewable?: boolean;
  /**
   * Bumped on every change. A snapshot that arrives late — the reply to a
   * Cancel click, racing the stream event that says the job has already
   * stopped — must not overwrite a newer one, and wall-clock times cannot
   * order two changes in the same millisecond. Never shown, so it cannot
   * make the model's view tick.
   */
  rev: number;
}

export interface RegisterInput {
  kind: string;
  title: string;
  state?: JobState;
  status?: string;
  /** How to stop it. Without one, Cancel says it cannot be stopped from here. */
  cancel?: () => void | Promise<void>;
  id?: string;
}

/** A title is model-chosen and reappears on the glass and in the model's own context. */
export function safeTitle(title: string): string {
  return String(title ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/<\/?(untrusted|recorded)[^>]*>/gi, "")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

/** A status line is one line, short, and has been through redaction. */
export function safeStatus(status: string): string {
  return redact(String(status ?? "").replace(/[\r\n]+/g, " ").trim()).slice(0, 200);
}

const KEEP = 60;

export class JobRegistry {
  private jobs = new Map<string, Job>();
  private cancels = new Map<string, () => void | Promise<void>>();
  private emitter: ((job: Job) => void) | null = null;

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  /** server.ts hands in broadcast; until then, changes are only stored. */
  setEmitter(fn: ((job: Job) => void) | null): void {
    this.emitter = fn;
  }

  register(input: RegisterInput): Job {
    const id = input.id ?? crypto.randomUUID();
    const state = input.state ?? "queued";
    const job: Job = {
      id,
      kind: safeTitle(input.kind).slice(0, 24),
      title: safeTitle(input.title),
      state,
      createdAt: this.now(),
      startedAt: state === "running" ? this.now() : undefined,
      status: safeStatus(input.status ?? state),
      rev: 1,
    };
    this.jobs.set(id, job);
    if (input.cancel) this.cancels.set(id, input.cancel);
    this.changed(job);
    return { ...job };
  }

  /** Attach or replace the stop handler once the work has something to stop. */
  setCancel(id: string, fn: (() => void | Promise<void>) | null): void {
    if (fn) this.cancels.set(id, fn);
    else this.cancels.delete(id);
  }

  update(id: string, patch: Partial<Pick<Job, "state" | "status" | "result" | "reviewable" | "title">>): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    // A finished job stays finished, and the first ending wins. A late
    // progress line from a child still flushing its last bytes must not turn
    // "cancelled" back into "running" on the glass, and the exit that follows
    // a cancel must not relabel it "failed". Only the pointer to the report
    // may still arrive.
    if (TERMINAL_STATES.includes(job.state)) {
      patch = { result: patch.result, reviewable: patch.reviewable };
    }
    const before = JSON.stringify(job);
    if (patch.state) {
      if (patch.state === "running" && !job.startedAt) job.startedAt = this.now();
      if (TERMINAL_STATES.includes(patch.state) && !job.finishedAt) job.finishedAt = this.now();
      job.state = patch.state;
    }
    if (patch.status !== undefined && patch.status !== null) job.status = safeStatus(patch.status);
    if (patch.result !== undefined) job.result = patch.result;
    if (patch.reviewable !== undefined) job.reviewable = patch.reviewable;
    if (patch.title !== undefined) job.title = safeTitle(patch.title);
    if (TERMINAL_STATES.includes(job.state)) this.cancels.delete(id);
    // Identical updates are not news: re-broadcasting them would churn the
    // HUD and the history file for nothing.
    if (JSON.stringify(job) !== before) {
      job.rev += 1;
      this.changed(job);
    }
    return { ...job };
  }

  finish(id: string, state: "done" | "failed" | "cancelled", status: string, result?: string): Job | null {
    return this.update(id, { state, status, ...(result !== undefined ? { result } : {}) });
  }

  get(id: string): Job | null {
    const want = String(id ?? "").trim();
    if (!want) return null;
    const exact = this.jobs.get(want);
    if (exact) return { ...exact };
    // The model and the operator both see the short id; accept it.
    const matches = [...this.jobs.values()].filter((j) => j.id.startsWith(want));
    return matches.length === 1 ? { ...matches[0] } : null;
  }

  /** Newest first. */
  list(): Job[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .map((j) => ({ ...j }));
  }

  canCancel(id: string): boolean {
    const job = this.get(id);
    return !!job && !TERMINAL_STATES.includes(job.state) && this.cancels.has(job.id);
  }

  /**
   * Ask the work to stop. The handler is responsible for finishing the job as
   * cancelled once it really has stopped — the registry does not pretend.
   */
  async cancel(id: string): Promise<{ ok: boolean; message: string }> {
    const job = this.get(id);
    if (!job) return { ok: false, message: `No job "${id}".` };
    if (TERMINAL_STATES.includes(job.state)) return { ok: false, message: `${shortId(job.id)} is already ${job.state}.` };
    const handler = this.cancels.get(job.id);
    if (!handler) return { ok: false, message: `${shortId(job.id)} (${job.kind}) cannot be cancelled from here.` };
    await handler();
    return { ok: true, message: `Asked ${shortId(job.id)} "${job.title}" to stop.` };
  }

  private changed(job: Job): void {
    this.save();
    try { this.emitter?.({ ...job }); } catch { /* the glass is a convenience */ }
  }

  private load(): void {
    if (!this.file) return;
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.file, "utf-8")); } catch { return; }
    if (!Array.isArray(raw)) return;
    for (const r of raw as any[]) {
      if (!r || typeof r.id !== "string" || typeof r.kind !== "string") continue;
      const job: Job = {
        id: r.id, kind: String(r.kind), title: safeTitle(r.title), state: r.state,
        createdAt: Number(r.createdAt) || 0,
        startedAt: r.startedAt ? Number(r.startedAt) : undefined,
        finishedAt: r.finishedAt ? Number(r.finishedAt) : undefined,
        status: safeStatus(r.status), result: typeof r.result === "string" ? r.result : undefined,
        reviewable: r.reviewable === true,
        rev: Number(r.rev) || 1,
      };
      // Work that was in flight when the claw stopped was not watched to the
      // end. Saying "running" would be a lie the operator acts on; the work's
      // own records (a worktree, a box's job dir) still say what happened.
      if (!TERMINAL_STATES.includes(job.state)) {
        job.state = "failed";
        job.finishedAt = job.finishedAt ?? (this.now());
        job.status = "the claw restarted while this was in flight — it was not watched to the end";
        job.rev += 1;
      }
      this.jobs.set(job.id, job);
    }
  }

  private save(): void {
    if (!this.file) return;
    const all = this.list();
    // Bounded: a claw that runs for a year should not carry a year of jobs.
    const keep = [...all.filter((j) => !TERMINAL_STATES.includes(j.state)), ...all.filter((j) => TERMINAL_STATES.includes(j.state)).slice(0, KEEP)];
    for (const j of all) if (!keep.includes(j)) this.jobs.delete(j.id);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(keep, null, 2));
    } catch { /* the in-memory list still serves the HUD */ }
  }
}

export function shortId(id: string): string {
  return String(id).slice(0, 8);
}

/** The model's view. Absolute times only: "3 minutes ago" would tick. */
export function jobsText(list: Job[]): string {
  if (!list.length) return "No jobs on the board.";
  return list
    .map((j) => {
      const at = j.startedAt ?? j.createdAt;
      const when = at ? new Date(at).toISOString().slice(0, 16).replace("T", " ") : "";
      const result = j.result ? ` · result ${j.result}` : "";
      return `${shortId(j.id)} · ${j.kind} · ${j.state} · "${j.title}" — ${j.status}${when ? ` · since ${when}Z` : ""}${result}`;
    })
    .join("\n");
}

/** The one registry the claw runs. Tests build their own with a null file. */
export const jobs = new JobRegistry(path.join(DATA_DIR, "jobs.json"));
