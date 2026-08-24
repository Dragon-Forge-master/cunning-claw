---
name: business-platform
description: Build a complete multi-tenant business platform on Cloudflare — auth, database, storage, payments, email, dashboard. Use when Chris asks for a SaaS, a client portal, a booking or quoting system, or anything a business would run on rather than a brochure site.
---

# Build a business platform

Chris has already shipped one of these. **Read `Dragon-Forge-master/estimatic` before you
start** — it is the reference implementation, not a hypothetical: multi-tenant SaaS on
Workers, D1 for data, R2 for photos, vanilla front end with no build step, AI vision for the
core feature, Resend for email, and CJVS as tenant #1.

Copy its shape rather than inventing one.

## The stack

| Layer | Use | Binding |
|---|---|---|
| API + routing | Workers | — |
| Front end | Static files in `public/`, no build step | — |
| Database | D1 (SQLite) | `[[d1_databases]]` |
| File storage | R2 | `[[r2_buckets]]` |
| Config, sessions | KV | `[[kv_namespaces]]` |
| Background work | Queues, or an Agent on a schedule | — |
| Transactional email | Resend, or Cloudflare Email Routing | — |
| Bot protection | Turnstile on every public form | — |
| Payments | Stripe webhook into a Worker route | — |

**No build step is a deliberate choice, not laziness.** estimatic serves plain HTML and JS
from `public/`. It deploys in seconds, has no toolchain to rot, and a year from now it still
builds. Only reach for a framework when something genuinely needs one.

## Multi-tenancy from the first line

Retrofitting tenancy is painful; assume it immediately.

- Every table carries a `tenant_id`. Every query filters on it. No exceptions.
- Resolve the tenant from the hostname or the path prefix, once, at the edge.
- Seed with two tenants locally, never one — a single-tenant seed hides the bug where a
  query forgets its filter and quietly returns everyone's data.
- Per-tenant config (pricing, branding, rules) belongs in the database, not in code.

## Order of work

1. **Schema first.** Write the D1 migration and a seed with two tenants. Get the data model
   right before any UI — it is the expensive thing to change later.
2. **One vertical slice end to end.** One real feature from form to database to dashboard,
   deployed and working, before building breadth. It proves the whole pipeline.
3. **Then breadth**, once the slice holds.
4. **Payments last.** Never wire money until the thing it charges for actually works.

## Rules

- **Auth and payments get human review before launch.** Scaffold them, then say plainly that
  Chris should read them. An AI-written session check is exactly the code that must not be
  trusted on a first pass.
- Secrets go in `wrangler secret put`. Never in `wrangler.toml`, never in the repo.
- Turnstile on every public form. A quote form without it becomes a spam relay in days.
- Test locally against `npx wrangler dev` with a seeded local D1 before deploying.
- Deploy to a `*.workers.dev` URL first. A customer domain needs Chris to say so explicitly.
- After deploying, open the live URL and check it — a deploy log is not proof.

## Where you stop

You can build the platform. You cannot decide whether the business works. Pricing, market,
terms, liability and anything touching real customer money are Chris's calls. Build the
thing, show him what you built, and say what you were unsure about.
