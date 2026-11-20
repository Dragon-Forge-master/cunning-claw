# Connect Outlook — Microsoft Graph, part 2 (a plan, not code)

Part 1 is built: the five email tools drive **Outlook on the web** in the claw's own
Chrome, exactly as they drive Gmail (`src/outlook.ts`, `src/mail-provider.ts`). No
keys, no app registration — and no calendar, no OneDrive, and nothing that works
when Outlook's page changes under us. Part 2 is the official road: a **"Connect
Outlook"** card that signs in through Microsoft and calls Microsoft Graph.

This is a plan. Every Microsoft fact below was read from the cited page on
20 November 2026; anything not read there is marked **unverified**.

## 1. The shape

- **One app registration, owned by Dragon Forge AI**, used by every install. It is a
  *public client*: no client secret exists, so there is none to ship, leak or
  rotate. Public clients "can't be trusted to safely keep application secrets …
  they can't have client secrets."
  ([public and confidential clients](https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-applications))
- **Sign-in by the OAuth 2.0 device authorization grant** (RFC 8628): the claw asks
  `https://login.microsoftonline.com/common/oauth2/v2.0/devicecode` for a code, shows
  the operator the `user_code` and `verification_uri` on the HUD (and Pocket), and
  polls `…/oauth2/v2.0/token` with
  `grant_type=urn:ietf:params:oauth:grant-type:device_code` every `interval` seconds
  until it gets tokens or one of `authorization_declined`, `expired_token` or
  `bad_verification_code`. `authorization_pending` means keep waiting. The code lasts
  15 minutes by default. Microsoft does not return `verification_uri_complete`, so
  the operator always types the code.
  ([device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code))
- `common` takes both work/school and personal accounts. A personal account is asked
  to sign in a second time to move the session onto the device — the same page says
  so; work and school accounts are not.
- Scopes, all **delegated** (the claw acts as the signed-in person, never as the
  organisation): `Mail.Read`, `Mail.Send`, `offline_access`, and `User.Read` to name
  the account on the card. Optional, asked for only when the operator turns them on:
  `Calendars.ReadWrite`, `Files.Read`. Graph's permission reference lists **"Admin
  consent required: No"** for the delegated form of every one of these, and says each
  is "available for consent in personal Microsoft accounts"; `offline_access` is the
  OIDC scope that returns a refresh token.
  ([Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference))
  `Mail.ReadWrite` (also no admin consent) is needed only if drafts are written
  through Graph rather than in the window; start without it.

### A warning to settle before building: device code is the flow Microsoft tells admins to block

Microsoft's Conditional Access guidance says: *"We recommend organizations get as
close as possible to a unilateral block on device code flow"*, and gives the policy to
do it.
([block authentication flows](https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-block-authentication-flows))
Device-code phishing — an attacker sends a victim a real Microsoft code — is why.
Two consequences:

1. In a well-run Microsoft 365 tenant, device-code sign-in may simply be refused. The
   card must say so in plain words ("your organisation blocks this kind of sign-in —
   ask IT, or use Outlook in the claw's browser instead"), not fail silently.
2. The claw already has the better flow for a machine with a browser: authorisation
   code + PKCE to a loopback redirect, which `src/mcp-oauth.ts` does today for MCP
   servers. **Recommendation:** register a *Mobile and desktop applications* platform
   with redirect `http://localhost` and use auth code + PKCE as the default; keep device
   code only for the case it is for — signing in from a phone or a second machine where
   the claw's browser is not in front of the operator. Same registration, same scopes.
   ([desktop app registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration))

The steps below cover both.

## 2. The app registration the founder creates (once)

Done in the Microsoft Entra admin center by someone who is at least an *Application
Developer* in the Dragon Forge tenant. Register it with a **work or school account**:
an app registered with a personal Microsoft account cannot be publisher verified (§4).
([register an app](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app))

1. Sign in to <https://entra.microsoft.com>. If you see several tenants, use the
   **Settings** icon to switch to Dragon Forge's.
2. **Entra ID** → **App registrations** → **New registration**.
3. **Name**: *Cunning Claw* — users see it on the consent screen.
4. **Supported account types**: **Any Entra ID Tenant + Personal Microsoft accounts**
   ("multitenant apps that support both organizational and personal Microsoft accounts
   (for example, Skype, Xbox, Live, Hotmail)"). This is what lets both a Microsoft 365
   business mailbox and a Hotmail address connect.
5. **Register**. From **Overview**, record the **Application (client) ID**. It is not a
   secret; it ships in the code, like a public key.
6. **Authentication** → **Add a platform** → **Mobile and desktop applications** → add
   `http://localhost` (the system-browser loopback redirect, for auth code + PKCE).
7. **Authentication** → **Advanced settings** → **Allow public client flows** → **Yes**
   → **Save**. Device code needs this and no redirect URI.
   ([desktop app registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration))
8. **Certificates & secrets**: create nothing. A secret in a public client is a
   secret published to everyone who downloads the claw.
9. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated
   permissions**: `Mail.Read`, `Mail.Send`, `offline_access`, `User.Read`; later
   `Calendars.ReadWrite`, `Files.Read`. Do **not** press *Grant admin consent* in
   Dragon Forge's own tenant on customers' behalf — consent belongs to each customer
   (§3).
10. **Branding & properties**: set a **Publisher domain** on the company's verified
    domain (needed for §4; it cannot be `*.onmicrosoft.com`), and the home page,
    terms and privacy statement URLs the consent screen links to.
    ([publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview))

## 3. Consent in a customer's work tenant

- By default a user may consent to permissions that do not require an administrator —
  "a user can consent to allow an app to access their mailbox". Every scope in §1 is
  in that class.
  ([configure user consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent))
- But a tenant can narrow that. Microsoft's own recommendation to admins is to allow
  user consent "only for applications that have been published by a verified
  publisher", and the built-in policy for it (`microsoft-user-default-low`) also
  limits users to permissions the admin has classified *low impact* — mail is
  unlikely to be one. In such a tenant the operator sees "Need admin approval".
- Since November 2020, where *risk-based step-up consent* is on, users cannot consent
  to newly registered multitenant apps that are **not** publisher verified and ask for
  more than sign-in and profile.
  ([publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview))
- What the card tells a small business with an IT person: the admin grants it once
  for everyone, at
  `https://login.microsoftonline.com/{their-tenant-or-domain}/adminconsent?client_id={client-id}`,
  or in their own admin center under **Entra ID** → **Enterprise apps** → *Cunning
  Claw* → **Permissions** → **Grant admin consent**. A Cloud Application
  Administrator, Application Administrator or Privileged Role Administrator can do it
  for delegated Graph permissions.
  ([grant admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent))
  Tenant-wide consent lets every user in that tenant connect the claw; the admin
  can restrict it to named people with *assignment required*.
- **Unverified:** whether Microsoft has since changed the *default* user-consent
  setting for new tenants (a "Microsoft-managed" policy was discussed in 2025). The
  page read for this plan describes the default as above; check again before launch.

## 4. Publisher verification, and what it costs

- What it gives: the blue *verified* badge on the consent prompt, and eligibility in
  tenants whose admins allow consent only for verified publishers.
- What it needs: a verified **Microsoft AI Cloud Partner Program** account (formerly
  MPN) — its partner global account's Partner One ID; the app's tenant associated with
  that account; a publisher domain matching the email domain used in partner
  verification; the person doing it an *Application Administrator* or *Cloud
  Application Administrator* in Entra and *Partner Admin* or *Account Admin* in
  Partner Center, signed in with MFA; and acceptance of the identity platform's terms.
- **Cost: none.** "Microsoft doesn't charge developers for publisher verification. No
  license is required", and "no charges are associated with completing the
  prerequisites".
  ([publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview))
- Not the same as **Microsoft 365 App Certification** (a separate, heavier programme
  of security attestations). It is not needed for Mail.Read/Mail.Send; it may help sell
  to cautious IT departments later. Contrast Google: Gmail's restricted scopes need a
  paid third-party security assessment, which is why the README's Google card waits.

## 5. Where the tokens live

Today the claw keeps OAuth tokens for MCP connectors in `data/mcp-oauth.json`, written
with mode `0600` (`src/mcp-oauth.ts`), never in the transcript. That file is on the
sensitive-path denylist every file tool obeys (`src/paths.ts`), and the shell's
sandbox mounts over it, whatever the config says (`ownSecrets` in `src/sandbox.ts`,
alongside `.env` and the claw's Chrome profile — which, since part 1, also holds the
Outlook on the web session).

Graph tokens go the same way, in their own file so a bug in one cannot spill the
other: `data/microsoft-oauth.json`, `0600`, added to `SENSITIVE_PREFIXES` and to
`ownSecrets` in the same commit, with the live bubblewrap test extended to plant
a synthetic refresh token and fail if `cat` inside the box can read it. Only the
refresh token is long-lived; access tokens (about an hour, per the `expires_in` the
token endpoint returns) are kept in memory and refreshed on demand. Disconnect deletes
the file's entry and tells the operator where to revoke the grant on Microsoft's side
(myapps / account.microsoft.com — **unverified** exact pages; confirm before writing
the copy). Tokens are opaque to the claw: Microsoft warns not to parse tokens for APIs
you do not own, and consumer tokens may be encrypted.
([device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code))

## 6. The safety rules that carry over unchanged

- Graph results are strangers' words: fenced with `fenceUntrusted`, and the Graph tools
  go in `UNTRUSTED_TOOLS` (`src/routing.ts`). Routing already pins "Outlook" / "Office
  365" turns to a trusted brain.
- `send_email` through Graph goes through the same `sendEmailStep` and the same
  `guardMailboxSend` consent check, and its card is never covered by a work order's
  blanket approval any more than today's.
- Calendar writes are committing actions and ask; reading OneDrive files goes through
  `read_document`'s fence.
- The model never supplies a tenant, a client id or a scope: those come from code and
  config, as hosts do for `src/remote.ts`.

## 7. What it unlocks

- **Mail without the page**: search with Graph's `$search`, threads by
  `conversationId`, real attachments, and sending that does not depend on Outlook's
  buttons keeping their names. The browser road stays as the no-account fallback.
- **Calendar** (`Calendars.ReadWrite`): "what's on tomorrow", booking a job into the
  diary, a reminder before the MOT customer arrives — the heartbeat can read it.
- **OneDrive** (`Files.Read`): the quote template, the price list, last year's
  accounts, read through `read_document`.
- Later, with their own scopes and their own cards: Teams messages, To Do, Contacts.

## 8. Order of work

1. Founder: the registration in §2 and the publisher verification in §4 (both free).
2. `src/microsoft-oauth.ts`: auth code + PKCE loopback (reusing `mcp-oauth.ts`'s
   pieces) and device code, with an injected `fetch` and clock so every branch —
   pending, declined, expired, blocked by Conditional Access, admin approval needed —
   is tested without an account.
3. Token file, denylist and sandbox hiding, with the live bubblewrap test.
4. Graph-backed providers behind the same five email tools (`email.provider:
   "outlook-graph"`), then calendar and files as their own tools.
5. Only then: tested against a real Microsoft 365 tenant and a real Outlook.com
   account, and the README says which.
