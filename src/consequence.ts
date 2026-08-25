import { config } from "./config.js";

/**
 * Which browser actions actually need a human.
 *
 * Gating every click and keystroke equally sounds safe and is not. Sending one
 * WhatsApp message took six approvals — click search, type a name, click the
 * contact, click the box, type the message, click send — of which exactly one
 * mattered. The other five taught the operator that the card is noise to be
 * clicked through, which is precisely how the sixth one gets clicked through too.
 *
 * The real boundary is reversibility. Clicking a contact changes nothing. Typing
 * into a box changes nothing; the words sit there until something sends them.
 * Pressing Send is irreversible, and that is the one worth stopping for.
 *
 * Conservative by construction: anything not recognised as safe is treated as
 * committing. A false prompt costs a click; a false pass sends the message.
 */

/** Irreversible in code — config can extend this list but never shorten it. */
const COMMITTING = [
  /\b(send|submit|post|publish|tweet|reply|share)\b/i,
  /\b(pay|buy|purchase|order|checkout|subscribe|donate|transfer|withdraw)\b/i,
  /\b(delete|remove|discard|destroy|erase|wipe|revoke|unsubscribe)\b/i,
  /\b(confirm|accept|agree|authorise|authorize|approve|consent)\b/i,
  /\b(book|reserve|apply|sign\s?up|register|enrol|enroll)\b/i,
  /\b(archive|block|report|leave|deactivate)\b/i,
  /type="submit"/i,
  /\bcontinue to (pay|checkout|payment)\b/i,
];

/**
 * Recognisably navigational — safe because nothing leaves the machine.
 * Checked *after* COMMITTING, so "Send message" is caught by "send" before
 * "message" can excuse it.
 */
const REVERSIBLE = [
  /\b(search|find|filter|sort|open|expand|collapse|scroll|back|forward|refresh)\b/i,
  /\b(next|previous|more|less|show|hide|view|preview|close|dismiss|cancel)\b/i,
  /\b(tab|menu|settings|profile|inbox|compose|new (message|chat|email|note))\b/i,
  // Input placeholders. Focusing a box is not an act.
  /\b(type|write|enter|compose)\b.{0,16}\b(a|your|the)?\s*(message|reply|comment|text|here|something)\b/i,
  /\b(message|text|search) (box|field|input|area)\b/i,
  /\b(textarea|input|contenteditable)\b/i,
];

export type Consequence = "reversible" | "committing";

/**
 * Classify a browser interaction. `query` is whatever the model aimed at — a
 * CSS selector or the visible text of a control.
 */
export function classifyBrowserAction(
  kind: "click" | "type",
  query: string,
  opts: { submit?: boolean } = {},
): { consequence: Consequence; why: string } {
  // Typing that presses Enter is a send in every messaging app there is.
  if (kind === "type" && opts.submit) {
    return { consequence: "committing", why: "typing and pressing Enter submits" };
  }
  // Typing alone puts words in a box. Nothing has happened yet.
  if (kind === "type") {
    return { consequence: "reversible", why: "text is entered but not sent" };
  }

  const extra = (config.browser?.committingPatterns ?? []).map((p) => new RegExp(p, "i"));
  for (const re of [...COMMITTING, ...extra]) {
    if (re.test(query)) return { consequence: "committing", why: `matches "${re.source}"` };
  }
  for (const re of REVERSIBLE) {
    if (re.test(query)) return { consequence: "reversible", why: "navigational" };
  }

  // A bare CSS selector carries no intent we can read, and an unrecognised
  // label could be anything. Ask.
  return { consequence: "committing", why: "unrecognised target — asking rather than guessing" };
}

/**
 * A grant covering the rest of the current task.
 *
 * The remaining friction is targets we cannot read — a contact's name, an
 * unlabelled control. Those are usually reversible but we decline to guess, so
 * the operator can say "yes, and stop asking me about this errand". The grant
 * never covers a committing action: Send still stops you, every time, and it
 * dies with the turn so it cannot leak into the next thing.
 */
let taskGrant = false;

export function grantForTask(): void {
  taskGrant = true;
}

export function clearTaskGrant(): void {
  taskGrant = false;
}

export function taskGrantActive(): boolean {
  return taskGrant;
}

export function needsApproval(
  kind: "click" | "type",
  query: string,
  opts: { submit?: boolean } = {},
): boolean {
  if (config.browser?.approveEveryAction) return true; // opt-in paranoid mode
  const { consequence } = classifyBrowserAction(kind, query, opts);
  if (consequence === "reversible") return false;
  // An irreversible action is never covered by a grant.
  const irreversible = classifyBrowserAction(kind, query, opts).why !== "unrecognised target — asking rather than guessing";
  if (taskGrant && !irreversible) return false;
  return true;
}
