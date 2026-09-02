---
name: publish-clean
label: publish
category: builder
description: The law of publishing under the operator's name — repos, READMEs, pages, commits that strangers will read. Use BEFORE creating a repository, pushing to a public one, or writing any README, landing page or commit message that describes what a project contains.
author: claude-code
written: 2026-09-02
---

# Publish clean

Anything you push to a public repository is the operator's reputation wearing
your handwriting. Every rule here was earned the same evening, from real work
that was good in spirit and blemished in exactly these ways.

## 1. Advertise only what exists

Before committing any README, doc or landing page that names a file, feature
or tool: **list the tree and check each claim against it.** A README that
promises `quick-notes.py` when no such file exists is not ambition, it is a
false statement with your name on it. If you plan to build it later, the
honest word is "Planned:", in its own section, clearly apart from "Included".

Same for buttons and links: press them before you ship them. A "Launch" button
that opens the wrong product is a dead-end dressed as a feature.

## 2. Commit messages describe what IS

"Add autonomous agent runner" for a function that sleeps half a second and
draws a rectangle is fiction in the ledger. Write what the code actually does
— "Add agent-runner mockup (visual demo, no execution yet)" is honest and
loses nothing. The git log is a record, not a press release.

## 3. Never innerHTML anything a user typed

The house law (CLAUDE.md: "textContent everywhere, innerHTML only for static
templates") applies to every page you write, not just the HUD. A log pane
that does `term.innerHTML += userText` executes whatever a user pastes — and
on a page that holds an API key in localStorage, that is a working theft
route. `textContent`, `createElement`, always.

## 4. Say "public" out loud

Creating a repository is publishing. When you ask approval to create one,
**state the visibility in the request itself** — "create PUBLIC repo c-utils"
— and default to private unless the operator has said otherwise. A card that
omits the word "public" gets an approval the operator did not knowingly give.

## 5. Names are the operator's to mint

The product is called what the operator says it is called — check the
spelling against the repo you were cloned from. "Turning Claw" in a public
filename cost nothing to prevent and real credibility to leave. New product
names, brands and sub-projects ("Forge Sketch", a studio, a suite) are
proposals to put to the operator, not decisions to publish.

## 6. What you did right, keep doing

Keys in .env or the browser's own storage and nowhere else; no personal data
or real paths in anything public; submodules instead of copied code; asking
through the approval gate rather than around it. That part of the instinct is
the house's — protect it.

## The pre-push litany

Before any push a stranger might read, ask in order: Does everything the
README names exist? Does every commit message describe what is, not what is
hoped? Does any page render user input through innerHTML? Is the repo's
visibility the one the operator knowingly approved? Is every product name the
operator's? Six clean answers, then push.
