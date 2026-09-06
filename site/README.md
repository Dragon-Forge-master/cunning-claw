# Landing page

Static. No build step, no framework — the whole page is `index.html`, and the
video sits beside it.

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
- Scripts live in their own files (`launch.js`). `_headers` sets a CSP with no
  `script-src`, so `default-src 'self'` applies and an inline `<script>` is
  silently refused by the browser — it will look fine locally and be dead live.

- `_headers` sets CSP, `X-Frame-Options: DENY` and `nosniff`. Pages applies it
  automatically; other hosts will ignore it, so re-do those headers if you move.
- `cunningclaw-demo.mp4` is 11MB. Pages serves it fine. If it ever needs to be
  smaller, re-encode at CRF 24 rather than dropping to 720p — the text in the
  frames is what suffers first.
- The numbers on the page (6 brains, 68 tools, 90 connectors, 306 tests, 2 dependencies) are
  real. Update them here when they change, or don't state them. Count them:
  brains from `claw.config.json`, tools with `grep -c '^    name: "' src/tools.ts`,
  tests from what `npm test` reports, connectors from `MCP_CATALOGUE.length` in
  `src/mcp-catalog.ts`.
- `hud.png`, `connect.png`, `skills.png`, `board.png` and `desk.png` are real captures of the HUD at rest on a fresh install (no keys, no
  Telegram). Re-shoot them from a clean data dir, never from a personal one.
- Fonts come from Google Fonts; `_headers` allows exactly those two hosts.
