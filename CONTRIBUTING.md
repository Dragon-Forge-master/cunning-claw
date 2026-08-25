# Contributing to JARVIS

This is a local assistant that can run a shell, see the screen, and drive a browser. A careless change is not a UI bug — it is someone else's machine. Read this before the code.

## Layout

```
public/            HUD (vanilla JS). Claude owns public/app.js — do not edit it
                   while auth work is in flight; check before you touch it.
src/server.ts      HTTP + SSE. Same ownership rule as app.js.
src/boot.ts        First-run gate, then loads the server
src/agent.ts       Streaming tool loop
src/brain.ts       Named brains, failover, spend
src/tools.ts       Tool schemas + dispatcher + HARD_DENY
src/browser.ts     Chrome via CDP; fences page/email as <untrusted>
src/desktop.ts     Screen, keys, clipboard — Linux and macOS via src/platform.ts
src/voice.ts       Piper / spd-say / say
src/doctor.ts      npm run doctor
src/workspace.ts   SOUL.md / MEMORY.md / skills
workspace/skills/  agentskills.io SKILL.md files
packaging/         systemd --user unit
```

Tune behaviour in `jarvis.config.json`, not with new constants.

## Checks

```bash
npm test        # must pass
npm run check   # tsc --noEmit
npm run doctor  # optional; names what to install
```

Assert *inclusion*, not exclusive arrays. The brain roster and the skill list grow; pinning the exact set is how two tests already broke.

Never commit `.env`, keys, or `data/history.json`.

## Safety invariants — do not weaken these

1. **The hard denylist floor cannot be switched off from JSON.** `HARD_DENY` in `src/tools.ts` is checked before `commandPolicy.denyPatterns`. An empty deny list, or `autoApprovePatterns: [".*"]`, must still block `rm -rf /`, pipe-to-shell, and disk wipes. Add patterns to the floor in code if you find a new shape. Do not move the floor into config.

2. **Untrusted content stays fenced.** Anything from a web page, an email, HTTP, or MCP is wrapped in `<untrusted>` (see `src/browser.ts`, `src/http.ts`, `src/mcp.ts`). Fence tokens inside the payload are stripped so a page cannot close the tag and impersonate the operator. New sources of stranger-written text must go through the same fence. Routing (`src/routing.ts`) pins those turns to a trusted brain; do not add a bypass.

3. **Agent-written files are data, never instructions.** `MEMORY.md`, the journal, and `data/memory.json` are rendered with `<recorded>` via `wrapRecorded`. Human-authored workspace files (`SOUL.md`, `USER.md`, `AGENTS.md`, …) are not. If you add a file JARVIS writes at runtime, fence it. `defuse()` must keep stripping `</recorded>` / `</untrusted>` so a stored note cannot escape.

4. **State-changing tools stay approval-gated.** Clicks, typing, keystrokes, non-GET HTTP, Home Assistant `call`, file writes/edits, and shell commands that are not on the auto-approve list must call `ctx.requestApproval` and stop if the user declines. Do not add a write/click/send tool that runs freely because “it is convenient.” Read-only tools (screenshot, `browser_read`, `check_email`) may run without a prompt; their *results* are still untrusted.

Defence in depth, not a guarantee. The approval card is the real boundary.

## Adding a tool

1. Append a schema to `toolDefinitions` in `src/tools.ts`.
2. Handle it in `executeTool`. If it can send, buy, delete, overwrite, or type, ask for approval first.
3. If the result is stranger-written, fence it.
4. Add a test that would have failed before your change. Prefer one behaviour (deny this command, fence this string) over a snapshot of every tool name.

The HUD learns tool names from the schema the server already sends. You should not need `public/app.js` for a new tool.

## Adding a skill

Drop `workspace/skills/<slug>/SKILL.md`:

```markdown
---
name: my-skill
description: One line for the skill index. When to use it.
---

1. Concrete steps JARVIS should follow.
2. Name the tools, do not invent new ones.
```

`listSkills()` picks up any folder with valid frontmatter. No registry file to edit. After a novel multi-step success in a live session, `skill_write` is the same path.

## Pull requests

Small, one reason each. Say *why* in the commit message, not just what changed. Run `npm test` and `npm run check` before you push.
