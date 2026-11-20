---
id: talking.bring-a-job
module: talking
order: 1
title: Bring a job, not a question
minutes: 10
outcomes: O1
benchmark: 1, 2
fluency: Description, Delegation
cy: needs-author
claims:
  - tool = write_file
  - promptSays = The Desk: ~/Documents/CunningClaw holds
---

## why
Your claw does the work. Your skill is saying what the work is, and checking it came back right.

A job described with its goal, its context, its limits and its finish line leaves the claw much less to guess.

## ask cold
confidence: yes
You want your claw to write something for you. What four things would you put in the request, so it does not have to guess?
answer: goal, aim, want, purpose, for, so that | context, background, who, customer, about | limit, constraint, must not, don't, no more than, budget, length, words, tone | finish, done, end, deliver, desk, save, by, when, where, format
pass: 3
hint: One is what you want. One is the background. One is a limit. The last is how you will know it is finished.
example: "Write a price list for my garden business (goal) for new customers in Pontypridd (context). Keep it to one page, no jargon (limit). Save it on the Desk as Price list (finish line)."
reveal: The goal, the context, the limits, and the finish line — what done looks like and where it should land.

## example
Here is the same job asked two ways.

Weak: "Can you do something about my prices?"

Strong: "Write a one-page price list for my garden business, for new customers. Hedge trimming is £45 an hour and lawn mowing £30 a visit. Plain words, no jargon. Save it on the Desk as Price list."

The strong one names the goal, gives the facts, sets a limit, and says where the result goes. The claw writes Desk documents to ~/Documents/CunningClaw, and you can open them from DESK at the top of the HUD.

## real
Pick one job you would like to hand over this week. Write it in the box below in your own words — it stays on this machine.

Then give it to your claw in the main chat, with a goal, the context, a limit and a finish line. You write the request; the lesson will not write it for you. Press Done when it has come back.

## recall finish
confidence: yes
Which of these is a finish line?
- [ ] "Make it good."
- [x] "Save it on the Desk as Price list."
- [ ] "Be quick about it."
reveal: A finish line says what done looks like and where it lands. "Make it good" leaves the claw to guess.

## check mastery
Which request leaves the claw least to guess?
- [ ] "Sort out my emails."
- [ ] "Write me something for the website."
- [x] "Draft a short, friendly reply to Siân confirming Tuesday at 9, and leave it in the compose window for me to read."
reveal: It names the goal (confirm Tuesday), the context (a reply to Siân), a limit (short and friendly), and a finish line (left unsent, for you to read).
