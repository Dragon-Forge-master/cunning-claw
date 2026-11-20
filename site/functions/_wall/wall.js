/**
 * The forge wall — "ask the forge" on cunningclaw.com.
 *
 * A visitor asks a question or suggests a feature; the team answers; a good
 * idea gets planned and built, and the card shows that journey with a link
 * to the commit or release. This file is the whole backend: a Cloudflare
 * Pages Function over one D1 database (binding WALL_DB, schema.sql beside
 * this file). Plain JS so Pages needs no build step; it exports no onRequest,
 * so Pages does not route it — functions/api/wall/[[route]].js does.
 *
 * It is a public form on the open internet, so it assumes spam, abuse and
 * personal data, and every choice below leans the safe way:
 *
 *  - Pre-moderation. Nothing a visitor writes is public until a person has
 *    read it and approved it. The public list selects moderation = 'public'
 *    and nothing else; there is no flag a visitor can set.
 *  - Spam. Cloudflare Turnstile, verified here with the secret (a token the
 *    browser merely claims proves nothing), then rate limits per visitor, a
 *    cap on the pending queue, and length limits on every field.
 *  - No raw IPs, ever. A visitor is a keyed HMAC of their address. The rate
 *    limit key changes every UTC day and its rows are deleted within two; the
 *    vote key is per card, so votes on two cards cannot be linked to one
 *    person. Neither is stored beside the words a visitor wrote.
 *  - The minimum. A card is the text, an optional first name or handle, the
 *    kind, dates to the day, and what the team did with it. No email field:
 *    an answer is public, so there is nothing to send. Text that carries an
 *    email address or a phone number is refused rather than stored.
 *  - Visitor text is never HTML. It is stored as written (after removing
 *    control and invisible characters) and served as JSON with nosniff and
 *    every "<" escaped; the page renders it with textContent. Links in it are
 *    never made clickable. The one link that is — the "built" link — is set
 *    by the team and must point at the project's own repository or site.
 *  - Admin is a bearer secret (WALL_ADMIN_TOKEN), compared in constant time,
 *    and it fails closed: unset or short, admin is off. The page has no admin
 *    UI; the operator's claw (src/wall.ts) and curl are the admin.
 *
 * Everything that touches the outside world — fetch and the clock — comes in
 * through `deps`, so src/site-wall.test.ts drives this with a fake Turnstile
 * and an in-memory database.
 */

export const ACTION = "wall-submit";
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const LIMITS = Object.freeze({
  textMin: 8,
  textMax: 600,
  nameMax: 32,
  answerMax: 1500,
  linkMax: 300,
  /** Request bodies: a card is at most a few kilobytes of JSON. */
  bodyMax: 8192,
  /** Turnstile's own maximum token length. */
  tokenMax: 2048,
});

/** Per visitor. Generous for a person, useless to a script. */
export const RATE = Object.freeze({ submitPerHour: 3, submitPerDay: 8, votePerHour: 30 });
/** Past this many unread cards the form says so, rather than letting a flood fill the database. */
export const PENDING_CAP = 300;
export const PUBLIC_LIMIT = 60;
export const ADMIN_LIMIT = 200;
export const KINDS = Object.freeze(["question", "idea"]);
export const STAGES = Object.freeze(["asked", "answered", "planned", "built"]);
export const MODERATIONS = Object.freeze(["pending", "public", "hidden"]);
/** Shorter than this and the admin token is guessable; admin stays off. */
export const MIN_ADMIN_TOKEN = 32;
export const MIN_SALT = 16;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const STAGE_AT = { answered: "answered_at", planned: "planned_at", built: "built_at" };

const defaultDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
};

/** The Pages Function entry: functions/api/wall/[[route]].js passes straight through. */
export async function handle(request, env, deps = {}) {
  const io = { ...defaultDeps, ...deps };
  try {
    return await route(request, env ?? {}, io);
  } catch {
    // Never echo an exception: it can carry SQL or a binding's internals.
    return json(500, { ok: false, error: "server", message: "Something went wrong on our side. Please try again later." });
  }
}

async function route(request, env, io) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/wall\/?/, "").replace(/\/+$/, "");
  const method = request.method.toUpperCase();
  if (path === "cards") return method === "GET" || method === "HEAD" ? listPublic(env) : notAllowed("GET");
  if (path === "submit") return method === "POST" ? submit(request, env, io) : notAllowed("POST");
  if (path === "vote") return method === "POST" ? vote(request, env, io) : notAllowed("POST");
  if (path === "admin" || path.startsWith("admin/")) return admin(path.slice(6), method, request, env, io, url);
  return json(404, { ok: false, error: "not-found", message: "No such endpoint." });
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

async function listPublic(env) {
  const db = env.WALL_DB;
  if (!db) return notReady();
  const { results } = await db
    .prepare(
      "SELECT id, kind, body, name, stage, answer, link, votes, created_at, answered_at, planned_at, built_at " +
      "FROM cards WHERE moderation = 'public' ORDER BY updated_at DESC, id DESC LIMIT ?",
    )
    .bind(PUBLIC_LIMIT)
    .all();
  return json(200, { ok: true, cards: (results ?? []).map(publicCard) }, { "Cache-Control": "public, max-age=15" });
}

/** Exactly what a stranger may see of a card — nothing about moderation, nothing about who. */
export function publicCard(row) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.body,
    name: row.name || null,
    stage: row.stage,
    answer: row.answer || null,
    link: safeLink(row.link),
    votes: Number(row.votes) || 0,
    asked: day(row.created_at),
    answered: day(row.answered_at),
    planned: day(row.planned_at),
    built: day(row.built_at),
  };
}

async function submit(request, env, io) {
  const db = env.WALL_DB;
  if (!db) return notReady();
  if (!isString(env.TURNSTILE_SECRET, 1) || !isString(env.WALL_IP_SALT, MIN_SALT)) {
    return json(503, { ok: false, error: "not-configured", message: "The wall is not taking new cards yet." });
  }
  const got = await readJson(request);
  if (got.response) return got.response;
  const b = got.body;

  const kind = KINDS.includes(b.kind) ? b.kind : null;
  if (!kind) return bad("kind", "Choose whether it is a question or an idea.");
  const text = clean(b.text, true);
  const name = clean(b.name, false);
  const n = length(text);
  if (n < LIMITS.textMin) return bad("too-short", `Say a little more — at least ${LIMITS.textMin} characters.`);
  if (n > LIMITS.textMax) return bad("too-long", `That is ${n} characters; the wall takes ${LIMITS.textMax} at most.`);
  if (length(name) > LIMITS.nameMax) return bad("name", `A name of ${LIMITS.nameMax} characters at most, please.`);
  if (name && !NAME_RE.test(name)) return bad("name", "A first name or handle: letters, numbers, spaces and . _ ' @ - only.");
  if (carriesContactDetails(text) || carriesContactDetails(name)) {
    return bad("personal-data", "This wall is public, so please leave out email addresses and phone numbers.");
  }
  const token = typeof b.turnstileToken === "string" ? b.turnstileToken : "";
  if (!token || token.length > LIMITS.tokenMax) return bad("turnstile", "Please complete the spam check first.");

  const ip = visitorIp(request);
  const now = io.now();
  const visitor = await rateKey(env.WALL_IP_SALT, ip, now);
  if (await overLimit(db, visitor, "submit", now, [[HOUR, RATE.submitPerHour], [DAY, RATE.submitPerDay]])) {
    return json(429, { ok: false, error: "rate-limit", message: "That is plenty for now — thank you. Please come back tomorrow." });
  }
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM cards WHERE moderation = 'pending'").first();
  if (Number(pending?.n ?? 0) >= PENDING_CAP) {
    return json(503, { ok: false, error: "queue-full", message: "The queue is full while we catch up. Please try again in a few days." });
  }
  // Last of the checks, because it is the one that costs a network call.
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET, token, ip, io))) {
    return json(403, { ok: false, error: "turnstile", message: "The spam check did not pass. Please try it again." });
  }

  await db.batch([
    db.prepare(
      "INSERT INTO cards (kind, body, name, moderation, stage, created_at, updated_at) VALUES (?, ?, ?, 'pending', 'asked', ?, ?)",
    ).bind(kind, text, name || null, now, now),
    db.prepare("INSERT INTO hits (visitor, action, at) VALUES (?, 'submit', ?)").bind(visitor, now),
    // Housekeeping rides on writes: yesterday's keys are no use to anyone.
    db.prepare("DELETE FROM hits WHERE at < ?").bind(now - 2 * DAY),
  ]);
  return json(202, { ok: true, message: "Thank you. A person reads every card before it appears here." });
}

async function vote(request, env, io) {
  const db = env.WALL_DB;
  if (!db) return notReady();
  if (!isString(env.WALL_IP_SALT, MIN_SALT)) {
    return json(503, { ok: false, error: "not-configured", message: "Voting is not open yet." });
  }
  const got = await readJson(request);
  if (got.response) return got.response;
  const id = toId(got.body.id);
  if (!id) return bad("id", "Which card?");
  const card = await db.prepare("SELECT id FROM cards WHERE id = ? AND moderation = 'public'").bind(id).first();
  if (!card) return json(404, { ok: false, error: "not-found", message: "No card with that number is on the wall." });

  const ip = visitorIp(request);
  const now = io.now();
  const visitor = await rateKey(env.WALL_IP_SALT, ip, now);
  if (await overLimit(db, visitor, "vote", now, [[HOUR, RATE.votePerHour]])) {
    return json(429, { ok: false, error: "rate-limit", message: "That is a lot of votes. Please try again later." });
  }
  // Per card: the same visitor's votes on two cards are two unrelated strings.
  const voter = await hmac(env.WALL_IP_SALT, `vote|${id}|${ip}`);
  const r = await db.prepare("INSERT OR IGNORE INTO votes (card_id, voter) VALUES (?, ?)").bind(id, voter).run();
  const counted = Number(r?.meta?.changes ?? 0) > 0;
  await db.batch([
    // Recounted, not incremented, so the number can never drift from the rows.
    db.prepare("UPDATE cards SET votes = (SELECT COUNT(*) FROM votes WHERE card_id = ?) WHERE id = ?").bind(id, id),
    db.prepare("INSERT INTO hits (visitor, action, at) VALUES (?, 'vote', ?)").bind(visitor, now),
    // Votes write hits too, so they sweep too: a wall that gets votes and no
    // new cards must not keep yesterday's visitor keys.
    db.prepare("DELETE FROM hits WHERE at < ?").bind(now - 2 * DAY),
  ]);
  const after = await db.prepare("SELECT votes FROM cards WHERE id = ?").bind(id).first();
  return json(200, { ok: true, counted, votes: Number(after?.votes ?? 0) });
}

// ---------------------------------------------------------------------------
// Admin — the operator's claw, or curl. No page calls these.
// ---------------------------------------------------------------------------

async function admin(sub, method, request, env, io, url) {
  const refused = await adminRefusal(request, env);
  if (refused) return refused;
  const db = env.WALL_DB;
  if (!db) return notReady();
  const now = io.now();
  // The operator's claw reads the queue routinely, so every admin call sweeps
  // as well: the two-day promise holds on a quiet wall, not only a busy one.
  await db.prepare("DELETE FROM hits WHERE at < ?").bind(now - 2 * DAY).run();

  if (sub === "cards") {
    if (method !== "GET") return notAllowed("GET");
    const id = url.searchParams.get("id");
    if (id !== null) {
      const row = toId(id) ? await db.prepare("SELECT * FROM cards WHERE id = ?").bind(toId(id)).first() : null;
      return row ? json(200, { ok: true, cards: [adminCard(row)] }) : missing();
    }
    const mod = url.searchParams.get("moderation") ?? "pending";
    if (mod !== "all" && !MODERATIONS.includes(mod)) return bad("moderation", "moderation is pending, public, hidden or all.");
    // The queue reads oldest first, so nobody waits forever; the rest newest first.
    const order = mod === "pending" ? "created_at ASC, id ASC" : "updated_at DESC, id DESC";
    const stmt = mod === "all"
      ? db.prepare(`SELECT * FROM cards ORDER BY ${order} LIMIT ?`).bind(ADMIN_LIMIT)
      : db.prepare(`SELECT * FROM cards WHERE moderation = ? ORDER BY ${order} LIMIT ?`).bind(mod, ADMIN_LIMIT);
    const { results } = await stmt.all();
    const counts = await db.prepare("SELECT moderation, COUNT(*) AS n FROM cards GROUP BY moderation").all();
    const totals = Object.fromEntries(MODERATIONS.map((m) => [m, 0]));
    for (const r of counts.results ?? []) totals[r.moderation] = Number(r.n);
    return json(200, { ok: true, totals, cards: (results ?? []).map(adminCard) });
  }

  if (method !== "POST") return notAllowed("POST");
  const got = await readJson(request);
  if (got.response) return got.response;
  const b = got.body;
  const id = toId(b.id);
  if (!id) return bad("id", "Which card? Give its id.");
  const row = await db.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();
  if (!row) return missing();

  switch (sub) {
    case "approve":
    case "hide": {
      const to = sub === "approve" ? "public" : "hidden";
      await db.prepare("UPDATE cards SET moderation = ?, updated_at = ? WHERE id = ?").bind(to, now, id).run();
      break;
    }
    case "answer": {
      const answer = clean(b.answer, true);
      if (length(answer) > LIMITS.answerMax) return bad("too-long", `An answer of ${LIMITS.answerMax} characters at most.`);
      // An answer moves a fresh card on to "answered"; it never drags a
      // planned or built card backwards. An empty answer clears it.
      const stage = answer && row.stage === "asked" ? "answered" : row.stage;
      const answeredAt = answer ? row.answered_at ?? now : row.answered_at;
      await db.prepare("UPDATE cards SET answer = ?, stage = ?, answered_at = ?, updated_at = ? WHERE id = ?")
        .bind(answer || null, stage, answeredAt ?? null, now, id).run();
      break;
    }
    case "stage": {
      if (!STAGES.includes(b.stage)) return bad("stage", `stage is one of ${STAGES.join(", ")}.`);
      let link = row.link;
      if (b.link !== undefined && b.link !== null) {
        const want = String(b.link).trim();
        if (want && !safeLink(want)) {
          return bad("link", "A link must be https on github.com/Dragon-Forge-master/cunning-claw or cunningclaw.com.");
        }
        link = want || null;
      }
      // Each step reached keeps the day it was first reached; steps beyond
      // the new stage are cleared, so moving a card back tells the truth.
      const reached = STAGES.indexOf(b.stage);
      const at = {};
      for (const [stage, col] of Object.entries(STAGE_AT)) {
        at[col] = STAGES.indexOf(stage) <= reached ? row[col] ?? now : null;
      }
      await db.prepare(
        "UPDATE cards SET stage = ?, link = ?, answered_at = ?, planned_at = ?, built_at = ?, updated_at = ? WHERE id = ?",
      ).bind(b.stage, link ?? null, at.answered_at, at.planned_at, at.built_at, now, id).run();
      break;
    }
    case "delete": {
      await db.batch([
        db.prepare("DELETE FROM votes WHERE card_id = ?").bind(id),
        db.prepare("DELETE FROM cards WHERE id = ?").bind(id),
      ]);
      return json(200, { ok: true, deleted: id });
    }
    default:
      return json(404, { ok: false, error: "not-found", message: "No such admin endpoint." });
  }
  const updated = await db.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();
  return json(200, { ok: true, card: adminCard(updated) });
}

function adminCard(row) {
  return { ...publicCard(row), link: row.link || null, moderation: row.moderation, updated: day(row.updated_at) };
}

async function adminRefusal(request, env) {
  const expected = env.WALL_ADMIN_TOKEN;
  if (!isString(expected, MIN_ADMIN_TOKEN)) {
    return json(503, { ok: false, error: "admin-off", message: `Admin is off: WALL_ADMIN_TOKEN is not set to ${MIN_ADMIN_TOKEN} characters or more.` });
  }
  const m = /^Bearer[ ]+(\S+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!m || !(await sameSecret(m[1], expected))) {
    return json(401, { ok: false, error: "unauthorised", message: "Not authorised." }, { "WWW-Authenticate": 'Bearer realm="wall"' });
  }
  return null;
}

/**
 * Constant time whatever the input: both sides are hashed first, so the
 * comparison is always 32 bytes against 32 bytes, and every byte is visited
 * whether or not an earlier one differed. A plain === stops at the first
 * wrong character, and that timing is how a token is guessed one character
 * at a time.
 */
export async function sameSecret(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(given))),
    crypto.subtle.digest("SHA-256", enc.encode(String(expected))),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Zero-width, bidi-override and soft-hyphen characters: invisible, so a moderator cannot see what they approve. */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
/** C0 and C1 controls, except the newline (tabs become spaces first). */
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
const NAME_RE = /^[\p{L}\p{M}\p{N} ._'’@-]+$/u;

/** Normalise without rewriting: what is stored is what was written, less what nobody can see. */
export function clean(raw, multiline) {
  if (typeof raw !== "string") return "";
  let s = raw.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROL, "").replace(INVISIBLE, "");
  s = multiline
    ? s.split("\n").map((line) => line.replace(/[  ]+/g, " ").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n")
    : s.replace(/\s+/g, " ");
  return s.trim();
}

/** In code points, the way a person counts, not UTF-16 units. */
const length = (s) => [...s].length;

/**
 * An email address, or ten or more digits in one run (spaces, dots, dashes
 * and brackets allowed between them): a phone number. Refused, not stored —
 * the moderator is the second line, not the first.
 */
export function carriesContactDetails(s) {
  if (!s) return false;
  if (/[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}/i.test(s)) return true;
  for (const m of s.matchAll(/\+?\d[\d\s().-]{8,}\d/g)) {
    if (m[0].replace(/\D/g, "").length >= 10) return true;
  }
  return false;
}

const LINK_RE = /^https:\/\/(?:github\.com\/Dragon-Forge-master\/cunning-claw|cunningclaw\.com)(?:\/[A-Za-z0-9._~\/#?=&%+-]*)?$/;

/** The one link the wall makes clickable is the team's, and only to the project's own places. */
export function safeLink(s) {
  return typeof s === "string" && s.length <= LIMITS.linkMax && LINK_RE.test(s) ? s : null;
}

async function verifyTurnstile(secret, token, ip, io) {
  try {
    const res = await io.fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(ip !== "unknown" ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const out = await res.json();
    if (out?.success !== true) return false;
    // A token minted for some other action on some other form is not this one.
    if (out.action && out.action !== ACTION) return false;
    return true;
  } catch {
    return false; // fails closed: no answer from Turnstile is not a yes
  }
}

function visitorIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

/** The rate-limit key: a keyed hash of the address and the UTC day, so it is useless by tomorrow. */
function rateKey(salt, ip, now) {
  return hmac(salt, `rate|${Math.floor(now / DAY)}|${ip}`);
}

export async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return [...sig.slice(0, 16)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function overLimit(db, visitor, action, now, windows) {
  for (const [ms, max] of windows) {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM hits WHERE visitor = ? AND action = ? AND at > ?")
      .bind(visitor, action, now - ms).first();
    if (Number(row?.n ?? 0) >= max) return true;
  }
  return false;
}

async function readJson(request) {
  const type = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return { response: json(415, { ok: false, error: "content-type", message: "Send JSON." }) };
  }
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > LIMITS.bodyMax) return { response: tooLarge() };
  const text = await request.text();
  if (text.length > LIMITS.bodyMax) return { response: tooLarge() };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { response: bad("json", "That was not valid JSON.") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { response: bad("json", "Send a JSON object.") };
  return { body };
}

function toId(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function isString(v, min) {
  return typeof v === "string" && v.length >= min;
}

/** Dates to the day: a visitor does not need the minute, and neither do we. */
function day(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/**
 * Every response is JSON with nosniff, and every "<" goes out as < — the
 * body is still the same JSON, but no browser, sniffer or careless proxy can
 * read a visitor's "<script>" in it as markup.
 */
export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body).replace(/</g, "\\u003c"), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

const bad = (error, message) => json(400, { ok: false, error, message });
const missing = () => json(404, { ok: false, error: "not-found", message: "No card with that id." });
const tooLarge = () => json(413, { ok: false, error: "too-large", message: "That request is too large." });
const notReady = () => json(503, { ok: false, error: "not-ready", message: "The wall is not set up yet." });
const notAllowed = (allow) => json(405, { ok: false, error: "method", message: `Use ${allow}.` }, { Allow: allow });
