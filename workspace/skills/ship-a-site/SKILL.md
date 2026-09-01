---
name: ship-a-site
label: Ship a site
category: forge
description: Build a website or web app in any stack — plain HTML, React, Vue, Svelte, anything with a toolchain — show it live in the glass, iterate conversationally, deploy on request. Use when asked to make, build, or ship a site, landing page, or app.
---

# Ship a site

The experience to deliver: The operator speaks, a good-looking site appears on the glass,
they say "make the header bigger", and it changes in front of them. Lovable and v0
sell exactly this — you do it locally, on their machine, in whatever stack fits.

## The loop — show early, change live

1. **Restate the brief in one line and start.** Sensible defaults beat questions;
   ask only when two readings genuinely diverge and the wrong one costs real work.
2. **Scaffold the smallest thing that looks great** (stack table below).
3. **`preview` with the site's folder path — immediately.** The HUD serves it
   itself. First render on the glass within the first few tool calls, even if
   it is only the hero. Never try to host a server through run_command; it
   waits for commands to finish and reaps them at the timeout.
4. **Iterate conversationally.** Every change request is an `edit_file`, then
   `preview` reload, then one phrase about what changed. He must never have to
   ask "can I see it?" — reload after every edit, always.
5. **Deploy only when they say so** (deploy sections below).

## Any stack — pick by the job, not by habit

| The ask | Build | Show |
|---|---|---|
| Landing page, portfolio, menu, brochure, invite | **One `index.html`, embedded CSS, Google Fonts** — the default; no toolchain to rot | `preview` the folder |
| "React" / "Vue" / "Svelte" / interactive app / SPA | `npm create vite@latest <name> -- --template react` (or `vue`, `svelte`, `react-ts`…), `npm install`, `npm run build` | `preview` the **`dist/`** folder |
| Multi-page content site, docs, blog | Plain HTML pages, or Astro when they name it | `preview` the folder / `dist/` |
| A backend (Flask, Express, APIs) | Write the code honestly — but local hosting of long-running servers is not possible yet (run_command reaps them). Target **Cloudflare Workers** and deploy there, or hand the operator the run command for their own terminal | Deployed URL |
| Any other language they name | You have a shell: if its toolchain emits static files, build them | `preview` the output |

Framework iteration has no dev server here — the cycle is **edit `src/` →
`npm run build` → `preview` reload**. Vite builds in seconds; that is fast
enough to feel live. Installs can take a minute or two; if a command is
reaped at the timeout anyway, run it once more — npm resumes where it left off.

## The design bar — this is what makes it feel like Lovable

Never ship browser-default styling. Every site, even a "quick" one, gets:

- A **palette**: four or five colours with one deliberate accent — chosen for
  the subject, stated in `:root` variables. (A site about Cunning Claw or
  Dragon Forge wears the house style: near-black ground, cyan `#35d6ed` accent.)
- **Real typefaces**: a Google Fonts pairing — display + body. Never Times,
  never bare Arial.
- **Space and rhythm**: a spacing scale, generous padding, `max-width` around
  65ch for prose, real vertical breathing room between sections.
- **A hero worth looking at**: strong headline, one clear call to action.
- **Hover states and small transitions** on anything clickable.
- **Responsive by construction**: flexbox/grid with `gap`, images `max-width:100%`.
- **Real copy** drawn from what you know of the subject — never lorem ipsum.

## Keep the project findable

Put sites in `~/sites/<name>`. After the first successful render, `memory_save`
the project name and path — so "carry on with the website" works next session
instead of a hunt through globs.

## Deploy where the user already is

**Do not assume a host.** Look before you choose:

```bash
ls vercel.json netlify.toml wrangler.toml wrangler.jsonc fly.toml railway.json 2>/dev/null
for c in vercel netlify wrangler flyctl railway gh; do which $c 2>/dev/null; done
```

| Host | Deploy | Good for |
|---|---|---|
| Cloudflare | `npx wrangler pages deploy <dir> --project-name <name>` · `npx wrangler deploy` | Static and Workers; D1, R2, KV; generous free tier |
| Vercel | `npx vercel --prod` | Next.js, React, anything v0 generated |
| Netlify | `npx netlify deploy --prod` | Static sites, Jamstack |
| GitHub Pages | `gh` + Actions, or push to `gh-pages` | Docs, zero cost |
| A plain server | `rsync -avz ./dist user@host:/var/www/` | the operator already has a box |

**If nothing is configured, recommend Cloudflare and say why.** Then let them
overrule you.

## Deploy is a shell job, not a tool hunt

There is **no special deploy tool**. A connected Cloudflare **MCP** is for reads
and management — **it does not deploy**. The answer is `npx wrangler deploy` in
the shell you already have. `wrangler` is already logged in on the Linux machine.

### Mind what the URL says out loud

A `*.workers.dev` URL is prefixed with the **account's** subdomain — the operator's
business name. For anything public, **prefer Pages**:
`npx wrangler pages deploy <dir> --project-name cunningclaw` →
`cunningclaw.pages.dev`, no business name anywhere. Confirm the public name with
The operator before shipping — the name is part of what goes live.

Then verify: open the returned URL, screenshot it, and only then report success —
a deploy that 200s on a blank page is a failure.

## Rules

- First render on the glass early; reload after every edit, unprompted.
- Staging URL first; a custom or client domain needs the operator to say so explicitly.
- Credentials come from `.env` as `${VAR}` — reference them, never read or print them.
- Do not register domains, change DNS, or touch billing.
- Two identical failures means the approach is wrong. Stop and report rather than retry.

## Test it before you call it done

A page is the one kind of work you can check yourself, so there is no excuse for
reporting it fixed on faith:

1. `preview` it, so the operator can see it.
2. `browser_open` the same URL, `browser_snapshot`, and actually drive it —
   `browser_press` for keyboard handling, `browser_click` for buttons.
3. Say what you tested. "Arrow keys move it; I checked" is worth something.
   "I have fixed the controls" without having pressed one is not.

If a thing genuinely cannot be tested from here, say so in the same sentence as
the claim, and ask what they are seeing. A second identical complaint means the
last change was not the fix — read the code you wrote and form a hypothesis
before touching it again.
