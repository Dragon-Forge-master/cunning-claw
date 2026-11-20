---
id: leaves.what-leaves
module: leaves
order: 1
title: What leaves the machine
minutes: 12
outcomes: O7
benchmark: 4, 5
fluency: Diligence
cy: needs-author
claims:
  - docSays = docs/SECURITY-ARCHITECTURE.md :: There is no telemetry and no account.
  - docSays = docs/SECURITY-ARCHITECTURE.md :: sends audio to the browser vendor
  - ntfyGuessable = claw-alerts
  - tool = learn_progress
---

## why
Local first does not mean nothing leaves. For your own install, you should be able to say what goes where, and to whom.

## ask cold
confidence: yes
When you chat with a cloud brain, who receives your words?
answer: provider, google, openrouter, anthropic, openai, company, model, cloud, server
pass: 1
reveal: The model provider behind that brain. The whole conversation for that turn goes to them.

## example
Your claw has no telemetry and no account. What can leave is this:

The conversation goes to the model provider of the brain in use, unless it is the local brain. Memory search can send memory text to an embeddings service, if one is keyed. Telegram and Discord get messages and cards, if you set them up. ntfy gets alerts. A connector gets what its tools are sent.

If the mic uses the browser's own recogniser rather than whisper, your speech goes to the browser's maker. The ears chip under the reactor says so in amber.

## example ntfy
An ntfy topic works like a public noticeboard: anyone who knows its name can read it. A short, guessable topic like claw-alerts is the risk. A long random one, or a token, is the fix — the doctor names it.

## real
Look at your own install: SYSTEM TELEMETRY on the left of the HUD, and the KEYS page. Note which phone lines, connectors and keys are switched on. Press Done when you have your list.

## recall topic
confidence: yes
A status page shows ntfy alerts going to the topic claw-alerts, with no token. What is the risk?
answer: guess, guessable, anyone, public, read, subscribe, stranger, see
pass: 1
reveal: Anyone who guesses the topic name can read every alert. Use a long random topic, or a token.

## check map
kind: status-map
For your install, as it is set up right now, where can your words or alerts go? Choose every one that is switched on.
reveal: The key is read from your own install's settings at the moment you answer — the brain in use, the embeddings choice, the phone lines, ntfy and connectors.
