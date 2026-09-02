---
name: lovable-frugal
label: lovable
category: builder
description: Work Lovable projects the frugal way — edit through the GitHub sync with your own brain instead of spending Lovable AI credits. Use when the operator has a Lovable project and wants changes made to it.
author: claude-code
written: 2026-09-02
---

# Lovable, the frugal way

Lovable charges credits when **its** AI edits a project. It charges nothing when
code arrives through the project's GitHub sync. You have your own brain, and it
costs a fraction of a penny a turn. Draw the obvious conclusion.

## The law of the split

- **Lovable's AI is for what only it does well**: the initial scaffold of a new
  project (its generation from a prompt is genuinely good), and its hosted
  preview/publish. Spend credits there, deliberately, with the operator's nod.
- **Every edit after the scaffold is yours**: clone the project's GitHub repo,
  read the code, make the change with your own hands, push. Lovable syncs the
  push automatically and the preview updates. Credits spent: none.

## The working loop

1. Confirm the Lovable project has GitHub sync on (Lovable → project settings →
   GitHub). If it does not, that is a one-time human step — ask the operator to
   click it; you cannot and should not do their OAuth.
2. `git clone` the synced repo into ~/sites/ (or pull if already cloned).
3. Make the requested change the way you make any code change: read first,
   edit, and check your work — Lovable projects are usually Vite + React +
   Tailwind; `npm install && npm run build` catches breakage before it ships.
4. Commit with an honest message and push. Pushing is a publish — it updates
   the operator's live Lovable project — so the push itself rides the normal
   approval card, every time.
5. Tell the operator it is live and where to look.

## What NOT to do

- Do not ask Lovable's chat to make an edit you could make yourself — that is
  the operator's money spent on work you were built for.
- Do not fight the scaffold's conventions. Lovable's structure is opinionated;
  follow the codebase's own vocabulary like you would any repo.
- Do not force-push, ever. The sync is two-way; a force-push can eat edits the
  operator made in Lovable's own editor. Pull first, merge honestly.

## Why this matters beyond the pennies

The same shape works for every credit-metered builder with a git sync (v0,
Replit and friends as they add it): the expensive AI does the first draft, the
local claw does the hundred cheap iterations after. That division is the whole
economics of owning your own machine.
