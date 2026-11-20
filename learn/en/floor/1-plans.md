---
id: floor.plans
module: floor
order: 1
title: One plan instead of ten cards
minutes: 10
outcomes: O4
benchmark: 5
fluency: Delegation, Diligence
cy: needs-author
claims:
  - tool = plan
  - planExpiryMinutes = 30
  - planRefuses = run_command :: rm -rf ~
  - planRefuses = write_file :: workspace/SCHEDULE.md
  - planRefuses = edit_file :: workspace/SOUL.md
  - planAsksUnderAlarm = send_email
  - runsFree = mkdir -p "~/Documents/CunningClaw/Quotes 2027"
---

## why
A job with ten steps could mean ten cards. Clicking card after card is how the one that matters gets clicked on reflex. A plan moves your reading earlier: one card, the whole job, while you are calm.

## ask cold
confidence: yes
You approve a plan with five steps. Then the claw wants to do a sixth thing that was not on the list. What happens?
answer: ask, asks, card, approval, approve, not covered, check
pass: 1
hint: A plan covers what is written on it. What about everything else?
reveal: The sixth thing raises its own card. A plan covers only the exact steps it lists.

## example
A plan card lists every step exactly: the command, the path, the recipient. Each step is matched exactly — "git status" on the plan never comes to mean anything longer. Anything not on the list still asks. A plan lasts thirty minutes.

Some things no plan can ever cover: a command on the floor, the files that define who the claw is (SOUL.md and its kin), standing orders in SCHEDULE.md, and claw.config.json. And if the claw reads text that tries to give orders, the plan stops covering sends and other irreversible steps for the rest of that turn.

## real
Ask your claw for a real job of three or more steps that each change something, and ask it to use a plan. For example: "make a folder on the Desk called Quotes 2027 and move my quote documents into it, using a plan".

Read the plan card before you approve it: is every step something you asked for? Press Done when the job is finished.

## recall never
confidence: yes
multi: yes
Which of these can a plan never pre-approve? Choose all that apply.
- [x] Arming a standing order in SCHEDULE.md
- [x] A command on the floor, such as rm -rf
- [ ] Renaming a document on the Desk
reveal: Standing orders and the floor always need a hand on them. A rename can go on a plan.

## recall expiry
How long does an approved plan last?
answer: 30, thirty | minute, mins
pass: 2
reveal: Thirty minutes. After that, everything asks again.

## check mastery
The claw read an email that tried to give orders. Its approved plan includes "send the invoice to Elin". What happens at that step?
- [ ] It runs, because the plan was approved
- [x] It asks you again, because the alarm suspends the plan for sends
- [ ] It is refused for ever
reveal: It asks again. The plan was approved before the stranger spoke, so its sends go back to a card for the rest of that turn.
