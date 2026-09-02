# CLAUDE.md

## Note from grok — 2 Sep 2026

Pre-launch hygiene, at the operator's request, the evening before open source. grok (Grok Bot) did not rewrite doctrine, the HUD, the safety floor, or the four good-first-issues.

- Delete leftover Claude Code branches `claude/code-review-iy1jr6` and `claude/cunning-claw-repo-m82hzk` before the visibility flip if they are still on the remote. They held pre-squash personal history. `main` and `launch` are the public line. grok could not delete refs through the GitHub connector; please do it, and do not restore them.
- `data/schedule-state.json` is gitignored and untracked. It was live operator briefing state. Do not re-add it.
- `senses/devices.example.json` no longer names a real person. Keep the example generic.

This file is still yours.

## What this is

Cunning Claw is a local-first personal AI assistant: one TypeScript/Node 22 process that serves a
browser HUD on `127.0.0.1:3900`, runs a streaming tool loop against a chosen model, and has real
hands on the operator's machine — shell, files, Chrome over CDP, the desktop, Gmail, WhatsApp,
MCP servers, a second machine over ssh, Telegram and Discord as phone lines. It goes open-source
imminently and is also a product (Dragon Forge AI, Cardiff). The threat model is prompt injection:
it reads strangers' text and must never take orders from it.

`CONTRIBUTING.md` is required reading — the layout, the four safety invariants, and how to add a
tool or a skill live there and are not repeated here. `docs/OFFICE-BLOCK.md` is the live design
for the multi-machine work; `docs/BRAND.md` and `docs/SWYN.md` govern anything user-facing.

## Commands

```bash
npm run dev            # tsx src/boot.ts — first-run gate, then the server; no build step needed
npm run build          # tsc → dist/ (only `npm start` and the tests' dist-free path need it)
npm run check          # tsc --noEmit
npm test               # tsx --test src/*.test.ts  (node:test; ~320 tests, ~6 s)
npx tsx --test src/discord.test.ts          # one file
npx tsx --test --test-name-pattern="4014" src/discord.test.ts   # one test
npm run doctor         # names every missing tool/key and the fix; run it on a fresh clone
```

Two runtime dependencies (`@anthropic-ai/sdk`, `express`) and that number is a rule, not an
accident. Node 22's own WebSocket, fetch and `node:test` are why Discord, MCP and the tests need
nothing else. Adding a dependency is a decision to argue for in the commit message.

Config is `claw.config.json` (read once at import in `src/config.ts`, which also loads `.env`
first — the Anthropic client is constructed at import time). `CLAW_ROOT`, `CLAW_DATA_DIR` and
`CLAW_CONFIG` relocate an install so two claws can run on one machine.

## How a turn flows

`public/app.js` → `POST /api/chat` (`src/server.ts`) → `runTurn` (`src/agent.ts`) → model → tool
calls → `executeTool` (`src/tools.ts`) → results back to the model → reply. Everything the HUD
sees arrives over one SSE stream (`GET /api/events`, `broadcast()` in server.ts), redacted by
`redactDeep`. `src/agent.ts` is a hard singleton — `history`, `busy`, `abortTurn`, spend are
module state — which is why a second claw is a second process, never a second instance.

**The system prompt is assembled per turn, in three parts** (`src/agent.ts`): `SYSTEM_PROMPT`
(persona and doctrine — a template literal, so backticks inside it must be escaped), the stable
half (`buildStableSystem`: brains, the "What you are" self-knowledge line, memory, skill index,
workspace, journal) and the volatile half (`volatileSystem`: time, brain, live MCP and box
rosters, cross-turn repetition warning). The rosters exist because history is a belief store
with no invalidation; anything the model must know *as of now* goes in the volatile half.
Doctrine lines in the prompt are field-earned — each was added after a real transcript showed
the failure, and the commit message says which.

**Approvals** (`src/server.ts`): `requestApproval` mints an id, broadcasts `approval_request`,
and pushes a card to Telegram and Discord; `settleApproval` resolves it from the HUD, either
phone line, or the timeout. A new message from the operator denies everything pending. Work
orders (`src/workorder.ts`) let a plan be approved once, but `stepIsCommitting` and the
identity-file/denylist guards decide what a plan can never pre-authorise. `src/consequence.ts`
classifies reversibility and holds the per-task grant.

**Routing** (`src/routing.ts`): tools that return stranger-written text are in
`UNTRUSTED_TOOLS`; a turn that touches one is pinned to a trusted brain and the taint sticks to
history. Add any new tool that reads outside content to that list.

**Phone lines** are siblings with one shape — `startX(events, { resolveApproval })`,
`sendApprovalCard`, `approvalSettled`, `xStatus()`: `src/telegram.ts` polls, `src/discord.ts`
holds a Gateway WebSocket (a state machine with sockets and timers injected, so it is fully
tested without a token). Trust is the allowlist and nothing else; every outbound message is
redacted *before* it is truncated or chunked.

## Rules that are not obvious from the code

- **The floor is code.** `HARD_DENY` in `src/tools.ts` runs before config and before the
  approval gate. Config can add patterns, never subtract; a plan cannot clear it.
- **Chokepoints, not sprinkles.** Redaction happens where text leaves the machine (`send()` in
  each phone line, `broadcast`, the journal), fencing where it enters (`fenceUntrusted`,
  `wrapRecorded`, `defuse`). Put new sources and sinks through the existing function.
- **No import cycles.** `agent → tools → schedule → agent` was a real one; the fix was the leaf
  `src/schedule-format.ts`. `paths.ts`, `redact.ts`, `voice.ts`, `config.ts` are leaves — keep
  them that way; inject a dependency rather than importing upward.
- **Status text is non-volatile on purpose.** The Ouroboros guard (`src/coherence.ts`) detects a
  model re-asking the same thing by identical results; a free-running clock or byte counter in
  a status string disables it. `remote.ts` `statusText` is the model to copy.
- **The model never supplies a host, user or ssh option** (`src/remote.ts`). Boxes are chosen
  by id from config; remote paths are whitelisted characters because scp hands them to a shell.
- **Personal data does not reach the glass.** Home collapses to `~` (`collapseHome`), chat ids
  show four digits (`maskChatId`); the HUD is screenshotted and filmed.

## Verifying UI work

The HUD is vanilla JS with no build; `textContent` everywhere, `innerHTML` only for static
templates — keep it that way, the transcript renders model output. Drive it for real:
Playwright with `chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })` and
`page.goto(url, { waitUntil: "domcontentloaded" })` — `networkidle` never fires because the SSE
stream stays open. Start a private server with `CLAW_CONFIG` pointing at a copy of the config
on another port and its own `CLAW_DATA_DIR`. Stop it by explicit PID; `pkill node` has killed
the operator's shell before. A button that "does nothing" has twice been a real bug found this
way (connectors, the Desk) — the pattern is a result written and then wiped by a re-render, or
an action with no visible state.

## Tests

`node:test` + `node:assert/strict`, one `src/<module>.test.ts` beside each module, no mocks
framework — modules take their sockets, timers, home dir or fetch by parameter when a test
needs to stand in. A test is only accepted if it fails with the fix reverted; say so in the
commit. Assert inclusion, not exact arrays (rosters grow). Fixtures for secrets are synthetic
and listed in `.gitreview/ignore`.

## Writing

UK English throughout — code comments, docs, commit messages, the HUD. Comments explain *why*,
matching the density of the file they are in; the codebase's comments are its design record.
Commit messages say what was broken, how it was found, and what test now covers it. Every claim
in docs or copy must survive "how do we know?" — count the number before you state it
(`grep -c '^    name: "' src/tools.ts` for tools, `MCP_CATALOGUE.length` for connectors,
`npm test` for tests). `tools/gitreview/` is the operator's pre-commit review tool, wired via
`core.hooksPath` on their machine, not here.
