# Pocket through the relay

Pocket Claw's second way home. The first, the private network
(docs/POCKET-CLAW.md), asks for Tailscale on the PC and on the phone. This one
asks for nothing: open **cunningclaw.com/pocket** on the phone, scan the QR on
the HUD, touch the fingerprint sensor. It works from anywhere, because both
ends dial *out* to a relay that Dragon Forge runs, and the relay carries an
end-to-end encrypted channel it cannot read or forge.

This file is the specification. `src/pocket-e2e.ts` (the claw, node:crypto)
and `public/pocket/e2e.js` (the phone, WebCrypto) implement it, and the tests
run one against the other. Where this file and the code disagree, the code
is wrong.

| Part | Where |
|---|---|
| The relay: a Cloudflare Worker and one Durable Object per room | `relay/pocket/` (`src/room.js` is all of its judgement; `src/worker.js` adapts it to Cloudflare) |
| The claw's transport: dials out, runs the handshake, dispatches into Pocket | `src/pocket-relay.ts`, `src/pocket-bridge.ts` |
| The end-to-end channel | `src/pocket-e2e.ts` (claw), `public/pocket/e2e.js` (phone) |
| The phone's transport | `public/pocket/relay.js` |
| The phone app as the website serves it | `site/pocket/` (made by `npm run site:pocket` from `public/pocket/`) |

**The relay is a transport, not a second Pocket.** A request that arrives on
an authenticated channel goes into the very same Express router the tailnet
name is served by (`pocket.phone`), with no listener in between. Pairing, the
three lock levels, the fresh fingerprint per card, revoke, receipts, shares,
jobs and push are Pocket's own code on both paths, and the tests for them
are run again through the relay.

## Who holds what

| | Kept where | Who ever sees it |
|---|---|---|
| Claw room secret, 32 random bytes | `data/pocket/relay.json`, mode 600 | the claw; the relay, in each hello (to check against the room id) |
| Room id = base64url(SHA-256(`"cc-relay room v1\0"` ‖ secret)) | derived | the relay, the phone (in the QR) |
| Claw static key, P-256 | `data/pocket/relay.json`, mode 600 | private half: the claw only. Public half: phones |
| Pairing code, 18 random bytes (144 bits), one use, five minutes | the claw's memory, as a hash and a psk | the HUD's QR (in the link's `#fragment`), the phone. **Never the relay.** |
| Phone static key, P-256 | the phone's IndexedDB; the private half is generated non-extractable | public half: the claw (`devices.json`, `relayKey`) |
| Phone relay token, 32 random bytes | the phone's IndexedDB | the relay, in each hello. The claw keeps only its hash |
| Passkey (WebAuthn, relying party `cunningclaw.com`) | the phone's authenticator | the claw keeps the public key, as for a tailnet phone |

A relay phone has **no device token and no cookie**. It is known by the
static key its channel proved; `findDevice` refuses relay devices on the
tailnet name, and a tailnet device is never matched through the relay.

## The QR

```
https://cunningclaw.com/pocket/#pair=<code>&room=<room id>&ck=<claw key fingerprint>&relay=wss://pocket-relay.cunningclaw.com
```

Everything is in the fragment, which a browser never sends to a server, and
the app takes it off the address bar and out of history on arrival. `ck` is
base64url(SHA-256(claw static public key, 65-byte uncompressed point)): the
QR carries a commitment to the claw's key, not the 65-byte key itself, so the
code stays small enough to scan across a desk (69 modules or fewer, tested).
The claw sends the full key in its handshake reply, and the phone accepts it
only if it hashes to `ck`. A fingerprint pins the key exactly as well as the
key would (finding a second key with the same SHA-256 is out of reach).

## The relay's own protocol

One WebSocket per party to `wss://<relay>/v1/room/<room id>`. Text frames of
JSON, at most 256 KiB each.

| From | Frame | Meaning |
|---|---|---|
| claw | `{"t":"hello","role":"claw","secret":"<b64u 32 bytes>"}` | The relay checks `SHA-256("cc-relay room v1\0" ‖ secret)` equals the room id. A newer claw connection replaces an older one. |
| phone | `{"t":"hello","role":"phone","token":"<b64u 32>"}` | Admitted if the claw has listed `relayHash(token)`. |
| phone | `{"t":"hello","role":"phone","ticket":"<b64u 32>"}` | Admitted if the claw announced `relayHash(ticket)` and it has not expired. **Spent on first use.** |
| relay | `{"t":"ready"}` | Admitted. |
| claw | `{"t":"allow","tokens":[hash…]}` | The phones that may enter (at most 32). A phone whose hash disappears is disconnected at once (revoke). |
| claw | `{"t":"ticket","hash":…,"ttl":s}` / `{"t":"unticket"}` | Announce or cancel a pairing ticket (at most 2 live, at most 15 minutes). |
| relay → claw | `{"t":"open","c":conn,"via":"token"\|"ticket"}` / `{"t":"gone","c":conn}` | A phone arrived or left. `conn` is a random id the relay made. |
| phone → relay → claw | `{"t":"m","d":…}` → `{"t":"from","c":conn,"d":…}` | One opaque end-to-end message. |
| claw → relay → phone | `{"t":"to","c":conn,"d":…}` → `{"t":"m","d":…}` | One opaque end-to-end message. |
| claw | `{"t":"kick","c":conn,"why":word}` | Close that phone (the claw refused its handshake, or unpaired it). |
| either | `ping` → `pong` | Keepalive, answered by Cloudflare without waking the room. |

`relayHash(v)` = base64url(SHA-256(`"cc-relay hash v1\0"` ‖ v)). The relay
stores hashes, never tokens or tickets.

Close codes (the phone turns each into a sentence): 4400 malformed, 4401 not
paired / wrong secret, 4403 refused by the claw, 4404 claw offline, 4408 no
hello in 10 s, 4409 claw replaced by a newer connection, 4410 the claw
reconnected, 4429 too much.

**Limits** (`LIMITS` in `room.js`): frames 256 KiB; 8 phones and 8
not-yet-hello sockets per room; a hello within 10 s; per phone 1,200 frames
and 64 MiB a minute; 20 failed hellos in 10 minutes stop the room answering
*strangers'* guesses (a token the claw lists and the claw itself are never
locked out); 60 new connections a minute per address (Cloudflare's rate-limit
binding, per location, approximate).

## The end-to-end channel

Notation: `‖` is concatenation, strings are UTF-8, `b64u` is unpadded
base64url, `DH(a, B)` is the 32-byte P-256 ECDH x-coordinate, keys on the wire
are 65-byte uncompressed points. Every received point is checked to be on the
curve before it is used (`createPublicKey` / `importKey` refuse one that is
not), and the phone's ephemeral and static keys must differ.

**Derivations from the pairing code** (the relay sees only the ticket's hash):

```
psk    = SHA-256("cc-relay psk v1\0"    ‖ code)          32 bytes, secret
ticket = b64u(SHA-256("cc-relay ticket v1\0" ‖ code))    what the phone shows the relay
```

**Handshake.** Three messages, the phone first, inside `d`. The shape is
Noise KK's three Diffie-Hellmans with a pre-shared key while pairing:

```
hs1  phone → claw  {"t":"hs1","v":1,"mode":"pair"|"session","room":R,"e":b64u(eP),"s":b64u(SP)}
hs2  claw → phone  {"t":"hs2","e":b64u(eC),"ck":b64u(SC),"mac":b64u(macC)}
hs3  phone → claw  {"t":"hs3","mac":b64u(macP)}
```

with `eP`, `eC` fresh ephemeral keys and `SP`, `SC` the static keys, and

```
th   = SHA-256("cc-pocket e2e v1" ‖ 0x00 ‖ mode ‖ 0x00 ‖ R ‖ 0x00 ‖ SC ‖ SP ‖ eP ‖ eC)
ikm  = DH(eC, eP) ‖ DH(sC, eP) ‖ DH(eC, SP)          (ee ‖ es ‖ se; the phone computes the mirror)
okm  = HKDF-SHA-256(ikm, salt = psk if mode = "pair" else 32 zero bytes,
                    info = "cc-pocket e2e v1 keys" ‖ th, L = 128)
k_p2c = okm[0..32]   k_c2p = okm[32..64]   m_c = okm[64..96]   m_p = okm[96..128]
macC = HMAC-SHA-256(m_c, "claw"  ‖ th)
macP = HMAC-SHA-256(m_p, "phone" ‖ th)
```

What each side checks, in order:

- **Phone, on hs2.** `SC` is the key it already trusts: for pairing,
  `b64u(SHA-256(SC)) = ck` from the QR; for a session, byte-equal to the key
  pinned at pairing. Then `macC`. Only `sC`'s holder can compute `es`; only
  someone who knows the code can compute the pairing `psk`. A relay that
  substitutes `SC`, changes `eC`, or moves the handshake to another room fails
  here, and nothing is sent.
- **Claw, on hs1.** The room is its own. For a session: the channel came in
  by a phone token, and `SP` is the key of a phone paired through the relay
  *now* (the device record must still exist: revoke is immediate). For
  pairing: the channel came in by a ticket, a relay pairing is live and
  unclaimed.
- **Claw, on hs3.** `macP`, compared in constant time. Only `SP`'s holder can
  compute `se`; while pairing, only someone who knows the code has the `psk`.
  A wrong MAC while pairing counts against the code; three, and the code is
  cancelled (the HUD says so). The first phone to prove the code claims it,
  and the ticket is withdrawn from the relay.

The handshake must finish within 20 s of the phone arriving.

Pairing is therefore an authenticated key agreement bound to the one-time
secret and to both static keys: the transcript hash covers both keys, the
mode and the room, and the keys come from a KDF salted with the code's psk.
Each session after pairing is fresh ephemeral ECDH (forward secrecy: a static
key stolen later does not open past sessions) authenticated by both pinned
static keys. Every key that matters goes into `th`, so an unknown-key-share
or a key swapped on the way changes every derived key and both MACs.

**Records.** AES-256-GCM. `k_p2c` encrypts phone → claw, `k_c2p` claw →
phone. Each direction keeps its own counter `n`, starting at 0 and never
sent:

```
nonce     = 0x00000000 ‖ uint64_be(n)          (12 bytes)
aad       = "cc-pocket rec v1"
plaintext = flag ‖ fragment                    flag 0x01 on a message's last fragment, else 0x00
record    = b64u(ciphertext ‖ tag)             carried as one d
```

The receiver opens record `n` with nonce `n` and nothing else, so a replayed,
reordered, dropped, truncated-and-resumed or reflected record (our own record
sent back to us) fails to authenticate. **The first failure kills the
session**: no resynchronising with a relay that has shown it will tamper; the
phone reconnects and handshakes afresh. Fragments are at most 128 KiB of
plaintext; a message is at most 40 MiB once reassembled; 2³² records per
direction, then a new session.

**Application messages** are JSON inside the channel: the phone sends
`{"t":"req","id":n,"method":"GET"|"POST"|"DELETE","path":"/pocket/api/…","type"?,"body"?,"enc"?:"b64"}`
and `{"t":"cancel","id":n}`; the claw answers `{"t":"res","id","status","type","body"}`,
or for a stream (the event feed) `head`, `data`…, `end`. Only `/pocket/api/`
paths are dispatched, at most 16 at once per channel. The bridge sets the
request's Host and Origin to the app's (`cunningclaw.com`) and puts the
channel's proven identity where the host gate's verdict would go; nothing a
request carries can set either.

## WebAuthn through the relay

The app is served from `https://cunningclaw.com/pocket/`, so its passkeys
belong to relying party `cunningclaw.com` and its assertions carry origin
`https://cunningclaw.com` (`pocket.relay.appOrigin`). The claw checks them
against that origin **only for a request that arrived on a relay channel**,
and only for a device paired through the relay; a tailnet phone's
assertions are still checked against its tailnet origin. A pairing code is
minted for one path, and a relay code cannot be spent on the tailnet name or
the reverse. Every other WebAuthn rule is unchanged: user verification
required, a fresh assertion per card bound to that card and that answer,
single use, two minutes.

## What the relay can and cannot see

**It never sees**: the pairing code or its psk; any private key; a word of
the conversation, a card, a receipt, a file, an event or a push
subscription; which requests are made. All of that is inside records it
cannot open.

**It holds, in memory only, while a socket is open** (the WebSocket's
attachment; nothing is ever written to Durable Object storage, and the
Worker contains no logging): each socket's role, a random connection id, the
hash it was admitted by, when it connected (until it says hello), and its
frame and byte counts for the current minute. On the claw's socket, the
hashes of the phone tokens it listed and of the live pairing tickets with
their expiry. A soft count of recent failed hellos per room, forgotten when
the room is idle.

**It can observe**, because it carries the bytes: the room id (a stable
pseudonym for one claw), when the claw and each phone connect and disconnect,
how many phones are connected, and the size and timing of every message.
Cloudflare, which runs the relay, sees what it sees for any site behind it:
each connection's IP address and the time, used here for the per-address
connection limit (kept 60 s, per location). Workers Logs are switched off in
`wrangler.toml`; the Cloudflare dashboard still shows aggregate request
counts and errors.

**It can do**: refuse or drop connections (deny service), delay messages,
and see the metadata above. **It cannot**: read, alter, inject, replay or
reorder a message without the far end noticing and closing the channel;
pair a phone of its own (it lacks the code); pretend to be the claw (it lacks
the claw's static key) or to a paired phone (it lacks that phone's key);
move a phone into another claw's room and pair it there; keep a revoked
phone in (the claw checks every session handshake against its own list).

## Threats, one by one

**The relay operator (Dragon Forge, or anyone who takes over its Cloudflare
account).** Sees the metadata above and can deny service. Cannot read or
forge content, for the reasons above. *Tests:* every `e2e:` test in
`src/pocket-e2e.test.ts`; *relay: a tampering relay is caught end to end,
and nothing it altered or replayed is acted on*; *relay: a relay that sends a
phone to another claw's room cannot pair it there*; *relay: a revoked phone's
key is refused by the claw even if a dishonest relay lets it in*.

**A network attacker** (café Wi-Fi, an ISP). Sees TLS to
`pocket-relay.cunningclaw.com` and its timing; inside TLS, only what the
relay could see. Even with a mis-issued certificate for the relay, they are
then in the relay's position and no better.

**A stranger who learns a room id** (glimpsed a QR). Cannot become the claw
(the room id is a hash of a secret they do not have), cannot join as a phone
without a listed token or a live ticket, cannot pair without the code, and
cannot lock the owner out by failing hellos. *Tests:* *relay: a room belongs
to the secret it is a hash of; a stranger who knows the room id cannot squat
or take it*; *relay: a phone gets in only with a token the claw listed, and
leaves the moment the claw unlists it*; *relay: a pairing ticket is
single-use and expires*; *relay: a room that keeps failing hellos stops
listening to strangers for a while, never to its claw or its phones*.

**Someone who photographs the QR.** That is someone holding the code: they
could pair before you do, which is why the code is single-use, lives five
minutes, dies when the panel closes, and every pairing puts a notice on the
HUD naming the phone ("Revoke it … if that was not you"). The same is true
on the tailnet path. *Tests:* *relay pairing: an expired or used code fails,
and a code cannot cross from one path to the other*; *e2e: an expired, reused
or wrong pairing code fails the handshake*.

**A compromised website.** This is the real cost of the easy way. The phone
app is JavaScript that `cunningclaw.com` serves; whoever controls what that
site serves to your phone controls the app on it. A malicious app could read
everything you read in it, use the phone's non-extractable key (it cannot
copy it out, but it can use it while open), and show you one card while
asking your fingerprint to approve another, since the assertion binds the
card the *page* asks for, not the one you think you are looking at. It could
not do anything a paired phone cannot: the claw's floor, its denylist and
the HUD's view of every approval are untouched, and it reaches only phones
that open the app while it is compromised. Mitigations, none of them
complete:

- **A strict Content Security Policy** for `/pocket/` (`site/_headers`): the
  app's own scripts only, no inline script, no third-party anything, and it
  may connect to itself and the relay and nowhere else. This stops an
  injected script or a hijacked dependency, not a site that serves different
  files. *Test:* *site: /pocket/ has a strict policy of its own that still
  lets it reach the relay, and only the relay*; *site: the app's pages carry
  no inline script and load scripts from their own origin only*.
- **Versioned, checkable files.** `site/pocket/` is generated from
  `public/pocket/` and a test fails if they drift. It carries
  `release.json`: the claw version it was made from and the SHA-256 of every
  file. `npm run doctor` fetches the live scripts and compares them byte for
  byte with the claw's own copy (`pocket-app` line). It catches a site that
  serves everyone something else; it cannot catch one that serves only your
  phone something else. *Tests:* *site: site/pocket/ is public/pocket/ byte
  for byte, but for the one line that says it is the site and a release
  manifest of hashes*; *doctor: says whether the website serves this claw's
  own phone app, file by file*.
- **Open source.** The app, the relay and this protocol are in this
  repository. Anyone can read what should be served.
- **The private network.** Pair with Tailscale instead and the app is served
  by your own claw, from your own machine, and nothing passes through
  Dragon Forge at all. The HUD offers both, side by side, every time.

**A stolen phone.** Exactly as on the tailnet (docs/POCKET-CLAW.md, "Three
levels"): without the fingerprint it sees which cards wait, no more. Revoke
it on the HUD; the claw drops its token from the relay's list, the relay
disconnects it at once, and its key is refused if it comes back. *Test:*
*relay: a revoked phone is refused — its channel is closed, the relay drops
it, and it cannot come back*.

## The claw dials out only when it has a reason

A claw with the relay switched on but no phone paired that way never
contacts the relay. It dials when the operator shows a relay QR, stays
connected while a relay phone is paired, and hangs up when the last one is
revoked. `pocket.relay.enabled: false`, or no `url`, switches it off entirely
and the HUD offers only the private network. *Tests:* *relay: the claw does
not dial out until a phone is paired the easy way, and hangs up when none
is*; *relay: switched off, or with no URL, there is no relay pairing and no
dialling out*.

```json
"pocket": { "relay": { "enabled": true, "url": "wss://pocket-relay.cunningclaw.com", "appOrigin": "https://cunningclaw.com" } }
```

Push still goes from the claw to the phone's push service directly (RFC
8291/8292), never through the relay, and still says only how many cards are
waiting. *Test:* *relay: push for a relay phone is sent by the claw itself,
and says how many, never what*.

## Deploying the relay (Dragon Forge, once)

`relay/pocket/README.md` has the steps, each checked against Cloudflare's
documentation on 20 November 2026.

## What has and has not been verified

Verified: every test named above, each confirmed to fail with its protection
removed; the phone's real `e2e.js` and `relay.js` run against the claw's
real code; the relay's real `room.js` runs in the tests, and the real
Worker ran under `wrangler dev` (workerd) for a Playwright drive: an
emulated Pixel 7 with a virtual passkey paired from the HUD's QR, talked,
approved a real card with a fresh assertion, reconnected after a reload,
said plainly when the relay was down and came back by itself when it
returned, and was revoked, with the site's CSP applied and no violations.

Not verified: the relay deployed on Cloudflare (it is not deployed); a real
phone; iPhone; behaviour under Cloudflare's real hibernation, eviction and
per-location rate limits; `/pocket/*` header matching on Cloudflare Pages
itself (the drive applied the same rules with a local server).
