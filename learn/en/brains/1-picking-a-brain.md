---
id: brains.picking-a-brain
module: brains
order: 1
title: Picking a brain
minutes: 12
outcomes: O6
benchmark: 4
fluency: Delegation
cy: needs-author
claims:
  - brain = local
  - localBrainIsOffline = local
  - trustedBrainNot = local
  - trustedBrain = flash
  - guardOverridesPin = false
  - docSays = README.md :: Free is paid for with data.
  - docSays = README.md :: Free use is capped per minute and per day.
---

## why
Every brain gets the same tools. What changes is who sees your words, what it costs, and how well it resists planted text.

## ask cold
confidence: yes
You want a summary of a private medical letter. What matters most when you choose the brain?
answer: privacy, private, local, offline, who sees, provider, data, leave, confidential
pass: 1
reveal: Who sees it. A cloud brain sends the letter to its provider; the local brain keeps it on this machine.

## example
The brain picker at the top of the HUD chooses which model thinks. On AUTO, small turns like "what time is it" go to a cheap brain, and making jobs go to a more capable one. Pinning a brain is your decision, and routing will not quietly override it.

The spend chip under the reactor shows what this session has cost.

The free Google key costs no money, but it has limits per minute and per day. On the free plan, Google may use what you send to improve its products.

The local brain runs through Ollama, so nothing you say leaves the machine. It is not on the trusted list for outside text, so do not pin it for the inbox.

## real
Pin a brain for one real job with the picker, or by typing /brain followed by its name. Read the spend chip before and after. Then set the picker back to AUTO. Press Done when you have.

## recall offline
confidence: yes
Which brain keeps every word on this machine?
- [x] The local brain, through Ollama
- [ ] The free Google key
- [ ] Any brain, if you ask it nicely
reveal: The local brain. Every cloud brain sends the conversation to its provider.

## recall free
confidence: yes
What does the free Google key cost?
- [ ] Nothing at all
- [x] No money, but Google may use what you send to improve its products
- [ ] A card payment after a month
reveal: No money. On the free plan, what you send may be used by Google; for private work, use billing, an OpenRouter key, or the local brain.

## check mastery
Which pairing of job and brain is the most defensible?
- [ ] Reading a stranger's invoices: the local brain, because it is private
- [x] A private letter: the local brain; reading the inbox: a trusted cloud brain; a quick question: AUTO
- [ ] Everything: the cheapest brain, because the tools are the same
reveal: Privacy decides the letter, resistance to planted text decides the inbox, and AUTO is fine for a quick question.
