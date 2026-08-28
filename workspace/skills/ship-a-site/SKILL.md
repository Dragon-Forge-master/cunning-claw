---
name: ship-a-site
label: Ship a site
category: forge
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

## Deploy is a shell job, not a tool hunt

You deploy by running a CLI through `run_command`. There is **no special deploy tool** to
find. A connected Cloudflare **MCP** is for reads and management — listing workers, KV, DNS —
**it does not deploy**. If you catch yourself reaching for something like
`deploy_worker_script`, or calling `mcp_status` to look for one, stop: the answer is
`npx wrangler deploy` in a shell. Do not invent a tool that isn't in your list; use the shell
you already have.

`wrangler` is already logged in on this machine (the OAuth account tied to Chris's email), so
there is no login step — just deploy.

### Fastest live URL — a page on the edge

This works — it is a walked path, not a theory. Two files and one command puts a Worker on a
free subdomain:

```jsonc
// wrangler.jsonc
{ "name": "cunningclaw-demo", "main": "worker.js",
  "compatibility_date": "2025-06-01", "workers_dev": true }
```
```js
// worker.js — the whole page is the response body
export default { async fetch() {
  return new Response("<!doctype html>…", { headers: { "content-type": "text/html" } });
}};
```
```bash
npx wrangler deploy      # prints https://<name>.<subdomain>.workers.dev
```

Static folder instead of a Worker? `npx wrangler pages deploy ./dist --project-name <name>`
returns a `<name>.pages.dev` URL.

### Mind what the URL says out loud

A `*.workers.dev` URL is prefixed with the **account's** subdomain, which here is Chris's
business name (`cjvehiclespecialist`). He does not want that on a public link. So for anything
someone else will see, **prefer Pages** — `wrangler pages deploy --project-name cunningclaw`
gives `cunningclaw.pages.dev`, where the URL is the *project* name and the account name never
appears. Whichever you use, confirm the public name with Chris before you ship — the name is
part of what goes live, not an afterthought.

Then verify: open the returned URL, screenshot it, and only then report success — a deploy
that 200s on a blank page is a failure.

> **v0, Lovable, Bolt** generate UI; they are not hosts. If the user brings v0 output, the
> deploy target is Vercel. Treat generated code as a starting point and read it before
> shipping it.

## Build

1. **Pin the brief in one go** — who it's for, what the visitor should do, brand and copy,
   the domain. If told "just make something", pick sensibly and show them.
2. **Build locally.** Plain HTML and CSS is usually right: no build step, instant deploy,
   nothing to rot. Reach for a framework only when something genuinely needs one.
3. **Look at your own work.** `preview` with the site's folder `path` — the HUD serves it
   itself; do NOT try to start `python -m http.server` through run_command, which waits for
   commands to finish and reaps any server at the timeout. Then `take_screenshot` and judge
   it as a stranger would — does it read on a phone, is the call to action obvious, is
   anything misaligned. Fix what you see before showing it.
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
