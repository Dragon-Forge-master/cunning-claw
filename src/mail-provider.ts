/**
 * Which mailbox the email tools drive.
 *
 * Email was Gmail-only, and a great many Welsh small businesses run on
 * Microsoft 365. Outlook on the web is driven the same way Gmail is — in the
 * claw's own signed-in Chrome, no keys, no app registration — so the five email
 * tools (check_email, read_email, draft_email, send_email, email_action) stay
 * the same five and take the mailbox from here. A parallel set of outlook_*
 * tools was the other road and was not taken: the contracts are the same shape
 * (list, read by index, draft without sending, send behind a card, act on one
 * conversation), and every safety rule is written against these names —
 * routing's UNTRUSTED_TOOLS, the work order's committing list, the injection
 * scanner's tool bait, Learn mode's scenarios. A second set would have had to
 * be added to each, and the one that was missed would be the hole.
 *
 * The operator picks the mailbox once in claw.config.json (`email.provider`);
 * a call may name one (`provider`) for an operator who has both. The model
 * names a provider, never an address: the Outlook URL comes from config and
 * must be an Outlook host.
 *
 * A leaf apart from config: tools.ts, browser.ts, agent.ts, the doctor and the
 * connector guide all read it, and it reads none of them.
 */
import { config } from "./config.js";

export type MailProvider = "gmail" | "outlook";
export type OutlookFlavour = "work" | "personal";

export type MailChoice =
  | { provider: "gmail"; label: "Gmail"; home: string }
  | { provider: "outlook"; label: "Outlook"; flavour: OutlookFlavour; home: string };

export type EmailConfig = { provider?: string; outlook?: string; outlookUrl?: string } | undefined;

/** Where each flavour's mailbox lives. Folders hang off these (src/outlook.ts). */
export const OUTLOOK_HOMES: Record<OutlookFlavour, string> = {
  work: "https://outlook.office.com/mail/",
  personal: "https://outlook.live.com/mail/0/",
};

export const GMAIL_HOME = "https://mail.google.com/mail/u/0/#inbox";

/**
 * Hosts Outlook on the web is served from. outlook.office365.com is the older
 * Microsoft 365 address and outlook.cloud.microsoft the newer one; both
 * redirect into the same app, so a configured URL on either is accepted.
 */
export const OUTLOOK_HOSTS = [
  "outlook.office.com",
  "outlook.office365.com",
  "outlook.cloud.microsoft",
  "outlook.live.com",
];

function outlookHome(cfg: NonNullable<EmailConfig>): { ok: true; home: string; flavour: OutlookFlavour } | { ok: false; message: string } {
  const flavourRaw = String(cfg.outlook ?? "work").trim().toLowerCase();
  const flavour: OutlookFlavour | null =
    flavourRaw === "work" || flavourRaw === "business" || flavourRaw === "microsoft365" || flavourRaw === "m365" ? "work"
      : flavourRaw === "personal" || flavourRaw === "home" || flavourRaw === "hotmail" || flavourRaw === "outlook.com" ? "personal"
        : null;
  if (!flavour) {
    return {
      ok: false,
      message: `email.outlook is "${cfg.outlook}" in claw.config.json — use "work" (Microsoft 365, outlook.office.com) or "personal" (Outlook.com / Hotmail, outlook.live.com).`,
    };
  }
  if (cfg.outlookUrl) {
    let u: URL;
    try {
      u = new URL(String(cfg.outlookUrl));
    } catch {
      return { ok: false, message: `email.outlookUrl "${cfg.outlookUrl}" is not a URL. Remove it, or give the mailbox address, e.g. ${OUTLOOK_HOMES.work}` };
    }
    if (u.protocol !== "https:" || !OUTLOOK_HOSTS.includes(u.hostname.toLowerCase())) {
      return {
        ok: false,
        message: `email.outlookUrl must be https on an Outlook host (${OUTLOOK_HOSTS.join(", ")}); "${u.hostname}" is not one. The email tools only ever open Outlook itself.`,
      };
    }
    const href = u.origin + (u.pathname.endsWith("/") ? u.pathname : u.pathname + "/");
    return { ok: true, home: href, flavour: u.hostname === "outlook.live.com" ? "personal" : "work" };
  }
  return { ok: true, home: OUTLOOK_HOMES[flavour], flavour };
}

/**
 * The mailbox for this call: the call's own `provider` if it names one, else
 * the config's, else Gmail. A value it does not know is refused with the fix,
 * never quietly read as Gmail — an operator who typed "outlok" must not find
 * their Google account answering instead.
 */
export function resolveMailProvider(
  arg?: unknown,
  cfg: EmailConfig = config.email,
): { ok: true; choice: MailChoice } | { ok: false; message: string } {
  const fromCall = arg === undefined || arg === null || arg === "" ? "" : String(arg).trim().toLowerCase();
  const fromConfig = String(cfg?.provider ?? "").trim().toLowerCase();
  const raw = fromCall || fromConfig || "gmail";
  const where = fromCall ? "provider" : "email.provider in claw.config.json";
  if (raw === "gmail" || raw === "google") {
    return { ok: true, choice: { provider: "gmail", label: "Gmail", home: GMAIL_HOME } };
  }
  if (raw === "outlook" || raw === "microsoft" || raw === "office365" || raw === "microsoft365" || raw === "hotmail") {
    const home = outlookHome(cfg ?? {});
    if (!home.ok) return home;
    return { ok: true, choice: { provider: "outlook", label: "Outlook", flavour: home.flavour, home: home.home } };
  }
  return { ok: false, message: `${where} is "${raw}". Use "gmail" or "outlook".` };
}

/** One line for the doctor, the prompt and the connector guide. Non-volatile. */
export function describeMailChoice(choice: MailChoice): string {
  if (choice.provider === "gmail") return "Gmail (mail.google.com)";
  const host = new URL(choice.home).host;
  return `Outlook on the web — ${choice.flavour === "work" ? "work or school, Microsoft 365" : "personal, Outlook.com / Hotmail"} (${host})`;
}

// ---------------------------------------------------------------------------
// email_action across the two mailboxes
// ---------------------------------------------------------------------------

/** Every name the email_action schema accepts. Gmail's own, then the Outlook words. */
export const EMAIL_ACTION_NAMES = [
  "archive", "star", "unstar", "read", "unread", "back", "spam", "trash", "select", "expand",
  "flag", "unflag", "delete",
] as const;

export const OUTLOOK_ACTION_NAMES = ["archive", "read", "unread", "flag", "unflag", "delete"] as const;
export type OutlookAction = (typeof OUTLOOK_ACTION_NAMES)[number];

/**
 * The same intent in each mailbox's own word. Gmail stars and trashes, Outlook
 * flags and deletes (to Deleted Items); either word works on either mailbox so
 * the model does not have to remember which one it is talking to.
 */
export function normaliseEmailAction(
  provider: MailProvider,
  action: string,
): { ok: true; action: string } | { ok: false; message: string } {
  const a = String(action ?? "").trim().toLowerCase();
  if (provider === "gmail") {
    const mapped = a === "flag" ? "star" : a === "unflag" ? "unstar" : a === "delete" ? "trash" : a;
    return { ok: true, action: mapped };
  }
  const mapped = a === "star" ? "flag" : a === "unstar" ? "unflag" : a === "trash" ? "delete" : a;
  if ((OUTLOOK_ACTION_NAMES as readonly string[]).includes(mapped)) return { ok: true, action: mapped };
  return {
    ok: false,
    message:
      `Outlook does not take "${a}" from email_action. It takes: ${OUTLOOK_ACTION_NAMES.join(", ")} ` +
      "(star/unstar mean flag/unflag, trash means delete to Deleted Items). Nothing was done.",
  };
}

/**
 * Which actions stop for a card. Gmail's spam and trash always have; Outlook's
 * delete moves to Deleted Items, which is the same act as Gmail's trash and
 * asks the same way. Checked after normalising, so "delete" on Gmail is trash
 * and asks, and "trash" on Outlook is delete and asks.
 */
export function emailActionAsks(provider: MailProvider, normalised: string): boolean {
  if (provider === "gmail") return normalised === "spam" || normalised === "trash";
  return normalised === "delete";
}

// ---------------------------------------------------------------------------
// check_email's view across the two mailboxes
// ---------------------------------------------------------------------------

export const EMAIL_VIEW_NAMES = [
  "inbox", "sent", "drafts", "starred", "snoozed", "spam", "all", "important",
  "junk", "deleted", "archive", "flagged",
] as const;

/**
 * A view in Gmail's own vocabulary, for the Outlook-only names. Gmail's
 * existing names pass through to parseGmailView exactly as before; the new
 * ones become the Gmail view or search that means the same.
 */
export function gmailViewFor(view?: string): { view?: string; query?: string } {
  const v = String(view ?? "").trim().toLowerCase();
  if (v === "junk") return { view: "spam" };
  if (v === "flagged") return { view: "starred" };
  if (v === "archive") return { view: "all" };
  if (v === "deleted") return { query: "in:trash" };
  return { view };
}
