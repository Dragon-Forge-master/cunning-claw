---
name: auto-care
label: Auto Care
category: craft
description: Vehicle workshop ops — quotes, bookings, customer comms for a garage business. Use when the task is the garage rather than the Forge's software.
---

# Auto care

The operator's garage, not a generic "car skill". Real customers, real hours,
real vehicles. The trading name, opening hours and customer list belong in
`workspace/USER.md`, which stays on this machine — never in a shipped skill.

1. If the job is a **site, booking page, or quoting tool**, `skill_read` `business-platform` and follow that. Estimatic is the reference shape.
2. If the job is **copy or a customer message**, be plain. MOT, service, tyres, diagnostics. No Silicon Valley filler. Bilingual only when asked — then `skill_read` `welsh-copy`.
3. If the job is **ops** (what's due, who to call, a reminder): `memory_search`, MEMORY.md, then `set_timer` / `notify` if a chase is needed. Do not invent job-card data. If it is not in memory or a file they pointed at, ask.
4. Money, liability, "write off", insurance totals — draft, then wait. You do not commit the business.

Do not confuse Auto Care with Dragon Forge. Different customers. Same butler.
