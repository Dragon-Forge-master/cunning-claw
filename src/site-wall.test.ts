import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// The site's Pages Function is plain JS with no build step; it runs here as it
// runs on Cloudflare, with the database and Turnstile stood in for.
import {
  ACTION, LIMITS, PENDING_CAP, RATE, SITEVERIFY_URL,
  carriesContactDetails, clean, handle, safeLink, sameSecret,
} from "../site/functions/_wall/wall.js";

/**
 * The forge wall is a public form on cunningclaw.com, so the tests are the
 * attacks: a card that skips moderation, a script that floods the queue, a
 * guessed admin token, a visitor who votes a hundred times, a 50 KB essay,
 * and a "<script>" that arrives as text and must leave as text.
 *
 * The database is a real SQLite in memory (node:sqlite) behind D1's API shape,
 * built from the very schema.sql the operator applies — so a column the code
 * expects and the schema lacks fails here, not on the live site.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, "..", "site");
const SCHEMA = path.join(SITE, "functions", "_wall", "schema.sql");

// Synthetic fixtures, assembled at runtime so no scanner mistakes them for keys.
const ADMIN = "wall-admin-fixture-" + "x".repeat(32);
const SALT = "salt-fixture-" + "s".repeat(16);
const TS_SECRET = "turnstile-secret-fixture";
const HOUR = 3_600_000;

let sqlite: any = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  // Node 22 before 22.5 has no node:sqlite; the suite says so rather than lie.
}

/** D1's surface — prepare/bind/first/all/run and batch — over an in-memory SQLite. */
function fakeD1() {
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(fs.readFileSync(SCHEMA, "utf-8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...args) as any) ?? null,
    all: async () => ({ success: true, results: db.prepare(sql).all(...args) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: any[]) => {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    /** Every value in every table, for the "no raw IP anywhere" check. */
    dump: () => ["cards", "votes", "hits"].map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join("\n"),
    count: (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n),
  };
}

/** Turnstile's siteverify, as a fetch: the token "pass" passes, anything else fails. */
function fakeTurnstile(opts: { action?: string; status?: number; throws?: boolean } = {}) {
  const calls: any[] = [];
  const fetch = async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (opts.throws) throw new Error("network down");
    const body = JSON.parse(init.body);
    const success = body.secret === TS_SECRET && body.response === "pass";
    return new Response(JSON.stringify({ success, action: opts.action ?? ACTION, hostname: "cunningclaw.com" }), {
      status: opts.status ?? 200, headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, calls };
}

function rig(over: { env?: Record<string, unknown>; turnstile?: ReturnType<typeof fakeTurnstile> } = {}) {
  const db = fakeD1();
  const ts = over.turnstile ?? fakeTurnstile();
  let now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const env = { WALL_DB: db, TURNSTILE_SECRET: TS_SECRET, WALL_ADMIN_TOKEN: ADMIN, WALL_IP_SALT: SALT, ...over.env };
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init: any = { method, headers: { "CF-Connecting-IP": "203.0.113.7", ...headers } };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      if (!("Content-Type" in headers)) init.headers["Content-Type"] = "application/json";
    }
    const res = await handle(new Request(`https://cunningclaw.com/api/wall/${p}`, init), env, { fetch: ts.fetch, now: () => now });
    const raw = await res.text();
    return { status: res.status, headers: res.headers, raw, json: raw ? JSON.parse(raw) : null };
  };
  const auth = { Authorization: `Bearer ${ADMIN}` };
  return {
    db, ts, env, call, auth,
    tick: (ms: number) => { now += ms; },
    submit: (text: string, extra: Record<string, unknown> = {}, ip = "203.0.113.7") =>
      call("POST", "submit", { kind: "idea", text, turnstileToken: "pass", ...extra }, { "CF-Connecting-IP": ip }),
    publicCards: async () => (await call("GET", "cards")).json.cards as any[],
    pending: async () => (await call("GET", "admin/cards?moderation=pending", undefined, auth)).json.cards as any[],
    admin: (p: string, body: unknown) => call("POST", `admin/${p}`, body, auth),
  };
}

const skip = sqlite ? false : "node:sqlite is not available in this Node";

test("a visitor's card is invisible to the public until a person approves it", { skip }, async () => {
  const w = rig();
  const sent = await w.submit("Could he read Outlook as well as Gmail?", { kind: "question", name: "Sam" });
  assert.equal(sent.status, 202);
  assert.equal(sent.json.ok, true);
  assert.deepEqual(await w.publicCards(), [], "pending must not be listed publicly");

  const [card] = await w.pending();
  assert.equal(card.text, "Could he read Outlook as well as Gmail?");
  assert.equal(card.moderation, "pending");
  // A visitor cannot vote a pending card into view, either.
  assert.equal((await w.call("POST", "vote", { id: card.id })).status, 404);

  assert.equal((await w.admin("approve", { id: card.id })).status, 200);
  const live = await w.publicCards();
  assert.equal(live.length, 1);
  assert.equal(live[0].name, "Sam");
  assert.equal(live[0].stage, "asked");
  assert.equal("moderation" in live[0], false, "the public shape says nothing about moderation");

  await w.admin("hide", { id: card.id });
  assert.deepEqual(await w.publicCards(), [], "a hidden card comes down");
});

test("a submission cannot choose its own moderation or stage", { skip }, async () => {
  const w = rig();
  await w.submit("Please publish me straight away, thanks", { moderation: "public", stage: "built", votes: 999, link: "https://cunningclaw.com/" });
  assert.deepEqual(await w.publicCards(), []);
  const [card] = await w.pending();
  assert.equal(card.stage, "asked");
  assert.equal(card.votes, 0);
  assert.equal(card.link, null);
});

test("Turnstile is verified on the server, with the secret, and fails closed", { skip }, async () => {
  const w = rig();
  assert.equal((await w.submit("A perfectly good idea here", { turnstileToken: "forged" })).status, 403);
  assert.equal((await w.submit("A perfectly good idea here", { turnstileToken: "" })).status, 400);
  assert.equal(w.db.count("cards"), 0, "nothing is stored for a failed check");
  assert.equal(w.ts.calls[0].url, SITEVERIFY_URL);
  assert.equal(w.ts.calls[0].body.secret, TS_SECRET);
  assert.equal(w.ts.calls[0].body.remoteip, "203.0.113.7");

  // A token minted for another action is not this form's token.
  const other = rig({ turnstile: fakeTurnstile({ action: "login" }) });
  assert.equal((await other.submit("A perfectly good idea here")).status, 403);
  // Turnstile down is not a yes.
  const down = rig({ turnstile: fakeTurnstile({ throws: true }) });
  assert.equal((await down.submit("A perfectly good idea here")).status, 403);
  const err = rig({ turnstile: fakeTurnstile({ status: 500 }) });
  assert.equal((await err.submit("A perfectly good idea here")).status, 403);
  // No secret configured: the wall refuses rather than skipping the check.
  const bare = rig({ env: { TURNSTILE_SECRET: undefined } });
  assert.equal((await bare.submit("A perfectly good idea here")).status, 503);
  assert.equal(bare.ts.calls.length, 0);
  const noSalt = rig({ env: { WALL_IP_SALT: "short" } });
  assert.equal((await noSalt.submit("A perfectly good idea here")).status, 503);
});

test("rate limits: a few an hour per visitor, more than that waits, other visitors are unaffected", { skip }, async () => {
  const w = rig();
  for (let i = 0; i < RATE.submitPerHour; i++) {
    assert.equal((await w.submit(`Idea number ${i} for the forge`)).status, 202);
  }
  const over = await w.submit("One more idea for the forge");
  assert.equal(over.status, 429);
  assert.equal(w.db.count("cards"), RATE.submitPerHour);
  assert.equal(w.ts.calls.length, RATE.submitPerHour, "a limited visitor does not cost a Turnstile call");
  assert.equal((await w.submit("A different visitor's idea", {}, "198.51.100.9")).status, 202);

  w.tick(HOUR + 1);
  assert.equal((await w.submit("Back an hour later with an idea")).status, 202);
  // ... but the day has its own ceiling.
  let accepted = RATE.submitPerHour + 1;
  while (accepted < RATE.submitPerDay) {
    w.tick(HOUR + 1);
    assert.equal((await w.submit(`Later idea ${accepted} for the forge`)).status, 202);
    accepted++;
  }
  w.tick(HOUR + 1);
  assert.equal((await w.submit("Too many for one day now")).status, 429);
});

test("the pending queue has a ceiling, so a flood cannot fill the database", { skip }, async () => {
  const w = rig();
  for (let i = 0; i < PENDING_CAP; i++) {
    await w.db.prepare("INSERT INTO cards (kind, body, moderation, stage, created_at, updated_at) VALUES ('idea', ?, 'pending', 'asked', 0, 0)").bind(`x${i}`).run();
  }
  const r = await w.submit("Room for one more, surely?");
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "queue-full");
});

test("no raw IP address is stored anywhere, and vote keys differ per card", { skip }, async () => {
  const w = rig();
  const ip = "203.0.113.77";
  await w.submit("First idea from this visitor", {}, ip);
  await w.submit("Second idea from this visitor", {}, ip);
  for (const c of await w.pending()) await w.admin("approve", { id: c.id });
  for (const c of await w.publicCards()) await w.call("POST", "vote", { id: c.id }, { "CF-Connecting-IP": ip });
  const everything = w.db.dump();
  assert.equal(everything.includes(ip), false);
  assert.equal(everything.includes("203.0.113"), false);
  const voters = JSON.parse(everything.split("\n")[1]).map((v: any) => v.voter);
  assert.equal(voters.length, 2);
  assert.notEqual(voters[0], voters[1], "one visitor's votes on two cards must not share a key");
});

test("admin needs the bearer token; a missing, wrong or short token is refused", { skip }, async () => {
  const w = rig();
  await w.submit("An idea waiting in the queue");
  assert.equal((await w.call("GET", "admin/cards")).status, 401);
  assert.equal((await w.call("GET", "admin/cards", undefined, { Authorization: `Bearer ${ADMIN}x` })).status, 401);
  assert.equal((await w.call("GET", "admin/cards", undefined, { Authorization: ADMIN })).status, 401, "the scheme is part of it");
  assert.equal((await w.call("POST", "admin/approve", { id: 1 }, { Authorization: "Bearer guess" })).status, 401);
  assert.deepEqual(await w.publicCards(), [], "a refused approve changed nothing");
  assert.equal((await w.call("GET", "admin/cards", undefined, w.auth)).status, 200);

  // Unset or short on the server, admin is off — not open.
  for (const token of [undefined, "", "short-token"]) {
    const off = rig({ env: { WALL_ADMIN_TOKEN: token } });
    const r = await off.call("GET", "admin/cards", undefined, { Authorization: `Bearer ${token ?? ""}` });
    assert.equal(r.status, 503, `token ${JSON.stringify(token)} must switch admin off`);
  }
});

test("the token comparison is exact, whatever the lengths", { skip }, async () => {
  assert.equal(await sameSecret(ADMIN, ADMIN), true);
  assert.equal(await sameSecret(ADMIN.slice(0, -1), ADMIN), false);
  assert.equal(await sameSecret(ADMIN + "x", ADMIN), false);
  assert.equal(await sameSecret("", ADMIN), false);
});

test("me too: one vote per visitor per card, and only on public cards", { skip }, async () => {
  const w = rig();
  await w.submit("An idea worth backing, surely");
  const [card] = await w.pending();
  await w.admin("approve", { id: card.id });

  const first = await w.call("POST", "vote", { id: card.id });
  assert.deepEqual([first.status, first.json.counted, first.json.votes], [200, true, 1]);
  const again = await w.call("POST", "vote", { id: card.id });
  assert.deepEqual([again.status, again.json.counted, again.json.votes], [200, false, 1]);
  const other = await w.call("POST", "vote", { id: card.id }, { "CF-Connecting-IP": "198.51.100.20" });
  assert.equal(other.json.votes, 2);
  assert.equal((await w.publicCards())[0].votes, 2);
  assert.equal((await w.call("POST", "vote", { id: 999 })).status, 404);
  assert.equal((await w.call("POST", "vote", { id: "1; DROP TABLE cards" })).status, 400);

  // Hammering the button is rate-limited too.
  const h = rig();
  await h.submit("Another idea worth backing");
  await h.admin("approve", { id: 1 });
  for (let i = 0; i < RATE.votePerHour; i++) await h.call("POST", "vote", { id: 1 });
  assert.equal((await h.call("POST", "vote", { id: 1 })).status, 429);
});

test("length limits hold on every field, counted the way a person counts", { skip }, async () => {
  const w = rig();
  assert.equal((await w.submit("hi")).status, 400);
  assert.equal((await w.submit("        spaces do not count        ".replace(/\S/g, " "))).status, 400);
  assert.equal((await w.submit("a".repeat(LIMITS.textMax + 1))).json.error, "too-long");
  assert.equal((await w.submit("a".repeat(LIMITS.textMax))).status, 202);
  // 600 emoji are 1,200 UTF-16 units and still 600 characters.
  assert.equal((await w.submit("🐉".repeat(LIMITS.textMax), {}, "198.51.100.1")).status, 202);
  assert.equal((await w.submit("A fine idea", { name: "n".repeat(LIMITS.nameMax + 1) }, "198.51.100.2")).json.error, "name");
  assert.equal((await w.submit("A fine idea", { name: "https://evil.example" }, "198.51.100.2")).json.error, "name");
  assert.equal((await w.submit("A fine idea", { kind: "spam" }, "198.51.100.2")).json.error, "kind");
  const huge = await w.call("POST", "submit", JSON.stringify({ kind: "idea", text: "x".repeat(50_000), turnstileToken: "pass" }));
  assert.equal(huge.status, 413);
  const form = await w.call("POST", "submit", "kind=idea&text=hello", { "Content-Type": "application/x-www-form-urlencoded" });
  assert.equal(form.status, 415, "only JSON — a cross-site form post is not a submission");

  const [card] = await w.pending();
  assert.equal((await w.admin("answer", { id: card.id, answer: "a".repeat(LIMITS.answerMax + 1) })).status, 400);
});

test("email addresses and phone numbers are refused, not stored", { skip }, async () => {
  const w = rig();
  for (const [i, text] of [
    "Email me at sam.jones@example.co.uk please",
    "Ring me on 07700 900123 about this",
    "Call +44 (0)29 2018 0000 any time",
  ].entries()) {
    const r = await w.submit(text, {}, `198.51.100.${i + 1}`);
    assert.equal(r.json.error, "personal-data", text);
  }
  assert.equal((await w.submit("A fine idea", { name: "sam@example.com" })).json.error, "personal-data");
  assert.equal(w.db.count("cards"), 0);
  // Versions, dates and counts are not phone numbers.
  assert.equal(carriesContactDetails("Since 0.4.0 on 2026-11-20 with 717 tests"), false);
});

test("HTML in a card stays text: stored as written, served as inert JSON", { skip }, async () => {
  const w = rig();
  const nasty = `<img src=x onerror="alert(1)"><script>alert(2)</script></untrusted> & "quotes"`;
  assert.equal((await w.submit(nasty, { name: "<b>Bold</b>" })).json.error, "name", "a name with markup is refused");
  await w.submit(nasty);
  const [card] = await w.pending();
  await w.admin("approve", { id: card.id });
  await w.admin("answer", { id: card.id, answer: "<i>Thanks</i>" });

  const res = await w.call("GET", "cards");
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.raw.includes("<"), false, "no literal '<' leaves the API");
  assert.equal(res.json.cards[0].text, nasty, "and the visitor's words survive exactly");
  assert.equal(res.json.cards[0].answer, "<i>Thanks</i>");
});

test("invisible and control characters are stripped before a moderator reads the card", { skip }, async () => {
  assert.equal(clean("ap‮prove​ me\u0007", true), "approve me");
  assert.equal(clean("line one\r\n\r\n\r\n\r\nline two  ", true), "line one\n\nline two");
  assert.equal(clean("  Sam\n  Jones ", false), "Sam Jones");
  assert.equal(clean(42 as any, true), "");
});

test("the journey: an answer moves a card on, stages keep their dates, the built link is checked", { skip }, async () => {
  const w = rig();
  await w.submit("Could he file my mileage claims?");
  const [card] = await w.pending();
  await w.admin("approve", { id: card.id });

  let r = await w.admin("answer", { id: card.id, answer: "Yes — it is on the list." });
  assert.equal(r.json.card.stage, "answered");
  assert.equal(r.json.card.answered, "2026-11-20");

  w.tick(24 * HOUR);
  r = await w.admin("stage", { id: card.id, stage: "planned" });
  assert.equal(r.json.card.planned, "2026-11-21");
  w.tick(24 * HOUR);
  const link = "https://github.com/Dragon-Forge-master/cunning-claw/releases/tag/v0.5.0";
  r = await w.admin("stage", { id: card.id, stage: "built", link });
  assert.deepEqual([r.json.card.stage, r.json.card.built, r.json.card.answered], ["built", "2026-11-22", "2026-11-20"]);
  const pub = (await w.publicCards())[0];
  assert.equal(pub.link, link);
  assert.equal(pub.planned, "2026-11-21");

  // A re-answer does not drag a built card backwards.
  r = await w.admin("answer", { id: card.id, answer: "Shipped in 0.5." });
  assert.equal(r.json.card.stage, "built");
  // Moving back clears the steps ahead of it.
  r = await w.admin("stage", { id: card.id, stage: "answered" });
  assert.deepEqual([r.json.card.planned, r.json.card.built], [null, null]);

  for (const bad of [
    "javascript:alert(1)",
    "http://github.com/Dragon-Forge-master/cunning-claw",
    "https://github.com/Dragon-Forge-master/cunning-claw-evil/releases",
    "https://github.com/someone-else/cunning-claw",
    "https://cunningclaw.com.evil.example/",
    "https://cunningclaw.com/\"><script>",
  ]) {
    assert.equal((await w.admin("stage", { id: card.id, stage: "built", link: bad })).json.error, "link", bad);
    assert.equal(safeLink(bad), null, bad);
  }
  assert.equal((await w.admin("stage", { id: card.id, stage: "shipped" })).json.error, "stage");
});

test("delete removes the card and its votes", { skip }, async () => {
  const w = rig();
  await w.submit("Here today, gone tomorrow");
  await w.admin("approve", { id: 1 });
  await w.call("POST", "vote", { id: 1 });
  assert.equal((await w.admin("delete", { id: 1 })).json.deleted, 1);
  assert.equal(w.db.count("cards"), 0);
  assert.equal(w.db.count("votes"), 0);
  assert.equal((await w.admin("delete", { id: 1 })).status, 404);
});

test("the public list says not-ready, not an error page, when the database is missing", { skip }, async () => {
  const res = await handle(new Request("https://cunningclaw.com/api/wall/cards"), {}, {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "not-ready");
  const wrong = await handle(new Request("https://cunningclaw.com/api/wall/submit"), {}, {});
  assert.equal(wrong.status, 405);
});

test("the page script never builds HTML from strings — visitor text goes in by textContent", () => {
  const src = fs.readFileSync(path.join(SITE, "wall.js"), "utf-8").replace(/^\s*\/\/.*$/gm, "");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "eval("]) {
    assert.equal(src.includes(sink), false, `wall.js must not use ${sink}`);
  }
  assert.match(src, /textContent/);
});

test("the CSP lets Turnstile in, and nothing else new", () => {
  const headers = fs.readFileSync(path.join(SITE, "_headers"), "utf-8");
  assert.match(headers, /script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(headers, /frame-src https:\/\/challenges\.cloudflare\.com;/);
  assert.equal(/script-src[^;]*'unsafe-inline'/.test(headers), false);
});
