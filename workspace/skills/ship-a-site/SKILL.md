---
name: ship-a-site
description: Build a website or web app from a brief and deploy it live, to whatever host the user actually uses. Use when asked to make, build, or ship a site, landing page, or app.
---

# Ship a site

You have everything needed to take a brief to a live URL: `write_file`, `edit_file`,
`run_command`, `preview`, `browser_open` and `take_screenshot`.

## Deploy where the user already is

**Do not assume a host.** Look before you choose — the answer is usually already on the
machine:

```bash
ls vercel.json netlify.toml wrangler.toml wrangler.jsonc fly.toml railway.json 2>/dev/null
for c in vercel netlify wrangler flyctl railway gh; do which $c 2>/dev/null; done
```

An existing config file or a logged-in CLI is the answer. Use it.

| Host | Deploy | Good for |
|---|---|---|
| Cloudflare | `npx wrangler pages deploy .` · `npx wrangler deploy` | Static and Workers; D1, R2, KV in one account; generous free tier |
| Vercel | `npx vercel --prod` | Next.js, React, anything v0 generated |
| Netlify | `npx netlify deploy --prod` | Static sites, Jamstack, forms built in |
| GitHub Pages | `gh` + Actions, or push to `gh-pages` | Docs, project sites, zero cost |
| Fly.io | `flyctl deploy` | Long-running processes and containers |
| Railway | `railway up` | Quick full-stack with a managed database |
| A plain server | `rsync -avz ./dist user@host:/var/www/` | The user already has a box |

**If nothing is configured, recommend Cloudflare and say why** — one CLI covers static sites,
serverless functions, database, and file storage, and the free tier genuinely ships things.
Then let the user overrule you. A recommendation is not a restriction.

Anything with a CLI works, because you have a shell. There is no per-provider support to
wait for.

> **v0, Lovable, Bolt** generate UI; they are not hosts. If the user brings v0 output, the
> deploy target is Vercel. Treat generated code as a starting point and read it before
> shipping it.

## Build

1. **Pin the brief in one go** — who it's for, what the visitor should do, brand and copy,
   the domain. If told "just make something", pick sensibly and show them.
2. **Build locally.** Plain HTML and CSS is usually right: no build step, instant deploy,
   nothing to rot. Reach for a framework only when something genuinely needs one.
3. **Look at your own work.** `preview` it, `take_screenshot`, and judge it as a stranger
   would — does it read on a phone, is the call to action obvious, is anything misaligned.
   Fix what you see before showing it.
4. **Deploy.** State-changing, so it raises an approval card. Put the target in the command
   so the user can see exactly what goes live.
5. **Verify.** Open the returned URL, read it, screenshot it. A deploy that returns 200 and
   renders a blank page is a failure. Never report success from a log alone.

## Rules

- Staging URL first. A custom or client domain needs the user to say so explicitly.
- Credentials come from `.env` as `${VAR}` — reference them, never read or print them.
- Do not register domains, change DNS, or touch billing. Say what needs doing; let the
  human do it.
- Two identical failures means the approach is wrong. Stop and report rather than retry.
