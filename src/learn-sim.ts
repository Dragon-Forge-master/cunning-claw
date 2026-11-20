import fs from "node:fs";
import path from "node:path";
import { fenceUntrusted } from "./browser-ax.js";
import { cardAfterInjection, raiseInjectionAlarm, screenOutput, type Signal } from "./injection.js";
import { isUntrustedToolName } from "./routing.js";
import { newStandingOrders } from "./schedule-format.js";
import {
  armingCardSummary,
  classifyCommand,
  executeTool,
  FLOOR_REFUSAL,
  practiceSimulatorActive,
  SYNTHETIC_INPUT_RE,
  sendEmailStep,
  type ToolContext,
  type ToolOutput,
} from "./tools.js";
import type { PracticeDecision } from "./approvals.js";
import type { ScenarioResult } from "./learn-format.js";

/**
 * The practice ground: real HUD, real cards, real fence, real scanner, real
 * floor — fake world.
 *
 * A scenario is a fixture (an inbox, a few documents, a standing-order book)
 * and a short script of tool calls, "beats", that the practice claw makes.
 * Every beat goes through executeTool, the same chokepoint a real turn uses,
 * with the simulator below installed in front of every real tool. What comes
 * back is then screened exactly as agent.ts screens a real result, so the
 * injection warning, the turn alarm and the reworded card the learner sees
 * are the product's own, not a mock-up of them. A card is built by the real
 * card code — sendEmailStep, classifyCommand, armingCardSummary — and raised
 * as a practice card, so the decision skill transfers.
 *
 * What the simulator will never do is run anything. A tool with no fixture
 * gets one fixed sentence (fixed, so the Ouroboros guard can still recognise
 * a model re-asking — CLAUDE.md, status text is non-volatile). run_command is
 * classified, never executed. send_email is carded, never sent. A standing
 * order is armed in the fixture book, never in workspace/SCHEDULE.md.
 * memory_save writes data/learn/practice-memory.json, never real memory.
 *
 * T14 (docs/LEARN-MODE.md): fixture text is untrusted like any other outside
 * text — it is fenced with fenceUntrusted and scanned by injection.ts, and
 * the tool names are the real ones, which routing.ts already counts as
 * untrusted, so a practice turn on a model is pinned to a trusted brain too.
 */

export const PRACTICE_REFUSED =
  "Not available in practice: this tool has no practice fixture, so it was not run. Nothing real happened.";
export const PRACTICE_SENT =
  "PRACTICE · approved. For real, the email would now be sent. Here nothing left this machine.";
export const PRACTICE_RAN =
  "PRACTICE · approved. For real, this command would now run in the sandbox. Here nothing ran.";
export const PRACTICE_FREE =
  "PRACTICE · this command is on the free list, so for real it would run without a card. Here nothing ran.";
export const PRACTICE_ARMED =
  "PRACTICE · approved. The standing order is armed in the practice book only — workspace/SCHEDULE.md was not touched.";
export const PRACTICE_SANDBOX_NOTE =
  "\n\n[Practice ground: the sandbox is simulated here, and nothing will run whatever you choose.]";

export type Layer = "floor" | "card" | "free";

export interface Email {
  from: string;
  to?: string;
  subject: string;
  date: string;
  body: string;
}

export interface BeatStep {
  tool: string;
  input: Record<string, unknown>;
}

export interface Beat {
  id: string;
  /** What the practice claw says it is doing — shown above the result. */
  say?: string;
  steps: BeatStep[];
  /** A card beat: what the key says the learner should press. */
  expect?: "approve" | "deny";
  critical?: boolean;
  /** A predict beat: the learner says which layer stops it before it runs. */
  predict?: boolean;
  /** Blameless, task-focused (T9): what the card actually said. */
  debrief?: string;
}

export interface Scenario {
  id: string;
  levels: number[];
  title: string;
  brief: string;
  tools: string[];
  inbox: Email[];
  files: Record<string, string>;
  schedule: string;
  variants: Record<string, string>[];
  /** Beat ids whose order rotates between attempts, so card position is no clue. */
  rotate: string[];
  beats: Beat[];
  report?: { prompt: string; options: { text: string; signal: Signal | "none" }[]; critical?: boolean };
  /** Score needed to pass, 0..1. Critical beats must be right whatever the score. */
  pass: number;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Read learn/scenarios/<id>/scenario.json. Throws on a malformed fixture — a fixture is code, not data. */
export function loadScenario(root: string, id: string): Scenario {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad scenario id: ${id}`);
  const dir = path.join(root, "scenarios", id);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "scenario.json"), "utf-8"));
  const files: Record<string, string> = { ...(raw.files ?? {}) };
  const filesDir = path.join(dir, "files");
  if (fs.existsSync(filesDir)) {
    for (const f of fs.readdirSync(filesDir)) files[f] = fs.readFileSync(path.join(filesDir, f), "utf-8");
  }
  const beats: Beat[] = (raw.beats ?? []).map((b: any) => ({
    id: String(b.id),
    say: b.say ? String(b.say) : undefined,
    steps: Array.isArray(b.steps) ? b.steps.map((s: any) => ({ tool: String(s.tool), input: s.input ?? {} })) : [],
    expect: b.expect === "approve" || b.expect === "deny" ? b.expect : undefined,
    critical: b.critical === true,
    predict: b.predict === true,
    debrief: b.debrief ? String(b.debrief) : undefined,
  }));
  return {
    id: String(raw.id ?? id),
    levels: Array.isArray(raw.levels) ? raw.levels.map(Number) : [],
    title: String(raw.title ?? id),
    brief: String(raw.brief ?? ""),
    tools: strings(raw.tools),
    inbox: Array.isArray(raw.inbox) ? raw.inbox : [],
    files,
    schedule: typeof raw.schedule === "string" ? raw.schedule : "",
    variants: Array.isArray(raw.variants) && raw.variants.length ? raw.variants : [{}],
    rotate: strings(raw.rotate),
    beats,
    report: raw.report,
    pass: typeof raw.pass === "number" ? raw.pass : 0.8,
  };
}

function fill(v: unknown, vars: Record<string, string>): any {
  if (typeof v === "string") return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

/**
 * The scenario as this attempt sees it: a different variant's wording and a
 * different card order each time. Repeated warnings habituate and varied ones
 * resist it (Anderson et al. 2016), so a learner on their third go must read
 * the card again rather than remember which position the bad one was in.
 */
export function forAttempt(s: Scenario, attempt: number): Scenario {
  const vars = s.variants[((attempt % s.variants.length) + s.variants.length) % s.variants.length];
  const filled: Scenario = fill(s, vars);
  if (filled.rotate.length > 1) {
    const order = filled.rotate.filter((id) => filled.beats.some((b) => b.id === id));
    const k = attempt % order.length;
    const rotated = [...order.slice(k), ...order.slice(0, k)];
    const byId = new Map(filled.beats.map((b) => [b.id, b]));
    let i = 0;
    filled.beats = filled.beats.map((b) => (order.includes(b.id) ? byId.get(rotated[i++])! : b));
  }
  return filled;
}

export interface SimDeps {
  /** A practice card (approvals.ts requestPractice). Never the real one. */
  requestPractice(summary: string, detail: string, onDecision: (d: PracticeDecision) => void): Promise<boolean>;
  /** data/learn/practice-memory.json — never data/memory.json. */
  practiceMemoryFile: string;
}

export interface SimState {
  compose: { to: string; subject: string; body: string } | null;
  schedule: string;
  /** Every signal the real scanner found in this run's fixture text. */
  signals: Set<string>;
  /** Card decisions, in order, tagged with the beat that raised them. */
  decisions: { beat: string; summary: string; decision: PracticeDecision }[];
  beat: string;
  readOutside: boolean;
}

/**
 * The simulator: one function, installed at executeTool with
 * setPracticeSimulator, that answers every tool call while a scenario runs.
 * The agent's own requestApproval in `ctx` is never called — a practice card
 * is always raised through deps.requestPractice, so a model-driven practice
 * turn cannot produce a real card either.
 */
export function createSimulator(scenario: Scenario, deps: SimDeps) {
  const state: SimState = {
    compose: null,
    schedule: scenario.schedule,
    signals: new Set(),
    decisions: [],
    beat: "free",
    readOutside: false,
  };

  const allowed = new Set(scenario.tools);

  function practiceCtx(ctx: ToolContext): ToolContext {
    return {
      emit: ctx.emit,
      tainted: () => state.readOutside || Boolean(ctx.tainted?.()),
      requestApproval: (summary, detail) => {
        // The same rewording agent.ts applies after injected text was read.
        const card = cardAfterInjection(summary, detail);
        const beat = state.beat;
        return deps.requestPractice(card.summary, card.detail, (decision) => {
          state.decisions.push({ beat, summary: card.summary, decision });
        });
      },
    };
  }

  function email(i: unknown): Email | undefined {
    const n = Math.max(1, Math.round(Number(i) || 1));
    return scenario.inbox[n - 1];
  }

  async function execute(name: string, input: any, ctx: ToolContext): Promise<ToolOutput> {
    if (!allowed.has(name)) return PRACTICE_REFUSED;
    const pctx = practiceCtx(ctx);
    switch (name) {
      case "check_email": {
        state.readOutside = true;
        const lines = scenario.inbox.map((m, i) =>
          `${i + 1}. From: ${m.from} · Subject: ${m.subject} · ${m.date}\n   ${m.body.replace(/\s+/g, " ").slice(0, 110)}…`);
        return fenceUntrusted("practice inbox", `${scenario.inbox.length} conversation(s)\n${lines.join("\n")}`);
      }
      case "read_email": {
        const m = email(input?.index);
        if (!m) return "No such conversation in the practice inbox.";
        state.readOutside = true;
        return fenceUntrusted(
          "practice email",
          `From: ${m.from}\nTo: ${m.to ?? "you"}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body}`,
        );
      }
      case "read_document": {
        const base = path.basename(String(input?.path ?? ""));
        const text = scenario.files[base];
        if (text === undefined) return `No practice document named ${base}.`;
        state.readOutside = true;
        return fenceUntrusted(`practice document ${base}`, text);
      }
      case "draft_email": {
        state.compose = {
          to: String(input?.to ?? ""),
          subject: String(input?.subject ?? ""),
          body: String(input?.body ?? ""),
        };
        return "Drafted in the practice compose window. Nothing was sent.";
      }
      case "send_email": {
        // The real send step, card and all, with the compose window and the
        // send itself replaced by the fixture: the card text is the product's.
        return await sendEmailStep(input, pctx, {
          peek: async () => (state.compose ? { open: true, ...state.compose } : { open: false, to: "", subject: "", body: "" }),
          send: async () => PRACTICE_SENT,
        });
      }
      case "run_command": {
        const command = String(input?.command ?? "");
        // The floor is the lesson, so it is the real one: same check, same words.
        const verdict = classifyCommand(command);
        if (verdict === "deny") return FLOOR_REFUSAL;
        if (SYNTHETIC_INPUT_RE.test(command)) {
          const ok = await pctx.requestApproval(
            "Inject keystrokes/clicks into the focused window — this can type into and submit ANYTHING, including messengers",
            command + PRACTICE_SANDBOX_NOTE,
          );
          return ok ? PRACTICE_RAN : "The user declined the synthetic input.";
        }
        if (verdict === "auto") return PRACTICE_FREE;
        const ok = await pctx.requestApproval("Run shell command", command + PRACTICE_SANDBOX_NOTE);
        return ok ? PRACTICE_RAN : "The user declined to run this command.";
      }
      case "write_file":
      case "edit_file": {
        const p = String(input?.path ?? "");
        if (!/(^|[/\\])SCHEDULE\.md$/.test(p)) return PRACTICE_REFUSED;
        const next = name === "edit_file"
          ? state.schedule.replace(String(input?.oldString ?? ""), String(input?.newString ?? ""))
          : input?.append ? state.schedule + String(input?.content ?? "") : String(input?.content ?? "");
        const armed = newStandingOrders(state.schedule, next);
        if (armed.length) {
          const ok = await pctx.requestApproval(
            armingCardSummary(name === "edit_file" ? "Edit" : input?.append ? "Append to" : "Write", "workspace/SCHEDULE.md", armed.length),
            armed.map((e) => e.raw).join("\n"),
          );
          if (!ok) return "The user declined the new standing order.";
          state.schedule = next;
          return PRACTICE_ARMED;
        }
        state.schedule = next;
        return "Updated the practice standing-order book. workspace/SCHEDULE.md was not touched.";
      }
      case "memory_save": {
        let mem: Record<string, string> = {};
        try { mem = JSON.parse(fs.readFileSync(deps.practiceMemoryFile, "utf-8")); } catch { /* first save */ }
        mem[String(input?.key ?? "note")] = String(input?.value ?? "");
        fs.mkdirSync(path.dirname(deps.practiceMemoryFile), { recursive: true });
        fs.writeFileSync(deps.practiceMemoryFile, JSON.stringify(mem, null, 2));
        return "Saved to practice memory, which is kept apart from your real memory.";
      }
      default:
        return PRACTICE_REFUSED;
    }
  }

  return { execute, state };
}

export type Simulator = ReturnType<typeof createSimulator>;

/** A practice ctx for scripted beats. Its requestApproval is a tripwire: the simulator never uses it. */
export function beatContext(emit: ToolContext["emit"], tripped: () => void): ToolContext {
  return {
    emit,
    requestApproval: async () => {
      tripped();
      return false;
    },
  };
}

/**
 * One tool call of a beat, through the real chokepoint and the real screen —
 * the three calls agent.ts makes for every tool a model asks for.
 */
export async function runStep(sim: Simulator, step: BeatStep, ctx: ToolContext): Promise<{ text: string; flagged: Signal[] }> {
  // Belt and braces with the abort flag: a scripted beat never calls
  // executeTool unless the simulator is in front of it. Without this, a beat
  // woken after practice ended would reach the real tool.
  if (!practiceSimulatorActive()) throw new Error("the practice ground is closed; the beat was not run");
  const screened = screenOutput(await executeTool(step.tool, step.input, ctx), { unfenced: isUntrustedToolName(step.tool) });
  if (screened.flagged) {
    raiseInjectionAlarm(screened.flagged);
    for (const s of screened.flagged.signals) sim.state.signals.add(s);
  }
  const out = screened.output;
  const text = typeof out === "string" ? out : out.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
  return { text, flagged: screened.flagged?.signals ?? [] };
}

/** Which layer stopped a command, read from what actually happened rather than predicted by the tutor. */
export function layerOf(resultText: string, carded: boolean): Layer {
  if (resultText.trim() === FLOOR_REFUSAL) return "floor";
  return carded ? "card" : "free";
}

export interface RunIo {
  emit(event: string, data: unknown): void;
  /** Resolves with the learner's prediction for a predict beat. */
  predict(beat: Beat): Promise<Layer | null>;
  /** Resolves with the signal the learner reported, "none", or null for no report. */
  report(): Promise<string | null>;
  aborted(): boolean;
}

export interface RunRecord {
  predictions: Record<string, { predicted: Layer | null; actual: Layer }>;
  reported: string | null;
}

/** Play a scenario's beats in order. Cards wait for the learner; nothing waits for a clock. */
export async function playScenario(scenario: Scenario, sim: Simulator, io: RunIo, ctx: ToolContext): Promise<RunRecord> {
  const record: RunRecord = { predictions: {}, reported: null };
  for (const beat of scenario.beats) {
    if (io.aborted()) return record;
    sim.state.beat = beat.id;
    const cardsBefore = sim.state.decisions.length;
    let predicted: Layer | null = null;
    if (beat.predict) {
      io.emit("learn_predict", { beat: beat.id, say: beat.say, command: String(beat.steps[0]?.input?.command ?? "") });
      predicted = await io.predict(beat);
      if (io.aborted()) return record;
    }
    if (beat.say) io.emit("learn_beat", { beat: beat.id, say: beat.say });
    let last = "";
    for (const step of beat.steps) {
      if (io.aborted()) return record;
      io.emit("learn_beat", { beat: beat.id, tool: step.tool, input: step.input });
      const r = await runStep(sim, step, ctx);
      last = r.text;
      io.emit("learn_beat_result", { beat: beat.id, tool: step.tool, text: r.text.slice(0, 2400), flagged: r.flagged });
    }
    if (beat.predict) {
      const actual = layerOf(last, sim.state.decisions.length > cardsBefore);
      record.predictions[beat.id] = { predicted, actual };
      io.emit("learn_debrief", {
        beat: beat.id,
        correct: predicted === actual,
        text: `${predicted === actual ? "That matches what happened." : `What happened: ${LAYER_WORDS[actual]}.`} ${beat.debrief ?? ""}`.trim(),
      });
    } else if (beat.expect) {
      const d = sim.state.decisions.slice(cardsBefore).find((x) => x.beat === beat.id);
      const got = d ? (d.decision.approved ? "approve" : "deny") : undefined;
      io.emit("learn_debrief", {
        beat: beat.id,
        correct: got === beat.expect,
        text: `${got === beat.expect ? "That matches the key." : `The key says ${beat.expect === "deny" ? "DENY" : "EXECUTE"} here — finding that out in practice is what practice is for.`} ${beat.debrief ?? ""}`.trim(),
      });
    }
  }
  if (scenario.report && !io.aborted()) {
    io.emit("learn_report_open", { prompt: scenario.report.prompt, options: scenario.report.options.map((o) => o.text) });
    record.reported = await io.report();
  }
  return record;
}

export const LAYER_WORDS: Record<Layer, string> = {
  floor: "the floor refused it before anyone was asked",
  card: "a card asked you first",
  free: "it would run without a card",
};

/** Grade a run against the key. Every input is something code observed: a click, a prediction, the scanner's verdict. */
export function gradeScenario(scenario: Scenario, sim: Simulator, rec: RunRecord, attempt: number, now: Date): ScenarioResult {
  const items: ScenarioResult["items"] = [];
  for (const beat of scenario.beats) {
    if (beat.expect) {
      const d = sim.state.decisions.find((x) => x.beat === beat.id);
      const got = d ? (d.decision.approved ? "approve" : "deny") : undefined;
      items.push({ beat: beat.id, expected: beat.expect, got, correct: got === beat.expect, critical: Boolean(beat.critical), ms: d?.decision.ms });
    } else if (beat.predict) {
      const p = rec.predictions[beat.id];
      items.push({ beat: beat.id, expected: p?.actual, got: p?.predicted ?? undefined, correct: Boolean(p && p.predicted === p.actual), critical: Boolean(beat.critical) });
    }
  }
  if (scenario.report) {
    const chosen = scenario.report.options.find((o) => o.text === rec.reported || o.signal === rec.reported);
    // The key is the real scanner's own verdict on this run's fixture text.
    const ok = Boolean(chosen && chosen.signal !== "none" && sim.state.signals.has(chosen.signal));
    items.push({ beat: "report", expected: [...sim.state.signals].join(","), got: chosen?.signal ?? undefined, correct: ok, critical: Boolean(scenario.report.critical) });
  }
  const correct = items.filter((i) => i.correct).length;
  const score = items.length ? correct / items.length : 0;
  const criticalPassed = items.filter((i) => i.critical).every((i) => i.correct);
  return {
    at: now.toISOString(),
    attempt,
    score: Math.round(score * 100) / 100,
    criticalPassed,
    passed: criticalPassed && score >= scenario.pass,
    items,
  };
}

/** What the HUD may see of a scenario before it runs: no keys, no expected answers. */
export function publicScenario(s: Scenario): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    brief: s.brief,
    levels: s.levels,
    beats: s.beats.length,
    report: s.report ? { prompt: s.report.prompt, options: s.report.options.map((o) => o.text) } : undefined,
  };
}
