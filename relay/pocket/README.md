# The Pocket relay

A Cloudflare Worker and one Durable Object per claw that let a phone reach
its claw with no Tailscale: both dial out to it, and it carries an
end-to-end encrypted channel between them that it cannot read or forge. The
protocol, what the relay can and cannot see, and the threats it does and does
not answer are in [docs/POCKET-RELAY.md](../../docs/POCKET-RELAY.md).

This is not the managed-model relay in `relay/` (its own `wrangler.toml`,
its own Worker, `cunningclaw-relay`). Deploy this one from **this** folder.

Plain JavaScript, no npm install, no build step, no secret.

- `src/room.js` — the whole of the relay's judgement: who may occupy a room,
  who may join it, the caps. The claw's tests run this exact file in Node
  (`src/pocket-relay-room.test.ts`, `src/pocket-relay.test.ts`), so what is
  tested is what is deployed.
- `src/worker.js` — routes `/v1/room/<id>` to that room's Durable Object and
  adapts Cloudflare's WebSocket Hibernation API to `room.js`.
- `wrangler.toml` — the Worker, its custom domain, the Durable Object class,
  the per-address connection limit, and logging off.

## What the relay knows

Nothing on disk, ever: the code never writes Durable Object storage and
contains no `console` call (a test fails if either appears). While a socket
is open it holds, in that socket's attachment: its role, a random connection
id, the hash it was admitted by, and its rate counters; the claw's socket
also holds the hashes of the phone tokens and pairing tickets it listed. No
message content is parsed, stored or logged; after the hello, every message
is an opaque string. Workers Logs are off in `wrangler.toml`. Cloudflare
itself sees each connection's IP address and time, as for any site it
fronts, and the rate limiter keys on the address for 60 seconds.

A claw proves it owns its room with a secret only it holds: the room id is
SHA-256 of that secret, so there is nothing to register and nothing to
store, and nobody can squat a room before its claw arrives.

## Deploy (once, by Dragon Forge)

Checked against Cloudflare's documentation on 20 November 2026. Nothing here
creates anything until you run it; it has not been run yet.

1. **Prerequisites.** A Cloudflare account on which `cunningclaw.com` is an
   active zone (the site is already on Cloudflare Pages there). The Workers
   Free plan is enough: SQLite-backed Durable Objects are available on it.
   <https://developers.cloudflare.com/durable-objects/platform/pricing/>
2. **Sign in** (once per machine): `npx wrangler login`.
3. **Deploy, from this folder:**

   ```bash
   cd relay/pocket
   npx wrangler deploy
   ```

   That one command:
   - uploads the Worker `cunningclaw-pocket-relay`;
   - provisions the `PocketRoom` Durable Object namespace, SQLite-backed, from
     the `[exports.PocketRoom]` entry. New Workers declare Durable Object
     classes with `exports`; the older `[[migrations]]` array still works but
     cannot be mixed with it, and a class's namespace can only be created by
     `wrangler deploy`, not `wrangler versions upload`.
     <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>
     <https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/>
   - attaches the custom domain `pocket-relay.cunningclaw.com`; Cloudflare
     creates its DNS record and certificate. It fails if that hostname
     already has a CNAME record: delete it first.
     <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>
   - creates the rate limiter `CONNECT_LIMIT` (namespace `7301`, any
     integer unique within the account; nothing to create beforehand;
     period must be 10 or 60 seconds).
     <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
4. **No secrets.** There is no `wrangler secret put` step. `ALLOWED_ORIGINS`
   in `wrangler.toml` is the only setting: the pages a browser may connect
   from (`https://cunningclaw.com`).
5. **Check it:**

   ```bash
   curl https://pocket-relay.cunningclaw.com/healthz
   # {"ok":true,"service":"cunning-claw pocket relay","protocol":1}
   ```

   Then on any claw, `npm run doctor` should say `Pocket relay: reachable`.
6. **Publish the phone app** with the site, as usual (site/README.md):

   ```bash
   npm run site:pocket            # refresh site/pocket/ from public/pocket/
   cd site && npx wrangler pages deploy . --project-name=cunningclaw
   ```

   `npm run doctor`'s `Pocket app` line then confirms the live scripts match
   the claw's own copy byte for byte.
7. **Logs stay off.** New Workers have Workers Logs on by default;
   `[observability] enabled = false` and `invocation_logs = false` keep them
   off. Do not turn them on to debug: use `wrangler dev` locally.
   <https://developers.cloudflare.com/workers/wrangler/configuration/#observability>

If the relay ever moves to another hostname, change it in three places
together: `wrangler.toml` (`pattern`), `site/_headers` (`connect-src`) and
`claw.config.json` (`pocket.relay.url`). `src/site-pocket.test.ts` fails if
they disagree.

## Run it locally

```bash
cd relay/pocket
npx wrangler dev --port 8787 --var ALLOWED_ORIGINS:http://localhost:8788
```

A claw reaches it with `"pocket": { "relay": { "url": "ws://127.0.0.1:8787",
"appOrigin": "http://localhost:8788" } }`, and serves the app from `site/` on
port 8788. Plain `ws://` and `http://` are accepted only for this machine's
own names.
