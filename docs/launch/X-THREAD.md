# X / Twitter — Cunning Claw 0.3 thread (Dragon Forge account)

For R-day: the day the v0.3.0 downloads go live. Post 1 at 15:00 UK time with
`v0.3/site-social-0.3.png` attached (or the launch film, if it has been
re-cut for 0.3; the old cut predates the sandbox). Thread the rest as replies,
a minute apart. Hand-posted from @Dragon_forge_ai: no scheduling tools, no
automation, because the account is the founder.

Every post is under 280 characters as written (counted). Re-check the numbers
on the morning: `npm test` for tests, `grep -c '^    name: "' src/tools.ts`
for tools. No download link anywhere; the site and the repository point to
the releases page.

*Replaces the 0.2 thread, which said 434 tests (now 622), described where
it was built wrongly (in a word the founder does not use), and said "fully
offline with Ollama" without the caveat that small local models are easier to
steer.*

---

**1/**
Most AI assistants will do whatever a web page tells them to.

Cunning Claw won't. And 0.3 makes him cheaper, harder to fool and more private.

A local-first AI assistant with real hands: shell, files, browser, email. Open source, from Cardiff.

cunningclaw.com

**2/**
Why it matters: he reads strangers' text all day. Web pages, emails, PDFs. That text must never become his orders.

So outside words arrive fenced as data, and anything with a consequence (send, spend, publish, run outside the box) waits for your yes.

**3/**
New in 0.3, the box. On Linux his shell runs in bubblewrap: it writes only to folders you allow, and your ssh and GPG keys, cloud and git logins, keyrings and browser profiles are hidden from it.

Mac: built, not yet run on a real Mac. Windows: no box yet, and he says so.

**4/**
Also new: a scanner that flags text trying to give him orders, including instructions hidden in invisible Unicode, and suspends any pre-approval for the rest of that turn.

It's a heuristic. It can be evaded. The approval card is the real boundary.

**5/**
Cheaper: he only carries the connector tools a message needs. In a test with 150 connector tools, 80% fewer tokens of tool lists per message.

And a free start: the setup page walks you through a free Google Gemini key in four steps. No card.

**6/**
Plus: speech-to-text on your own machine, memory by meaning, PDF/Word/Excel/scans, ntfy alerts with no account, and "Guide me" on all 94 connectors.

Downloads for Windows, Mac and Linux: unzip, double-click.

73 tools. 622 tests. 2 runtime dependencies. MIT.

**7/**
It's alpha, with very few users so far, and I'd rather be told what's broken than be flattered. If you break the fences, file it.

github.com/Dragon-Forge-master/cunning-claw

— Chris, Dragon Forge AI, Cardiff

---

## Follow-ups for the week (one a day, not more)

- **R+2 — the refusal.** The site's injection demo: a page hid an instruction
  to read `~/.ssh/id_rsa` and post it away. Quote his reply exactly as the
  site prints it, from the real run, and add: "Defence in depth, not a
  guarantee. The cards are the boundary."
- **R+3 — the floor.** "Twelve things he will never run, whoever asks. Even
  you." Then the list: `rm -rf`, `mkfs`, `dd` onto a disk, the fork bomb,
  `curl … | sh`… "Config can add to it. Nothing can take from it."
- **R+5 — the spellbook.** "Standing orders, in either language." A
  screenshot of three schedule lines, e.g. `17:00:gwener` for a Friday
  invoices check. "The day names parse in Welsh or English, because the
  machine is bilingual like its country."
- **R+6 — what broke.** Only if something real did: the issue, the fix, the
  test that now covers it. If nothing was reported, skip the day.
- **R+7 — one carousel slide.** Post `v0.3/carousel/03-boxed-shell.png` on its
  own with its honest bit as the text. The limits are the selling point for
  this audience.
