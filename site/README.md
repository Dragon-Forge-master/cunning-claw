# Landing page

Static, with no build step and no framework — the whole page is `index.html`,
and the video sits beside it. The one dynamic part is the forge wall, a Pages
Function in plain JS (below).

## Deploy

The live site is **https://cunningclaw.com** (Cloudflare Pages).

```bash
cd site
npx wrangler pages deploy . --project-name=cunningclaw
```

`cunningclaw.forgenet.cloud` was the first address and still serves an older
deploy ("The Forge Master's Agent"). Retire it, or redirect it to cunningclaw.com,
in the Cloudflare dashboard — a stranger who lands there today sees a page from
before the rebrand.

## Notes

- **The two films are not in git.** `index.html` plays `brand-film.mp4` and
  `cunningclaw-demo.mp4` from this folder, but neither is committed (they are
  large and change often). Whoever runs `wrangler pages deploy` must have both
  files in `site/` on that machine first, or the players show a black box.
- Scripts live in their own files (`holo.js`, `wall.js`). `_headers` sets a CSP with no
  `script-src`, so `default-src 'self'` applies and an inline `<script>` is
  silently refused by the browser — it will look fine locally and be dead live.

- `_headers` sets CSP, `X-Frame-Options: DENY` and `nosniff`. Pages applies it
  automatically; other hosts will ignore it, so re-do those headers if you move.
- `cunningclaw-demo.mp4` is 11MB. Pages serves it fine. If it ever needs to be
  smaller, re-encode at CRF 24 rather than dropping to 720p — the text in the
  frames is what suffers first.
- The numbers on the page (11 brains, 75 tools, 95 connectors, 37 skills, 717 tests, 2 dependencies) are
  real. Update them here when they change, or don't state them. Count them:
  brains from `claw.config.json` (the catalogue less `managed`, which is not live until the relay is), tools with `grep -c '^    name: "' src/tools.ts`,
  tests from what `npm test` reports, connectors from `MCP_CATALOGUE.length` in
  `src/mcp-catalog.ts`, skills with `ls workspace/skills/*/SKILL.md`.
- `hud.png`, `connect.png`, `skills.png`, `board.png` and `desk.png` are real captures of the HUD at rest on a fresh install (no keys, no
  Telegram). Re-shoot them from a clean data dir, never from a personal one.
- Fonts come from Google Fonts; `_headers` allows exactly those two hosts for
  styles and fonts, and `challenges.cloudflare.com` for scripts and frames —
  Turnstile, the wall's spam check, and nothing else.

## The update feed

`latest.json` is the file every claw that said yes to the update check
(`src/updates.ts`) reads once a day. It names the newest released version,
its date, whether it is a security update, up to six short summary lines
(display text on the HUD; never shown to the model), the release notes and
one download per installer and archive. `_headers` gives it an hour's cache,
so a release reaches every claw within the day and a mistake can be undone as
fast. The claw refuses the whole file if any of it is wrong, so a broken feed
means no light, never a wrong one.

### Release checklist

1. Publish the GitHub release, with all its assets uploaded.
2. **Then** update `latest.json`: `version` and `date` (the day it was
   published), `security` (true only when the release fixes a security
   problem — it turns the light red-amber and tells the phones so), the
   summary, the `notes` link to the release, and every download link with the
   new version in it.
3. `npm test`. `src/site-latest.test.ts` checks the file passes the claw's own
   validation, that each download is the asset `scripts/bundle.mjs` names, and
   that its version is **never newer than package.json's**. It may lag (the
   version is bumped while the next release is being prepared, and the feed
   still names the last published one, whose files exist) but a feed ahead of
   the code would announce a release whose downloads are links to nothing.
4. Deploy (above). Until then no claw has heard.

## The forge wall

The "ask the forge" section (`#ask`) is a small live wall: visitors ask a
question or suggest a feature, the team answers, and a card shows its journey —
asked, answered, planned, built — with a link to the commit or release once it
ships. Nothing a visitor writes is public until a person approves it.

- `wall.js` — the page side. Visitor text is set with `textContent` only and
  links in it are never made clickable. With no API it leaves the static note
  in place; with the API but no Turnstile key it shows cards and rests the form.
- `functions/api/wall/[[route]].js` → `functions/_wall/wall.js` — the backend, a
  Pages Function over D1 (binding `WALL_DB`). Pre-moderation, Turnstile checked
  on the server, rate limits keyed by an HMAC of the IP (never the IP), one vote
  per visitor per card, length limits, admin by bearer token. Its tests are
  `src/site-wall.test.ts`, run by `npm test`.
- `functions/_wall/schema.sql` — the tables. `functions/` is compiled by
  Pages and not uploaded as files; `wrangler.toml` **is** uploaded (it is
  readable at `/wrangler.toml`), which is why it holds no secret.
- The claw's side is the `site_wall` tool (`src/wall.ts`): it lists pending
  and public cards, fenced as strangers' words, and approves, hides, answers
  and moves them — each one behind an approval card.

### One-off setup

Run these from `site/`, logged in to the Cloudflare account that owns the
`cunningclaw` Pages project (`npx wrangler login`).

1. **Create the database in the EU.** A jurisdiction can only be set when the
   database is created, never added later.

   ```bash
   npx wrangler d1 create cunningclaw-wall --jurisdiction=eu
   ```

   In `wrangler.toml`, remove the `#` from the four `[[d1_databases]]` lines
   (they ship switched off, because Pages refuses a deploy that names a
   database that does not exist yet) and put the `database_id` it printed in
   place of the zeros.

2. **Create the tables.**

   ```bash
   npx wrangler d1 execute cunningclaw-wall --remote --file=./functions/_wall/schema.sql
   ```

   Every statement is `IF NOT EXISTS`, so running it twice is harmless.

3. **Make a Turnstile widget.** Cloudflare dashboard → Turnstile → Add widget.
   Hostname `cunningclaw.com` (add `cunningclaw.pages.dev` too if you want it
   to work on preview deploys), widget mode *Managed*. It gives you two keys:
   - the **site key** is public: in `index.html`, replace
     `data-sitekey="TURNSTILE_SITE_KEY"` with it. Until you do, the form stays
     hidden and the wall says new cards open soon.
   - the **secret key** goes in the next step, never in a file.

4. **Set the three secrets.** Each command prompts for the value.

   ```bash
   npx wrangler pages secret put TURNSTILE_SECRET --project-name=cunningclaw
   npx wrangler pages secret put WALL_ADMIN_TOKEN --project-name=cunningclaw
   npx wrangler pages secret put WALL_IP_SALT --project-name=cunningclaw
   ```

   - `TURNSTILE_SECRET` — the widget's secret key from step 3.
   - `WALL_ADMIN_TOKEN` — make one with `echo "ccw_$(openssl rand -hex 32)"`.
     Under 32 characters and admin stays switched off. Keep the same value for
     the claw (step 6). The `ccw_` prefix is what lets the claw's redaction
     recognise a pasted one.
   - `WALL_IP_SALT` — `openssl rand -hex 32`. It keys the hashes that stand in
     for IP addresses. Changing it later resets who has voted on what.

   Without `TURNSTILE_SECRET` and `WALL_IP_SALT` the wall refuses new cards
   rather than skipping the check.

5. **Deploy**, so the new secrets and the Function go live together.

   ```bash
   npx wrangler pages deploy . --project-name=cunningclaw
   ```

   From the first deploy with `wrangler.toml` in this folder, that file is the
   source of truth for the project's settings; the dashboard shows them
   read-only.

   Check it: `curl https://cunningclaw.com/api/wall/cards` should answer
   `{"ok":true,"cards":[]}`, and
   `curl -H "Authorization: Bearer $TOKEN" https://cunningclaw.com/api/wall/admin/cards`
   should list the (empty) pending queue.

6. **Connect the claw.** Put the same token in the claw's `.env` as
   `WALL_ADMIN_TOKEN=`. `siteWall.url` in `claw.config.json` already points at
   `https://cunningclaw.com`. Then ask him what is pending on the wall.

### Moderating

The claw is the everyday way: "what's on the wall?", then approve, answer or
move a card — each change shows you exactly what will be public before it
happens. By hand, with the token in `$TOKEN`:

```bash
B=https://cunningclaw.com/api/wall/admin
curl -H "Authorization: Bearer $TOKEN" "$B/cards?moderation=pending"     # or public, hidden, all; or ?id=12
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"id":12}' $B/approve   # also: hide, delete
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"id":12,"answer":"Yes — on the plan."}' $B/answer
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":12,"stage":"built","link":"https://github.com/Dragon-Forge-master/cunning-claw/releases/tag/v0.5.0"}' $B/stage
```

`delete` is only here, on purpose: the claw can hide a card but not destroy
one. The page promises that a card is taken down when someone asks in an
issue — `hide` or `delete` is how.

### Trying it locally

```bash
npx wrangler d1 execute cunningclaw-wall --local --file=./functions/_wall/schema.sql
npx wrangler pages dev . --port 8788 \
  --binding TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
  --binding WALL_IP_SALT=local-dev-salt-0123456789 \
  --binding WALL_ADMIN_TOKEN=ccw_local_dev_only_0123456789abcdef
```

Those are Cloudflare's published Turnstile test keys (the secret always
passes; the matching site key is `1x00000000000000000000AA`). Use them only
locally, in a copy of `index.html` — never deploy a test key.
