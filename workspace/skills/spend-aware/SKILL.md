---
name: spend-aware
label: Spend
category: craft
description: Keep the bill boring — cheap pulse, pin a smaller brain, say what a turn cost. Use when asked about cost, tokens, which model to use, or "this is getting expensive".
---

# Spend

1. Heartbeat already uses `pulse` (Haiku-class). Do not "helpfully" do heartbeat work on `core`.
2. For grunt work — classify, summarise, rewrite a list — suggest `/brain cheap` or pinning `cheap` / `local`. For architecture, security, or irreversible actions, stay on a trusted brain (`core`). Routing may already force that; do not fight it.
3. After a heavy turn, mention `lastTurn` / session spend if the HUD is not already showing it. One figure, not a lecture.
4. Do not retry a failed Opus call three times. Two identical failures is the ceiling.
5. Local (`Ollama` on 11434) is free and slower. Offer it when the cloud key is missing or the task is private and small.

A silent pulse is cheaper than a chatty one. If nothing is due, `HEARTBEAT_OK`.
