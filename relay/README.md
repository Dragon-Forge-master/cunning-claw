# Dragon Forge relay

The "Just works" retail tier for Cunning Claw. A customer's claw sends
OpenAI-compatible chat requests here with their `DRAGONFORGE_TOKEN`; the relay
validates the token, forwards the request to OpenRouter on the house provider
key, streams the answer straight back, and meters a monthly token budget.
The customer never handles a provider key, never signs up with OpenRouter,
never sees a usage dashboard they didn't ask for.

It is a single Cloudflare Worker with **zero npm dependencies** — plain Worker
APIs only, in keeping with the main codebase's two-runtime-dependency ethos.

## The privacy invariant

**The relay never logs, stores, or inspects message content.** No prompt ever
touches a log line, KV, or analytics. The only fields read from a request are
the Authorization header, `model`, and `stream`; the only field read from a
response is `usage.total_tokens` (streamed bodies are piped through
byte-for-byte with a length counter and nothing more). The relay counts
tokens; it does not read words. This is the product's one promise — any
change to `src/index.ts` is reviewed against it first.

## Endpoints

| Route | What |
| --- | --- |
| `POST /v1/chat/completions` | The relay. Bearer token required. Streamed and non-streamed. |
| `GET /healthz` | `{"ok":true}` |

Failure modes are short, friendly JSON: `401` unknown token, `403` disabled
token, `402` monthly budget spent (upgrade or wait for the month to roll),
`400` model not on the plan's allowlist.

## Deploy

```bash
cd relay
wrangler kv namespace create TOKENS     # once; paste the id into wrangler.toml
wrangler secret put OPENROUTER_KEY      # the house OpenRouter key
wrangler deploy
```

The model allowlist is the `MODELS` var in `wrangler.toml` (comma-separated;
defaults to `google/gemini-3.5-flash-lite`). Tokens are minted by hand for
now — see `provision.md`.

## Pointing a claw at it

> **Not yet deployed** — `relay.cunningclaw.com` has no DNS yet. Until it
> does, use the `*.workers.dev` URL wrangler prints, with the same `/v1` path.

A managed-brain claw is just an OpenAI-compatible brain whose base URL is the
relay and whose "API key" is the Dragon Forge token:

```jsonc
// claw.config.json → brain roster
{
  "provider": "openai",
  "model": "google/gemini-3.5-flash-lite",
  "baseUrl": "https://relay.cunningclaw.com/v1",
  "apiKeyEnv": "DRAGONFORGE_TOKEN"
}
```

with `DRAGONFORGE_TOKEN=df_...` in the claw's `.env`.

## Metering honesty

Non-streamed responses are metered exactly, from the `usage.total_tokens`
OpenRouter reports. Streamed responses are *estimated* — (request bytes +
response bytes) / 4 — because reading the real figure would mean parsing the
SSE frames, which the privacy invariant forbids. The KV counter increment is
read-modify-write, so truly simultaneous requests on one token can drop an
increment; both approximations err in the customer's favour and are
acceptable per-customer for v1 (a Durable Object per token is the upgrade
path if that stops being true).

## Tests

```bash
node relay/test.mjs
```

Plain `node:assert` over the pure functions in `src/lib.ts` — no test
framework, no build step (relies on Node 22.18+'s built-in type stripping).
