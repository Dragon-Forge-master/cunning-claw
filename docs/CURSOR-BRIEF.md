# JARVIS — task brief

**Repo:** `~/Game Dev/jarvis` (note the space — *not* `~/jarvis/jarvis`)
**Branch:** work on `main`, pull before you start, commit and push each task separately.

JARVIS is a local AI assistant: 36 tools, 5,200 lines, 63 tests, 2 runtime deps.
It runs shell commands, sees the screen, drives Chrome, reads Gmail, speaks, and
deploys sites. Read `README.md` first, then `jarvis.config.json`.

## Coordination — read this before touching anything

Claude is working on **API authentication** right now, which touches
`src/server.ts` and `public/app.js`. **Do not edit those two files.** We collided
twice yesterday by both building the same thing; the fix is file boundaries.

Yours for these tasks: `src/voice.ts`, `src/desktop.ts`, `src/doctor.ts` (new),
`install.sh` (new), `packaging/` (new), `docs/`.

If a task genuinely needs `server.ts`, stop and say so rather than editing it.

## House rules

- `npm test` and `npm run check` must pass before every commit. 63 tests currently.
- Add tests for anything you fix. Assert *inclusion*, not exclusive lists —
  two roster tests already broke because they pinned exact arrays.
- **Verify, don't assume.** Run the thing. Yesterday four real bugs were found only
  by using it: a stream crash, an env load-order race, a keyless-local-model check,
  and a `tool_use` with no `tool_result` that bricked every later turn.
- Never commit secrets. `.env` is gitignored; keep it that way.
- Config-driven over hardcoded — Chris tunes behaviour in `jarvis.config.json`.

---

## Task 1 — Make it run on macOS (biggest win)

JARVIS is Linux-only today and silently degrades elsewhere. This is the single
largest adoption blocker for an open-source release.

Platform-specific code lives in `src/desktop.ts` and `src/voice.ts`:

| Feature | Linux now | macOS needs |
|---|---|---|
| Screenshot | `gnome-screenshot`, `ffmpeg x11grab` | `screencapture -x` |
| Windows | `wmctrl -l` / `-a` | AppleScript via `osascript` |
| Keystrokes | `xdotool key` / `type` | `osascript` System Events |
| Clipboard | `xclip` | `pbcopy` / `pbpaste` |
| Volume | `pactl` | `osascript … output volume` |
| Voice | Piper → `paplay` | Piper → `afplay`, or the `say` command |
| Notify | `notify-send` | `osascript display notification` |

Detect with `process.platform` once, behind a small adapter, so a third platform
is a table entry rather than a rewrite. Every function must degrade to a clear
message when a tool is missing — never a silent no-op. That exact bug cost an hour
yesterday: Chrome on Linux reports zero speech-synthesis voices, so `speak()`
succeeded and produced nothing.

**Done when:** every desktop and voice tool either works on macOS or returns a
message naming what to install, and the Linux paths still pass their tests.

## Task 2 — `jarvis doctor`

New file `src/doctor.ts`, plus `"doctor": "tsx src/doctor.ts"` in package.json.

Diagnose a broken install and say how to fix it, one line per check:
Node ≥22 · `.env` present · which brains have keys · voice engine (Piper venv,
model file, player) · Ollama reachable on 11434 · screenshot tool · `xdotool` /
`wmctrl` / `xclip` / `pactl` · Chrome for the browser tools · port 3900 free ·
`data/history.json` well-formed JSON.

Exit non-zero if anything essential is missing. Every failure line must name the
fix (`sudo apt install xdotool`), never just report a problem.

## Task 3 — Install and autostart

`install.sh` at the repo root: check Node, `npm install`, create `.env` from the
example and prompt for a key, offer `./setup-voice.sh`, run `npm run doctor`,
then print how to start.

`packaging/jarvis.service` — a **`systemd --user`** unit so JARVIS survives a
closed terminal and starts at login. Document `systemctl --user enable --now jarvis`.
User service, not system: it needs the user's session for X11, audio and Chrome.

**Done when:** a clean clone reaches a running JARVIS with one command, and it
comes back after a reboot.

## Task 4 — First-run experience

Today an empty `.env` produces a warning and a dead assistant. Make the *terminal*
first run guide the user: detect no key, print exactly where to get one and which
line to add, and exit cleanly rather than starting a broken server.

Keep this in the boot path and `doctor` — **not** in `server.ts` request handling.

## Task 5 — Cost visibility

`src/brain.ts` knows which brain ran; nothing tracks spend. Add per-turn token
and cost accounting with a per-model price table in config, exposed as a function
other modules can read. **Do not wire it into the HUD** — Claude will do that
when the auth work lands. Ship the accounting and a test; leave the display.

## Task 6 — CONTRIBUTING.md

Short and real: repo layout, `npm test` / `npm run check`, the safety invariants a
contributor must not break (the hard denylist floor cannot be weakened by config;
untrusted content stays fenced; agent-written files are data, never instructions;
state-changing tools stay approval-gated), and how to add a tool or a skill.

---

## Order

1, 2, 3 are the release blockers for open-sourcing — do those first.
4, 5, 6 after. Commit each separately with a message explaining *why*, not just what.
