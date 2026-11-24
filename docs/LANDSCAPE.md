# Field map — Cunning Claw-class systems

Last survey: **24 November 2026** (first: 24 August; previous: 29 September). This is a living brief for the Dragon Forge CUNNING CLAW, not a Wikipedia of every GitHub repo named Cunning Claw.

There are hundreds of student butler-assistant clones (the Iron-Man-inspired kind). Almost none of them are assistants. The field that actually matters in 2026 is small:

| System | Role | What we take | What we refuse |
| --- | --- | --- | --- |
| **OpenClaw** | Always-on daemon in your chats; by September the giant of the field, with dozens of channels, phone apps and a marketplace | `SOUL.md` / `HEARTBEAT.md` / skills folders; quiet heartbeat; named brains with a cheap heartbeat model and a fallback chain | Internet-exposed gateways, plugin sprawl, token furnaces, sub-agent org charts. We do not chase its reach; we win on trust |
| **Hermes Agent** (Nous) | Self-improving runtime | `agentskills.io` SKILL.md, skills from experience, MEMORY/USER files; skills that improve with use, taken 29 Sept as approved per-machine skill lessons | Framework-not-product. No HUD, no machine soul. Silent rewrites of instructions |
| **Open Interpreter** | Supervised local code | Approval before shell | Not persistent. Not this |
| **Stanford OpenClaw** | On-device research stack | Local-first, cost as a metric | Research scaffolding |
| **Community daemon + sidecar projects** | Daemon + sidecars | Always-on, authority gates | Multi-agent org charts too early |
| **Community HUD skins on Hermes** | HUD skin on Hermes | The world wants the arc reactor | We will not be a skin |
| **Goose** (Agentic AI Foundation) | Desktop agent and CLI, neutral governance | Linux desktop app, MCP as the extension standard, many providers | A worker you point at jobs, not an assistant that keeps the house |
| **Leon** | Privacy-first personal assistant | The privacy instinct | Endless rewrites before the loop works |
| **AnythingLLM** | Local agents and document chat | Local unless you choose a cloud model | Document chat is not hands on the machine |
| **Self-Operating Computer** | A model driving the screen (2023) | Early proof of full computer use | Pixels first; refs and real tools beat guessed coordinates |
| **Jan / LocalAI** | Local models | BYO brain later | Chat UIs and inference servers |
| **Python butler-assistant toys** | Cultural memory | Voice, presence, the name | Wikipedia-and-weather demos |
| **Earlier internal prototypes** | Our own lineage | Local-first, Welsh doctrine, allowlisted HTTP | Do not dissolve the butler into the distro |

## What changed, 29 September to 24 November 2026

- **OpenClaw turned one** (first commit November 2025) and is bigger than ever: about 395K GitHub stars, a foundation since February, an enterprise edition since 29 September, and a release every day or two. Third-party guides still describe its defaults as commands without approval and the sandbox off. Safety remains a hardening guide for the owner to follow: our ground has not moved.
- **Hermes Agent became a product**, not just a kit: Hermes Desktop in the Microsoft Store, Teams, an Azure enterprise edition (18 Nov), a hosted cloud agent on every paid plan (27 Oct), and a guided first-run chat on a free model (v0.22, 13 Oct). The "framework, not product" line above is now out of date for it.
- **New local-first neighbours:** Linger (Simplex AI, open-sourced 19 Nov: local Qwen models, memory on the device, unsigned macOS build, like ours) and QwenPaw (AgentScope, v2.3.0 on 11 Nov). Neither has been run here yet.
- **The big companies now drive the screen:** Anthropic (computer use beta for Team and Enterprise, 20 Nov), Google (Gemini desktop on macOS, paid), OpenAI (ChatGPT desktop). An assistant that acts is now expected, which helps the pitch and raises the bar.
- **Prompt injection is no longer theoretical.** Reported this autumn: a single encoded email taking over a Manus session holding the user's Gmail token (Salt Labs, October), and phishing emails carrying hidden instructions aimed at the recipient's AI assistant (Barracuda, October). This is film 1's attack, in the wild. Check the primary disclosures before quoting either on the site.

## Reviews, distilled

OpenClaw reviews in 2026 say the same three things: the *paradigm* (an agent that texts you first) is real; the *bill* is shocking if every thought is Opus; the *memory* still forgets; the *security* is only as good as the operator. Hermes is praised as the learning loop and criticised as a kit, not a companion. Open Interpreter is loved for “do this on my machine now” and abandoned the moment you close the terminal.

**CUNNING CLAW wins by being the thing those reviews still want:** a presence on the glass, a denylist that config cannot weaken, untrusted-web fencing, approval cards you actually read (HUD and Telegram), a heartbeat that stays quiet, a brain you can make cheap, and skills that are files you can open-source.

## Doctrine

1. One operator. One machine. 127.0.0.1.
2. Workspace files are the soul — editable markdown, not a hidden database.
3. Skills are [agentskills.io](https://agentskills.io) folders. Portable the day we go public.
4. Heartbeat may act. Heartbeat must also be allowed to say `HEARTBEAT_OK` and vanish.
5. Track the field in `docs/landscape.json`. Do not pretend we indexed the entire internet.

Machine-readable copy: [`landscape.json`](./landscape.json).
