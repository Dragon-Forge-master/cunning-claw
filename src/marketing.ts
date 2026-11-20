import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { collapseHome, expandHome } from "./paths.js";

/**
 * The desk marketer's floor: who may be sent marketing email, decided in code.
 *
 * A small business asking the claw for "a follow-up to everyone who had an MOT
 * in March" is asking for exactly the thing UK law (PECR, with UK GDPR behind
 * it) is strict about. In plain terms:
 *
 *   - Marketing email to an individual needs their consent, OR the "soft
 *     opt-in": they are an existing customer (or were negotiating to be one),
 *     the message is about similar products or services, they were given an
 *     easy way to opt out when their details were taken, and they did not.
 *   - Every marketing email carries a way to unsubscribe.
 *   - An opt-out is final until the person opts back in themselves.
 *
 * Doctrine in a prompt is something a model can be argued out of — by a
 * persuasive customer email, or by its own eagerness to finish the job. So the
 * rule lives here, as a register the operator keeps on their own Desk and a
 * check at the places marketing can leave the machine. The model plans with
 * `marketing_audience`; the sends are checked whether it planned or not.
 *
 * What this module can and cannot see is said where each check is made. The
 * short version: it sees addresses and bodies that pass through a tool call.
 * It cannot see a list that lives on a vendor's servers (a Klaviyo segment, a
 * Resend audience): there the card says the audience is held at the vendor and
 * that consent for it is the vendor's list, which is why adding contacts TO a
 * vendor's list is checked here too. Nor can it see marketing that leaves by
 * a road that is not a mail tool: a raw http_request POST to a vendor's API,
 * or a click on "Send campaign" in a vendor's web dashboard. Those already ask
 * (non-GET HTTP and committing clicks are gated), but their card carries no
 * consent count. A one-to-one Gmail send the model does not call marketing is
 * taken at its word: telling a single offer from a single reply would mean
 * judging prose, and a wrong refusal there blocks a customer's answer. It is
 * not legal advice and does not try to be — the skill tells the operator to
 * check the ICO's current guidance.
 *
 * Everything below `registerPath` is pure: the register's rows are passed in,
 * so the tests need no disk and the answers are the same for the same state.
 */

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export type Basis = "consent" | "soft-opt-in" | "none";

export interface ConsentRow {
  email: string;
  name: string;
  /** As written in the register; `basisOf` reads it. */
  basis: string;
  source: string;
  since: string;
  optedOut: string;
  notes: string;
}

/**
 * The register is a Desk document: the HUD's Docs page opens it, the operator
 * edits it like any other note, and it never leaves the machine. A markdown
 * table rather than a CSV because the Desk is markdown — a CSV there would be a
 * file only a terminal could read. claw.config.json `marketing.register` moves it.
 */
export const DEFAULT_REGISTER = path.join("Documents", "CunningClaw", "Marketing consent.md");

export function registerPath(home: string = os.homedir()): string {
  const configured = config.marketing?.register;
  if (configured) return path.resolve(expandHome(configured));
  return path.join(home, DEFAULT_REGISTER);
}

/**
 * Above this many recipients, a mailbox send (Gmail or Outlook) is treated as marketing whatever the
 * model said about it. Bcc'ing the whole customer list from the shop's own
 * mailbox is the classic small-business breach, and it is the one a model
 * marking its own homework would wave through. Only the operator moves this.
 */
export function bulkThreshold(): number {
  const n = Number(config.marketing?.bulkThreshold);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
}

export const REGISTER_TEMPLATE = `# Marketing consent

Who may be sent marketing email — newsletters, offers, reminders, review requests.
Cunning Claw checks every marketing send against this table, and refuses anyone
who is not on it, has no basis, or has opted out. You can edit it here like any
other document.

- **Basis** is \`consent\` (they said yes — say where and when in Source) or
  \`soft-opt-in\` (an existing customer, about similar services, who was offered
  an easy opt-out when their details were taken and did not use it — Source names
  the job or sale). Anything else, or blank, means no marketing.
- **Opted out**: put the date. That stops all marketing to them until they opt
  back in themselves; then clear it and record the new consent in Source.
- Check the ICO's current guidance on electronic marketing; this table is a
  record, not legal advice.

| Email | Name | Basis | Source | Since | Opted out | Notes |
|---|---|---|---|---|---|---|
`;

function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

function columnOf(header: string[], re: RegExp): number {
  return header.findIndex((h) => re.test(h.toLowerCase()));
}

/**
 * Read the register's table. Columns are found by their header, in any order,
 * so the operator can add one or reorder them without breaking the check. A
 * row without a readable address is counted in `bad`, never guessed at.
 */
export function parseRegister(md: string): { rows: ConsentRow[]; bad: number; found: boolean } {
  const rows: ConsentRow[] = [];
  let bad = 0;
  let found = false;
  let cols: Record<keyof ConsentRow, number> | null = null;
  for (const line of md.split("\n")) {
    if (!/^\s*\|/.test(line)) {
      cols = null;
      continue;
    }
    const c = cells(line);
    if (!cols) {
      const header = c;
      const email = columnOf(header, /^e-?mail(\s*address)?$/);
      const basis = columnOf(header, /basis/);
      if (email < 0 || basis < 0) continue;
      found = true;
      cols = {
        email,
        basis,
        name: columnOf(header, /^name/),
        source: columnOf(header, /^source/),
        since: columnOf(header, /^(since|date|when|recorded|consented)/),
        optedOut: columnOf(header, /opt(ed)?[\s-]*out|unsubscribed/),
        notes: columnOf(header, /^notes?$/),
      };
      continue;
    }
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === "")) continue; // the |---| line
    const at = (k: keyof ConsentRow) => (cols![k] >= 0 ? c[cols![k]] ?? "" : "");
    const email = normaliseEmail(at("email"));
    if (!EMAIL_RE.test(email)) {
      if (c.some(Boolean)) bad++;
      continue;
    }
    rows.push({
      email, name: at("name"), basis: at("basis"), source: at("source"),
      since: at("since"), optedOut: at("optedOut"), notes: at("notes"),
    });
  }
  return { rows, bad, found };
}

export function loadRegister(file: string = registerPath()): { rows: ConsentRow[]; bad: number; exists: boolean; found: boolean } {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return { rows: [], bad: 0, exists: false, found: false };
  }
  return { ...parseRegister(text), exists: true };
}

// ---------------------------------------------------------------------------
// The consent check
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ADDRESS_IN_TEXT = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** `  "Jo" <Jo@Example.COM> ` and `mailto:jo@example.com` are both jo@example.com. */
export function normaliseEmail(raw: string): string {
  let s = String(raw ?? "").trim();
  const angled = s.match(/<([^>]+)>/);
  if (angled) s = angled[1];
  return s.replace(/^mailto:/i, "").trim().replace(/\.$/, "").toLowerCase();
}

/** Every address in a header-ish string: "a@x.com, Bo <b@y.com>". */
export function addressesIn(text: string): string[] {
  return [...new Set((String(text ?? "").match(ADDRESS_IN_TEXT) ?? []).map(normaliseEmail))];
}

export function basisOf(raw: string): Basis {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  if (/^(consent|consented|opt-?in|opted-?in)$/.test(s)) return "consent";
  if (/^soft(-?opt-?in)?$/.test(s)) return "soft-opt-in";
  return "none";
}

/** "no", "-" and blank mean "not opted out"; a date, "yes", anything else means they have. */
export function isOptedOut(raw: string): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  return !(s === "" || /^(no|n|false|-|–|—)$/.test(s));
}

export type RefusalReason = "unknown" | "no-basis" | "no-source" | "opted-out" | "not-an-address";

export interface ConsentVerdict {
  allowed: { email: string; basis: Exclude<Basis, "none"> }[];
  refused: { email: string; reason: RefusalReason; why: string }[];
}

const WHY: Record<RefusalReason, string> = {
  "unknown": "not in the consent register",
  "no-basis": "no basis recorded (consent or soft-opt-in)",
  "no-source": "a basis with no Source — nothing to show where it came from",
  "opted-out": "opted out — final until they opt back in themselves",
  "not-an-address": "not an email address",
};

/**
 * Given a proposed list and the register: who may be sent marketing, and why
 * each of the rest may not. Matching is trimmed and case-insensitive; a
 * duplicate in the list is one person.
 *
 * An opt-out on ANY row for an address wins over a basis on another, because
 * a register gathered from two spreadsheets will have the same customer twice
 * and the objection is the line that matters. A basis needs a Source: under
 * GDPR the business has to be able to show where consent came from, and a
 * soft opt-in rests on a real sale or enquiry — "soft-opt-in" with nothing
 * behind it is a word, not a basis.
 */
export function checkConsent(recipients: readonly string[], rows: readonly ConsentRow[]): ConsentVerdict {
  const byEmail = new Map<string, ConsentRow[]>();
  for (const r of rows) {
    const k = normaliseEmail(r.email);
    byEmail.set(k, [...(byEmail.get(k) ?? []), r]);
  }
  const out: ConsentVerdict = { allowed: [], refused: [] };
  const seen = new Set<string>();
  const refuse = (email: string, reason: RefusalReason) => out.refused.push({ email, reason, why: WHY[reason] });
  for (const raw of recipients) {
    const email = normaliseEmail(raw);
    if (seen.has(email)) continue;
    seen.add(email);
    if (!EMAIL_RE.test(email)) { refuse(email, "not-an-address"); continue; }
    const mine = byEmail.get(email);
    if (!mine?.length) { refuse(email, "unknown"); continue; }
    if (mine.some((r) => isOptedOut(r.optedOut))) { refuse(email, "opted-out"); continue; }
    const based = mine.filter((r) => basisOf(r.basis) !== "none");
    const backed = based.find((r) => r.source.trim());
    if (backed) {
      out.allowed.push({ email, basis: basisOf(backed.basis) as Exclude<Basis, "none"> });
    } else {
      refuse(email, based.length ? "no-source" : "no-basis");
    }
  }
  return out;
}

/** "consent 8, soft opt-in 4" — the basis line every card carries. */
export function basisSummary(v: ConsentVerdict): string {
  const consent = v.allowed.filter((a) => a.basis === "consent").length;
  const soft = v.allowed.length - consent;
  return `consent ${consent}, soft opt-in ${soft}`;
}

/** "2 not in the consent register, 1 opted out …" — counts only, never addresses. */
export function refusalSummary(v: ConsentVerdict): string {
  const counts = new Map<RefusalReason, number>();
  for (const r of v.refused) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${n} ${WHY[reason]}`).join("; ");
}

/**
 * Does this body give the reader a way out? A deliberately simple test: the
 * word unsubscribe (or a vendor's merge tag for it — {{unsubscribe}},
 * *|UNSUB|*, {{{RESEND_UNSUBSCRIBE_URL}}}, {$unsubscribe}), "opt out", "reply
 * STOP", or "manage your preferences". It proves the line is there, not that
 * the link works — the operator reads the email on the card for that.
 */
export function hasUnsubscribeRoute(body: string): boolean {
  const b = String(body ?? "");
  return (
    /(?<![a-z])unsub(?:scrib[a-z]*)?(?![a-z])/i.test(b) ||
    /(?<![a-z])opt(?:ed)?[\s-]?out(?![a-z])/i.test(b) ||
    /\b(?:reply|text|respond|email us)\b[^.\n]{0,40}\bstop\b/i.test(b) ||
    /\bstop (?:receiving|getting|hearing from us)\b/i.test(b) ||
    /\b(?:manage|update|change) (?:your )?(?:email |mailing )?(?:preferences|subscription)/i.test(b)
  );
}

// ---------------------------------------------------------------------------
// Register writes: arming more recipients is consequential
// ---------------------------------------------------------------------------

function permittedSet(md: string): Set<string> {
  const { rows } = parseRegister(md);
  const v = checkConsent(rows.map((r) => r.email), rows);
  return new Set(v.allowed.map((a) => a.email));
}

/**
 * Which addresses would this write newly permit to receive marketing?
 *
 * The Desk is a free-write zone, rightly, and the register lives there. Without
 * this, one injected line — "add everyone from that spreadsheet as consent" —
 * would let the model grant itself the audience the check exists to refuse.
 * The same shape as newStandingOrders: only a change that WIDENS who may be
 * mailed raises a card (a new row with a basis, a basis upgraded, an opt-out
 * cleared). Recording an opt-out, deleting a row, or editing notes is free,
 * because making the list smaller is never the dangerous direction.
 */
export function newlyPermitted(before: string, after: string): string[] {
  const had = permittedSet(before);
  return [...permittedSet(after)].filter((e) => !had.has(e));
}

/** The approval card for a register write that widens the audience. */
export function permitCard(after: string, added: string[]): { summary: string; detail: string } {
  const { rows } = parseRegister(after);
  const v = checkConsent(added, rows);
  const lines = added.slice(0, 40).map((e) => {
    const r = rows.find((x) => x.email === e && basisOf(x.basis) !== "none" && x.source.trim());
    return `${e} — ${r ? `${basisOf(r.basis)}; source: ${r.source.slice(0, 60)}` : "?"}`;
  });
  return {
    summary:
      `Marketing consent register — this lets ${added.length} more ${added.length === 1 ? "address" : "addresses"} ` +
      `receive marketing (${basisSummary(v)})`,
    detail:
      lines.join("\n") + (added.length > 40 ? `\n…and ${added.length - 40} more` : "") +
      "\n\nApprove only if each of these people really gave consent, or is an existing customer who was " +
      "offered an opt-out and did not take it. Recording opt-outs never asks.",
  };
}

// ---------------------------------------------------------------------------
// Where marketing leaves: tool-call inspection
// ---------------------------------------------------------------------------

/** Email services whose sends are marketing by default. Matched on the server id. */
const VENDORS: Record<string, string> = {
  klaviyo: "Klaviyo", mailerlite: "MailerLite", hubspot: "HubSpot", resend: "Resend",
  mailchimp: "Mailchimp", brevo: "Brevo", sendgrid: "SendGrid",
};

function words(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const READ_FIRST = new Set(["get", "list", "read", "search", "fetch", "find", "query", "lookup", "view", "describe", "count", "check", "preview", "render"]);
/** Calls that make the audience smaller. Never blocked: an opt-out must always be recordable. */
const SHRINK = new Set(["remove", "delete", "unsubscribe", "unsubscribed", "suppress", "suppression", "suppressions", "cancel", "archive", "revoke", "unassign"]);
const SEND = new Set(["send", "sends", "schedule", "scheduled", "dispatch"]);
const COMPOSE_VERB = new Set(["create", "update", "compose", "edit", "set", "draft", "duplicate", "put", "assign"]);
const CONTENT = new Set(["campaign", "campaigns", "broadcast", "broadcasts", "newsletter", "newsletters"]);
/**
 * Where a campaign's body is a template made in its own call (Klaviyo builds a
 * campaign, then a template, then assigns one to the other), the template is
 * the only place the body is ever visible. Elsewhere — Resend, SendGrid,
 * Brevo — templates are as often a receipt or a password reset as a
 * newsletter, and demanding an unsubscribe line in those would be wrong.
 */
const MARKETING_TEMPLATES = new Set(["Klaviyo", "Mailchimp", "MailerLite"]);
/**
 * HubSpot's contacts are a CRM — the customer you quoted yesterday — not a
 * mailing list; whether one may be marketed to is a separate status there. So
 * a HubSpot contact write is not an audience write, and its sends still are.
 */
const CONTACTS_ARE_CRM = new Set(["HubSpot"]);
const AUDIENCE_VERB = new Set(["create", "add", "import", "subscribe", "upsert", "update", "assign", "put", "bulk", "batch", "set"]);
const AUDIENCE = new Set(["contact", "contacts", "profile", "profiles", "subscriber", "subscribers", "member", "members", "segment", "segments", "list", "lists", "audience", "audiences", "topics"]);

export type MarketingKind = "send" | "compose" | "audience";

/**
 * Is this MCP tool a place marketing leaves? Read from the local name
 * (`mcp__resend__send_broadcast`) so it works whether or not the server is
 * connected, and so a vendor cannot rename its way out by describing a tool
 * differently. A reply is correspondence; anything that shrinks the audience
 * passes untouched.
 */
export function classifyMcpTool(localName: string): { kind: MarketingKind; vendor: string | null } | null {
  const parts = localName.split("__");
  if (parts[0] !== "mcp" || parts.length < 3) return null;
  const server = parts[1].toLowerCase().replace(/[^a-z0-9]/g, "");
  const w = words(parts.slice(2).join("_"));
  if (!w.length || READ_FIRST.has(w[0])) return null;
  if (w.some((x) => SHRINK.has(x)) || w.includes("reply")) return null;
  const key = Object.keys(VENDORS).find((k) => server.includes(k));
  const vendor = key ? VENDORS[key] : null;
  if (w.some((x) => SEND.has(x))) return { kind: "send", vendor };
  if (!vendor) return null;
  const content = (x: string) => CONTENT.has(x) || (MARKETING_TEMPLATES.has(vendor) && /^templates?$/.test(x));
  if (w.some((x) => COMPOSE_VERB.has(x)) && w.some(content)) return { kind: "compose", vendor };
  if (CONTACTS_ARE_CRM.has(vendor)) return null;
  if (w.some((x) => AUDIENCE_VERB.has(x)) && w.some((x) => AUDIENCE.has(x))) return { kind: "audience", vendor };
  return null;
}

const flat = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "");
const SENDER_KEYS = new Set(["from", "sender", "replyto", "fromemail", "senderemail", "fromaddress", "replytoemail", "replytoaddress", "replytoemails", "replytoaddresses", "owner"]);
const BODY_KEYS = new Set(["html", "text", "body", "content", "plain", "plaintext", "message", "htmlbody", "textbody", "htmlcontent", "textcontent", "contenthtml", "contenttext", "bodyhtml", "bodytext"]);
const RECIPIENT_KEYS = new Set(["to", "cc", "bcc", "email", "emails", "emailaddress", "emailaddresses", "recipient", "recipients", "address", "addresses", "subscriber", "subscribers"]);

/** Every recipient address in a call's arguments — never a sender, never an address quoted in a body. */
export function recipientsIn(input: unknown, key = ""): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, k: string) => {
    const f = flat(k);
    if (SENDER_KEYS.has(f) || BODY_KEYS.has(f) || f === "subject") return;
    if (typeof v === "string") {
      if (RECIPIENT_KEYS.has(f)) for (const a of addressesIn(v)) out.add(a);
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el, k);
    } else if (v && typeof v === "object") {
      for (const [ck, cv] of Object.entries(v)) walk(cv, ck);
    }
  };
  walk(input, key);
  return [...out];
}

/**
 * Each object that carries a body, as the text a reader would get. An object
 * passes if any of its body fields (the HTML or the plain text) has the route.
 */
export function bodiesIn(input: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const el of v) walk(el); return; }
    if (!v || typeof v !== "object") return;
    const own = Object.entries(v).filter(([k, x]) => BODY_KEYS.has(flat(k)) && typeof x === "string" && x.trim());
    if (own.length) out.push(own.map(([, x]) => String(x)).join("\n"));
    for (const [k, x] of Object.entries(v)) if (!BODY_KEYS.has(flat(k))) walk(x);
  };
  walk(input);
  return out;
}

/**
 * The arguments with refused recipients taken out. A list loses the refused
 * entries; a comma list is rewritten without them; an object (a contact, one
 * email of a batch) whose own recipient is refused is dropped from the list it
 * sits in. If a refused address cannot be removed without removing the whole
 * call — a single `to` — `whole` comes back true and the call is refused.
 */
export function trimRecipients(input: unknown, refused: ReadonlySet<string>): { value: unknown; whole: boolean } {
  const DROP = Symbol("drop");
  const walk = (v: unknown, k: string): unknown => {
    const f = flat(k);
    if (SENDER_KEYS.has(f) || BODY_KEYS.has(f) || f === "subject") return v;
    if (typeof v === "string") {
      if (!RECIPIENT_KEYS.has(f)) return v;
      const all = addressesIn(v);
      if (!all.length) return v;
      const keep = all.filter((a) => !refused.has(a));
      if (keep.length === all.length) return v;
      return keep.length ? keep.join(", ") : DROP;
    }
    if (Array.isArray(v)) {
      const kept = v.map((el) => walk(el, k)).filter((x) => x !== DROP);
      return v.length && !kept.length ? DROP : kept;
    }
    if (v && typeof v === "object") {
      const next: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(v)) {
        const r = walk(cv, ck);
        if (r === DROP) return DROP;
        next[ck] = r;
      }
      return next;
    }
    return v;
  };
  const value = walk(input, "");
  return value === DROP ? { value: input, whole: true } : { value, whole: false };
}

/** A contact update that records an opt-out — `unsubscribed: true`, `status: "unsubscribed"`. */
function recordsOptOut(input: unknown): boolean {
  let hit = false;
  const walk = (v: unknown, k: string) => {
    const f = flat(k);
    if (f === "unsubscribed" && v === true) hit = true;
    if (typeof v === "string" && ["status", "consent", "state", "subscriptionstatus", "emailstatus"].includes(f) &&
      /^(unsubscribed|suppressed|opted[_\s-]?out|never_subscribed)$/i.test(v.trim())) hit = true;
    if (Array.isArray(v)) for (const el of v) walk(el, k);
    else if (v && typeof v === "object") for (const [ck, cv] of Object.entries(v)) walk(cv, ck);
  };
  walk(input, "");
  return hit;
}

export type Guard =
  | { verdict: "pass" }
  | { verdict: "refuse"; message: string }
  | { verdict: "card"; input: unknown; title: string; note: string };

function registerHint(where: string): string {
  return `Run marketing_audience for the addresses that may be sent marketing (register: ${where}).`;
}

function noRoute(where: string): Guard {
  return {
    verdict: "refuse",
    message:
      "Refused: this is a marketing email and its body has no unsubscribe route. Every marketing email must " +
      "give the reader a way out — an unsubscribe link, the service's unsubscribe merge tag, or a line such as " +
      `"Reply STOP to hear no more from us". Add one and try again. ${registerHint(where)}`,
  };
}

/**
 * The check on an MCP call. "pass" means not marketing — the ordinary MCP card
 * path, unchanged. "card" means marketing that may go, with the arguments it
 * may go with (refused recipients removed) and a title stating the count, the
 * basis and the unsubscribe route. The title is where the facts go because
 * the detail is truncated JSON and a title cannot be scrolled past.
 */
export function guardMcpCall(
  localName: string,
  input: unknown,
  rows: readonly ConsentRow[],
  opts: { threshold: number; where: string },
): Guard {
  const c = classifyMcpTool(localName);
  if (!c) return { verdict: "pass" };
  const recips = recipientsIn(input);
  const vendor = c.vendor ?? "the service";
  // A general-purpose sender (a Gmail or Outlook connector) is marketing only
  // when it is a bulk send; one-to-one mail through it is correspondence.
  if (!c.vendor && recips.length <= opts.threshold) return { verdict: "pass" };
  if (c.kind === "audience") {
    if (recordsOptOut(input)) return { verdict: "pass" };
    if (!recips.length) {
      if (words(localName).includes("import")) {
        return {
          verdict: "refuse",
          message:
            `Refused: an import into ${vendor} from a file is a list the consent register cannot read. ` +
            `Add contacts one call at a time from marketing_audience's list instead, so each one is checked. ` +
            registerHint(opts.where),
        };
      }
      return { verdict: "pass" };
    }
  }
  const bodies = bodiesIn(input);
  if ((c.kind === "send" || c.kind === "compose") && bodies.some((b) => !hasUnsubscribeRoute(b))) return noRoute(opts.where);
  if (c.kind === "compose" && !bodies.length && !recips.length) return { verdict: "pass" };

  let value = input;
  let head: string;
  let removed = 0;
  if (recips.length) {
    const v = checkConsent(recips, rows);
    if (!v.allowed.length) {
      return {
        verdict: "refuse",
        message:
          `Refused: none of the ${recips.length} recipient(s) may be sent marketing — ${refusalSummary(v)}. ` +
          registerHint(opts.where),
      };
    }
    if (v.refused.length) {
      const trimmed = trimRecipients(input, new Set(v.refused.map((r) => r.email)));
      if (trimmed.whole) {
        return {
          verdict: "refuse",
          message:
            `Refused: ${v.refused.length} of ${recips.length} recipients may not be sent marketing ` +
            `(${refusalSummary(v)}), and they could not be taken out of this call without changing what it is. ` +
            `Make the call again with only the addresses marketing_audience returns.`,
        };
      }
      value = trimmed.value;
      removed = v.refused.length;
    }
    const n = v.allowed.length;
    head = c.kind === "audience"
      ? `adds ${n} ${n === 1 ? "address" : "addresses"} to ${vendor}'s audience (${basisSummary(v)})`
      : `marketing to ${n} ${n === 1 ? "recipient" : "recipients"} (${basisSummary(v)})`;
  } else {
    head = `marketing — audience held at ${vendor}; consent there is the vendor's list`;
  }
  const route = c.kind === "audience"
    ? ""
    : bodies.length
      ? "; unsubscribe route present"
      : `; content held at ${vendor} — no unsubscribe route visible here, its footer must carry one`;
  const cut = removed ? `; ${removed} refused by the consent register and removed` : "";
  return {
    verdict: "card",
    input: value,
    title: head + route + cut,
    note:
      `Consent register: ${opts.where}. ` +
      (recips.length
        ? "Every address in this call was checked against it."
        : `This call names no addresses, so the register could not check it: who receives it is ${vendor}'s list. ` +
          "Contacts added to that list through Cunning Claw were checked; any added another way were not."),
  };
}

/**
 * The check on send_email, in Gmail's words; guardMailboxSend below is the
 * same check for whichever mailbox is configured. Marketing if the operator or model says so,
 * or if it goes to more than the bulk threshold. Anything else is
 * correspondence and passes untouched — a reply to a customer, even one about
 * unsubscribing them, even to someone who has opted out of marketing, is not
 * marketing, and blocking it would be the wrong way round.
 *
 * Gmail's compose window cannot be trimmed from here, so a marketing send with
 * any refused recipient is refused whole, with the counts. The guard sees what
 * the compose window shows: the To/Cc/Bcc chips and the body as the reader
 * will get it.
 */
export function guardGmailSend(
  preview: { to: string; subject: string; body: string },
  marked: boolean | undefined,
  rows: readonly ConsentRow[],
  opts: { threshold: number; where: string },
): Guard {
  return guardMailboxSend(preview, marked, rows, { ...opts, mailbox: "Gmail" });
}

/**
 * The same check for any mailbox the email tools drive — Gmail or Outlook.
 *
 * Outlook adds one thing Gmail's compose window never needed: a recipient can
 * show as a name with no address in sight (a contact, a colleague from the
 * directory). Counting only addresses would let a send to fifty such names
 * pass as correspondence under a threshold of five, and would check consent
 * for the few that showed an address while the rest went unexamined. So the
 * count is whichever is larger — addresses, or recipients on the lines — and
 * a marketing send with any recipient the register cannot see is refused.
 */
export function guardMailboxSend(
  preview: { to: string; subject: string; body: string; recipientCount?: number },
  marked: boolean | undefined,
  rows: readonly ConsentRow[],
  opts: { threshold: number; where: string; mailbox: "Gmail" | "Outlook" },
): Guard {
  const recips = addressesIn(preview.to);
  const counted = Math.max(recips.length, Math.floor(Number(preview.recipientCount) || 0));
  if (marked !== true && counted <= opts.threshold) return { verdict: "pass" };
  if (!recips.length) {
    return { verdict: "refuse", message: "Refused: this is marked as marketing but no recipient address is visible in the compose window." };
  }
  if (counted > recips.length) {
    const hidden = counted - recips.length;
    return {
      verdict: "refuse",
      message:
        `Refused: ${hidden} of ${counted} recipients show a name but no address in the compose window, so the consent ` +
        `register cannot check them. ` +
        (marked === true ? "" : `More than ${opts.threshold} recipients is treated as a marketing send. `) +
        `Nothing was sent. Redraft with the addresses marketing_audience returns, typed as addresses. ${registerHint(opts.where)}`,
    };
  }
  const v = checkConsent(recips, rows);
  if (v.refused.length) {
    return {
      verdict: "refuse",
      message:
        `Refused: ${v.refused.length} of ${recips.length} recipients may not be sent marketing (${refusalSummary(v)}). ` +
        (marked === true ? "" : `More than ${opts.threshold} recipients is treated as a marketing send. `) +
        `Nothing was sent. Redraft with only the addresses marketing_audience returns — and for more than a handful, ` +
        `send through a mailing service rather than this mailbox. ${registerHint(opts.where)}`,
    };
  }
  if (!hasUnsubscribeRoute(preview.body)) return noRoute(opts.where);
  const n = v.allowed.length;
  return {
    verdict: "card",
    input: preview,
    title: `Send this marketing email — ${n} ${n === 1 ? "recipient" : "recipients"} (${basisSummary(v)}); unsubscribe route present`,
    note:
      opts.mailbox === "Gmail"
        ? "Every recipient was checked against the consent register. Gmail is a personal mailbox: bulk marketing " +
          "from it runs into its sending limits and its spam reputation — a mailing service is the proper road."
        : "Every recipient was checked against the consent register. Outlook is a mailbox, not a mailing service: bulk " +
          "marketing from it runs into Microsoft's sending limits and the business domain's spam reputation — a mailing " +
          "service is the proper road.",
  };
}

// ---------------------------------------------------------------------------
// marketing_audience
// ---------------------------------------------------------------------------

/**
 * What the model plans with: the addresses that may be sent marketing, and
 * only counts for the rest — the refused are not named, so they cannot drift
 * back into a send by being in the conversation. No clock in the text, so the
 * Ouroboros guard can still see a repeated question.
 */
export function audienceReport(
  reg: { rows: ConsentRow[]; bad: number; exists: boolean; found: boolean },
  input: { recipients?: unknown; campaign?: unknown },
  where: string,
): string {
  if (!reg.exists || !reg.found) {
    return (
      `No consent register at ${where}${reg.exists ? " — the file has no table with Email and Basis columns" : ""}. ` +
      `Until there is one, every marketing send is refused. skill_read desk-marketer: set it up with the ` +
      `operator (ask about each customer's basis — never assume it). Creating rows with a basis asks the operator.\n\n` +
      REGISTER_TEMPLATE
    );
  }
  const proposed = Array.isArray(input.recipients)
    ? input.recipients.map((x) => String(x))
    : reg.rows.map((r) => r.email);
  const v = checkConsent(proposed, reg.rows);
  const label = String(input.campaign ?? "").trim().slice(0, 80);
  const lines = [
    `Audience${label ? ` for "${label}"` : ""}: ${v.allowed.length} may be sent marketing (${basisSummary(v)}).`,
    v.refused.length
      ? `Refused ${v.refused.length}: ${refusalSummary(v)}. They are not listed — leave them out.`
      : "None refused.",
  ];
  if (reg.bad) lines.push(`${reg.bad} register row(s) have no readable email address and were skipped.`);
  if (v.allowed.some((a) => a.basis === "soft-opt-in")) {
    lines.push("Soft opt-in covers only similar products or services to what they bought or asked about.");
  }
  lines.push("Every marketing send is checked again, and its body needs an unsubscribe route.");
  if (v.allowed.length) lines.push("", ...v.allowed.map((a) => `${a.email} (${a.basis})`));
  return lines.join("\n");
}

export function registerWhere(): string {
  return collapseHome(registerPath());
}
