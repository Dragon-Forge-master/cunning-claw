/**
 * The connector guide — how each catalogue connector signs in, and the steps
 * to get it working, taken from MCP_CATALOGUE rather than from the model's
 * memory.
 *
 * The operator asked for the claw to be "the best advisor on how to set up the
 * connectors, and on teaching them". Before this, he could add a server
 * (mcp_add) and open a sign-in (mcp_login), but had no view of the catalogue
 * itself: asked "how do I connect Xero?", he had nothing to answer from but
 * recall, and the catalogue's own rule is "do not invent URLs". So every
 * fact here — the address, whether it signs in through a browser or a pasted
 * token, which .env names a local server reads — is read from the entry the
 * CONNECT sheet uses, and the advice is the same as the buttons.
 *
 * "Teaching" a connector is the last step, not a feature of the connector:
 * MCP servers do not learn. What the claw can keep is how this operator uses
 * one — written down as a skill once a job has gone the way they wanted.
 *
 * Pure: the live status and catalogue are passed in, so the text is
 * deterministic for tests and identical for identical state (the Ouroboros
 * guard compares results).
 */
import { MCP_CATALOGUE, MCP_CATEGORIES, type CatalogueEntry } from "./mcp-catalog.js";

export type GuideStatus = { id: string; status: string; tools: number };

/** Where to make a token, for the vendors whose token page we know for sure. */
const TOKEN_PAGES: Record<string, string> = {
  github: "https://github.com/settings/personal-access-tokens/new (a fine-grained token, limited to the repositories you choose)",
  xero: "https://developer.xero.com/app/manage (the official Xero MCP server's README says which kind of app to create)",
};

type SignIn = "browser" | "token" | "local-keys" | "local";

export function signInKind(c: CatalogueEntry): SignIn {
  if (c.tokenEnv) return "token";
  const e = c.entry as { url?: string; env?: Record<string, string> };
  if (e.url) return "browser";
  return Object.keys(e.env ?? {}).length ? "local-keys" : "local";
}

/** The .env names a connector needs, from its own ${VAR} references. */
export function keysNeeded(c: CatalogueEntry): string[] {
  if (c.tokenEnv) return [c.tokenEnv];
  const env = (c.entry as { env?: Record<string, string> }).env ?? {};
  const names = new Set<string>();
  for (const v of Object.values(env)) for (const m of String(v).matchAll(/\$\{([A-Z0-9_]+)\}/g)) names.add(m[1]);
  return [...names];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Exact id or name first; otherwise every entry whose name, blurb or category matches all the words. */
export function findConnectors(query: string, catalogue: CatalogueEntry[] = MCP_CATALOGUE): CatalogueEntry[] {
  const q = norm(query);
  if (!q) return [];
  const exact = catalogue.filter((c) => norm(c.id) === q || norm(c.label) === q);
  if (exact.length) return exact;
  const words = q.split(" ");
  return catalogue.filter((c) => {
    const hay = norm(`${c.id} ${c.label} ${c.blurb} ${c.category}`);
    return words.every((w) => hay.includes(w));
  });
}

function statusLine(c: CatalogueEntry, live: GuideStatus | undefined): string {
  if (!live) return "Not added on this machine yet.";
  if (live.status === "connected") return `Connected, with ${live.tools} tool${live.tools === 1 ? "" : "s"}.`;
  if (live.status === "needs_auth") return c.tokenEnv ? `Added, but its key (${c.tokenEnv}) is missing or refused.` : "Added, waiting for you to sign in.";
  if (live.status === "failed") return "Added, but the last connection attempt failed — mcp_status has the reason.";
  return `Added, status: ${live.status}.`;
}

/** The snippet mcp_add takes for this entry: the catalogue's own, never a reconstruction. */
export function addSnippet(c: CatalogueEntry): string {
  return JSON.stringify({ mcpServers: { [c.id]: c.entry } });
}

export function guideFor(c: CatalogueEntry, live: GuideStatus | undefined): string {
  const kind = signInKind(c);
  const keys = keysNeeded(c);
  const lines: string[] = [
    `CONNECTOR GUIDE — ${c.label} (${c.id}) · ${c.category}`,
    c.blurb,
    `On this machine: ${statusLine(c, live)}`,
    "",
  ];

  if (kind === "browser") {
    lines.push("How it signs in: through the vendor's own sign-in page in the browser. There is no key to copy, and the claw never sees the password.");
  } else if (kind === "token") {
    lines.push(`How it signs in: a token from the vendor, saved on the KEYS page as ${keys[0]}. A browser sign-in cannot work for this one.`);
  } else if (kind === "local-keys") {
    lines.push(`How it signs in: it is a small program that runs on this machine, and reads ${keys.join(" and ")} from the KEYS page.`);
  } else {
    lines.push("How it signs in: it does not — it is a small program that runs on this machine and needs no account.");
  }
  if (kind === "local" || kind === "local-keys") {
    const cmd = (c.entry as { command?: string }).command;
    if (cmd === "npx") lines.push("The first start downloads the program, so it needs the internet once and can take a minute.");
  }

  lines.push("", "Steps, one at a time — check each before the next:");
  let n = 1;
  if (kind === "token" || kind === "local-keys") {
    const page = TOKEN_PAGES[c.id];
    lines.push(
      `${n++}. Make the key${keys.length > 1 ? "s" : ""} in your ${c.label} account${page ? `: ${page}` : " — usually under settings, called an API key or access token"}. ` +
        "Give it the least access that does the job.",
    );
    lines.push(`${n++}. Paste ${keys.join(" and ")} on the KEYS page. Never paste a key into the chat — it is the one place it should not go.`);
  }
  lines.push(
    `${n++}. Add it: CONNECT → ${c.label} → Connect (Retry, if it was added before). Or say the word and the claw adds it with mcp_add, using the catalogue's own entry.`,
  );
  if (kind === "browser") {
    lines.push(`${n++}. Sign in: a browser tab opens on ${c.label}'s page. Sign in there and allow access. If no tab opens, the sign-in link is shown on the CONNECT sheet (or ask for mcp_login).`);
  }
  lines.push(`${n++}. Check: mcp_status should show it connected, with its tools listed.`);
  lines.push(
    `${n++}. First job: something that only reads — list, search, look up. Anything that creates, sends, pays or publishes stops for your approval, and the card says what it will do.`,
  );
  lines.push(
    `${n++}. Teach the claw: connectors do not learn, but the claw can. Once a job has gone the way you like, save how you like it done as a skill (skill_write) — names, defaults, what to check first — and it is done that way every time after.`,
  );

  lines.push("", `For mcp_add: ${addSnippet(c)}`);
  return lines.join("\n");
}

export function overview(catalogue: CatalogueEntry[], states: GuideStatus[]): string {
  const connected = states.filter((s) => s.status === "connected").map((s) => s.id);
  const lines = [
    `CONNECTOR GUIDE — ${catalogue.length} connectors in the catalogue. Connected here: ${connected.length ? connected.join(", ") : "none yet"}.`,
    "",
    "Three ways they sign in: a browser sign-in (most), a token pasted on the KEYS page (GitHub and a few others), or a local program that needs no account.",
    "Ask connector_guide with a name (\"xero\"), a category (\"money\"), or what you want to do (\"invoices\").",
    "Email (Gmail or Outlook) is not a connector: it is the built-in email tools in the claw's own Chrome — ask connector_guide \"outlook\" or \"gmail\".",
    "",
  ];
  for (const cat of MCP_CATEGORIES) {
    const inCat = catalogue.filter((c) => c.category === cat);
    if (!inCat.length) continue;
    lines.push(`${cat}: ${inCat.map((c) => c.label).join(", ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mail is not a connector
// ---------------------------------------------------------------------------

/**
 * "How do I connect Outlook?" found nothing in the catalogue and was told it
 * might work as a custom server — when the answer is the built-in email
 * tools and one sign-in in the claw's own Chrome. Asked about a mailbox, the
 * guide answers about the mailbox. The facts are passed in, so the text is
 * the same for the same setup.
 */
export type MailFacts = {
  /** describeMailChoice of the configured mailbox, or the config's own error. */
  configured: string;
  provider: "gmail" | "outlook" | null;
  profileDir: string;
};

const MAIL_QUERY = /\b(outlook|hotmail|live\.com|office ?365|microsoft ?365|m365|o365|exchange|owa|gmail|google ?mail)\b/i;
const OUTLOOK_QUERY = /\b(outlook|hotmail|live\.com|office ?365|microsoft ?365|m365|o365|exchange|owa)\b/i;

export function mailGuide(query: string, facts: MailFacts): string | null {
  if (!MAIL_QUERY.test(query)) return null;
  const outlook = OUTLOOK_QUERY.test(query);
  const chosen = facts.provider === (outlook ? "outlook" : "gmail");
  const lines = [
    `MAIL GUIDE — ${outlook ? "Outlook on the web (Microsoft 365, Outlook.com, Hotmail)" : "Gmail"}`,
    "Not a connector: the built-in email tools (check_email, read_email, draft_email, send_email, email_action) drive it in Cunning Claw's own Chrome. " +
      "There is no key to make and no app to register, and the claw never sees the password.",
    `On this machine: email is ${facts.configured}.`,
    "",
    "Steps, one at a time — check each before the next:",
  ];
  let n = 1;
  if (!chosen) {
    lines.push(
      outlook
        ? `${n++}. Choose Outlook once: in claw.config.json, "email": { "provider": "outlook", "outlook": "work" } for a work or school account on Microsoft 365 (outlook.office.com), or "outlook": "personal" for Outlook.com or Hotmail (outlook.live.com). Restart the claw. Or name it per job: check_email with provider outlook.`
        : `${n++}. Choose Gmail: in claw.config.json, "email": { "provider": "gmail" } (it is also the default when there is no email setting). Restart the claw. Or name it per job: check_email with provider gmail.`,
    );
  }
  lines.push(
    `${n++}. Sign in once: ask the claw to check your email. A tab opens in Cunning Claw's own Chrome (profile ${facts.profileDir}) — a separate window from your everyday browser, so being signed in there does not count. ` +
      (outlook
        ? "Sign in with your Microsoft account in that window, approve the prompt on your phone if your organisation uses one, and choose to stay signed in if it offers."
        : "Sign in with your Google account in that window."),
    `${n++}. Check: ask again — check_email lists your inbox. If it says it could not find the message list, the page was still loading or ${outlook ? "Microsoft" : "Google"} has changed it; the message names what was missing.`,
    `${n++}. First job: something that only reads. Sending always stops for your approval, and so does ${outlook ? "delete" : "trash or spam"}.`,
  );
  if (outlook) {
    lines.push(
      "",
      "Good to know: the claw presses Outlook's buttons by name, and uses keyboard shortcuts only when a button is not found — the \"Outlook\" set (Settings → General → Accessibility → Keyboard shortcuts) is the one it knows. " +
        "A work account's IT admin can block sign-in from a new browser; if the sign-in page says so, that switch is theirs. " +
        "Calendar and OneDrive are not part of this — they need \"Connect Outlook\" through Microsoft Graph, which is planned, not built.",
    );
  } else {
    lines.push("", "Good to know: Gmail's keyboard shortcuts must be on (Settings → See all settings → General → Keyboard shortcuts → On).");
  }
  return lines.join("\n");
}

export function connectorGuide(
  query: string | undefined,
  states: GuideStatus[],
  catalogue: CatalogueEntry[] = MCP_CATALOGUE,
  mail?: MailFacts,
): string {
  const q = String(query ?? "").trim();
  if (!q) return overview(catalogue, states);
  const mailText = mail ? mailGuide(q, mail) : null;
  if (mailText) return mailText;
  const hits = findConnectors(q, catalogue);
  if (hits.length === 1) return guideFor(hits[0], states.find((s) => s.id === hits[0].id));
  if (hits.length > 1) {
    return [
      `CONNECTOR GUIDE — ${hits.length} connectors match "${q}". Ask again with one id for its steps:`,
      ...hits.slice(0, 15).map((c) => `- ${c.id} — ${c.label}: ${c.blurb}`),
      ...(hits.length > 15 ? [`…and ${hits.length - 15} more; narrow the words.`] : []),
    ].join("\n");
  }
  return (
    `CONNECTOR GUIDE — nothing in the catalogue matches "${q}". It may still work as a custom server ` +
    "(CONNECT → Add your own) if the vendor publishes an MCP address; never guess one."
  );
}
