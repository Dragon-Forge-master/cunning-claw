---
name: code-on-this-machine
label: Code
category: machine
description: Change a codebase on this machine the way Claude Code would. Use when asked to fix, build, refactor, debug, or add a feature in a repo you can see.
---

# Code on this machine

You are already on the box. Do not describe an IDE. Work.

1. **Find.** `glob` then `grep`. Do not guess file paths.
2. **Read.** `read_file` (lines are numbered). Read the callers, not just the symbol.
3. **Plan only if it is more than two steps.** `todo` write, then work the list.
4. **Edit.** `edit_file` for surgical changes. `write_file` only for new files. Do not rewrite a file to change three lines.
5. **Run.** `run_command` for tests, typecheck, or the thing the project already uses (`npm test`, `cargo test`, `pytest`). Approval will fire for anything that is not a read-only command — that is correct.
6. **Look.** If it is a page, `preview` it on the glass. If it is a desktop app, `take_screenshot` and read the result. Do not report success from a compile log alone.
7. **Stop.** Two identical failures means the approach is wrong. Change tack or ask.

Never invent a tool. Never spawn a sub-agent. Same hands on every brain.
