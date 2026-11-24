# The website

Static, with no build step and no framework. Seven pages, each a plain `.html`
file that Pages serves without the extension:

| File | Address | What it is |
|---|---|---|
| `index.html` | `/` | The home page: the practice card, the films, a week, safety, downloads, cost, the wall |
| `features.html` | `/features` | The full week, every tool, all 95 connectors by name, new in 0.5 |
| `install.html` | `/install` | Every download, first-run steps, model prices, platforms, from source |
| `security.html` | `/security` | The box, the fence, the cards, the floor, the known gaps |
| `vs-openclaw.html` | `/vs-openclaw` | The comparison, sourced and dated |
| `about.html` | `/about` | The name, the makers, the doctrine, how to get in touch |
| `map.html` | `/map` | The constellation |

`404.html` is what Pages serves for an address that does not exist. Without
it, Pages answers every unknown address with the home page and a 200.

`site.css` is the whole site's stylesheet: every colour and face is a token in
its `:root`, and the theme in force is the last `:root` block in the file
(theme D, Dragon Forge's own orange on near-black navy, with Manrope and
JetBrains Mono; `docs/BRAND.md` records the ruling). `page.css` adds what the
five pages of prose need and names no colour of its own. `home.js` runs the
practice card, the downloads that know your computer, and the films; with
scripts off every page is complete. The one dynamic part is the forge wall, a
Pages Function in plain JS (below).

The five pages of prose share one bar and one footer, byte for byte;
`src/site-seo.test.ts` fails if one drifts, so change all five (and `404.html`)
together.

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

- **The five films are not in git.** `index.html` plays
  `cunningclaw-bank-details.mp4`, `cunningclaw-demo-2.mp4`,
  `cunningclaw-lovable.mp4`, `cunningclaw-business.mp4` and
  `cunningclaw-medical.mp4` from this folder
  (they are large; `.gitignore` holds `site/*.mp4`). Whoever runs
  `wrangler pages deploy` must have all five in `site/` on that machine first, or the players show their poster and
  play nothing. Their posters (`poster-*-1200.webp`, composed title cards) and
  captions (`*.vtt`) are small and are committed. No film is fetched until
  the visitor presses play (`preload="none"`).
- Scripts live in their own files (`home.js`, `wall.js`). `_headers` sets a CSP with no
  `script-src`, so `default-src 'self'` applies and an inline `<script>` is
  silently refused by the browser — it will look fine locally and be dead live.

- `_headers` sets CSP, `X-Frame-Options: DENY` and `nosniff`. Pages applies it
  automatically; other hosts will ignore it, so re-do those headers if you move.
- `cunningclaw-demo-2.mp4` is 86.9 s, 1920×1080 H.264 (yuv420p, faststart)
  with a mono AAC track at about 160 kbit/s, and 20.1 MB; Pages refuses any
  file over 25 MiB. The narration is the founder's own voice, an AI copy made
  with ElevenLabs from their own recording; the music is Cunning Claw's own,
  composed in code, and ducks under the voice. It is one real run:
  the request typed into the HUD on the Google brain, the approval card,
  EXECUTE, Claude Code building a site for Blawd a Mêl (a fictional Cardiff
  bakery-café) through the foreman, and the foreman's report, all from one
  Playwright recording of the HUD; then the finished site, recorded
  afterwards in Chromium at desktop and phone size, untouched since the
  foreman's commit. Stretches are sped up and each carries a badge saying by
  how much; captions are the only thing drawn on the frames. It was cut with
  ffmpeg and encoded two-pass at about 1.7 Mbit/s. If it ever needs to be
  smaller, lower the bitrate rather than drop to 720p — the text in the frames
  is what suffers first.
- `cunningclaw-bank-details.mp4` is 76.1 s, 8.7 MB, and `cunningclaw-lovable.mp4`
  is 159.9 s, 25.4 MB (two-pass at 1.1 Mbit/s to fit under the 25 MiB limit);
  both 1920×1080 H.264 with the same voice and music as the demo. Each is real
  runs of the claw recorded with Playwright, cut and captioned the same way.
  The supplier page in the first is a fake served on the recording machine;
  the second's retakes (Google's free tier stopping a turn, a read-only GitHub
  token) are described in the page's note and were not filmed. Its live demo is
  volt-vale-electrical.lovable.app, on the founder's Lovable account.
- The numbers on the page (11 brains, 83 tools, 95 connectors, 37 skills, 1111 tests, 2 dependencies) are
  real, counted at v0.5.2, the version the downloads give; move them on with each release. Update them here when they change, or don't state them. Count them:
  brains from `claw.config.json` (the catalogue less `managed`, which is not live until the relay is), tools with `grep -c '^    name: "' src/tools.ts`,
  tests from what `npm test` reports, connectors from `MCP_CATALOGUE.length` in
  `src/mcp-catalog.ts`, skills with `ls workspace/skills/*/SKILL.md`.
- `hud.png`, `connect.png`, `skills.png` and `desk.png`, shown on `/features`, are real captures of the HUD at rest on a fresh install (no keys, no
  Telegram), in the product's own cyan; `board.png` is kept but no page shows it. Re-shoot them from a clean data dir, never from a personal one, and under a
  clean HOME too: connectors live in ~/.config/cunningclaw/mcp.json, so a claw run on a
  machine that has another claw shows that claw's connectors. hud, connect, skills and desk
  were shot from v0.5.1 that way on 21 November; board.png is older, because Open-Meteo's
  daily limit for the shared address had run out that day and the weather box showed an error.
- `cunningclaw-business.mp4` is 146.5 s, 1920×1080, 25.0 MB (23.9 MiB, under
  the 25 MiB limit): five real requests in one conversation on Gemini 3.8
  Flash via OpenRouter, recorded with Playwright, then the built site and the
  PDFs. Its first attempt was discarded because the recording machine ran the
  claw as root, whose home folder the sensitive-path floor refuses
  (`/root/` in `src/paths.ts`); the retake ran with an ordinary home folder.
- `cunningclaw-medical.mp4` is 218.6 s, 1920×1080, 24.8 MB (23.7 MiB, under
  the 25 MiB limit, two-pass): a GP practice's AI plan, board pack and staff
  app in one conversation with a private claw on Gemini 3.8 Flash via
  OpenRouter (said in the captions; the plan itself calls for a local Ollama
  server). The claw made the plan PDF, the savings CSV and a patient notice
  itself, with a card before a file was replaced; the Front Desk app went to
  Claude Code after a card showing the brief. The notice the claw wrote claimed
  sign-offs (DPIA, DSPT, Caldicott, clinical safety) that do not exist, so the
  film calls it a draft. Cwm Taf Valley Medical Centre is fictional.
- Fonts come from Google Fonts; `_headers` allows exactly those two hosts for
  styles and fonts, and `challenges.cloudflare.com` for scripts and frames —
  Turnstile, the wall's spam check, and nothing else.

## What search engines and language models are told

Titles, descriptions, canonical links and share tags are in each page's head.
The rest is held to the page and the feed by `src/site-seo.test.ts`:

- **Structured data.** The home page carries `WebSite`, `Organization` and
  `SoftwareApplication` (with `softwareVersion`, the repository in `sameAs`,
  and a `disambiguatingDescription` that tells the product from the Diablo II
  item of the same name). Each page with a `<div class="faq">` (questions as
  `<details>`, the question in an `<h3>` inside the `<summary>`) carries a
  `FAQPage` block. **Never edit that block by hand:** change the visible
  question or answer, then run `npm run site:seo`, which writes the JSON-LD
  from the page's own words and the version from `latest.json`. No rating or
  review is declared, because there are none.
- **`llms.txt` and `llms-full.txt`** (llmstxt.org): the product in plain
  Markdown for language models. Their "Current release" line is stamped by the
  same script. The counts in them (tools, connectors, skills, tests) are the
  ones in the note above; move them together.
- **`sitemap.xml`** lists every page; the test fails if a page is missing from
  it or it names one that does not exist. Set `lastmod` to the day a page's
  words changed.
- **`vs-openclaw.html`** quotes OpenClaw's own documentation, and says the day
  it was read. Every row about OpenClaw links the page it came from, and a
  phrase in quotation marks is theirs word for word. Re-read those pages
  before each release and move the date, or correct the cell; a stale
  comparison is a false one.
- **The home page's one `h1`** holds the name and what it is ("Cunning Claw ·
  a free local AI agent for your own computer") as the small line above the
  headline, so the heading a search engine reads is not only a slogan.
- **`/features` lists every connector** in `MCP_CATALOGUE` by name, and the
  test fails when the catalogue gains one the page lacks.
- **A new page** needs: one `h1`, `lang="en-GB"`, a title of 20 to 60
  characters naming Cunning Claw, a description of 70 to 175, a canonical
  link, the share tags, the shared bar and footer, a line in `sitemap.xml` and
  in `llms.txt`, and an entry in the test's `PAGES`. No inline script, handler
  or `style` attribute: the CSP refuses the first two and the test all three.

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
3. `npm run site:seo`, which moves the version in the home page's structured
   data and in `llms.txt` and `llms-full.txt` to the feed's. Then, by hand:
   every element marked `data-rel` (`grep -n 'data-rel' site/*.html` — the
   version, each download link, each size, the test count), the file table and
   the `.deb` command on `install.html`, and the counts in the pages' own
   words. The test in the next step fails on any version marker or download
   link that is not the feed's.
4. `npm test`. `src/site-latest.test.ts` checks the file passes the claw's own
   validation, that each download is the asset `scripts/bundle.mjs` names, and
   that its version is **never newer than package.json's**. It may lag (the
   version is bumped while the next release is being prepared, and the feed
   still names the last published one, whose files exist) but a feed ahead of
   the code would announce a release whose downloads are links to nothing.
5. Deploy (above). Until then no claw has heard.

## Pocket Claw at /pocket/

`site/pocket/` is the phone app for pairing through the Pocket relay
(docs/POCKET-RELAY.md). It is generated: never edit it here. Change
`public/pocket/`, then run `npm run site:pocket`, which copies it, marks the
page as the site's copy, and writes `release.json` (the claw version and the
SHA-256 of every file). `src/site-pocket.test.ts` fails if this folder drifts
from that output. `_headers` gives `/pocket/*` its own strict policy, with the
homepage's detached first: the app's own files only, and `connect-src` for
the relay's host and nothing else. `functions/pocket/share.js` answers a
shared file that arrives before the service worker is installed by sending
the phone back to the app, unread. `_headers` marks it `noindex`: it is an app
shell, and the words about it are on the home page and `/features`.

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
