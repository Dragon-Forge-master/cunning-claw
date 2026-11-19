# Cunning Claw 0.3 — copy

Ready-to-paste copy for every channel in [MARKETING-PLAN.md](MARKETING-PLAN.md).
Every claim is one of the facts in the plan's "The facts we stand on" table or
in [SECURITY-ARCHITECTURE.md](../../SECURITY-ARCHITECTURE.md); the limits that
go with each claim are in the same piece, not left for the replies.

Rules for using it:

- **R-day** is the day the v0.3.0 downloads go live. Pieces marked
  **[R-day]** mention the downloads and wait for it. Never paste a download
  link: point to cunningclaw.com or the repository, and let the releases page
  speak for itself.
- **Re-check the numbers** (73 tools, 94 connectors, 31 skills, 623 tests,
  2 runtime dependencies) on the morning you post.
- **"He" or "it".** The consumer pieces call the assistant *he*, as the site's
  0.3 section does. The developer pieces (HN, Reddit) say *it*: those readers
  find a gendered program twee, and the substance is what they came for.
- **Character counts** are given where a platform has a limit; they were
  counted, not guessed.

---

## Show HN [R-day + 1]

**URL field:** `https://github.com/Dragon-Forge-master/cunning-claw`

**Title** (72 characters, limit 80):

> Show HN: Cunning Claw – a local AI agent with real hands that asks first

**Body:**

> Hi HN, I'm Chris, in Cardiff. I'm self-taught and have been writing software
> for about six years; this is the thing I've been building.
>
> Cunning Claw is a local-first AI assistant: one Node 22 process on your own
> machine that serves a browser UI on 127.0.0.1:3900 and runs a tool loop
> against a model you choose. It has real hands: a shell, files, its own
> Chrome profile (so Gmail and WhatsApp Web through the browser), the desktop,
> 94 MCP connectors, Telegram/Discord/ntfy, Home Assistant, and a second
> machine over ssh.
>
> That makes prompt injection the threat that matters. It reads strangers'
> text all day, and that text must never become its orders. The design assumes
> the model will sometimes be fooled, and puts the boundaries in code:
>
> - Outside text is fenced as data, and fence tags inside it are stripped, so
>   a page cannot close its own fence.
> - Sends, spends, publishes and anything run outside the sandbox wait for an
>   approval card (in the UI, or a Telegram/Discord DM). No answer in three
>   minutes is a no; a new message from you cancels every pending card.
> - Twelve commands (rm -rf, mkfs, curl | sh, …) are refused before config,
>   approvals or approved plans are consulted. Config can add to the list,
>   never subtract.
> - On Linux, `run_command` executes in bubblewrap: read-only root, writes
>   only to folders you allow, and ~/.ssh, ~/.gnupg, cloud and git
>   credentials, keyrings and browser profiles replaced by empty stand-ins.
>   Credential-like environment variables are stripped and the agent/keyring/
>   display sockets hidden. A live test plants a fake key and fails if `cat`
>   can read it from inside the box.
> - A turn that has read outside text is pinned to a model you've cleared for
>   hostile input, and the taint sticks to the history.
>
> New in 0.3: connector tool schemas load on demand (in a test with 150
> connector tools, 80% fewer tokens of tool lists per message); the sandbox;
> local speech-to-text with whisper.cpp; memory search by meaning (embeddings
> from a provider you key, or Ollama); reading PDF, Office files and scanned
> images; a heuristic injection scanner that strips Unicode tag-character
> smuggling and suspends any pre-approval for the rest of the turn; ntfy push
> alerts; a step-by-step guide for setting up each connector; and a first-run
> page that walks a newcomer through a free Gemini key.
>
> What it is not, yet:
>
> - Alpha, with very few users. Nothing has been independently audited.
> - The scanner is a heuristic in an open file; anyone can write around it.
>   The approval card is the boundary, and it only works if you read it.
> - The sandbox confines writes, not reads. A boxed command can still read
>   your other files, and the network is on by default
>   (`sandbox.network: false` turns it off).
> - The macOS sandbox (sandbox-exec) is built and unit-tested but has not run
>   on a real Mac. Windows has no sandbox, and every result says so.
> - Document converters run outside the sandbox (without your keys in their
>   environment).
>
> Numbers you can check: 73 tools, 623 tests passing (`npm test`), two
> runtime dependencies (@anthropic-ai/sdk and express; Node 22's own fetch,
> WebSocket and node:test do the rest). MIT. The threat model, with every
> claim pointing at the file that implements it, is
> docs/SECURITY-ARCHITECTURE.md.
>
> Try it with `npx cunningclaw`, or clone and run `./install.sh`. As of today
> there are also downloads for Windows, macOS and Linux with Node inside, on
> the releases page.
>
> What I'd value most is someone breaking the fences. File it as an issue;
> the security review that hurts is the one I want.

---

## Reddit — r/selfhosted [R-day + 2]

Read the subreddit's rules on the day: self-promotion rules there change, and
some subreddits only allow it on set days. Say plainly that you built it.

**Title:**

> Cunning Claw 0.3 — a local AI assistant that runs as one process on your own machine, with a sandboxed shell (alpha, MIT)

**Body:**

> Disclosure: I built this. It's alpha and I'm looking for people to break it.
>
> **What it is:** an AI assistant that runs on your own machine as a single
> Node 22 process. The UI is a browser page on 127.0.0.1:3900, behind a token
> it mints for itself. No account, no telemetry. It talks to whichever model
> provider you give it a key for, or to a local model through Ollama.
>
> **What it can touch:** a shell, files, its own Chrome profile (so Gmail and
> WhatsApp Web through the browser), the desktop, 94 MCP connectors, Home
> Assistant (off unless you turn it on), another machine you own over ssh,
> and Telegram, Discord or ntfy to reach your phone.
>
> **Why self-hosters might care:**
>
> - Your data stays as files on your disk: documents on the Desk as markdown,
>   memory and a dated journal, and scheduled tasks in a markdown file you
>   can read and edit (day names parse in English or Welsh).
> - Two runtime dependencies. `npm run doctor` names every missing tool or key
>   and the fix.
> - `CLAW_ROOT`, `CLAW_DATA_DIR` and `CLAW_CONFIG` relocate an install, so two
>   can run on one machine.
> - Anything that sends, spends, publishes or runs outside the sandbox waits
>   for an approval card. Twelve destructive commands are refused outright.
> - On Linux, shell commands run in bubblewrap: writes only to folders you
>   allow, with ssh/GPG keys, cloud and git credentials, keyrings and browser
>   profiles hidden from them.
>
> **New in 0.3:** on-demand connector tool schemas (80% fewer tokens of tool
> lists per message in a 150-tool test), the sandbox, local speech-to-text
> with whisper.cpp, memory search by meaning, PDF/Office/scan reading, an
> injection scanner, ntfy alerts, guided connector setup, and a first-run page
> that walks you through a free Gemini key. As of this week there are
> downloads for Windows, macOS and Linux with Node inside.
>
> **Limits, up front:**
>
> - Very few users so far, and no independent audit.
> - The sandbox confines writes, not reads, and the network is on by default
>   (you can turn it off per install). macOS's sandbox is built but untested
>   on a real Mac; Windows has none.
> - The injection scanner is a heuristic and can be evaded; the approval card
>   is the real boundary.
> - On Google's free plan, Google may use what you send to improve its
>   products. Use a paid key, or Ollama, for anything private.
>
> Source and the full security write-up:
> github.com/Dragon-Forge-master/cunning-claw (docs/SECURITY-ARCHITECTURE.md).
> 623 tests, MIT. Issues very welcome.

---

## Reddit — r/LocalLLaMA [R-day + 3]

Read the subreddit's rules on the day, and say plainly that you built it.

**Title:**

> Cunning Claw 0.3: a local agent that can run on Ollama, with whisper.cpp ears, local embeddings and on-demand tool schemas

**Body:**

> Disclosure: I built this; it's alpha.
>
> Cunning Claw is an AI assistant that runs on your own machine and operates
> it: shell, files, browser, desktop, MCP connectors. 0.3 has a few things
> this sub might care about:
>
> - **Fully local stack, if you want it.** A brain through Ollama,
>   speech-to-text with whisper.cpp, text-to-speech with Piper, and memory
>   search by meaning with embeddings from Ollama. With all of those (and no
>   phone lines switched on), nothing leaves the machine.
> - **Fewer tokens of tool lists.** Connector tool schemas are only sent when a
>   message needs them; the rest sit in a short roster the model can load from.
>   In a test with 150 connector tools, each message carried 80% fewer tokens
>   of tool lists. That matters more with a small context window.
> - **Memory by meaning.** "The car spraying job" finds a note that says
>   "mobile paint repair", with no word in common. That exact case is a test.
> - **Hostile text handling.** Outside text is fenced as data; a heuristic
>   scanner flags text addressed to the model (and strips Unicode
>   tag-character smuggling); consequential actions wait for an approval
>   card; on Linux the shell runs in bubblewrap with your keys hidden.
>
> **The honest part about local models:** smaller local models are weaker at
> reasoning and easier to steer, so they are not on the "trusted brain" list
> by default. When a turn has read outside text, the router wants a trusted
> brain, and if a local one handles it anyway the guard says so. The Ollama
> path has unit tests but has not been exercised end to end in CI, so reports
> of which models handle the tool loop well (or badly) would genuinely help.
>
> Other limits: very few users so far; the scanner can be evaded; the sandbox
> confines writes, not reads; macOS's box is untested on a real Mac and
> Windows has none.
>
> github.com/Dragon-Forge-master/cunning-claw: MIT, 623 tests, two runtime
> dependencies. Security write-up in docs/SECURITY-ARCHITECTURE.md.

---

## Product Hunt [R-day + 15]

**Tagline** (47 characters, limit 60):

> The local AI assistant that asks before it acts

**Description** (241 characters, limit 260):

> Cunning Claw runs on your own computer and works it: email, files, browser,
> 94 connectors. Anything that sends, spends or publishes waits for your yes;
> text that tries to give it orders is flagged. Open source, free with your
> own key. Alpha.

**Maker's first comment:**

> Hello Product Hunt, I'm Chris from Dragon Forge AI in Cardiff.
>
> Cunning Claw is an AI assistant that lives on your own computer, not in
> someone else's cloud. You open it in your browser, and it can read your
> email, documents and spreadsheets, draft replies, keep standing jobs on a
> schedule, and work tools such as Xero, Canva, Notion and GitHub through 94
> connectors. Each connector has a "Guide me" button that walks you through
> setting it up.
>
> The part I care most about: an assistant that reads the web and your inbox
> will eventually read something written to hijack it. So outside text is
> treated as information, never as orders; text that tries to give orders is
> flagged; and anything that sends, spends or publishes waits for you to say
> yes. On Linux its commands run inside a box that hides your keys and
> passwords. (The Mac box is built but not yet tested on a real Mac, and
> Windows has none yet.)
>
> It's free forever with your own key, and the setup page walks you through a
> free Google key in four steps. A £7-a-month "Just Works" plan, with one code
> and no keys, is coming.
>
> It's alpha, with very few users, so the most useful thing you can do is try
> it and tell me what broke.

**Gallery:** `site-social-0.3.png` first, then carousel slides 02–10. Check
Product Hunt's current gallery size guidance on the day; the share image is
16:9 and the slides are square.

**Topics** (check they still exist): Open Source, Artificial Intelligence,
Privacy, Productivity.

---

## X / Twitter thread

In [../X-THREAD.md](../X-THREAD.md), rewritten for 0.3.

---

## LinkedIn: security [R-day + 16]

Attach `security-at-a-glance.pdf`.

> An AI agent that can use your shell, your browser and your inbox will, sooner
> or later, read something written to hijack it. That isn't a corner case for
> an agent with tools; it's the normal case.
>
> I've put the security design of Cunning Claw on one page. The short version:
> we assume the model will sometimes be fooled, and put the boundaries that
> matter in code. Consequential actions wait for a human approval card. Twelve
> commands are refused whatever the config says. On Linux the shell runs in a
> bubblewrap sandbox that hides ssh and GPG keys, cloud and git credentials,
> keyrings and browser profiles, and strips credentials from the environment.
>
> And the page lists what it does not do, in priority order: boxed commands can
> still read other files and, with the network on, send them; document
> converters run outside the box; Windows has no box; the macOS box is
> untested on hardware; the injection scanner is a heuristic; and an approval
> card only works if someone reads it.
>
> Nothing here has been independently audited, and it isn't certified for
> regulated use. If you work in security and you'd look at it and tell me
> where it's wrong, I'd be grateful. The full write-up is
> docs/SECURITY-ARCHITECTURE.md in the repository.
>
> github.com/Dragon-Forge-master/cunning-claw

---

## Carousel captions

The carousel is `carousel/01-cover.png` to `carousel/11-close.png`, in order.

### Instagram [ready now]

> Nine upgrades to Cunning Claw, the AI assistant that runs on your own
> computer and asks before anything that sends, spends or publishes.
>
> Cheaper. Harder to fool. More private. Swipe for all nine, honest bits
> included.
>
> Free with your own key. Open source. Built in Cardiff by Dragon Forge AI.
> cunningclaw.com (link in bio)
>
> #opensource #AI #privacy #localfirst #smallbusiness #Cardiff #Wales

### Facebook page [ready now]

> Cunning Claw 0.3: nine upgrades to the AI assistant that runs on your own
> computer, not in someone else's cloud.
>
> He's cheaper to run, harder to fool, and more private, and you can now
> start free: the setup page walks you through a free Google key in four
> steps, no card. Every slide says what's new, and where there's a catch, the
> slide says that too.
>
> Open source, built in Cardiff. No crypto token, ever. cunningclaw.com

### Alt text, slide by slide

1. Cunning Claw 0.3 cover: "Cheaper. Harder to fool. More private." Nine upgrades to the AI assistant that runs on your own computer, and asks before anything that matters.
2. Upgrade 1, costs less: he only carries the tools a message needs. In a test with 150 connector tools, 80% fewer tokens of tool lists per message.
3. Upgrade 2, boxed shell: on Linux his commands can write only to folders you allow, and your keys, logins, keyrings and browser profiles are hidden. Mac: built, not yet tested on a real Mac. Windows: no box yet. Boxed commands can still read your other files.
4. Upgrade 3, private ears: speech-to-text on your own computer with whisper.cpp. Needs a one-off setup script; without it the browser's recogniser is used and the screen says audio goes to Google.
5. Upgrade 4, remembers by meaning: ask about "the car spraying job" and he finds the note that says "mobile paint repair".
6. Upgrade 5, reads documents: PDF, Word, Excel, PowerPoint and scans, treated as a stranger's words, never as orders.
7. Upgrade 6, notices tricks: text that tries to give him orders is flagged, even when hidden in invisible characters. The scanner can be evaded; the approval card is the real boundary.
8. Upgrade 7, push alerts: ntfy on your phone with no account, personal details scrubbed, never an approve button.
9. Upgrade 8, connector coach: a "Guide me" button on every one of the 94 connectors walks you through setup.
10. Upgrade 9, a free start: a free Google Gemini key in four steps, no card. Google's free plan has daily limits and Google may use what you send.
11. Closing slide: every send, spend and publish waits for your yes. 73 tools, 94 connectors, 31 skills, 623 tests, 2 dependencies. Free forever with your own key. Alpha. No crypto token, ever.

### Story [ready now]

`story-0.3.png`. Add a link sticker to cunningclaw.com. No caption needed;
if the app wants one: "Nine upgrades. Swipe up for the details."

---

## Friends: WhatsApp and personal Facebook

### WhatsApp (one-to-one; change the opening for each person) [R-day]

> Hiya, bit of a different one from me. You know me from the vehicle side, but
> for about six years I've been teaching myself to build software, and the
> thing I've been building is ready for people to try.
>
> It's called Cunning Claw: an AI assistant that lives on your own computer
> instead of someone else's cloud. It can read your emails and documents,
> draft replies, keep your reminders and work things like Xero and Canva, and
> it asks you before it sends, spends or posts anything.
>
> It's free to start, and the setup walks you through it. It's very new, so if
> you give it a go, tell me what's confusing or broken. That's the most useful
> thing anyone can do for me right now.
>
> cunningclaw.com

### Personal Facebook [R-day]

> Something different from me today.
>
> Most of you know me from the vehicle business. What fewer of you know is
> that I've spent about six years teaching myself to write software, and today
> the thing I've been building in Cardiff gets a big update.
>
> It's called Cunning Claw. It's an AI assistant that runs on your own
> computer, not in someone else's cloud. It can read your email and your
> paperwork, draft replies, keep track of jobs and reminders, and work the
> tools you already use, like Xero, Canva or Stripe. And it asks you first
> before it sends, spends or publishes anything. That last bit is the whole
> point.
>
> From today there's a download for Windows, Mac and Linux: unzip it,
> double-click, and a setup page walks you through getting a free Google key.
> No card.
>
> It's early days and very few people use it yet, so I'd love it if you tried
> it and told me honestly what you made of it. And if you run a business and
> want to see it working, message me.
>
> cunningclaw.com

---

## Local business group post [R-day + 8]

Only in groups Chris belongs to, and only where the rules allow it.

> Hi all, Chris here, from Dragon Forge AI in Cardiff.
>
> I make Cunning Claw, a free AI assistant that runs on your own computer. For
> a small business it can read your emails and draft replies, read the PDFs
> and spreadsheets suppliers send, keep standing reminders (say, a Friday
> check for unpaid invoices) and work tools like Xero, Canva and Stripe.
> Anything that sends, spends or publishes waits for you to press yes.
>
> It's free with your own key; the setup page walks you through a free Google
> one. It's new, so I'm looking for a few local businesses to try it and tell
> me straight what works and what doesn't. I'm happy to show anyone it
> working, no charge.
>
> cunningclaw.com

---

## Cold email for local businesses [R-day + 9]

Attach `cunning-claw-for-your-business.pdf`. Send by hand, one at a time, only
to limited companies, LLPs and public bodies (sole traders and some
partnerships need consent first; see "Cold email: the law" in the plan).
Fill in the bracketed line with something true and specific, or delete it.

**Subject lines** (pick one):

- An AI assistant that asks before it acts, from Cardiff
- Free help with the inbox and paperwork, [Business name]?
- A quick one from a Cardiff software maker

**Body:**

> Hi [first name],
>
> I'm Chris, from Dragon Forge AI in Cardiff. [One true line on why you are
> writing to this business, or delete this line.]
>
> We make Cunning Claw, an AI assistant that runs on your own computer. For a
> business like yours it can:
>
> - read your emails and draft replies, sent only when you say yes
> - read the PDFs, spreadsheets and scanned letters suppliers send you
> - keep standing reminders, like a Friday check for unpaid invoices
> - work tools you may already use, such as Xero, Canva or Stripe
>
> It's free with your own key, and the setup page walks you through getting a
> free Google one. Anything that sends, spends or publishes waits for you to
> press yes.
>
> I'll be straight with you: it's new, and very few businesses use it yet. If
> you'd like, I'll show you it working in fifteen minutes, in person or on a
> call. No charge and nothing to sign.
>
> There's a one-page summary attached.
>
> Thanks,
> Chris
> Dragon Forge AI · Cardiff
> cunningclaw.com
>
> If you'd rather not hear from me again, reply "no thanks" and I won't
> email again.

---

## Press release [R-day]

The quote is a **draft for Chris to approve or rewrite**; do not send it
until he has.

> **FOR IMMEDIATE RELEASE · [R-DAY DATE]**
>
> **Cardiff software maker releases free AI assistant that runs on your own computer, and asks before it acts**
>
> CARDIFF, [DATE] — Dragon Forge AI today released Cunning Claw 0.3, a free,
> open-source AI assistant that runs on a person's own computer rather than in
> a company's cloud, and stops to ask before it does anything with
> consequences.
>
> Cunning Claw opens in the web browser and can work the computer it runs on:
> it reads email and documents, drafts replies, keeps scheduled jobs, and
> connects to 94 services including Xero, Canva, Stripe, Notion and GitHub. It
> can message its owner on Telegram, Discord or ntfy. Anything that sends,
> spends or publishes waits for its owner to approve it.
>
> An assistant that reads the web and email will eventually read text written
> to trick it. Cunning Claw treats everything it reads from outside as
> information, never as orders; flags text that tries to give it
> instructions, including instructions hidden in invisible characters; refuses
> twelve dangerous commands whoever asks; and, on Linux, runs its commands
> inside a box that hides the owner's keys and passwords.
>
> Version 0.3 brings nine upgrades, including lower running costs (in a test
> with 150 connector tools, 80% fewer tokens of tool lists per message),
> speech-to-text on the owner's own computer, and a free start: a setup page
> that walks a first-time user through a free Google Gemini key in four steps,
> with no card. For the first time there are downloads for Windows, Mac and
> Linux: unzip, double-click, and everything needed to start is inside.
>
> [DRAFT QUOTE — CHRIS TO APPROVE OR REPLACE] "Most AI assistants will do
> whatever a web page tells them to. I wanted one I could trust with my own
> inbox, so it asks before anything that matters, and it's honest about what
> it can't yet do. It's new, and the best thing anyone can do is try it and
> tell me what breaks," said Chris, founder of Dragon Forge AI.
>
> The project is at an early stage, with very few users so far, and is not
> certified for clinical, safety-critical or regulated use. Its security
> design and known gaps are published in full alongside the source code.
>
> Cunning Claw is free forever with the user's own key, and its source is
> published under the MIT licence. A "Just Works" plan at £7 a month, with one
> code and no keys to set up, is coming.
>
> **Availability:** cunningclaw.com · github.com/Dragon-Forge-master/cunning-claw
>
> \#\#\#
>
> **Notes to editors**
>
> - About Dragon Forge AI: see the 100-word boilerplate below.
> - Facts as of release: 73 tools, 94 connectors, 31 skills, 622 automated
>   tests passing, two runtime dependencies. MIT licence.
> - There is no Cunning Claw crypto token, and there never will be.
> - Images: `site-social-0.3.png` (1600×900), carousel slides (1080×1080).
> - Contact: [Chris's name as he wants it printed, email and phone — to fill].

---

## About Dragon Forge AI

### 50 words

> Dragon Forge AI is a software maker based in Cardiff, Wales. It builds Cunning
> Claw, a free, open-source AI assistant that runs on your own computer and
> asks before anything that sends, spends or publishes. Free with your own
> key, MIT-licensed and built in the open. No crypto token, ever.

### 100 words

> Dragon Forge AI is a software maker in Cardiff, Wales, founded by Chris, a
> self-taught developer with about six years of building software behind him.
> Its product is Cunning Claw, a free, open-source AI assistant that runs on
> your own computer, not in someone else's cloud. It reads email and
> documents, keeps scheduled jobs and works 94 connected services, and anything
> that sends, spends or publishes waits for a human yes. The name comes from
> the Welsh cunning folk, *y dyn hysbys*, the knowing one. The motto is local
> first, human consent where there are consequences. No crypto token, ever.
