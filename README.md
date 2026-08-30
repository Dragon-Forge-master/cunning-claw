<div align="center">

<img src="docs/assets/banner.svg" alt="CUNNING CLAW" width="100%">

**Y dyn hysbys — the knowing one.**

A personal AI assistant that runs on your machine and actually operates it.
Sees your screen. Runs your shell. Reads your inbox. Speaks back.
And refuses when a web page tells it to do something you didn't ask for.

<br>

![status](https://img.shields.io/badge/status-alpha-f5a623?style=for-the-badge)
![node](https://img.shields.io/badge/node-22%2B-3c873a?style=for-the-badge&logo=node.js&logoColor=white)
![typescript](https://img.shields.io/badge/typescript-strict-3178c6?style=for-the-badge&logo=typescript&logoColor=white)
![tests](https://img.shields.io/badge/tests-251%20passing-35d6ed?style=for-the-badge)
![offline](https://img.shields.io/badge/runs-offline%20capable-8b5cf6?style=for-the-badge)
![platforms](https://img.shields.io/badge/linux%20·%20macOS-supported-35d6ed?style=for-the-badge)
![windows](https://img.shields.io/badge/windows-beta-ffb454?style=for-the-badge)

<sub>Built in Cardiff by <b>Dragon Forge AI</b> · Local-first when privacy matters · Human approval when consequences matter</sub>

</div>

---

## The name

*Cunning folk* is an occupational term, not a flourish. In Wales they were the
**dynion hysbys** — "the knowing ones", singular *dyn hysbys*, literally *the knowing man*.
They worked in villages across Wales into the twentieth century.

They were **tradespeople, not mystics**. You did not visit a *dyn hysbys* for enlightenment;
you brought him a job. Find who took the horse. Read the weather before the sailing. Treat
the child. He worked, you paid.

That is the posture here. Not a companion, not a personality to be enjoyed for its own sake
— **a practitioner you bring a job to.**

The best known were **John Harries and his son Henry of Cwrt-y-Cadno, Carmarthenshire** —
ninety minutes from where this was built. Harries kept the major medical texts of his day
beside Latin and Greek, and practised as physician and astrologer both. His working papers
survive at the National Library of Wales: prescriptions, payment records, horoscopes worked
up on request, correspondence, lecture notes.

A practitioner keeping a record of the work and the reasoning behind each judgement. That is
a case file — and it is a closer description of this software's memory, journal and skills
than the name it used to carry.

*Cunning* cuts both ways, too. A cunning man's trade included telling a client when they
were being had. Which is exactly what this does when a web page tries to give it orders.

→ [`docs/NAME.md`](docs/NAME.md) for the history and sources.

---

## Install

One command from a clean clone:

```bash
git clone https://github.com/Dragon-Forge-master/cunning-claw.git
cd cunning-claw
./install.sh
```

That checks Node 22+, runs `npm install`, creates `.env` from the example, asks for an OpenRouter key, offers the offline voice, runs `npm run doctor`, and prints how to start.

Then `npm run dev` and open **http://127.0.0.1:3900**. It binds to loopback only — nothing is exposed to your network.

### Windows (native)

Install [Node 22+](https://nodejs.org) and [Git](https://git-scm.com/download/win), then in PowerShell:

```powershell
git clone https://github.com/Dragon-Forge-master/cunning-claw.git
cd cunning-claw
powershell -ExecutionPolicy Bypass -File .\install.ps1
npm run dev
```

`install.ps1` mirrors `install.sh`: Node check, `npm install`, `.env` with a no-echo key
prompt, workspace seeding, `npm run doctor`. No Piper voice on Windows yet — he types.

Windows is the youngest platform: coded and doctor-checked, but the least field-tested —
that is why the badge says beta. If you want the full Linux experience on a Windows
machine (voice included), install under **WSL2** instead and follow the Linux steps.

### Autostart (Linux)

CUNNING CLAW is meant to survive a closed terminal. `install.sh` can drop a **systemd --user** unit (not a system unit — it needs your session for X11, audio and Chrome):

```bash
systemctl --user enable --now cunningclaw
loginctl enable-linger $USER    # still running after logout
```

The template lives at `packaging/cunningclaw.service`. macOS: keep `npm run dev` in a Terminal at login, or a LaunchAgent if you add one later.

### By hand

```bash
npm install
cp .env.example .env        # add your OPENROUTER_API_KEY
./setup-voice.sh            # neural voice, ~60MB, fully offline
npm run doctor
npm run dev
```

Runs on **Linux** (`xdotool`, `wmctrl`, `pactl`, `paplay`), **macOS** (`screencapture`, `osascript`, `pbcopy`, `afplay`/`say`) and **Windows** (PowerShell — nothing to install). Missing tools return a message naming what to install, never a silent no-op. See the platform table below.

```

                                                                       ▄▀  ▄▄   
                                                                    ▄▄▀   ▄███  
   ▄███▄ ▄█   █▄ █▄  ▄█ ██   █ ▄█ ██   █  ▄███▄                  ▄▄█▀    ████▀  
   ██▀██ ██   ██ ██  ██ ██   █ ██ ██▄  █  ██▀██▄          ▄▄█▀█████▀     ███    
  ██   █ ██   ██ ██▄ ██ ███  █ ██ ███  █ ▄█   ██         ██▀██▀▄█▀▀ ▄▄▄  █▄     
  ██     ██   ██ ███ ██ ███  █ ██ ███  █ ██             █ █▀▀▄██▀▄▄▀▀▀▀▀  ▀▀    
  ██     ██   ██ █▀█ ██ █▀█▄ █ ██ ████ █ ██  ▄▄▄  ▄▄▄▄▄▄██▄███ ██▀▄█████████████
  ██     ██   ██ █ ████ █ ▀█ █ ██ ██▀█ █ ██  ███   █████▄ ████▄▀▄███████████▀▀▀ 
  ██   ▄ ██   ██ █ ▀███ █▄ ███ ██ ██ ███ ██  ▀▀█     ▀███████▄▀▀████████▀▄▄█▀   
  ██   █▀ █   █▀ █  ███ ██ ███ ██ ██ ███ ▀█   ▄█           ▀▀███████▀██▄▀███    
   ██▄██  ██▄██  █  ███ ██  ██ ██ ██  ██  ██▄███              ████████▀▀▀▀      
   ▀███▀  ▀███▀  █   ██ █▀  ██ ██ ██  ██  ▀███▀              ▄█████████▄        
                                                          ▄▄█████████████▄▄     
                                                          █████▀▀   ▀▀█████     

  ──────────────────────────────────────────────────────────────
  CUNNING CLAW  ·  y dyn hysbys  ·  v0.2.0
  Yn lleol yn gyntaf · Caniatâd dynol pan fo canlyniadau
  (local first · human consent where there are consequences)

  ▸ ar-lein  http://127.0.0.1:3900   the glass is lit
  ▸ brain    flash · google/gemini-3.5-flash-lite (openrouter)
  ▸ llais    piper · en_GB-alan-medium   (the voice)
  ▸ curiad   every 30m   (the heartbeat)
  ▸ offer    64 tools on the bench

  ▸ wards    y ffens   — outside words are fenced
             y llw     — consequences wait for you
             y sarff   — the serpent watches the loop

  “Dyfal donc a dyr y garreg.”
    — Steady tapping breaks the stone.  · arysgrif y dydd

  At your service, sir.
```

<div align="center">
<br>
<!-- SCREENSHOT: the HUD at rest — arc reactor, telemetry panel, empty transcript -->
<sub>The HUD: arc reactor, live telemetry, transcript, approval cards.</sub>
</div>

---

## What it does

| | |
|---|---|
| **Sees** | Screenshots the desktop, and can *glance* at the room through a webcam or a Home Assistant camera — mood is a hypothesis, never a reason to act |
| **Operates** | Shell, files, apps, volume, media, clipboard, notifications, window focus, keystrokes |
| **Browses** | Owns a Chrome profile over CDP — accessibility refs, real mouse/keys, snapshot after every action, Gmail, WhatsApp Web |
| **Reads mail** | Gmail through that Chrome session — search operators, category tabs, whole threads, drafts. Send is always an approval. No credentials handled |
| **WhatsApp** | WhatsApp Web / Business in the same Chrome — chat list, title unread count, draft, send. Send is always an approval. QR is scanned in that window |
| **Accounts** | Jurisdiction packs (UK first; IE, US, AU, DE as stubs) plus Xero via the official local MCP. It will not invent a foreign tax rate or file a return |
| **Speaks** | Neural TTS (Piper), offline. Push-to-talk and a "Claw" wake word |
| **Remembers** | Markdown memory and a dated journal that survive restarts |
| **Watches** | A 30-minute heartbeat that stays silent when there's nothing worth saying |
| **Reaches you** | Telegram, so it isn't trapped at your desk |
| **Extends** | Skills as `SKILL.md` files ([agentskills.io](https://agentskills.io)). Click **SKILLS** on the HUD to arm them, the same idea as Claude’s capabilities list |

<div align="center">
<br>
<!-- SCREENSHOT: a turn using tools — tool chips, then a reply -->
<sub>Tool calls stream into the transcript as they happen.</sub>
</div>

---

## Platforms

| | Linux | macOS | Windows |
|---|---|---|---|
| Shell, files, browser, email, HTTP, MCP | ✅ | ✅ | ✅ |
| Screenshots | `gnome-screenshot` / `ffmpeg` | `screencapture` | PowerShell + System.Drawing |
| Webcam glance | `ffmpeg` + `/dev/video0` | `ffmpeg` + avfoundation | not wired yet |
| Windows, keystrokes | `wmctrl`, `xdotool` | `osascript` | PowerShell SendKeys |
| Clipboard | `xclip` | `pbcopy` | `Get-/Set-Clipboard` |
| Notifications | `notify-send` | `osascript` | balloon tip |
| Voice | Piper → `paplay`, or espeak | Piper → `afplay`, or `say` | Piper → PowerShell, or Windows SAPI |
| Volume | `pactl` | `osascript` | media keys (no absolute level) |

Windows needs nothing installed for the desktop tools — PowerShell ships with the OS.
Each platform's paths live in `src/platform.ts`, `src/windows.ts` and `src/desktop.ts`;
a missing tool always produces a message naming the fix, never a silent no-op.

**Butler eyes.** `look` takes one still from the desk webcam, or from a Home
Assistant `camera.*` entity. It is on in `claw.config.json` (`eyes.enabled`,
device `/dev/video0` on Linux). Mood is a hypothesis, never a diagnosis and
never a reason to act without asking. Not a live stream. Not a heartbeat.
Frames are not kept.

Honesty about maturity: **Linux** is where CUNNING CLAW lives every day. **macOS** and
**Windows** are coded and doctor-checked but far younger — expect rough edges, and please
report what you find. Native install on Windows is `install.ps1` (see Install above).

> **Honesty about testing:** Linux is exercised daily. macOS and Windows are written
> against the documented APIs with their pure logic unit-tested, but neither has been run
> on real hardware yet. If you try one, please open an issue with what broke.

## Run it offline

Every brain is swappable. Point one at a local runtime and nothing leaves the machine —
no API key, no account, no network.

```bash
ollama pull llama3.2
```

```jsonc
// claw.config.json — this brain ships already configured
{ "id": "local", "provider": "openai", "model": "llama3.2:latest",
  "baseUrl": "http://localhost:11434/v1" }
```

Then `/brain local` in the HUD. Ollama, llama.cpp, LM Studio and vLLM all serve the same
API; loopback and private-range hosts skip the key check entirely.

> **One caveat, stated plainly.** Resisting a prompt injection is model *behaviour*, not a
> code guarantee, and small models are measurably worse at it. So turns that can see
> untrusted content are forced onto a trusted brain — see below. Offline is for privacy and
> cost, not for handing your inbox to a 7B model.

---

## MCP

Cunning Claw speaks the same `mcpServers` files Claude Code and Cursor use, over the
same transports: **stdio** (a local subprocess) and **Streamable HTTP** (a remote URL,
with `Mcp-Session-Id` and `MCP-Protocol-Version: 2025-03-26`). That is how Canva, Slack, HubSpot, Notion, Figma, and the rest of the hosted
catalogue work — not a one-shot POST.

The HUD **CONNECT** button is the directory: Popular cards, category chips
(Create, Code, Work, Docs, Chat, Money, Data, Ship, Search, Sales, Automate,
Meetings, AI), All / Connected / Not connected, search, and Reconnect when a
server needs sign-in. Seeing a name in the list does **not** connect it.
Connect writes `~/.config/cunningclaw/mcp.json`. You can still paste a Claude
snippet under ADD, or keep servers in the files below.

Put servers in any of these (first id wins):

1. `claw.config.json` → `mcp.servers`
2. `~/.config/cunningclaw/mcp.json` (the one to copy snippets into)
3. `<this install>/.mcp.json`
4. `~/.claude.json` (Claude Code user-scope, plus a matching project block)
5. `~/.cursor/mcp.json`

Canva is a hosted server. Nothing to install. Copy `docs/mcp.example.json` to
`~/.config/cunningclaw/mcp.json`, restart, then in the HUD: *connect Canva*.
`mcp_login` opens the **system** browser for OAuth (PKCE + dynamic registration)
and listens on `127.0.0.1`. Sign-in is never started at boot — systemd has no
browser. After that, tools show up as `mcp__canva__…`.

If Canva (or another vendor) only allowlists Claude/ChatGPT as OAuth clients,
use the stdio bridge instead (`docs/mcp.canva-remote.example.json`). Same tools,
local `mcp-remote` process, its own browser dance.

```jsonc
{
  "mcpServers": {
    "canva": { "type": "http", "url": "https://mcp.canva.com/mcp" }
  }
}
```

The older `claw.config.json` array still works:

```jsonc
"mcp": {
  "enabled": true,
  "servers": [
    { "id": "github", "transport": "stdio",
      "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } }
  ]
}
```

`${VAR}` and `${VAR:-default}` expand in command, args, env, url, and headers.

Tools arrive namespaced (`mcp__github__create_issue`) so a server cannot shadow a built-in.
Those tools, **with their JSON Schemas**, are sent to every brain — Anthropic and the
OpenAI-compatible ones (Gemini Flash/Pro, nano, local Ollama). `mcp_status` lists each
tool and its required arguments; `mcp_schema` returns the full input schema so the
assistant does not have to guess `prompt` vs `input.prompt`. Call results come back as
JSON (`ok`, `text`, `json`, `structured`, `resources`) inside `<untrusted>`. Flattened
arguments are repaired to the schema before the server sees them.

The client is hand-rolled — MCP is JSON-RPC, and the official SDK brings ten dependencies
into a project that has two.

**Connecting to a server is a trust decision, so servers come from config only, never
discovery.** A stdio server is a subprocess you spawn — that is arbitrary code execution.
Three consequences are handled for you: tool *descriptions* are written by the server and
reach the system prompt, so they are sanitised and length-capped; tool *results* are
attacker-controlled and come back `<untrusted>`-fenced; and any MCP call taints the turn,
so it can never be handled by a cheap brain. Writes are approval-gated unless you list them
as read-only. Ask `mcp_status` any time.

## Authentication

Binding to loopback keeps CUNNING CLAW off your network. It does **not** keep it away from your
machine — any process running as you could otherwise POST to `/api/chat` and get a shell,
a file write, or your inbox. Loopback is not a permission boundary.

A token is generated on first run and written to `.env` (mode 600). Three checks, because
no single one covers every caller:

- **Bearer token** for scripts: `Authorization: Bearer $CLAW_TOKEN`
- **A session cookie** (`HttpOnly`, `SameSite=Strict`) issued when you load the HUD —
  `EventSource` cannot set headers, so the event stream has no other way to authenticate
- **An Origin check** on state-changing requests, so a page you happen to be visiting
  cannot ride that cookie

```bash
curl -H "Authorization: Bearer $CLAW_TOKEN" http://127.0.0.1:3900/api/status
```

Opening `http://127.0.0.1:3900` in a browser needs nothing — the cookie is issued on load.

## Safety

Most assistants in this category will run whatever the model emits. This one is built on the
assumption that the model will eventually be lied to.

**Enforced in code — holds on any model, cannot be weakened by config:**

- A **hard denylist floor**. `rm -rf`, `mkfs`, `dd` to a block device, fork bombs, `curl | sh`,
  reads of `/etc/shadow`. Config can add to it, never subtract.
- **Approval gates** on everything that changes the world — shell, file writes, clicks,
  keystrokes, purchases, device control.
- A **host allowlist** for HTTP. Blocked hosts are reported, never silently dropped.
- **Credential redaction** on every disk write and every event, so a pasted key never lands
  in the transcript.
- An **Ouroboros guard** that blocks a tool call repeated identically within a turn.

**Enforced by design:**

- Everything read from the web or your inbox is **fenced as untrusted data**, with fence
  tokens stripped so a page can't close the fence and impersonate you.
- **Agent-written files are separated from human-written ones.** A note CUNNING CLAW recorded is a
  recollection, never an instruction — so a poisoned memory can't become a standing order.
- **Memory carries provenance.** A fact saved while untrusted content sat in the context
  window is stamped `UNVERIFIED` forever — testimony, not ground truth.
- **Identity files are locked.** Writes to `SOUL.md`, `IDENTITY.md`, and `HEARTBEAT.md`
  always raise an approval card, even mid-task — a persuasive page cannot talk the claw
  into rewriting its own guardrails.
- An **epistemic firewall** in the soul: what another AI or a webpage says is testimony
  under attribution, never fact; no borrowed personas, sigils, or mythic registers. Learned
  the hard way, from a live session with a very eloquent wizard.
- Turns that can see hostile text are **pinned to a trusted brain**, and taint is *sticky*:
  an email read three turns ago is still in the context window now.

Tested against a live attack — a page instructing it to read `~/.ssh/id_rsa`, POST it to a
remote host, and hide the fact. It summarised the real content, refused, called zero
forbidden tools, and reported the attempt.

<div align="center">
<br>
<!-- SCREENSHOT: an approval card mid-flight -->
<sub>The approval card is the real security boundary. Read it before you click.</sub>
</div>

> **This is defence in depth, not a guarantee.** It runs shell commands on your machine.
> Treat the approval prompts as the boundary they are.

---

## Y Swyn — it speaks Welsh, and every riddle checks out

The claw carries a liturgy. Boot it and the terminal greets you like a grimoire opening:

```
  CUNNING CLAW  ·  y dyn hysbys  ·  v0.2.0
  Yn lleol yn gyntaf · Caniatâd dynol pan fo canlyniadau
  (local first · human consent where there are consequences)

  ▸ wards    y ffens   — outside words are fenced
             y llw     — consequences wait for you
             y sarff   — the serpent watches the loop

  “Dyfal donc a dyr y garreg.”
    — Steady tapping breaks the stone.  · arysgrif y dydd
```

None of it is decoration. Each ward names a real subsystem — the untrusted-content fence,
the approval gate, the loop guard — and the banner is forbidden from printing a ward that
isn't running. The *arysgrif y dydd* is a genuine Welsh proverb, rotated daily. The
scheduler takes Welsh day names as first-class syntax (`08:00:llun-gwe` parses and fires),
and annual dates for birthdays. Every term is documented in [docs/SWYN.md](docs/SWYN.md):
magic to the hurried, a glossary to the curious — the intended ratio.

Wales gave the world the equals sign, packet switching, and the fuel cell. It can have
this too.

---

## How it's built

```
public/          HUD — vanilla JS, canvas arc reactor, SSE client
src/agent.ts     Streaming agent loop, Ouroboros guard
src/brain.ts     Brain catalogue, failover, /brain pinning
src/routing.ts   Trusted-brain guard, sticky taint
src/tools.ts     tool schemas, dispatcher, HARD_DENY
src/browser.ts   persistent CDP, accessibility refs, Gmail, WhatsApp Web
src/gmail.ts     search operators, list/thread scrapers, draft/send helpers
src/doctor.ts    `npm run doctor` — one line per check, every failure names the fix
packaging/       systemd --user unit (session, not system)
install.sh       clean-clone setup (Linux / macOS)
install.ps1      clean-clone setup (Windows, native)
src/desktop.ts   Screen capture, windows, input, clipboard, volume
src/voice.ts     Piper neural TTS, espeak / macOS `say` fallback
src/redact.ts    Credential redaction
src/workspace.ts SOUL.md / USER.md / MEMORY.md / skills
```

**~13,900 lines of TypeScript, two runtime dependencies.** Most of what it does comes from composing things
your machine already has — `xdotool` / `osascript`, `wmctrl` / System Events, `pactl` /
`afplay`, Chrome's debug protocol — rather
than dragging in frameworks.

```bash
npm test        # 251 tests
npm run check   # tsc --noEmit
```

**Part of it wrote itself.** The fail-open git review tooling in
[`tools/gitreview/`](tools/gitreview/ARCHITECTURE.md) — deterministic gates that may block,
a local model that only ever advises — was designed and written by Cunning Claw, then
reviewed, corrected, and merged by Claude Code. Several commits in the log are co-authored
by the software they change. The workshop reviews everything, including its own apprentice.

Want to change it? [CONTRIBUTING.md](CONTRIBUTING.md) is the contract: denylist floor, fences, approval, and how to add a tool or a skill.

---

## Where it sits

**OpenClaw** is a gateway — it reaches you anywhere, owns no machine.
**Hermes** is a framework — a kit you assemble.
**Open Interpreter** dies when you close the terminal.

This one owns the glass *and* the hands: it lives on your desk, sees your screen, and has a
threat model. `docs/LANDSCAPE.md` tracks the field and is meant to be edited as it moves.

---

<div align="center">
<sub>

**Dragon Forge AI** · Cardiff, Wales 🏴󠁧󠁢󠁷󠁬󠁳󠁿
*Local-first when privacy matters · Edge-first when scale matters · Human approval when consequences matter*

</sub></div>