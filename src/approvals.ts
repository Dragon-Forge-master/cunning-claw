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

export type SettledBy = "hud" | "phone" | "voice" | "timeout" | "cancel";

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
  /** For the spoken code; crypto.randomInt by default, a test passes its own. */
  randomInt?: (max: number) => number;
  /**
   * The operator's own spoken passphrase, if they set one (CLAW_SAY_PASSPHRASE
   * in .env), read at each use. Never broadcast, never spoken, never in the
   * model's context; see settleSpoken.
   */
  passphrase?: () => string | null | undefined;
  /**
   * Is a HUD listening for SAY right now? Without it the claw would invite a
   * spoken answer nobody can hear, which is how the passphrase first failed
   * in use: read aloud, answered, and no microphone open.
   */
  listening?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Pending {
  practice: boolean;
  /** The two words that approve this card by voice. Real cards only. */
  spoken?: [string, string];
  /** True when the card's own text contains the passphrase: then only the code answers it. */
  holdsPhrase?: boolean;
  finish(approved: boolean, by: SettledBy, scope?: "task"): void;
}

/**
 * Answering a card by voice, for an operator on another screen.
 *
 * A spoken "yes" is the easiest approval there is to forge: anyone in the
 * room, a video or a radio, an audio clip on a page the claw opened, or the
 * claw's own voice could say it. So a spoken approval must name a code that
 * exists only on the operator's glass: two words drawn fresh for each real
 * card, shown on the card and never spoken, sent to a phone line, put in the
 * model's context or written to the journal. The listener that hears it
 * cannot know it.
 *
 * - "approve <the two words>" approves that card and no other, once.
 * - An approval word with the wrong words, or none ("yes" on its own),
 *   denies every pending real card: a guess gets one try, and a forged "yes"
 *   is a refusal, never a consent.
 * - "deny", "no", "cancel" deny every pending real card. Refusing is always
 *   safe, so it needs no code.
 * - Anything else is not an answer and changes nothing.
 * - Practice cards carry no code and cannot be answered by voice: Learn mode
 *   teaches reading the card, and its cards stay on the HUD's buttons.
 *
 * Words are short, common and unlike each other when heard, so local speech
 * recognition gets them right; 64 of them make 4,032 ordered pairs.
 *
 * The passphrase, added because a code on the glass still means looking at
 * the glass: the operator may set a phrase of their own ("crack on", say) on
 * the Keys page. Then the claw reads the card aloud and saying the phrase
 * approves it, eyes elsewhere. It is a PIN said out loud: anyone in earshot
 * who knows it could use it, which the Keys page says. So:
 *   - it must be the whole of what was heard ("I'll crack on later" is not
 *     an answer), allowing only a filler or "approve" in front and "please"
 *     after;
 *   - it approves only when exactly one real card is waiting (two waiting is
 *     "ambiguous": the code picks one);
 *   - a card whose own text contains the phrase cannot be answered by it.
 *     The claw reads summaries aloud and outside text can steer a summary, so
 *     a page could otherwise make the claw say a common phrase to itself;
 *   - "approve" with neither the phrase nor a code still denies everything.
 */
export const SPOKEN_WORDS = [
  "amber", "anchor", "apple", "arrow", "badger", "banjo", "basket", "beacon",
  "bishop", "blossom", "bucket", "cabin", "camel", "candle", "carpet", "castle",
  "cherry", "cobalt", "copper", "cricket", "daisy", "dolphin", "dragon", "eagle",
  "falcon", "feather", "forest", "garden", "ginger", "glacier", "hammer", "harbour",
  "hazel", "island", "jacket", "jigsaw", "kettle", "ladder", "lemon", "lighthouse",
  "magnet", "maple", "marble", "meadow", "mitten", "orange", "otter", "panda",
  "parrot", "pebble", "pepper", "pillow", "planet", "pocket", "puffin", "rabbit",
  "raven", "river", "rocket", "saddle", "salmon", "thistle", "tiger", "violin",
] as const;

/** Speech recognition often starts with a filler; it is allowed before the answer word, nothing else is. */
const FILLER = "(?:(?:ok|okay|right|so|um|uh|er|erm|well|yeah) )*";
const APPROVE_WORDS = new RegExp(`^${FILLER}(?:approve|approved|yes|allow|execute|go ahead|confirm)\\b`);
const DENY_WORDS = new RegExp(`^${FILLER}(?:deny|denied|no|nope|cancel|refuse|reject|stop|don't)\\b`);

const BARE_YES = /^(?:approve|approved|yes|yeah|yep|allow|execute|confirm|ok|okay|sure)$/;

/** Apostrophes go too, so "Let's go." heard matches "lets go" typed. */
function phraseForm(text: string): string {
  return normaliseSpoken(String(text ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ")).replace(/'/g, "");
}

/**
 * A passphrase worth having: at least four letters, not a bare "yes" (which
 * anything could say), and not starting with a refusal, so "no" and "stop"
 * always mean no.
 */
export function usablePassphrase(raw: string | null | undefined): string | null {
  const p = phraseForm(raw ?? "");
  if (p.replace(/ /g, "").length < 4) return null;
  if (BARE_YES.test(p) || DENY_WORDS.test(p)) return null;
  return p;
}

/** Is the whole of what was heard the passphrase? A filler or "approve" before, "please" after. */
export function saidPassphrase(text: string, phrase: string): boolean {
  let h = phraseForm(text).replace(new RegExp(`^${FILLER}`), "").replace(/ (?:please|thanks|thank you)$/, "");
  if (h === phrase) return true;
  h = h.replace(/^(?:approve|approved|yes) /, "");
  return h === phrase;
}

/** Lower case, letters and spaces only, so "Approve, Amber-Falcon." reads as "approve amber falcon". */
export function normaliseSpoken(text: string): string {
  return String(text ?? "").toLowerCase().replace(/['’]/g, "'").replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
}

export type SpokenOutcome =
  | { outcome: "approved"; id: string }
  | { outcome: "denied"; count: number }
  | { outcome: "wrong-code"; count: number }
  | { outcome: "not-an-answer" }
  | { outcome: "ambiguous"; count: number }
  | { outcome: "code-only"; id: string }
  | { outcome: "nothing-pending" };

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
  const randomInt = deps.randomInt ?? ((max: number) => crypto.randomInt(max));
  /** Two different words, fresh for each card. */
  function drawCode(): [string, string] {
    const a = randomInt(SPOKEN_WORDS.length);
    let b = randomInt(SPOKEN_WORDS.length - 1);
    if (b >= a) b++;
    return [SPOKEN_WORDS[a], SPOKEN_WORDS[b]];
  }
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
      const spoken = drawCode();
      // byPassphrase says the passphrase may answer this card (a yes/no,
      // never the phrase), so the claw reads it aloud for an operator who is
      // not looking. Not if the card's own text holds the phrase: it is read
      // aloud, and outside text can steer what it says.
      const phrase = usablePassphrase(deps.passphrase?.());
      const holdsPhrase = phrase !== null && ` ${phraseForm(`${s} ${d}`)} `.includes(` ${phrase} `);
      // Invited only while a HUD is listening; the passphrase itself still
      // answers if SAY is switched on after the card went up.
      const byPassphrase = phrase !== null && !holdsPhrase && (deps.listening?.() ?? true);
      pending.set(id, { practice: false, spoken, holdsPhrase, finish });
      // The code rides on the HUD's card and nowhere else: not to the phone
      // lines, not to ntfy, and the model never sees this event.
      deps.broadcast("approval_request", { id, summary: s, detail: d, spoken: spoken.join(" "), byPassphrase, passphraseSet: phrase !== null });
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

  /** Every pending real card, denied, by voice. Practice cards stay on their buttons. */
  function denyRealByVoice(): number {
    const ids = [...pending.entries()].filter(([, p]) => !p.practice).map(([id]) => id);
    for (const id of ids) pending.get(id)?.finish(false, "voice");
    return ids.length;
  }

  /** An answer heard by the HUD's microphone (the rules are above SPOKEN_WORDS). */
  function settleSpoken(text: string): SpokenOutcome {
    const heard = normaliseSpoken(text);
    const real = [...pending.entries()].filter(([, p]) => !p.practice && p.spoken);
    if (real.length === 0) return { outcome: "nothing-pending" };
    const phrase = usablePassphrase(deps.passphrase?.());
    if (phrase && saidPassphrase(text, phrase)) {
      if (real.length !== 1) return { outcome: "ambiguous", count: real.length };
      // The phrase is in this card's own text: it cannot answer it. Not a
      // denial either; the operator is told to use the code.
      if (real[0][1].holdsPhrase) return { outcome: "code-only", id: real[0][0] };
      real[0][1].finish(true, "voice");
      return { outcome: "approved", id: real[0][0] };
    }
    if (DENY_WORDS.test(heard)) return { outcome: "denied", count: denyRealByVoice() };
    if (!APPROVE_WORDS.test(heard)) return { outcome: "not-an-answer" };
    const words = ` ${heard} `;
    const match = real.find(([, p]) => words.includes(` ${p.spoken![0]} ${p.spoken![1]} `));
    if (!match) return { outcome: "wrong-code", count: denyRealByVoice() };
    match[1].finish(true, "voice");
    return { outcome: "approved", id: match[0] };
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
    settleSpoken,
    cancelAll,
    cancelPractice,
    isPractice: (id: string) => pending.get(id)?.practice === true,
    pendingCount: () => pending.size,
  };
}

export type Approvals = ReturnType<typeof createApprovals>;
