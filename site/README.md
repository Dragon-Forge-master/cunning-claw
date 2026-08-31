# Landing page

Static. No build step, no framework — the whole page is `index.html`, and the
video sits beside it.

## Deploy to a forgenet.cloud subdomain

```bash
cd site
npx wrangler pages deploy . --project-name=cunningclaw
```

Then in the Cloudflare dashboard: **Workers & Pages → cunningclaw → Custom domains**,
add `cunningclaw.forgenet.cloud`. DNS is handled for you if forgenet.cloud is already
on this Cloudflare account.

## Notes

- `_headers` sets CSP, `X-Frame-Options: DENY` and `nosniff`. Pages applies it
  automatically; other hosts will ignore it, so re-do those headers if you move.
- `cunningclaw-demo.mp4` is 11MB. Pages serves it fine. If it ever needs to be
  smaller, re-encode at CRF 24 rather than dropping to 720p — the text in the
  frames is what suffers first.
- The numbers on the page (6 brains, 68 tools, 284 tests, 2 dependencies) are
  real. Update them here when they change, or don't state them. Count them:
  brains from `claw.config.json`, tools with `grep -c '^    name: "' src/tools.ts`,
  tests from what `npm test` reports.
