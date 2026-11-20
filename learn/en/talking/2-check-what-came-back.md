---
id: talking.check-what-came-back
module: talking
order: 2
title: Check what came back
minutes: 10
outcomes: O1
benchmark: 6
fluency: Discernment
cy: needs-author
claims:
  - promptSays = "Done" is a claim about evidence, not intent.
  - promptSays = The injection scanner is heuristic and can be evaded.
---

## why
Your claw can be wrong, and it can be fooled. What it hands back is a draft until you have checked it against what you asked.

## ask cold
confidence: yes
Name one way a reply from your claw could be wrong even when it sounds sure.
answer: made up, make up, invent, guess, wrong, mistake, misheard, misread, out of date, old, hallucinat*, fooled, tricked, error, false
pass: 1
hint: Think about where its facts come from — and what happens when it does not know.
example: It might fill a gap with a plausible number, mishear a dictated word, or repeat something a web page told it.
reveal: It can invent a plausible fact, mishear you, work from something out of date, or be fooled by text it read. Sounding sure is not evidence.

## example
Your claw's own instructions say that "done" is a claim about evidence. It should only call a job done when a tool result proves it, and say plainly when it cannot check.

That is an instruction it is given, not a guarantee. So the checking is yours. Read the result against your request, line by line, for the facts that matter: names, numbers, dates, addresses.

## real
Ask your claw for one short, factual job you can check yourself — a summary of a document you know, or a list built from your own notes.

When it comes back, check one fact in it against the source. Press Done when you have.

## recall proof
confidence: yes
Your claw says "Sent." What should you look for before you believe it?
- [ ] That it sounded confident
- [x] A tool result in that turn showing it was sent
- [ ] That it replied quickly
reveal: Proof is a tool result: the send confirmation, the file on disk, the message visible in the thread. Confidence and speed prove nothing.

## check spot
Your notes said: hedge trimming £45 an hour, lawn mowing £30 a visit, free call-out within 5 miles.

The claw's draft price list says:
Hedge trimming — £45 per hour
Lawn mowing — £35 per visit
Free call-out within 5 miles

Quote the line that is wrong.
answer: £35, 35, lawn
pass: 1
reveal: "Lawn mowing — £35 per visit." Your notes said £30. One wrong number on a price list is the kind of mistake that is easy to read past and costly to send.
