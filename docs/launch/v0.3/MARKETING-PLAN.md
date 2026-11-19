# Cunning Claw 0.3 — marketing plan

A plan for the four weeks after **R-day**: the day the v0.3.0 downloads
(Windows, Mac and Linux, Node inside, unzip and double-click) go live on the
GitHub releases page. Until that release exists, nothing here links to a
download, and the pieces that describe the downloads wait (see
[README.md](README.md) for which ones).

The copy lives in [COPY.md](COPY.md), [POSTS.md](POSTS.md) and
[../X-THREAD.md](../X-THREAD.md). The voice is [SWYN.md](../../SWYN.md) and
the look is [BRAND.md](../../BRAND.md). The rule that governs all of it is
BRAND.md's rule 8: every claim must survive "how do we know?"

## The facts we stand on

These are the numbers and claims every piece uses. Re-check them on the morning
of R-day, because the code moves and a stale number is the cheapest way to lose
a technical audience.

| Fact | Today | How to re-check |
|---|---|---|
| Tools | 73 | `grep -c '^    name: "' src/tools.ts` |
| Connectors | 94 | `MCP_CATALOGUE.length` in `src/mcp-catalog.ts` |
| Skills | 31 | count of `workspace/skills/*/SKILL.md` |
| Usable brains | 11 (12 in config; the paid-plan one is not live) | `claw.config.json` |
| Tests passing | 622 | `npm test` |
| Runtime dependencies | 2 | `package.json` |
| Tool-list saving | 80% fewer tokens of tool lists per message, in a test with 150 connector tools | `npx tsx --test src/tool-diet.test.ts` (the test asserts "well over three quarters"; 80% is the measured figure) |
| Floor | 12 commands refused whatever the config, plan or approval | `HARD_DENY` in `src/tools.ts` |

If a number has changed, change it everywhere: the HTML sources in this
folder, then `node docs/launch/v0.3/render.cjs` to re-render the PNGs and PDFs.

## Audiences

### 1. Non-technical small businesses and trades

Sole traders, small firms, trades, shops and offices, starting in Cardiff and
South Wales, where Chris is known (many people know him from his vehicle
business, cjvs.co.uk).

- **What they have:** email, invoices, supplier PDFs, quotes, reminders, and
  tools such as Xero, Canva or Stripe. Too much admin, no IT person.
- **What worries them:** AI doing things without asking; their customers' data
  going somewhere they cannot see; another subscription; anything that needs
  "typing commands".
- **What we tell them:** an assistant that works on your own computer, asks you
  before anything that sends, spends or publishes, and starts free with a
  Google key that the setup page walks you through. Plain words, no jargon.
- **What we must be straight about:** it is new and few people use it yet; it
  works while your computer is on; on Google's free plan Google may use what
  you send, so anyone handling customers' personal details should use a paid
  key.
- **How they hear:** people they know. Chris's personal Facebook and WhatsApp,
  local business groups, a short cold email with the one-page PDF, and
  showing it working in person.

### 2. Developers and self-hosters

People who run their own services, use local models, or build with agents.

- **What they care about:** what it can touch, what stops it, what leaves the
  machine, how many dependencies, whether the claims are tested.
- **What we tell them:** the threat model is prompt injection, and the
  boundaries are in code: fencing, the scanner, the approval card, the floor,
  the bubblewrap sandbox with key stores hidden. One Node process, two runtime
  dependencies, 622 tests, MIT. Runs on a model you choose, including local
  models through Ollama.
- **What we must be straight about:** alpha; nothing independently audited;
  the scanner is a heuristic; the box confines writes, not reads, and the
  network is on by default; the Mac box has not run on a real Mac; Windows has
  no box; document converters run outside the box. These communities punish
  hype and reward stated limits, so the limits go in the post, not in the
  replies.
- **How they hear:** Show HN, r/selfhosted, r/LocalLLaMA, X, GitHub itself.

### 3. Security-minded organisations (carefully)

Security leads and engineers who are thinking about agents with real access.

- **What we offer them:** not a product to deploy, but a design worth reading
  and attacking: [SECURITY-ARCHITECTURE.md](../../SECURITY-ARCHITECTURE.md),
  summarised in `security-at-a-glance.pdf`, where every claim points at the
  file that implements it and the gaps are listed in priority order.
- **What we ask for:** review, issues, and a conversation. "Break the fences
  and tell us" is the honest invitation.
- **What we never do with them:** suggest it is ready for regulated,
  clinical or safety-critical use, or imply an audit, a certification, a
  customer or a partnership that does not exist.
- **How they hear:** LinkedIn, direct messages to people Chris already knows,
  and the PDF sent on request.

## Message pillars

Four things we say, each with the proof that lets it survive "how do we know?"

| Pillar | The line | The proof |
|---|---|---|
| **He asks before he acts** | Every send, spend and publish waits for your yes. | Consequential actions (send, spend, publish, run outside the box) raise an approval card; no answer in three minutes is a no; a new message from you cancels every pending card; Discord cards only ever go to a private message. Twelve commands are refused whoever asks. |
| **Your computer, your keys** | He runs on your own computer, not in someone else's cloud. | One program, opened in your browser at 127.0.0.1:3900. No account and no telemetry. Speech-to-text on your machine with whisper.cpp; the Desk keeps documents as markdown on your disk; a local model through Ollama if you want nothing to leave at all. |
| **Hard to fool, and honest about how hard** | Outside words are data, never orders — and here is exactly where that stops. | Fencing, the injection scanner (hidden Unicode stripped), the bubblewrap sandbox with ssh/GPG keys, credentials, keyrings and browser profiles hidden. The limits are published next to the guarantees in SECURITY-ARCHITECTURE.md. 622 tests, each required to fail with its fix reverted. |
| **Free to start, cheap to run** | Start free with a Google key. | The setup page walks a first-timer through a free Gemini key in four steps, no card. Free forever with your own key. In a test with 150 connector tools, 80% fewer tokens of tool lists per message. |

A supporting theme, not a pillar: **built in Cardiff, in the open**, by a
self-taught founder, with a Welsh name that means something
(*y dyn hysbys*, the knowing one). It earns warmth locally; it is never the
headline for the technical audiences.

## Channels: what to post where

| Channel | Audience | What | Copy |
|---|---|---|---|
| Chris's personal Facebook | friends, local | The personal post, then the carousel a week later | POSTS.md "Facebook"; COPY.md "Friends" |
| WhatsApp (one-to-one and groups Chris is already in) | friends, local | The short personal message. One-to-one beats a broadcast. | COPY.md "Friends" |
| Local business Facebook groups | small businesses | Only groups Chris is a member of, and only where the rules allow promotion; many have a promotion day. Lead with what it does for a business, offer to show it. | COPY.md "Local business group post" |
| Cold email | small businesses | A short, plain email with the business PDF attached, sent by hand to a short list. | COPY.md "Cold email" |
| LinkedIn | developers, security, local business | The 0.3 post on R-day; the security one-pager in week 3; the new banner on Chris's profile and the company page. | POSTS.md "LinkedIn"; COPY.md "LinkedIn: security" |
| X (@Dragon_forge_ai) | developers | The thread on R-day, then one follow-up a day for a week | ../X-THREAD.md |
| Hacker News (Show HN) | developers | One post, R+1, with Chris free to answer for the rest of the day | COPY.md "Show HN" |
| Reddit r/selfhosted | self-hosters | One post, R+2. Read the sidebar first: self-promotion rules there change, and some subs limit it to certain days. | COPY.md "r/selfhosted" |
| Reddit r/LocalLLaMA | local-model users | One post, R+3, about the local stack. Read the sidebar rules first. | COPY.md "r/LocalLLaMA" |
| Product Hunt | early adopters | Launch in week 3, once the first week's bugs are fixed | COPY.md "Product Hunt" |
| Instagram / Facebook page | local, general | The carousel and the story | COPY.md "Carousel captions" |
| Welsh tech and business communities | local, developers | A short note and an offer to demo or talk | COPY.md "Local business group post", adapted |
| Local press | general | The press release, on R-day or the day after | COPY.md "Press release" |

**Welsh tech and business communities — check each before posting.** We are
confident these exist, but not of their current channels, rules or whether
they take member announcements: **Technology Connected** (Wales's tech
membership network), **Cardiff Start** (the Cardiff startup community),
**Tramshed Tech** (the Cardiff tech workspace and its community),
**Business Wales** (the Welsh Government's business support service) and
**FSB Wales** (the Federation of Small Businesses). Check for current
meet-ups, Slack or Discord groups and newsletters; do not post anywhere we
cannot first confirm is active and welcoming of it.

**Local press — check names and current contacts:** WalesOnline's business
desk, Business News Wales, and BBC Wales. A Cardiff founder releasing free,
open-source software with a Welsh name is the local story; the security
design is the technical one.

## The four weeks

R-day is day 0. "R+3" is three days after. Keep to one main push a day: each
one needs Chris present to answer, and a reply within the hour is worth more
than a second post.

### Before R-day (R−7 to R−1)

- [ ] The v0.3.0 release exists on github.com/Dragon-Forge-master/cunning-claw/releases, with all three downloads, and each has been unzipped and double-clicked on a real machine.
- [ ] Re-check every number in "The facts we stand on"; re-render if any changed.
- [ ] The site's share image is updated to `site-social-0.3.png` (by whoever owns `site/`, not from this folder).
- [ ] Put the new LinkedIn banner on Chris's profile and the company page.
- [ ] Fill in the cold-email list (20 businesses Chris can name and has a reason to contact) and check the rules in "Cold email: the law" below.
- [ ] Draft the press-release quote with Chris; it is marked as a draft until he approves it.
- [ ] Decide who answers what: issues, HN, Reddit, email. If it is only Chris, space the posts out further.

### Week 1 — release (R to R+6)

| Day | What | Where |
|---|---|---|
| R | Release notes live. X thread (15:00 UK). LinkedIn post. Personal Facebook post. WhatsApp to close friends. | X, LinkedIn, Facebook, WhatsApp |
| R+1 | Show HN, then stay on it for the day. Press release to local press. | HN, email |
| R+2 | r/selfhosted. X follow-up: the refusal. | Reddit, X |
| R+3 | r/LocalLLaMA. X follow-up: the floor. | Reddit, X |
| R+4 | Fix what the first three days found. Post what was fixed, with the issue numbers. | GitHub, X |
| R+5 | X follow-up: the spellbook (Welsh day names). Story on Instagram/Facebook. | X, Instagram, Facebook |
| R+6 | Rest, reply, read. Write down every question people asked; they are next week's posts. | — |

### Week 2 — local (R+7 to R+13)

| Day | What | Where |
|---|---|---|
| R+7 | Carousel on Instagram and the Facebook page; share to personal Facebook. | Instagram, Facebook |
| R+8 | Local business groups (where allowed), with an offer to show it working. | Facebook groups |
| R+9 | First ten cold emails, sent by hand, each with one true line about why that business. | Email |
| R+10 | Welsh tech and business communities: a note to the ones confirmed active. | as found |
| R+11 | Ten more cold emails. Follow up anyone who replied. | Email |
| R+12 | One in-person demo if anyone said yes; ask what confused them. | — |
| R+13 | Review: what did small businesses ask that the site and PDF do not answer? Hand that to the site owner. | — |

### Week 3 — Product Hunt and the security audience (R+14 to R+20)

| Day | What | Where |
|---|---|---|
| R+14 | Prepare Product Hunt: gallery (the share image and carousel slides), maker comment, first-day reply plan. | — |
| R+15 | Product Hunt launch on a weekday. Product Hunt's day starts at 00:01 Pacific time (08:01 UK); check this before scheduling. Tell friends it is live; never ask anyone to upvote. | Product Hunt |
| R+16 | LinkedIn: the security post with `security-at-a-glance.pdf`. | LinkedIn |
| R+17 | Send the security PDF to security people Chris knows personally, asking for review, not a sale. | Email, LinkedIn |
| R+18 | X: one thread on a single defence (the Unicode-tag smuggling the scanner strips), with its limit. | X |
| R+19–20 | Fix and reply. | GitHub |

### Week 4 — keep going and take stock (R+21 to R+27)

| Day | What | Where |
|---|---|---|
| R+21 | "What we learned from the first three weeks": real issues, real fixes, what is next (the Mac box on real hardware; converters inside the box). | LinkedIn, X, GitHub Discussions if enabled |
| R+22–24 | Follow up every business that replied; a second, final email to those who opened a conversation and went quiet. Nobody gets a third. | Email |
| R+25 | Re-check the numbers; if 0.3.x has moved them, update and re-render. | — |
| R+27 | Retrospective against "What to measure"; decide the next month. | — |

The Just Works plan (£7 a month, one code, no keys) is **coming** throughout.
When it goes live, it gets its own announcement; no piece in this kit says it
is available.

## What to measure

Weekly, in one sheet, starting the week before R-day so there is a baseline.

| Measure | Where it comes from | Why |
|---|---|---|
| Release downloads, per platform | GitHub release asset download counts | The real number of people who tried it |
| `npx cunningclaw` installs | npm's weekly download count for `cunningclaw` | The second way in |
| GitHub stars, forks, watchers | the repository page | Interest, not use; never quote stars as users |
| Issues and pull requests from people other than Chris | GitHub | The best signal there is: someone cared enough to tell us |
| Setup problems reported | issues and messages, tagged by hand | Where first-timers get stuck |
| Site visits and where they came from | whatever the site host already reports in aggregate (check what is available); add no tracker that contradicts "no telemetry" | Which channel worked |
| HN, Reddit and Product Hunt: comments and questions | the threads | What people misunderstood is what the copy must fix |
| Cold email: sent, replied, demos given | a hand-kept list | Whether the local route is worth a second month |

Do not publish any of these numbers as marketing until they are worth
publishing, and never round them up.

## Cold email: the law

UK rules (PECR, enforced by the ICO) treat businesses differently. Limited
companies, LLPs and public bodies can be emailed without prior consent, as long
as we say who we are and give an easy way to opt out. **Sole traders and some
partnerships count as individuals and need consent first**, so do not cold-email
them; meet them, or post where they already are. Check the ICO's current
guidance on electronic marketing before the first send. Keep the list small,
write each email by hand, and stop at the first "no thanks".

## What we never say

The honest limits, and the pledges. If a draft contradicts one, the draft is
wrong.

- **Never "production-ready", "secure", "unhackable" or "safe" without a
  qualifier.** It is alpha, with very few users so far, and nothing has been
  independently audited.
- **Never that it is suitable for clinical, safety-critical or regulated
  use.** It is not certified for any of them.
- **Never that the scanner stops prompt injection.** It is a heuristic and can
  be evaded. The approval card is the real boundary.
- **Never that the sandbox protects your files.** Boxed commands can still read
  your other files, and the network is on by default.
- **Never "sandboxed on Mac" without "not yet tested on a real Mac".** Never
  imply Windows is boxed: it is not, and it says so.
- **Never that speech stays private without the condition:** it does with
  whisper.cpp, which needs a setup script; otherwise the browser's recogniser
  sends audio to Google, and the HUD says so.
- **Never "free" for Google's plan without its terms:** daily limits, and on
  it Google may use what you send to improve its products.
- **Never "available" for the Just Works plan.** It is coming.
- **Never a download link before the release exists**, and never "no terminal"
  before R-day: without the downloads, starting needs `npx cunningclaw` or a
  clone.
- **Never a statistic, customer, quote, award, review or partnership we do not
  have.** Connectors are integrations we support, not partners.
- **Never a Cunning Claw crypto token.** There is none and there never will be.
- **Never "garage" or "bloke".** Chris dislikes both, and the old X thread's
  "Cardiff garage" was wrong.
- **Never new Welsh.** Use only the phrases already on the site:
  *Yn lleol yn gyntaf · Caniatâd dynol pan fo canlyniadau* (with its gloss)
  and *y dyn hysbys*. The audience this must never embarrass is Wales.
- **Never a fox.** The marks are the Forge Claw and the triskele.
- **Never ask for upvotes** on HN, Reddit or Product Hunt. It breaks their
  rules and it is beneath the product.
