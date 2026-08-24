---
name: ship-a-site
description: Build a website or Cloudflare Worker from a brief and deploy it live. Use when Chris asks you to make, build, or ship a site, landing page, or Worker for him or for a client.
---

# Ship a site

You have everything needed to take a brief to a live URL: `write_file`, `edit_file`,
`run_command`, `preview`, `browser_open` and `take_screenshot`. Work in that order.

## 1. Pin the brief before writing anything

Ask only what actually changes the build, and ask it all at once:
who it's for, what the visitor should do, any brand colours or copy, and the domain.
If Chris says "just make something", pick sensibly and show him — do not interrogate.

## 2. Build locally first

```bash
mkdir -p ~/sites/<name> && cd ~/sites/<name>
```

For a static site, plain HTML/CSS is usually right — no build step, deploys instantly,
nothing to maintain. Reach for a Worker only when there is server-side work: forms,
auth, an API, a database.

Write the files, then use `preview` to serve it and `take_screenshot` to **look at your own
work before showing it to him**. Judge it as a stranger would: does it read clearly on a
phone, is the call to action obvious, is anything misaligned. Fix what you see.

## 3. Deploy

```bash
cd ~/sites/<name>
npx wrangler pages deploy . --project-name=<name>     # static site
npx wrangler deploy                                    # Worker (needs wrangler.toml)
```

`wrangler` is not installed globally — always call it through `npx`.
Deploying is a state-changing command, so it raises an approval card. Expected. Put the
target and the project name in the command so Chris can see exactly what will go live.

## 4. Verify it is actually up

Never report success from a deploy log alone. Open the returned URL with `browser_open`,
read it with `browser_read`, and screenshot it. A deploy that returns 200 but renders a
blank page is a failure.

## Rules

- **Never deploy to a client's domain without Chris saying so explicitly in this
  conversation.** A staging URL on `*.pages.dev` is the safe default.
- Cloudflare credentials live in `.env` as `CLOUDFLARE_API_TOKEN`. Reference it as
  `${CLOUDFLARE_API_TOKEN}` in headers — never read the value, never print it.
- Do not register domains, change DNS, or alter billing. Surface what needs doing and
  let Chris do it.
- If a deploy fails twice for the same reason, stop and report. Do not retry a third time.
