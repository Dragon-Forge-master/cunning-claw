# Field map — Cunning Claw-class systems

Last survey: **29 September 2026** (first: 24 August). This is a living brief for the Dragon Forge CUNNING CLAW, not a Wikipedia of every GitHub repo named Cunning Claw.

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
