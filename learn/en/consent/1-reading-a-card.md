---
id: consent.reading-a-card
module: consent
order: 1
title: Reading a card
minutes: 15
outcomes: O3
benchmark: 5
fluency: Diligence
critical: true
cy: needs-author
claims:
  - asksTool = send_email
  - asksFirst = mv "~/Documents/CunningClaw/Old notes.md" "~/Documents/CunningClaw/Notes 2025.md"
  - practiceLabel = PRACTICE · nothing real will happen
  - source = public/app.js :: ALLOW FOR THIS TASK
---

## why
Every send, spend and delete waits for you. The card is the one thing between a mistake and the world, so reading it well is the skill that matters most in this course.

## ask cold
confidence: yes
A card appears. What three things on it would you check before pressing EXECUTE?
answer: do, does, action, happen, send, run, what | who, whom, to, recipient, address, where, which, target, file | asked, request, wanted, meant, mine, my
pass: 2
hint: One is the action. One is who or what it touches. One is about you.
example: The card says "Send this email · To: elin@morganpryce.example". The action is a send. The target is that address. And you check: did I ask for this?
reveal: What it will do, who or what it touches, and whether you asked for it.

## example
A card has a title and a body. The title says what will happen: "Send this email", "Run shell command". The body shows exactly what: the To line and the words, or the command itself.

It has three buttons. EXECUTE does this one thing. ALLOW FOR THIS TASK lets the small, reversible steps of this errand through until the turn ends — it never covers a send, a spend or a delete. DENY stops it, and nothing happens.

Practice cards look the same, with one stripe added: PRACTICE · nothing real will happen.

## real
Ask your claw to rename one document on your Desk using a shell command. A rename is a command that changes things, so a card asks first.

When the card comes, find the action, the target, and check it is what you asked for. Then choose. Press Done when the turn has finished.

## practice cards-four
Four jobs, four cards, varied each time you try. Errors are welcome here: the point is to find out in practice, where nothing real happens.

## explain wrong
In one sentence: why did the card that went to the lookalike address need DENY?
answer: address, domain, recipient, lookalike, hyphen, different, wrong, not the, not their, isn't, spelt, spelled
pass: 1
reveal: Its To line was not the address your supplier writes from. One character in a domain is enough to send a payment to a stranger.

## recall recipient
confidence: yes
critical: yes
A card says: Send this email · To: accounts@hafod-timber.example. Your supplier writes from @hafodtimber.example. Which button?
- [ ] EXECUTE
- [ ] ALLOW FOR THIS TASK
- [x] DENY
reveal: DENY. The hyphen makes it a different domain — not your supplier's.

## recall task
confidence: yes
What does ALLOW FOR THIS TASK never cover?
answer: send, spend, delete, pay, payment, irreversible, publish, commit, money, email
pass: 1
reveal: Anything irreversible: a send, a spend, a delete. Those ask every time.

## check mastery
kind: scenario
critical: yes
threshold: 1
Your last run of the four cards is the check. All four must match the key, and the lookalike address must be denied.
