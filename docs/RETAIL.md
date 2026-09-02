# Retail — the two ways to own a claw

How Cunning Claw is sold, and what is promised to each kind of owner. The rule of the
house applies to every line here: each claim must survive "how do we know?" — so every
section is marked **BUILT** (in the repo now, testable) or **PLANNED** (written down,
not deployed). As of this writing, **nothing in the relay exists outside this document
and the Worker source being written alongside it in `relay/`.** No Worker is deployed,
no Stripe account is wired, no token has ever been issued.

## The two tiers

| | Bring your own key | Just works |
|---|---|---|
| Costs | Free, forever | A monthly package |
| Who it serves | People comfortable making an OpenRouter or Gemini account | People who are not, and should never have to be |
| Setup | Put a key in `.env` or the HUD Keys page | Paste one Dragon Forge token |
| Model traffic | Your machine → provider, directly | Your machine → Dragon Forge relay → provider |
| Capability | Everything | Everything. The same everything. |
| Status | **BUILT** (`.env` path; the Keys page is **PLANNED**) | **PLANNED** |

**Bring your own key** is the current behaviour: `install.sh` asks for an OpenRouter key,
the brain catalogue in `claw.config.json` points at `https://openrouter.ai/api/v1`, and
the claw spends the owner's money at the owner's chosen rate. This tier is the open-source
project and it is never crippled — see Refusals below.

**Just works** exists because the operator runs a garage, not a software house, and knows
exactly who walks in the door: someone who wants the thing to work and does not want to
learn what an API is. They subscribe, they receive one `DRAGONFORGE_TOKEN`, they paste it
once. The word "API" never appears in anything they read.

### Pricing thinking (all figures estimates, working shown)

The workhorse brain is Gemini flash-class via OpenRouter: **$0.30/M input, $2.50/M output**
(those are the live numbers in `claw.config.json`; the operator's brief says assume
$0.30–0.50/M input, so take the range as the planning band).

An agent turn is input-heavy: system prompt, history, tool results. Estimate a typical
turn at **~15k input + ~500 output tokens** (estimate — measure real transcripts before
setting caps). Per turn: 15k × $0.30/M + 500 × $2.50/M ≈ **$0.0058**, call it 0.6¢.

What £7/month buys (at ~$1.30/£, so ~$9.10 gross — estimate):

| | Estimate |
|---|---|
| Stripe fee (UK card, ~1.5% + 20p) | ~£0.31 |
| Model spend allowance at cap | **$4.50** (~£3.46) |
| Turns that buys at 0.6¢/turn | **~750/month, ~25/day** |
| Left for Cloudflare, support, margin | ~£3.20/month |

Honest headroom: 25 turns a day is a genuinely used assistant, not a demo — but a heavy
day of browsing (40k-token tool results) can burn 5× the typical rate. Hence the cap is
on **metered spend, not turns**, and the cap message says how much is left all month, not
just at the end. If real usage shows $4.50 is mean rather than generous, the honest moves
are a higher price or a lower cap — never silent model-downgrading.

## The relay — **PLANNED** (source in `relay/`, not yet deployed)

A single Cloudflare Worker. It is a **pipe, not a reader** — that is the hard invariant:

> **The relay never logs, stores, or inspects message content. It reads exactly two
> things from a response: the status code and the `usage` object. Nothing else.**

How we know: the Worker source is open in `relay/`, deliberately small enough to read in
one sitting; Workers observability logging is off in `wrangler.toml`; there is no
`console.log` of any body, and a review rule in `relay/` says a PR adding one is refused.
The proof is the code being short and public, not a promise being loud.

### Shape

- **Endpoint**: `POST /v1/chat/completions`, OpenAI-compatible, streamed and unstreamed.
  The body passes through to OpenRouter untouched except that the relay pins the model
  server-side (the customer's plan decides the model; a client-supplied model id outside
  the plan's allowlist is replaced, not honoured — the relay holds the real provider key
  and will not let one token spend at Pro rates on a flash plan).
- **Auth**: `Authorization: Bearer <DRAGONFORGE_TOKEN>`. Unknown or revoked token → 401.
  The real OpenRouter key lives only in the Worker's secret store, never in a response.
- **Metering**: OpenRouter is asked to include usage (`usage: {include: true}`); the
  relay reads the `usage` object from the final chunk, prices it against the plan's
  rates, and adds it to the month's total in KV.
- **At cap**: HTTP **402** with an OpenAI-shaped error body so the claw renders it as a
  message, not a crash: *"Your claw has done a full month's thinking and the plan's
  allowance is used. It resets on the 1st. If you keep hitting this, tell us — the plan
  may be too small for you, and that is our problem to fix, not yours."* Polite, plain,
  no jargon, and it never pretends to be a model error.

### KV schema (Workers KV)

| Key | Value | Notes |
|---|---|---|
| `tok:<token>` | `{ status, plan, customerId, createdAt }` | `status`: `active` \| `revoked`. Written by billing, read on every request. |
| `use:<token>:<YYYY-MM>` | `{ inputTokens, outputTokens, spendMicroUsd, turns, updatedAt }` | Read-modify-write per request. Month key = automatic reset; old months age out via KV TTL (~90 days) — enough for a billing dispute, no longer. |
| `plan:<planId>` | `{ capMicroUsd, models: [...], label }` | One read, cacheable in the Worker for minutes. |

Stated plainly: **KV has no atomic increment**, so under concurrent turns the counter can
undercount briefly — the cap is enforceable to within a few turns, not to the token. That
is acceptable for a politeness cap on a single-owner assistant (one claw, serial turns).
If it ever is not, the upgrade path is a Durable Object per token; the schema above maps
onto it unchanged. Designing for that day now would be dishonest complexity.

The token itself is 32 random bytes, prefixed `df_` so a leak is greppable and
`src/redact.ts` can recognise it. It is a bearer credential: whoever holds it can spend
the plan. Revocation is one KV write.

## Claw-side wiring — **PLANNED** (small; the brain plumbing it rides on is **BUILT**)

The relay speaks the same dialect as every OpenAI-compatible brain the claw already runs
(`src/brain.ts` — this is why the relay is OpenAI-shaped and not bespoke). The managed
tier is therefore one catalogue entry, no new code path:

```jsonc
// claw.config.json → brains.catalog — ships in the default config, inert without a token
{ "id": "managed", "label": "Managed", "provider": "openai",
  "model": "dragonforge/plan-default",
  "baseUrl": "https://relay.dragonforge.example/v1",   // final host TBD — not yet registered
  "apiKeyEnv": "DRAGONFORGE_TOKEN",
  "note": "the subscription — one token, no accounts anywhere else" }
```

The **Keys page** (HUD, **PLANNED** — not in `public/` yet) is where the two tiers meet:
one page listing each brain's key slot. For the managed tier its whole job is: one field
labelled **"Your Dragon Forge token"**, paste, save (writes `DRAGONFORGE_TOKEN` to `.env`
via the existing redaction-aware config path), and the claw switches its default brain to
`managed` and says hello. That paste is the entire setup. The page also shows the month's
usage as a plain sentence ("about a third used, resets on the 1st"), fetched from a relay
`GET /v1/me` endpoint — the customer's own metering, shown without asking them to
understand tokens.

The trusted-brain routing (`src/routing.ts`, **BUILT**) treats the managed brain like any
other flash-class brain: it is trusted iff the underlying model is, which the plan pins.

## Billing — **PLANNED**, design only, nothing wired

Stripe end to end; the relay never sees a card and the claw never sees Stripe.

1. Customer subscribes via a Stripe Checkout link (from the website, `site/`).
2. Stripe calls a webhook route on the same Worker (`POST /billing/stripe`, signature
   verified with the webhook secret — an unverifiable event is dropped and counted).
3. `checkout.session.completed` → mint token, write `tok:<token>` to KV, email the
   customer one message: the token and the one-paste instruction. Nothing else.
4. `invoice.paid` → keep `status: active`. Payment failed / subscription cancelled →
   `status: revoked` after Stripe's own retry grace, with a final email saying so in
   plain words. Revoked ≠ deleted: resubscribing reactivates the same token.
5. Refund handling, plan changes, and the email sender are design gaps — listed here so
   they are not forgotten, not silently absent.

## What is deliberately refused

- **No token or coin, ever.** The house pledge (`docs/BRAND.md`) already says there is no
  Cunning Claw cryptocurrency and never will be. `DRAGONFORGE_TOKEN` is a subscription
  credential, a string in a `.env` file — the unfortunate collision of names ends here.
- **No content logging.** The relay's value is that it holds a key and counts, nothing
  more. A relay that reads is a product we refuse to build; the open Worker source in
  `relay/` is the standing proof.
- **No lock-in.** The BYO-key tier is never crippled, rate-limited, or feature-gated to
  push the subscription; the managed tier is convenience, not capability. A managed
  customer who learns what an API is can put their own key in the Keys page and cancel,
  and the software will not sulk. If the paid tier cannot survive that being easy, it
  does not deserve to exist.
- **No silent downgrades.** At the cap the claw stops and says so. It does not get
  quietly stupider to protect the margin.

*Yn lleol yn gyntaf · Caniatâd dynol pan fo canlyniadau* — and now: paid for plainly,
where it is paid for at all.
