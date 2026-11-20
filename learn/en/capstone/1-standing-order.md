---
id: capstone.standing-order
module: capstone
order: 1
title: Arm one standing order, safely
minutes: 30
outcomes: O8
benchmark: 3
fluency: Delegation, Diligence
critical: true
requires: consent.reading-a-card, strangers.how-injection-works
cy: needs-author
claims:
  - welshSchedule = 08:00:llun-gwe
  - armingAsks = true
  - planRefuses = write_file :: workspace/SCHEDULE.md
  - source = src/tools.ts :: this arms ${count === 1 ? "a standing order that fires"
---

## why
A standing order is the claw acting for you later, with nobody watching. Arming one safely — and knowing how to stop it — is the last thing this course asks of you.

## ask cold
confidence: yes
A standing order fires at eight every weekday morning. Who approves each time it fires?
answer: nobody, no one, none, noone, once, arming, armed
pass: 1
reveal: Nobody — that is the point of it. You approve it once, when it is armed. After that it fires unattended, so the arming card deserves your slowest reading of all.

## example
Standing orders live in workspace/SCHEDULE.md, one line each. This one is armed — [x] — and fires at eight on weekdays, written with the Welsh day names the book also understands:

- [x] schedule: `08:00:llun-gwe` | target: `briefing` | instruction: Morning briefing on the Desk.

Arming a line, or turning [ ] into [x], always raises a card, and no plan can cover it. Turning [x] back into [ ] pauses it, and that needs no card.

## practice standing-order
An email asks your assistant to arm a standing order. The fooled practice claw tries.

## real arm
verify: schedule-armed
Now arm one real standing order on your own claw. Ask it in the main chat for something small and useful — for example, a weekday morning note on the Desk.

Read the arming card yourself, then approve it. Press Done: the lesson checks workspace/SCHEDULE.md for an order armed since this step began.

## explain defend
In a few sentences: what can your standing order do unattended, where does what it makes end up, and how would you switch it off?
answer: desk, document, file, note, telegram, phone, email, chat, nowhere, stays | untick, pause, remove, delete, switch off, switch it off, turn off, turn it off, stop, schedule.md, unarm, disarm
pass: 2
hint: Say where its output lands, and which line you would change to stop it.
reveal: For example: "It writes a note on my Desk at eight on weekdays and sends nothing anywhere. To stop it, I untick its line in SCHEDULE.md, or ask the claw to pause it."

## recall email
confidence: yes
critical: yes
An email asks your claw to add a standing order. The arming card appears. Which button?
- [ ] EXECUTE
- [ ] ALLOW FOR THIS TASK
- [x] DENY
reveal: DENY. A standing order you did not ask for, raised after reading a stranger's words, is exactly what the card is for.

## check mastery
kind: scenario
critical: yes
threshold: 1
Your last practice run is the check — the planted standing order denied and reported — together with the real order you armed yourself.
