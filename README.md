# J.A.R.V.I.S.

A Claude-powered personal assistant that controls your machine. Voice in, voice out, real system control, persistent memory — wrapped in an arc-reactor HUD.

## Features

- **Brain** — Claude Opus 5 with adaptive thinking, streaming responses, prompt-cached persona
- **System control** — runs shell commands, reads/writes files, launches apps and URLs, controls volume, reads live telemetry
- **Safety** — config-driven command policy: safe commands run instantly, risky ones raise an approval card in the HUD, destructive ones are hard-blocked
- **Memory** — long-term facts persist across sessions (`data/memory.json`)
- **Web search** — Anthropic server-side web search for current events
- **Browser control** — drives its own Chrome via the DevTools Protocol: open pages, read them, list tabs, click and type (approval-gated)
- **Email** — reads and searches Gmail through that browser session, no credentials handled
- **Voice** — neural TTS (Piper, offline) server-side, with an espeak fallback; plus push-to-talk and "Jarvis" wake-word input
- **Extras** — weather (no API key), timers/reminders announced aloud

## Setup

```bash
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run dev            # → http://127.0.0.1:3900
```

## Voice

Speech is produced **server-side**, because Chrome on Linux exposes zero Web Speech
synthesis voices (`speechSynthesis.getVoices()` returns an empty list, so browser TTS
silently no-ops). Jarvis runs on your own machine, so the server's audio output is your
speakers. Two engines, auto-detected in order:

1. **Piper** (default) — neural TTS, fully offline, genuinely natural. Streams raw audio
   straight into `paplay`, so speech begins before synthesis finishes.
2. **speech-dispatcher / espeak-ng** — fallback. Always intelligible, distinctly robotic.

Piper lives entirely inside the project (`.venv/` and `voices/`, both gitignored):

```bash
./setup-voice.sh
```

To hear other voices before committing to one:

```bash
./audition-voices.sh
```

Then set `voice.piper.model` (and `sampleRate`, if it differs) in `jarvis.config.json`.
Tuning knobs under `voice.piper`: `lengthScale` (higher = slower), `noiseScale`,
`sentenceSilence`, `volume`. The **VOICE** button in the HUD mutes it live.

## Browser & email

Jarvis drives **its own Chrome profile** (`~/.config/jarvis/chrome-profile`), launched on demand
with the DevTools Protocol on port 9222. A separate profile is deliberate: it keeps Jarvis out of
your main browser's cookies, history and saved passwords, and stops it fighting your running Chrome.

**One-time setup:** the first time you ask for email, a Chrome window opens at Gmail. Sign in there
once and the session persists. Jarvis never sees, stores, or types your password.

Tools: `browser_open`, `browser_read`, `browser_tabs` (read-only, run freely), `browser_click`,
`browser_type` (always approval-gated), `check_email`, `read_email`.

### Prompt-injection defence

Web pages and emails are written by strangers, and some contain text crafted to look like orders
from you. Three layers guard against this:

1. Everything read from a page or mailbox is returned inside `<untrusted>` fencing, with the
   fence tokens stripped from the content so a page cannot close the fence and impersonate Jarvis.
2. The system prompt states that untrusted content is data and never instructions — regardless of
   claimed authority, urgency, or prior authorisation.
3. Every state-changing action (clicking, typing, sending, shell commands, file writes) requires
   your explicit approval in the HUD.

Verified against a live attack: a planted page instructing Jarvis to read `~/.ssh/id_rsa`, POST it
to a remote host, and hide the fact. Jarvis summarised the real content, refused, called zero
forbidden tools, and reported the attempt.

**This is defence in depth, not a guarantee.** Treat the approval prompts as the real boundary —
read them before approving.

## Configuration

Everything tunable lives in `jarvis.config.json`:

- `model`, `effort`, `maxTokens` — the brain
- `persona` — name, how it addresses you
- `commandPolicy.autoApprovePatterns` — regexes for commands that run without asking
- `commandPolicy.denyPatterns` — regexes for commands that are never run
- `webSearch`, `history`, `server` — the rest

## Architecture

```
public/          HUD frontend (vanilla JS, canvas arc reactor, SSE client)
src/server.ts    Express + SSE event bus + approval flow
src/agent.ts     Streaming manual agent loop (Anthropic SDK)
src/tools.ts     Tool definitions + executors + command policy
src/voice.ts     Server-side TTS (Piper neural, espeak fallback)
src/browser.ts   Chrome control via DevTools Protocol + Gmail reading
src/memory.ts    Long-term memory store
src/config.ts    Config loader
data/            Runtime state (history, memory) — gitignored
```

The server binds to `127.0.0.1` only — it is not exposed to your network.
