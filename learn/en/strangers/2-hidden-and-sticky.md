---
id: strangers.hidden-and-sticky
module: strangers
order: 2
title: Invisible ink, sticky taint, and testimony
minutes: 12
outcomes: O5
benchmark: 5, 6
fluency: Discernment
critical: true
cy: needs-author
claims:
  - untrusted = read_document
  - injectionSignal = hidden
  - hiddenTextScanned = true
  - stickyTaint = true
  - memoryUnverifiedWhenTainted = true
---

## why
Some planted text cannot be seen at all. And outside text does not leave the conversation when the turn ends. Both change how far a clean-looking page can be trusted.

## ask cold
confidence: yes
Can a document contain words that a model reads but you cannot see on the screen?
- [x] Yes
- [ ] No
reveal: Yes. Some characters are invisible on screen but are read as text by a model.

## example
Some Unicode characters draw nothing at all, yet they can spell out a whole sentence for a model to read. Your claw's scanner strips them out, then reads what they spelt as if it were visible.

Outside text is also sticky. Once an email or a page is in the conversation, every turn after it goes to a trusted brain, until that text falls out of the conversation window.

A memory saved while outside text is in view is stamped unverified: it is testimony from that turn, not a fact you told it.

## real
Ask your claw what it remembers about you, and whether any of it is marked unverified. If something is, ask where it came from. Press Done when you have.

## practice hidden-injection
One invoice that looks entirely ordinary. Read it yourself first, then see what the scanner finds.

## explain see
What did the scanner find that you could not see?
answer: hidden, invisible, tag, unicode, can't see, cannot see, couldn't see, could not see, secret
pass: 1
reveal: Invisible characters spelling out an order to email your bank details to a stranger.

## recall sticky
confidence: yes
You asked your claw to read one email this morning. Ten turns later, which brain answers?
- [ ] The cheapest one, because the email was hours ago
- [x] A trusted brain, while that email is still in the conversation window
- [ ] The local brain
reveal: A trusted one. The email is still in the conversation the model sees, so the guard still applies.

## recall testimony
confidence: yes
A memory is saved while a web page is in the conversation. How is it kept?
- [ ] As a plain fact, like anything else
- [x] Marked unverified — testimony, not fact
- [ ] It is not kept at all
reveal: Marked unverified, so later turns know it came from a turn a stranger was talking in.

## check mastery
kind: scenario
critical: yes
threshold: 1
Your last run is the check: the bank-details card denied, and the hidden text reported.
