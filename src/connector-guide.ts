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
    "",
  ];
  for (const cat of MCP_CATEGORIES) {
    const inCat = catalogue.filter((c) => c.category === cat);
    if (!inCat.length) continue;
    lines.push(`${cat}: ${inCat.map((c) => c.label).join(", ")}`);
  }
  return lines.join("\n");
}

export function connectorGuide(
  query: string | undefined,
  states: GuideStatus[],
  catalogue: CatalogueEntry[] = MCP_CATALOGUE,
): string {
  const q = String(query ?? "").trim();
  if (!q) return overview(catalogue, states);
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
