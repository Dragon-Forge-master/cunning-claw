/**
 * Driving another AI in a terminal: the claw may type its instructions, but
 * never answer its permission prompts.
 *
 * Field report, 24 November 2026: the operator asked their claw to drive
 * Claude Code in a terminal window. It did that well, typing briefs through
 * type_on_desktop. But when Claude Code stopped at a permission prompt, the
 * claw typed "1" and Return itself, and an "Allow for this task" grant earlier
 * in the turn meant no card fired. The other AI's safety catch was answered
 * by an AI. It also ran `claude -p ... --dangerously-skip-permissions`, which
 * removes that catch altogether.
 *
 * The operator liked the driving, so the driving stays. What changes is the
 * one moment that matters: a keystroke that could answer another AI's
 * prompt goes to the operator on a card, every time, whatever was granted,
 * and the card can be answered from a phone like any other. The claw types
 * only the answer the operator approved.
 *
 * A leaf: no imports from the rest of the claw, so tools.ts and desktop.ts
 * can both use it without a cycle.
 */

/** Coding agents that stop and ask permission in a terminal. Matched on a process's name or its script's name. */
export const AGENT_BINARIES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  aider: "Aider",
  goose: "goose",
  "cursor-agent": "Cursor Agent",
  copilot: "GitHub Copilot CLI",
  opencode: "opencode",
  qwen: "Qwen Code",
  amp: "Amp",
};

/**
 * Which agent a window title shows, or null. Claude Code titles its terminal
 * with the task ("Port Estimatic") behind a ✳ or a braille spinner while it
 * works, so the glyphs count as well as the names.
 */
export function agentFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  if (/claude\s*code/i.test(title) || /^\s*[✳✻✽✶✢·⠀-⣿]/.test(title)) return "Claude Code";
  for (const [bin, name] of Object.entries(AGENT_BINARIES)) {
    if (bin === "claude" || bin === "amp") continue; // "claude" alone is the claw's own talk; "amp" is too common a word
    if (new RegExp(`\\b${bin.replace("-", "[- ]")}\\b`, "i").test(title)) return name;
  }
  return null;
}

export interface Proc {
  pid: number;
  ppid: number;
  /** The process name (comm). */
  comm: string;
  /** Its arguments; node CLIs show as `node /…/bin/claude`. */
  argv: string[];
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

function agentOf(p: Proc): string | null {
  const names = [p.comm, base(p.argv[0] ?? ""), base(p.argv[1] ?? "")].map((n) => n.replace(/\.(js|mjs|cjs|exe)$/i, ""));
  for (const n of names) if (AGENT_BINARIES[n]) return AGENT_BINARIES[n];
  return null;
}

/**
 * The agent running anywhere under a window's process, or null. A terminal
 * emulator that serves every window from one server process (gnome-terminal)
 * makes this answer for all its windows at once: more cards, never fewer.
 */
export function agentInTree(rootPid: number, procs: readonly Proc[]): string | null {
  const children = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of children.get(pid) ?? []) {
      const hit = agentOf(c);
      if (hit) return hit;
      stack.push(c.pid);
    }
  }
  return null;
}

/**
 * Keys that pick or confirm an option in a terminal prompt: Claude Code's
 * menus take a digit, arrows and Return; shift+Tab cycles its permission
 * mode, which includes accepting edits without asking.
 */
const ANSWER_KEY = /^(?:return|enter|kp_enter|tab|shift\+tab|iso_left_tab|up|down|left|right|space|[0-9]|kp_[0-9]|y|n|a)$/i;
const SUBMIT_KEY = /^(?:return|enter|kp_enter)$/i;

/** A typed reply short enough to be choosing an option rather than giving an instruction. */
const SHORT_ANSWER = /^(?:[0-9]|y|yes|n|no|a|all|always|allow|approve|accept|ok|okay|sure|go|go ahead|continue|proceed|do it)[.!]?$/i;

export type Keystrokes = { kind: "keys"; keys: string } | { kind: "text"; text: string };

/**
 * Could these keystrokes answer a prompt the other AI is showing? Long text
 * is an instruction. A lone Return straight after an instruction the claw
 * typed into the same window (and has not yet sent) submits that
 * instruction. Anything else that picks, confirms or cycles is an answer.
 * Keys with nothing answer-shaped in them (ctrl+c, Escape) stop or cancel,
 * which is always safe.
 */
export function answersPrompt(k: Keystrokes, pendingInstruction: boolean): boolean {
  if (k.kind === "text") {
    const body = k.text.replace(/[\r\n]+$/, "").trim();
    if (body === "") return true; // a bare newline is Return
    return SHORT_ANSWER.test(body) || body.length <= 2;
  }
  const chords = k.keys.trim().split(/\s+/).filter(Boolean);
  if (!chords.some((c) => ANSWER_KEY.test(c))) return false;
  if (pendingInstruction && chords.length === 1 && SUBMIT_KEY.test(chords[0])) return false;
  return true;
}

/** Typed text that leaves an instruction waiting in the box (no newline at the end), so the next Return sends it. */
export function leavesInstructionPending(k: Keystrokes): boolean {
  return k.kind === "text" && !answersPrompt(k, false) && !/[\r\n]$/.test(k.text);
}

/**
 * Flags that take another AI's permission prompts away altogether. The claw
 * may not launch an agent with one, by shell or by typing it into a terminal.
 */
const BYPASS =
  /--(?:allow-)?dangerously-skip-permissions\b|--dangerously-bypass-approvals-and-sandbox\b|--permission-mode[=\s]+["']?bypassPermissions\b|\b(?:gemini|qwen)\b[^|;&]*\s--yolo\b/i;

export function bypassFlag(s: string): string | null {
  return s.match(BYPASS)?.[0].trim() ?? null;
}

export function bypassRefusal(flag: string): string {
  return (
    `Refused: ${flag} switches off another AI's permission prompts, and those prompts are the operator's to ` +
    `answer. Nothing was run or typed. Launch it without the flag; when it asks permission, the operator ` +
    `answers on a card. If the operator wants this flag, they can type it themselves.`
  );
}

/**
 * Remembers, per window, that the claw typed an instruction and has not sent
 * it yet, so the Return that sends it does not raise a card. A minute at
 * most: after that a Return is treated as the answer it may well be.
 */
const PENDING_MS = 60_000;
const pending = new Map<string, number>();

export function notePending(window: string, now = Date.now()): void {
  pending.set(window, now);
}

export function takePending(window: string, now = Date.now()): boolean {
  const at = pending.get(window);
  pending.delete(window);
  return at !== undefined && now - at <= PENDING_MS;
}

export function clearPending(): void {
  pending.clear();
}

export interface RelayCard {
  summary: string;
  detail: string;
  declined: string;
}

/** What the operator sees: who is asking, what the claw would press, and the claw's reading of the question. */
export function relayCard(o: { agent: string; window: string | null; send: string; asking?: string }): RelayCard {
  const where = o.window ? ` (window "${o.window.slice(0, 60)}")` : "";
  const asking = o.asking?.trim()
    ? `What the claw reads on screen: "${o.asking.trim().slice(0, 400)}"`
    : "The claw did not say what is being asked: look at the screen before you answer.";
  return {
    summary: `${o.agent} is asking permission — answer it?`,
    detail:
      `${o.agent}${where} is waiting at a prompt. The claw would answer: ${o.send}\n\n${asking}\n\n` +
      `Only you answer another AI's permission prompts; "Allow for this task" does not cover them, so this card comes every time.`,
    declined:
      `The operator declined: nothing was typed into ${o.agent}. Do not answer its prompt another way. ` +
      `Tell the operator what it was asking and wait for them.`,
  };
}
