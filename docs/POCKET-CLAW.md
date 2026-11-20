# Pocket Claw

The claw's own phone app. Talk to it, answer its approval cards with your
fingerprint, photograph a receipt, or share a photo or PDF to it from any app.
It is a web app you add to your home screen, made for Android and Chrome
first. Telegram and Discord still work as before; Pocket is the private,
richer way in.

Your claw keeps listening on `127.0.0.1` and nowhere else. Nothing here opens
a port to the internet or to your Wi-Fi. Your phone reaches the claw through
[Tailscale](https://tailscale.com), a private network that only your own
devices can join.

## Setting it up on Android

You need about ten minutes and a free Tailscale account.

1. **Install Tailscale on the PC that runs the claw.** Download it from
   <https://tailscale.com/download> and sign in. (`npm run doctor` has a
   Pocket Claw line that says whether it is there.)
2. **Install Tailscale on your phone.** Get it from the Play Store and sign
   in with the same account. Both devices now share one private tailnet.
3. **Turn on HTTPS for your tailnet, once.** In the Tailscale admin console,
   open DNS and enable MagicDNS and HTTPS Certificates. `tailscale serve`
   needs both, and your phone's fingerprint prompt only works over HTTPS.
4. **On the PC, share the claw with your tailnet:**

   ```bash
   tailscale serve --bg 3900
   ```

   Use your own port if you changed `server.port`. `--bg` keeps it running
   after you close the terminal and after a restart. To see the address, run
   `tailscale serve status`; it prints something like
   `https://your-pc.your-tailnet.ts.net`. To stop sharing, run
   `tailscale serve --https=443 off`, or `tailscale serve reset` to clear it.
5. **Tell the claw its name.** On the HUD, press **POCKET**, paste the name
   without `https://` (for example `your-pc.your-tailnet.ts.net`), and press
   **SAVE NAME**. You can put it in `claw.config.json` instead:
   `"pocket": { "hosts": ["your-pc.your-tailnet.ts.net"] }`.
6. **Pair.** Press **PAIR A PHONE**. Scan the code with your phone's camera
   and open the link in Chrome. Give the phone a name and press **Pair with
   fingerprint**. The code works once and expires after five minutes.
7. **Add to Home screen.** In Chrome's menu, choose **Add to Home screen**
   (or **Install app**). Pocket Claw now opens like any other app. Long-press
   its icon for **Talk**, **Snap receipt** and **Approvals**.
8. **Notifications (optional).** In Pocket, open **Phone** and press **Tell
   me when approvals wait**.

**Receipts.** Long-press the icon and choose **Snap receipt**, then
photograph the slip. Or open a photo in your gallery, WhatsApp or Files,
press Share and choose **Pocket Claw**. The share screen asks which you mean:

- **File as receipt**: read and added to your receipts ledger, the same one a
  Telegram photo captioned "receipt" goes to. The phone shows the line it
  filed (`R-0007 · 2026-11-19 · Caffi Bach · £12.40 (VAT £2.07) · meals ·
  contactless`). If it misread anything, type the fix while the slip is in
  your hand, e.g. `total £14.60, payment card`. **Not a receipt — void it**
  keeps the line but marks it void. JPEG and PNG photos only. A PDF or HEIC
  can still go to the chat.
- **Attach to chat**: the claw reads it as outside content and answers you.
- **Just keep it on the Desk**: saved, nothing else.

**Jobs.** The **Jobs** tab shows mission control's list when the phone is
unlocked: what each job is, its state, and the claw's own status line. A job
that can be stopped has **Cancel**, which asks for your fingerprint for that
job.

The microphone sends your recording to the claw's own ears (whisper.cpp, set
up with `./setup-ears.sh`). If that is not installed, Pocket says so; it never
falls back to an online recogniser.

## How it is kept safe

**Who can reach it.** Only devices signed in to your tailnet can open the
address at all. On that address the claw serves Pocket and nothing else: the
HUD, the Keys page and every `/api` route answer 404 there, and the HUD's
master session is never handed to anything that arrives through the tailnet.
A request that names any other host is refused with 421 before a route runs.
That includes a page trying DNS rebinding against `127.0.0.1`, and a tailnet
device sending `Host: 127.0.0.1`: `tailscale serve` passes the Host header
through unchanged but always adds `X-Forwarded-For`, and any forwarding
header costs a request its local standing. (`src/pocket-host.ts`; tests in
`src/pocket-host.test.ts`: *a DNS-rebinding page's name is refused, so GET /
cannot hand it the session*, *an unlisted name is refused even when it arrives
through tailscale serve*, *a tailnet device that sends Host: 127.0.0.1 through
the proxy is not local*, *the gate: the tailnet name sees /pocket/ and nothing
of the HUD*.)

**Pairing.** The QR holds a one-time code in the link's `#fragment`, so it
never reaches a proxy log. It expires in five minutes and dies the moment it
is used. Pressing PAIR again or closing the panel cancels it. Pairing enrols a
passkey from your phone's own fingerprint, face or screen lock, with *user
verification required*. Only then does the phone get a device token: 256
random bits, kept on the claw as a SHA-256 hash in
`data/pocket/devices.json` (mode 600), and held by the phone in an HttpOnly
cookie that the page itself cannot read. (*pairing: a code is single-use*,
*pairing: a code expires in minutes*, *pairing: an enrolment from the wrong
origin or without UV is refused and issues no token*, *the device token is
stored hashed, never as itself*.)

**Three levels on the phone.**

| With… | the phone can |
|---|---|
| the device token alone | see the approval cards waiting, and how many |
| a fingerprint in the last 10 idle minutes | read the conversation, send, share files, file and correct receipts, use the mic, see jobs |
| a fresh fingerprint for *that* card | approve or deny that one card |
| a fresh fingerprint for *that* job | cancel that one job |

The fingerprint for a card signs a challenge that names that card and that
answer. It can be used once, within two minutes. A "deny" cannot be replayed
as an "approve", and an answer to card A cannot settle card B. The answer
goes through the same `settleApproval` as the HUD, Telegram and Discord, so
all of them see it. (`src/webauthn.ts` checks the challenge, the origin, the
relying-party hash, the user-present and user-verified flags and the signature
counter, using node:crypto only. Tests: *approving needs a fresh assertion
bound to that approval, and settles through settleApproval*, *a replayed
approval assertion is refused*, *an assertion minted to deny cannot approve,
and one for card A cannot answer card B*, *an approval assertion from the
wrong origin, or without UV, is refused*, *locked: the token opens the cards,
not the conversation*, *a challenge expires after two minutes*.)

**What a stolen, unlocked phone can and cannot do.** Whoever holds it can see
which approval cards are waiting, word for word, as Telegram would show them.
Without your fingerprint, face or screen lock they cannot answer a card. Once
your last unlock has lapsed (10 idle minutes; **Lock now** ends it at once)
they cannot read the conversation, send the claw anything, share a file to it
or use the mic. If they know your phone's screen lock, the phone is theirs and
so is Pocket. Revoke it.

**Revoke.** On the HUD, press **POCKET**, then **REVOKE** next to the phone.
Its record is deleted, its token gets 401 everywhere and its open streams are
closed. (*an unknown or revoked token gets 401 everywhere*.) Failed attempts
are rate-limited for each tailnet address. (*failed attempts are rate-limited
per client*.)

**What leaves the claw for the phone.** The same redacted events the HUD
gets, with less in them. A tool's name is sent, but never its input or its
result, because results are other people's words (web pages, emails). History
is redacted on the way out. (*events: a locked phone hears the cards only; an
unlocked one follows the turn, tool names without results*, *history leaving
for the phone is redacted: the home folder is ~*.)

**Notifications** carry a count and nothing else: "2 approvals waiting".
They show on a locked screen and pass through Google's push service, so a
card's text is never in one. Messages are encrypted to your phone (RFC 8291)
and signed by your claw (RFC 8292 VAPID), on node:crypto, with no push library.
The claw only sends to real push services, so a paired phone cannot point it
at your router. ntfy stays as the fallback. (*a push says how many, never
what: the card's text does not leave in the notification*, *encryption
reproduces the RFC 8291 §5 message byte for byte*, *only real push services
are accepted as endpoints*.)

**Shared files are strangers' words.** A photo or PDF from WhatsApp or Files
is checked by its bytes (JPEG, PNG, WebP, HEIC or PDF; anything else is
refused). It is saved on the Desk under a name the claw chooses, so the
sender's filename never ends up in your message. It is attached with the same
`[file attached: …]` marker the HUD's paperclip uses, which means the turn is
pinned to a trusted brain and `read_document` fences what the file says.
(*a shared photo is saved under the claw's own name and attached with the
paperclip's marker*, *a share that is not a photo or a PDF by its bytes is
refused*.)

**Receipts never become a turn.** **File as receipt** goes to the receipts
ledger (`src/receipts.ts`) with no conversation in between, as Telegram's
does. Nothing printed on the slip is ever put to the model as part of a chat.
The phone shows the filed line as text. The HUD only hears that receipt
`R-0007` was filed, never what the slip says. A phone can correct only the
receipts it filed itself. Corrections are parsed from what you type, with no
model involved. (*a receipt is filed in the ledger the Telegram flow uses,
with no turn, and the phone sees the filed line*, *the filed line can be
corrected from the phone, but only for receipts this phone filed*, *receipts
need the unlock, and a receipt cannot be smuggled into the chat as a turn*,
*the HUD hears that a receipt was filed, never what the slip says*.)

**Jobs** are the claw's own status lines, never a job's output, and the
result pointer stays at home. Cancel signs a challenge that names that job's
full id, single-use and two minutes long. An approval's fingerprint cannot
cancel a job, and a fingerprint for job A cannot stop job B. (*jobs: listed
only when unlocked, as our own status lines*, *cancelling a job needs a fresh
assertion bound to that job*, *a cancel challenge is not handed out while
locked, or for a job that cannot be stopped*, *job events reach an unlocked
phone only, cut to the phone's view*.)

**On the phone,** the service worker caches the app's shell (page, style,
script, icons) and nothing else. Conversation, cards and history are never
written to a cache. A shared file sits in a cache of its own only for the
moment between Android handing it over and the page taking it; the page
deletes it as it reads it.

## The alternative: Cloudflare Tunnel with Cloudflare Access

Use this if you cannot install Tailscale on the phone. Your Pocket address is
then on the public internet, behind Cloudflare Access's sign-in. That is more
exposure than a tailnet, so turn Access on *before* you start the tunnel.

1. Put a domain you own on Cloudflare, then install `cloudflared` on the PC.
2. Create a named tunnel (`cloudflared tunnel login`, then
   `cloudflared tunnel create claw`). Route a hostname to it
   (`cloudflared tunnel route dns claw pocket.example.com`). Add an ingress
   rule sending that hostname to `http://127.0.0.1:3900`.
3. In Cloudflare Zero Trust, add a self-hosted Access application for
   `pocket.example.com`, with a policy that allows only your own email.
4. Do **not** set `httpHostHeader` on the tunnel. cloudflared then passes the
   public hostname through as the Host header. If you set it, the original
   name moves to `X-Forwarded-Host`, and the claw refuses requests whose two
   names disagree.
5. Put `pocket.example.com` in `pocket.hosts` or save it on the HUD's POCKET
   panel, then pair exactly as above.

Access is the outer gate; the device token and your fingerprint still guard
everything behind it. The claw does not yet check Access's own signed header
(`Cf-Access-Jwt-Assertion`). That is listed below as deferred.

## Not built yet

- **An Android home-screen widget** that shows only the counts (approvals
  waiting, a job running), via a small Capacitor wrapper around Pocket. A tap
  opens the card and the fingerprint prompt. A web app cannot draw a widget,
  so this needs the wrapper.
- **iPhone.** Pocket loads in Safari, and passkeys and web push work for
  apps added to the Home Screen on iOS 16.4 or later. It has only been driven
  in Chromium emulating a Pixel, with a virtual passkey. An iPhone Shortcut
  ("Ask my claw") is the planned
  quick way in. iOS has no Web Share Target, so sharing to Pocket from other
  iPhone apps is not possible.
- **Checking Cloudflare Access's JWT** on the Cloudflare route.
- **Receipts from PDFs or HEIC photos.** The ledger takes JPEG and PNG. On
  most Android phones the camera saves JPEG.
