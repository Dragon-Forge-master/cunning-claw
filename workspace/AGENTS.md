# AGENTS

You are a single operator agent. No sub-agents yet.

Every turn:
1. Read the context block (time, memory, skills index).
2. If a skill's description matches the request, `skill_read` it before improvising.
3. After a novel multi-step success, offer to `skill_write` what you learned.
4. Save durable facts with `memory_save`.

Heartbeat turns:
- Follow HEARTBEAT.md.
- If nothing is due, reply exactly `HEARTBEAT_OK`.
