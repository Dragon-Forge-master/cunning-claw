/**
 * Known hosted MCP endpoints. This is a directory Chris can browse, not
 * discovery from the web — every URL is a vendor's published Streamable HTTP
 * (or legacy SSE) address, the same ones Claude Code's
 * `claude mcp add --transport http` list uses.
 *
 * Listing is not connecting. Connect still writes mcp.json and talks to the
 * server. Do not invent URLs; skip anything that needs a per-account host.
 */
import type { ClaudeMcpEntry } from "./mcp-config.js";

export type CatalogueEntry = {
  id: string;
  label: string;
  blurb: string;
  category: string;
  popular: boolean;
  entry: ClaudeMcpEntry;
};

/** HUD group order — same idea as Claude's "Popular for Sales" sections. */
export const MCP_CATEGORIES = [
  "Create",
  "Code",
  "Work",
  "Docs",
  "Chat",
  "Money",
  "Data",
  "Ship",
  "Search",
  "Sales",
  "Automate",
  "Meetings",
  "AI",
] as const;

function http(
  id: string,
  label: string,
  blurb: string,
  category: (typeof MCP_CATEGORIES)[number],
  url: string,
  popular = false,
): CatalogueEntry {
  return { id, label, blurb, category, popular, entry: { type: "http", url } };
}

function sse(
  id: string,
  label: string,
  blurb: string,
  category: (typeof MCP_CATEGORIES)[number],
  url: string,
): CatalogueEntry {
  return { id, label, blurb, category, popular: false, entry: { type: "sse", url } };
}

function stdio(
  id: string,
  label: string,
  blurb: string,
  category: (typeof MCP_CATEGORIES)[number],
  command: string,
  args: string[],
  env?: Record<string, string>,
  popular = false,
): CatalogueEntry {
  return { id, label, blurb, category, popular, entry: { command, args, env } };
}

export const MCP_CATALOGUE: CatalogueEntry[] = [
  // Popular — names people already know they have.
  http("canva", "Canva", "Designs, exports, brand kit", "Create", "https://mcp.canva.com/mcp", true),
  // GitHub refuses self-registered OAuth clients, so browser sign-in cannot
  // work here. A Personal Access Token in .env as GITHUB_TOKEN does: the
  // header ships only once the token exists (empty auth headers are stripped).
  {
    id: "github",
    label: "GitHub",
    blurb: "Repos, issues, pull requests (needs GITHUB_TOKEN in .env)",
    category: "Code",
    popular: true,
    entry: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    },
  },
  http("notion", "Notion", "Pages, databases, search", "Docs", "https://mcp.notion.com/mcp", true),
  http("figma", "Figma", "Files, components, comments", "Create", "https://mcp.figma.com/mcp", true),
  http("slack", "Slack", "Messages, canvases, workspace search", "Chat", "https://mcp.slack.com/mcp", true),
  http("linear", "Linear", "Issues and projects", "Work", "https://mcp.linear.app/mcp", true),
  http("stripe", "Stripe", "Payments and billing", "Money", "https://mcp.stripe.com", true),
  http("sentry", "Sentry", "Errors, traces, releases", "Code", "https://mcp.sentry.dev/mcp", true),

  // Create
  http("miro", "Miro", "Boards and diagrams", "Create", "https://mcp.miro.com/"),
  http("webflow", "Webflow", "CMS, pages, assets, sites", "Create", "https://mcp.webflow.com/mcp"),
  http("lucid", "Lucid", "Diagrams and whiteboards", "Create", "https://mcp.lucid.app/mcp"),
  http("jotform", "Jotform", "Forms and submissions", "Create", "https://mcp.jotform.com/mcp-app"),
  http("gamma", "Gamma", "Presentations, docs, sites", "Create", "https://mcp.gamma.app/mcp"),
  http("wix", "Wix", "Sites and apps on Wix", "Create", "https://mcp.wix.com/mcp"),
  http("sanity", "Sanity", "Structured content and CMS", "Create", "https://mcp.sanity.io"),
  sse("cloudinary", "Cloudinary", "Images, video, media assets", "Create", "https://asset-management.mcp.cloudinary.com/sse"),
  http("bitly", "Bitly", "Short links and QR codes", "Create", "https://api-ssl.bitly.com/v4/mcp"),

  // Code
  http("context7", "Context7", "Up-to-date library docs for code", "Code", "https://mcp.context7.com/mcp"),
  http("clerk", "Clerk", "Auth, organisations, billing", "Code", "https://mcp.clerk.com/mcp"),
  http("postman", "Postman", "API collections and specs", "Code", "https://mcp.postman.com/minimal"),
  http("microsoft-learn", "Microsoft Learn", "Microsoft docs for development", "Code", "https://learn.microsoft.com/api/mcp"),
  http("jam", "Jam", "Bug reports with screen context", "Code", "https://mcp.jam.dev/mcp"),
  http("graphos", "Apollo GraphOS", "GraphQL docs and schema tools", "Code", "https://mcp.apollographql.com"),
  http("incident-io", "incident.io", "Incidents and on-call", "Code", "https://mcp.incident.io/mcp"),
  http("datadog", "Datadog", "Metrics and logs (US site)", "Code", "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp"),
  http("honeycomb", "Honeycomb", "Observability queries and SLOs", "Code", "https://mcp.honeycomb.io/mcp"),

  // Work
  http("asana", "Asana", "Tasks, projects, goals", "Work", "https://mcp.asana.com/v2/mcp"),
  http("atlassian", "Atlassian", "Jira and Confluence", "Work", "https://mcp.atlassian.com/v1/mcp"),
  http("monday", "monday.com", "Boards and workflows", "Work", "https://mcp.monday.com/mcp"),
  http("clickup", "ClickUp", "Tasks and team work", "Work", "https://mcp.clickup.com/mcp"),
  http("tickettailor", "Ticket Tailor", "Events, tickets, orders", "Work", "https://mcp.tickettailor.ai/mcp"),
  http("devrev", "DevRev", "Company knowledge graph", "Work", "https://api.devrev.ai/mcp/v1"),

  // Docs
  http("box", "Box", "Files and Box AI", "Docs", "https://mcp.box.com"),
  http("egnyte", "Egnyte", "Secure file content", "Docs", "https://mcp-server.egnyte.com/mcp"),
  http("guru", "Guru", "Company knowledge cards", "Docs", "https://mcp.api.getguru.com/mcp"),
  http("craft", "Craft", "Notes and documents", "Docs", "https://mcp.craft.do/my/mcp"),
  http("mem", "Mem", "AI notebook", "Docs", "https://mcp.mem.ai/mcp"),

  // Chat
  http("intercom", "Intercom", "Customer conversations", "Chat", "https://mcp.intercom.com/mcp"),
  http("pylon", "Pylon", "Support issues and tickets", "Chat", "https://mcp.usepylon.com/"),

  // Money
  http("paypal", "PayPal", "Payments platform", "Money", "https://mcp.paypal.com/mcp"),
  sse("square", "Square", "Payments, orders, catalog", "Money", "https://mcp.squareup.com/sse"),
  http("ramp", "Ramp", "Spend and cards", "Money", "https://ramp-mcp-remote.ramp.com/mcp"),
  http("mercury", "Mercury", "Business banking", "Money", "https://mcp.mercury.com/mcp"),
  http("gocardless", "GoCardless", "Direct debit payments", "Money", "https://mcp.gocardless.com"),
  // Official Xero server is local stdio, not a hosted mcp.xero.com.
  stdio(
    "xero",
    "Xero",
    "Invoices, contacts, payroll (official @xeroapi/xero-mcp-server; XERO_CLIENT_ID/SECRET in .env)",
    "Money",
    "npx",
    ["-y", "@xeroapi/xero-mcp-server@latest"],
    { XERO_CLIENT_ID: "${XERO_CLIENT_ID}", XERO_CLIENT_SECRET: "${XERO_CLIENT_SECRET}" },
    true,
  ),

  // Data
  http("supabase", "Supabase", "Database, auth, storage", "Data", "https://mcp.supabase.com/mcp"),
  http("airtable", "Airtable", "Bases and records", "Data", "https://mcp.airtable.com/mcp"),
  http("neon", "Neon", "Serverless Postgres", "Data", "https://mcp.neon.tech/mcp"),
  http("prisma", "Prisma", "Database schema and queries", "Data", "https://mcp.prisma.io/mcp"),
  http("amplitude", "Amplitude", "Product analytics", "Data", "https://mcp.amplitude.com/mcp"),
  http("mixpanel", "Mixpanel", "Events and funnels", "Data", "https://mcp.mixpanel.com/mcp"),
  http("posthog", "PostHog", "Product analytics and flags", "Data", "https://mcp.posthog.com/mcp"),
  http("bigquery", "BigQuery", "Google Cloud analytics", "Data", "https://bigquery.googleapis.com/mcp"),
  http("similarweb", "Similarweb", "Web and market data", "Data", "https://mcp.similarweb.com"),
  http("motherduck", "MotherDuck", "DuckDB in the cloud", "Data", "https://api.motherduck.com/mcp"),
  http("planetscale", "PlanetScale", "Postgres and MySQL", "Data", "https://mcp.pscale.dev/mcp/planetscale"),

  // Ship
  http("vercel", "Vercel", "Projects and deployments", "Ship", "https://mcp.vercel.com"),
  http("cloudflare", "Cloudflare", "Workers, storage, bindings", "Ship", "https://bindings.mcp.cloudflare.com/mcp"),
  http("netlify", "Netlify", "Sites, deploys, forms", "Ship", "https://netlify-mcp.netlify.app/mcp"),
  http("godaddy", "GoDaddy", "Domain search and availability", "Ship", "https://api.godaddy.com/v1/domains/mcp"),
  http("wordpress-com", "WordPress.com", "WordPress.com sites", "Ship", "https://public-api.wordpress.com/wpcom/v2/mcp/v1"),

  // Search
  http("tavily", "Tavily", "Web search for agents", "Search", "https://mcp.tavily.com/mcp"),
  http("exa", "Exa", "Web and code-docs search", "Search", "https://mcp.exa.ai/mcp"),
  http("ahrefs", "Ahrefs", "SEO and search analytics", "Search", "https://api.ahrefs.com/mcp/mcp"),
  http("consensus", "Consensus", "Scientific paper search", "Search", "https://mcp.consensus.app/mcp"),

  // Sales
  http("hubspot", "HubSpot", "CRM, deals, contacts", "Sales", "https://mcp.hubspot.com/anthropic"),
  http("attio", "Attio", "CRM records and lists", "Sales", "https://mcp.attio.com/mcp"),
  http("mailerlite", "MailerLite", "Email marketing", "Sales", "https://mcp.mailerlite.com/mcp"),
  http("klaviyo", "Klaviyo", "Email and SMS campaigns", "Sales", "https://mcp.klaviyo.com/mcp?include-mcp-app=true"),
  http("clay", "Clay", "Prospecting and enrichment", "Sales", "https://api.clay.com/v3/mcp"),
  http("zoominfo", "ZoomInfo", "Contacts and accounts", "Sales", "https://mcp.zoominfo.com/mcp"),
  http("outreach", "Outreach", "Sales sequences and pipeline", "Sales", "https://api.outreach.io/mcp/"),
  http("harmonic", "Harmonic", "Company and people research", "Sales", "https://mcp.api.harmonic.ai"),

  // Automate
  http("zapier", "Zapier", "8,000+ apps via Zapier", "Automate", "https://mcp.zapier.com/api/v1/connect"),
  http("make", "Make", "Scenarios and automations", "Automate", "https://mcp.make.com"),
  http("ifttt", "IFTTT", "Applets across 1,000+ apps", "Automate", "https://ifttt.com/mcp"),

  // Meetings
  http("granola", "Granola", "Meeting notes", "Meetings", "https://mcp.granola.ai/mcp"),
  http("circleback", "Circleback", "Meeting context and search", "Meetings", "https://app.circleback.ai/api/mcp"),
  http("krisp", "Krisp", "Transcripts and meeting notes", "Meetings", "https://mcp.krisp.ai/mcp"),

  // AI
  http("hugging-face", "Hugging Face", "Models, Hub, Gradio apps", "AI", "https://huggingface.co/mcp"),
];

export function catalogueById(id: string): CatalogueEntry | undefined {
  return MCP_CATALOGUE.find((c) => c.id === id);
}
