---
id: turn.chips-and-stop
module: turn
order: 1
title: Chips, states and STOP
minutes: 10
outcomes: O2
benchmark: 6
fluency: Discernment
cy: needs-author
claims:
  - ouroborosLimit = 2
  - source = src/server.ts :: const STOP_WORDS = /^\s*(stop|cancel|abort|halt
  - source = public/app.js :: es.addEventListener("brain_guard"
  - source = public/app.js :: ⚑ instructions inside
  - trustedBrain = flash
---

## why
A turn is your claw thinking, calling tools, and replying. If you can read a turn as it happens, you can stop one going wrong before it finishes.

## ask cold
confidence: yes
Your claw has been working on something for a long time and seems to be going round in circles. What can you do?
answer: stop, cancel, abort, halt, press, interrupt
pass: 1
hint: There is a button for this at the top of the HUD while the claw is thinking.
reveal: Press STOP, or type "stop". Either abandons the request at once.

## example
Read the transcript from the top of a turn down.

The state under the reactor says THINKING. Each tool the claw calls gets a chip: ▸ when it starts, ✓ when it is complete. If a result had text in it that tried to give orders, its chip carries an amber ⚑ instructions inside.

A ⛨ guarded chip means the turn had read outside text, so a trusted brain answered it. A ▸ takes this one chip means a making job went to a more capable brain.

While THINKING, a STOP button appears at the top. Typing "stop" does the same.

## real
Give your claw a real two-step job — for example, "What is the weather in Cardiff, and put it in a note on the Desk."

Watch the chips as it works. Name to yourself each tool it called. Press Done when the turn has finished.

## recall loop
confidence: yes
Here is part of a turn:
▸ browser_wait {"ms":2000}  ✓
▸ browser_wait {"ms":2000}  ✓
▸ browser_wait {"ms":2000}  ✓ [Ouroboros] loop blocked

What happened on the third identical call?
answer: blocked, refused, not run, stopped, did not run, didn't run, prevented
pass: 1
hint: Read the end of the last line.
reveal: Y sarff — the Ouroboros guard — refused to run it. The same call with the same answer is not re-asked a third time; the claw is told to change approach or say where things stand.

## check mastery
The transcript shows "⛨ guarded → flash · history contains untrusted content". What does it tell you?
- [ ] The claw is broken
- [x] This conversation has read outside text, so a trusted brain answered
- [ ] Your pinned brain is out of credit
reveal: Outside text — an email, a page, a document — is in the conversation, so the turn went to a brain on the trusted list.
