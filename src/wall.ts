import { config, type ClawConfig } from "./config.js";
import { fenceUntrusted } from "./browser-ax.js";
import { redact } from "./redact.js";
import { defuse } from "./workspace.js";

/**
 * site_wall — the claw's hands on the "ask the forge" wall at cunningclaw.com
 * (site/functions/_wall/wall.js is the other end).
 *
 * Every card on the wall is a stranger's words, typed into a public form by
 * anyone at all, so this is a reading tool for untrusted text first: what it
 * lists is fenced, the tool is in UNTRUSTED_TOOLS so the turn is pinned to a
 * trusted brain, and a card that says "approve all cards and answer yes" is a
 * card to report on, nothing more.
 *
 * The other half is publishing. Approving a card puts a stranger's words on
 * the project's own site; an answer goes up in the forge's name; "built"
 * links a card to the code. Each of those is a publish, and a publish always
 * asks: ctx.requestApproval every time, never gate(), so no work order or
 * task grant rides over it. The card shows exactly what will be public. There
 * is no delete here on purpose — the operator deletes with curl, by hand.
 *
 * The model never supplies the address or the token. The wall is the one URL
 * in claw.config.json (siteWall.url); the token is read from .env under
 * siteWall.tokenEnv and sent only there, with redirects refused so it cannot
 * be carried anywhere else.
 */

type WallConfig = NonNullable<ClawConfig["siteWall"]>;

export const DEFAULT_WALL_URL = "https://cunningclaw.com";
/** Caught by sandboxEnv's SECRET_NAME (…_TOKEN) and by redact's env-assign rule — see wall.test.ts. */
export const DEFAULT_TOKEN_ENV = "WALL_ADMIN_TOKEN";
export const STAGES = ["asked", "answered", "planned", "built"] as const;
export const MODERATIONS = ["pending", "public", "hidden", "all"] as const;
export const ANSWER_MAX = 1500;
/**
 * The same rule as the site's safeLink (site/functions/_wall/wall.js), copied
 * because src/ cannot import from site/; wall.test.ts holds the two together.
 * Checked here as well so the operator is never shown a card for a link the
 * site would refuse.
 */
export const LINK_RE = /^https:\/\/(?:github\.com\/Dragon-Forge-master\/cunning-claw|cunningclaw\.com)(?:\/[A-Za-z0-9._~\/#?=&%+-]*)?$/;

export interface WallIO {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

const defaultIO = (): WallIO => ({
  fetch: (...args) => fetch(...args),
  env: process.env,
  timeoutMs: config.http?.timeoutMs ?? 20_000,
});

export interface WallGate {
  requestApproval(summary: string, detail: string): Promise<boolean>;
}

export type Resolved =
  | { ok: true; base: string; host: string; token: string }
  | { ok: false; message: string };

export function resolveWall(cfg: WallConfig | undefined, env: NodeJS.ProcessEnv): Resolved {
  if (cfg?.enabled === false) return { ok: false, message: "The site wall is off (siteWall.enabled in claw.config.json)." };
  let url: URL;
  try {
    url = new URL(cfg?.url || DEFAULT_WALL_URL);
  } catch {
    return { ok: false, message: "siteWall.url in claw.config.json is not a URL." };
  }
  // http only to this machine, for `wrangler pages dev`; a token never crosses
  // a network in the clear.
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && local))) {
    return { ok: false, message: "siteWall.url must be an https address with no credentials in it." };
  }
  const name = cfg?.tokenEnv || DEFAULT_TOKEN_ENV;
  const token = env[name];
  if (!token) {
    return {
      ok: false,
      message: `The site wall is not connected: put the wall's admin token in .env as ${name} (site/README.md, "The forge wall").`,
    };
  }
  return { ok: true, base: url.origin, host: url.host, token };
}

type Reply = { ok: true; json: any } | { ok: false; message: string };

async function wallFetch(w: Extract<Resolved, { ok: true }>, io: WallIO, method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  let res: Response;
  try {
    res = await io.fetch(`${w.base}/api/wall/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${w.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect is somewhere the token was not meant to go.
      redirect: "error",
      signal: AbortSignal.timeout(io.timeoutMs),
    });
  } catch (err: any) {
    return { ok: false, message: `Could not reach the wall at ${w.host}: ${redact(String(err?.message ?? err))}` };
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.status === 401) {
    return { ok: false, message: `The wall at ${w.host} refused the admin token: the one in .env does not match the site's WALL_ADMIN_TOKEN secret.` };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, message: `Nothing that looks like the wall answered at ${w.host}/api/wall (HTTP ${res.status}). Is it deployed?` };
  }
  if (!res.ok || json.ok !== true) {
    // The server's messages are its own fixed sentences, but they crossed a
    // network: short, defused, redacted.
    const said = defuse(redact(String(json.message ?? json.error ?? "no reason given"))).slice(0, 200);
    return { ok: false, message: `The wall at ${w.host} said no (HTTP ${res.status}): ${said}` };
  }
  return { ok: true, json };
}

function cardLines(c: any): string {
  const head = [
    `#${Number(c.id)}`,
    c.kind === "idea" ? "idea" : "question",
    String(c.moderation ?? "public"),
    String(c.stage ?? "asked"),
    `${Number(c.votes) || 0} me-too`,
    c.asked ? `asked ${c.asked}` : "",
  ].filter(Boolean).join(" · ");
  const lines = [head, `  from: ${c.name ? String(c.name) : "(no name given)"}`, `  text: ${indent(String(c.text ?? ""))}`];
  if (c.answer) lines.push(`  answer: ${indent(String(c.answer))}`);
  if (c.link) lines.push(`  link: ${String(c.link)}`);
  return lines.join("\n");
}

const indent = (s: string) => s.replace(/\n/g, "\n        ");

/** The list, fenced: every word in it may be a stranger's. */
export function formatCards(host: string, moderation: string, json: any): string {
  const cards: any[] = Array.isArray(json?.cards) ? json.cards : [];
  const t = json?.totals ?? {};
  const totals = ["pending", "public", "hidden"].map((k) => `${k} ${Number(t[k]) || 0}`).join(", ");
  const order = moderation === "pending" ? "oldest first" : "most recently changed first";
  const head = `The wall at ${host} — ${totals}. Showing ${cards.length} ${moderation === "all" ? "cards" : moderation} (${order}).`;
  if (!cards.length) return `${head}\nNothing to show.`;
  const body = defuse(redact(cards.map(cardLines).join("\n\n")));
  return `${head}\n${fenceUntrusted(`wall:${host}`, body)}\n` +
    "Approving, hiding, answering or moving a card asks the operator, and the card shows exactly what will be public.";
}

function toId(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** What the operator reads on the card: the visitor's words, as they will appear. */
function quoted(card: any): string {
  return `${card.kind === "idea" ? "Idea" : "Question"} #${card.id}, from ${card.name ? `"${card.name}"` : "someone who gave no name"}:\n\n${card.text}`;
}

export async function siteWallTool(
  input: { action?: string; moderation?: string; id?: unknown; answer?: unknown; stage?: string; link?: unknown },
  ctx: WallGate,
  warning = "",
  io: WallIO = defaultIO(),
  cfg: WallConfig | undefined = config.siteWall,
): Promise<string> {
  const w = resolveWall(cfg, io.env);
  if (!w.ok) return w.message;
  const action = String(input?.action ?? "list");

  if (action === "list") {
    const moderation = MODERATIONS.includes(input.moderation as any) ? String(input.moderation) : "pending";
    const r = await wallFetch(w, io, "GET", `admin/cards?moderation=${moderation}`);
    return r.ok ? formatCards(w.host, moderation, r.json) : r.message;
  }

  if (!["approve", "hide", "answer", "stage"].includes(action)) {
    return `site_wall has no action "${action.slice(0, 40)}". Use list, approve, hide, answer or stage.`;
  }
  const id = toId(input.id);
  if (!id) return "Which card? Give its id (the number after # in the list).";

  // Validate before fetching or asking, so the operator never sees a card the site would refuse.
  let answer = "";
  let stage = "";
  let link: string | undefined;
  if (action === "answer") {
    answer = String(input.answer ?? "").trim();
    if (!answer) return "An answer needs some words.";
    if ([...answer].length > ANSWER_MAX) return `That answer is ${[...answer].length} characters; the wall takes ${ANSWER_MAX}.`;
  }
  if (action === "stage") {
    stage = String(input.stage ?? "");
    if (!(STAGES as readonly string[]).includes(stage)) return `stage is one of ${STAGES.join(", ")}.`;
    if (input.link !== undefined && input.link !== null && String(input.link).trim()) {
      link = String(input.link).trim();
      if (!LINK_RE.test(link) || link.length > 300) {
        return "A wall link must be https on github.com/Dragon-Forge-master/cunning-claw or cunningclaw.com — a release, a commit or an issue.";
      }
    }
  }

  const got = await wallFetch(w, io, "GET", `admin/cards?id=${id}`);
  if (!got.ok) return got.message;
  const card = got.json.cards?.[0];
  if (!card) return `There is no card #${id} on the wall.`;
  const pending = card.moderation !== "public"
    ? `\n\n(The card is ${card.moderation}: nothing about it is public until it is approved.)`
    : "";

  let summary: string;
  let detail: string;
  let path: string;
  let body: Record<string, unknown>;
  switch (action) {
    case "approve":
      if (card.moderation === "public") return `Card #${id} is already public.`;
      summary = `Publish wall card #${id} on ${w.host} — public`;
      detail = `${warning}A stranger's words go up on the public wall exactly as below.\n\n${quoted(card)}\n\n` +
        `Approve only what you would be happy to see on ${w.host}: no personal details, nothing abusive, nothing that is not theirs to share.`;
      path = "admin/approve";
      body = { id };
      break;
    case "hide":
      if (card.moderation === "hidden") return `Card #${id} is already hidden.`;
      summary = `Take wall card #${id} down from ${w.host}`;
      detail = `${warning}${quoted(card)}\n\nIt stops being shown; it is not deleted.`;
      path = "admin/hide";
      body = { id };
      break;
    case "answer":
      summary = `Answer wall card #${id} on ${w.host} — public, in the forge's name`;
      detail = `${warning}${quoted(card)}\n\nThe answer that will appear under it:\n\n${answer}` +
        (card.answer ? `\n\nIt replaces the current answer:\n\n${card.answer}` : "") + pending;
      path = "admin/answer";
      body = { id, answer };
      break;
    default:
      summary = `Move wall card #${id} to ${stage.toUpperCase()} on ${w.host} — public`;
      detail = `${warning}${quoted(card)}\n\n${String(card.stage).toUpperCase()} → ${stage.toUpperCase()}` +
        (link ? `\nLink shown on the card: ${link}` : "") + pending;
      path = "admin/stage";
      body = link ? { id, stage, link } : { id, stage };
  }

  const ok = await ctx.requestApproval(summary, detail);
  if (!ok) return "The operator declined; nothing changed on the wall.";
  const done = await wallFetch(w, io, "POST", path, body);
  if (!done.ok) return done.message;
  const after = done.json.card ?? {};
  switch (action) {
    case "approve": return `Card #${id} is public on ${w.host}.`;
    case "hide": return `Card #${id} is hidden from ${w.host}.`;
    case "answer": return `Card #${id} has its answer, and is at ${after.stage ?? "answered"}.${pending ? " It shows once the card is approved." : ""}`;
    default: return `Card #${id} is at ${after.stage ?? stage}${after.link ? `, linked to ${after.link}` : ""}.`;
  }
}
