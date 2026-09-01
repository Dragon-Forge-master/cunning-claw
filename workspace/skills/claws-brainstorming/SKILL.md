---
name: claws-brainstorming
description: Systematic generation and expansion of Cunning Claw skills for local automation, Telegram integrations, media processing, and trade workflows.
---

# Cunning Claw Skill Expansion Framework

A structured methodology for brainstorming, designing, and authoring portable agent skills under `workspace/skills/`.

## Core Skill Categories
1. **Local System & Desktop Integration**: Window management, clipboard automation, process monitoring, hardware sensors.
2. **Communication & Messaging**: Telegram photo buffering, channel broadcasting, voice note transcription.
3. **Trades & Business Workflow**: Invoice processing, estimating, colour matching notes, client correspondence.
4. **Cloud & Infrastructure**: Cloudflare workers/KV management, API connectors, secure credential bridging.

## Authoring Protocol
- Keep instructions modular, reproducible, and self-contained.
- Follow agentskills.io frontmatter standards (`name`, `description`).
- Document gotchas, security boundaries (never auto-send or auto-spend), and exact tool pairings.
