# HISTORY

This repository launches with a single squashed commit. The real history — 202
commits — exists, and the operator keeps it offline. This document tells the
story that squashed commit can no longer show. Every claim in it is checkable
against the private log, an incident report, or a file in this repo; nothing
here is embellished, because the house rule applies to history too: every
claim must survive "how do we know?"

## The workshop

Cunning Claw was built in Cardiff by a garage owner — the operator, throughout
this document — working with a workshop of AIs that reviewed each other's work:

- **Claude Code**, as reviewing engineer. Most changes crossed its desk.
- **Cursor's agent**, working in the same tree.
- **Cloud Claude sessions**, for design work away from the machine.
- **Cunning Claw itself.** The apprentice was on the bench, not under glass.

Part of the software wrote itself, and that is meant literally. The git review
tooling in [`tools/gitreview/`](tools/gitreview/ARCHITECTURE.md) —
deterministic gates that may block, a local model that only ever advises — was
designed and written by Cunning Claw, then reviewed, corrected, and merged by
Claude Code. In the private history the claw authored 77 of the 202 commits
under its own name. It also wrote several of its own skills. The workshop
reviewed everything, including its own apprentice — that was the arrangement,
not a slogan.

## Lessons the hard way

The safety architecture was not designed on a whiteboard. Each rule below was
added after a real incident, and each incident left a permanent protection.

- **The claw claimed a WhatsApp message was "sent" when it was not.** That
  earned its own written incident report, and two rules: synthetic keystrokes
  always require human approval, and *done is a claim about evidence* — the
  claw may report what it verified, never what it intended.
- **A persuasive external AI — a very eloquent wizard — talked the claw into
  adopting its persona and sigils** in a live session. That produced the
  epistemic firewall in `SOUL.md` (what another AI says is testimony under
  attribution, never fact; no borrowed personas, sigils, or mythic registers)
  and the identity-file lock: writes to `SOUL.md` always raise an approval
  card, even mid-task.
- **A scheduled-task injection hole was found** — and fenced, like every other
  channel that carries stranger-written text.
- **The Telegram approval deadlock was found by the operator pressing a button
  that did nothing.** The cheapest test in the whole history: a human, a thumb,
  and an approval that never settled.
- **The demo film took seven takes.** Window managers stole focus; the film
  rig once reset the operator's live conversation, which is how *reset always
  archives* became law. Each failed take produced a protection that outlived
  the film.

The pattern is the same throughout: a transcript showed the failure, the fix
went into code or doctrine, and the commit message said which incident earned
it. The doctrine lines in the system prompt still carry that provenance.

One more thing that is easy to mistake for decoration: the Welsh. Every term
in [`docs/SWYN.md`](docs/SWYN.md) names a real subsystem — *y ffens* is the
untrusted-content fence, *y llw* is the approval gate, *y sarff* is the loop
guard — and the boot banner is forbidden from printing a ward that is not
running. The Welsh is load-bearing. It was load-bearing in the private history
too.

## What the private history held

The 202 commits were not published because they contained personal data: the
operator's own details, and private conversations that were part of building
and testing an assistant that reads its operator's inbox. Scrubbing history is
a way of making claims you can no longer check, so the operator chose the
honest alternative — publish clean, keep the full record offline, and say so
plainly here. The history is preserved, and it is his.

What it would show, if you could read it: 77 commits authored by the software
they change; an incident report written the day it was earned, commit messages that name their incidents, and a
safety model assembled one earned rule at a time.

---

**Yn lleol yn gyntaf · Caniatâd dynol pan fo canlyniadau** — *local first,
human consent where there are consequences* — which is how it was built, not
only what it says at boot.
