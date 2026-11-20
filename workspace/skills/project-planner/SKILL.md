---
name: project-planner
label: Project plan
category: projects
description: Turn a goal into a working project plan on the Desk — scope, milestones, tasks with owners and dates, dependencies, risks, budget — with optional check-ins as standing orders and an optional sync to Linear, Asana, Notion, ClickUp or monday.com after approval. Use for "plan this project", "break this down", a launch, a build, a bid timetable.
author: cunningclaw
written: 2026-11-20
---

# Project planner

A plan is useful when someone can open it on a Tuesday and know what to do
next. Keep it one document, on the Desk, in plain markdown.

## 1. Pin the scope

Ask, at most, what changes the plan: **the outcome** (what is true when it
is done), **the deadline and why it is fixed**, **who is available** and
for how much of their week, **budget**, and **what is out of scope**. Write
the answers as the plan's first section. Names of people are the ones the
operator gives you — never placeholders dressed as people.

## 2. Build the plan

`write_file` `~/Documents/CunningClaw/<Project> - plan.md`:

1. **Outcome and scope** — in / out, assumptions, constraints.
2. **Milestones** — 3–7, each a checkable state ("Pilot running with 3
   users"), with a date.
3. **Tasks** — a table:

   | # | Task | Owner | Start | Due | Depends on | Status |
   |---|---|---|---|---|---|---|

   Tasks small enough to finish in a week. Dates are real calendar dates
   (today's date is in your system prompt); skip weekends and the bank
   holidays the operator names. Work out dates with `run_command`
   (`date -d`), not by counting in your head.
4. **Dependencies and critical path** — which chain sets the end date; say
   what slips if a named task slips.
5. **Risks** — likelihood, impact, mitigation, owner.
6. **Budget** — lines with assumptions, from the operator's numbers;
   `[NEEDED: …]` where you have none. Sum with `run_command`.
7. **Next three actions** — this week, with owners.

Use `todo` for your own working list while you draft; the plan file is the
operator's.

## 3. Deliver

- `export_pdf` with the plan's Desk name for a PDF to share
  (`page_break_h1` is rarely needed for a plan).
- Tell the operator: end date, the critical path in one line, the biggest
  risk.

## 4. Check-ins (optional, ask first)

Offer a weekly check-in as a standing order in `workspace/SCHEDULE.md`
(the `schedule-keeper` format), for example:

```
- [x] schedule: `09:10:mon` | target: `<Project> check-in` | instruction: `Read ~/Documents/CunningClaw/<Project> - plan.md. List tasks due this week and anything overdue, in five lines. Do not change the plan.`
```

Writing a new armed order raises a card — that is intended. The check-in
reads and reports; changing the plan waits for the operator.

## 5. Sync to a work tool (optional, approval first)

If the operator uses **Linear, Asana, Notion, ClickUp or monday.com**:

1. `mcp_status` — is it connected? If not, `connector_guide` with its name
   gives the real sign-in steps; do not recite them from memory.
2. `mcp_schema` for the create tools you will use; never guess argument
   names.
3. **Before creating anything**, show the operator the exact list — which
   workspace/team/board, every project, milestone and task title, owner and
   due date — and wait for a yes. Creating dozens of items in someone's
   team tool is a consequence; a correction afterwards is a chore for
   everyone in it.
4. Create in small batches; record each created item's link in the plan
   file. If a call fails half-way, say exactly which items exist and which
   do not — do not retry blindly and make duplicates.
5. The Desk plan stays the source you edit; say so, or agree with the
   operator that the tool is now the source and stop editing the file.

## Honest limits

- A plan is an estimate. Mark guesses as guesses; say which dates are
  fixed by the outside world and which are yours.
- You do not know team members' calendars unless the operator shares them.
- You cannot assign work in a tool to someone who is not a member of it.
