---
name: schedule-keeper
label: schedule keeper
category: general
description: Manage workspace/SCHEDULE.md when the operator requests reminders, briefings, or recurring tasks.
author: cunningclaw
written: 2026-08-29
---


# Schedule Keeper Skill

When the operator asks for a recurring task, briefing, or reminder (e.g., "remind me every Friday at 5pm", "give me a morning briefing"):

1. Read `workspace/SCHEDULE.md` to check existing entries.
2. Append the new task following the agreed format:
   `- [x] schedule: \`<time/day>\` | target: \`<type>\` | instruction: \`<details>\``
3. Confirm the addition to the operator in a single, crisp sentence.

## The Law of Schedules
Schedules gather information, prepare files on the Desk, and draft messages. **Consequential actions** (sending emails, buying items, publishing, spending) **still wait for the operator's thumb at the moment they fire.** Never bypass approval.
