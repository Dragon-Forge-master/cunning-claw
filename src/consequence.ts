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

/**
 * What an approval card for a creating/publishing MCP tool must say about who
 * will be able to see the result.
 *
 * Field report (issue #4): the claw made a GitHub repository through the
 * GitHub connector. The card fired — create_* gates — but it showed only the
 * arguments the model passed, which said nothing about visibility, and the
 * vendor defaulted to PUBLIC. The operator approved a publish without ever
 * seeing the word. A card is only a boundary if it shows the consequence, so
 * a creating tool's card states visibility either way: what the arguments
 * set, or that they set nothing and the vendor's default applies.
 *
 * Name-based, like the MCP gate itself: the server's schema is third-party
 * text, and a missing field is exactly the case that matters.
 */
const CREATING_VERBS = new Set([
  "create", "publish", "new", "upload", "share", "post", "deploy", "fork", "import", "copy", "duplicate", "remix",
]);
const VISIBILITY_KEY = /visib|private|public|privacy|unlisted|audience|access_?level|permission/i;

export function publishVisibilityNote(toolName: string, input: unknown): string {
  // mcp__github__create_repository → the remote half: create, repository.
  const remote = toolName.replace(/^mcp__.+?__/, "");
  const words = remote.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-zA-Z]+/).map((w) => w.toLowerCase());
  if (!words.some((w) => CREATING_VERBS.has(w))) return "";
  const found: string[] = [];
  const look = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 2) return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (VISIBILITY_KEY.test(k) && (typeof val !== "object" || val === null)) found.push(`${k}: ${String(val)}`);
      else look(val, depth + 1);
    }
  };
  look(input, 0);
  return found.length
    ? `visibility — ${found.join(", ")}`
    : "visibility not specified — vendor default applies (may be public)";
}
