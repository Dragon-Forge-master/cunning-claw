# From `git clone` to double-click: packaging Cunning Claw as an app

The PowerShell install is fine for developers and a wall for everyone else.
This is the plan for a consumer-grade download — and what it actually takes.

## What the app is

A **Tauri** shell (Rust-based, ~10MB, uses the OS webview) wrapping three things:

1. **The HUD** — already a web page; becomes the app window unchanged.
2. **The engine** — the Node/TypeScript server, compiled to a single
   self-contained binary with Node's **Single Executable Application** support
   (or `pkg`/Bun compile). No Node install, no `npm install`, no terminal.
   (Note: the engine is Node — there is no Python runtime in Cunning Claw and
   none needs bundling. Voice's optional Piper setup is the one Python-adjacent
   piece, and on Windows SAPI already covers it.)
3. **A first-run wizard** — the piece that kills two birds:
   - asks the new owner's **name** and **town** (fixing the shipped-config
     problem where every fresh claw greets its owner as "Chris" and reports
     Cardiff weather),
   - collects the **OpenRouter key** (or offers "fully offline" via a
     one-click Ollama model pull),
   - creates data folders, `.env` (mode 600), and the per-machine token.

Electron would also work but ships a whole Chromium (~150MB) we don't need —
the claw already drives its *own* Chrome for automation.

## The unavoidable frictions (be honest in the plan)

- **Code signing.** Unsigned installers get the scary SmartScreen wall.
  Windows: an OV/EV certificate (~£70–300/yr, EV kills SmartScreen fastest).
  macOS: Apple Developer ID (~£79/yr) + notarization. Budget line items, not
  engineering.
- **Auto-update.** Tauri's updater, fed from GitHub Releases. The current
  `npm run update` habit becomes "the app updates itself."
- **The service question.** The installer should offer "start at login"
  (registers the systemd --user unit on Linux, a login task on Windows,
  LaunchAgent on macOS) — the app is a butler, not a document you open.
- **External tool detection stays doctor's job** — the wizard runs the same
  checks and shows the same named fixes, in a window instead of a terminal.

## Order of work

1. Node SEA build of the engine (`npm run bundle`) — proves the single-binary
   engine on all three platforms; useful on its own for a "portable zip".
2. First-run wizard as a plain HUD page shown when `.env` is missing —
   valuable immediately, even before any app shell exists.
3. Tauri shell + tray icon + updater.
4. Signing certificates and release automation (GitHub Actions builds all
   three installers per tag).

Step 2 is the highest value-per-hour and needs no new technology at all.
