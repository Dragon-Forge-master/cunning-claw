---
id: consent.silence-and-phones
module: consent
order: 2
title: Silence is a no, and answering from a phone
minutes: 10
outcomes: O3
benchmark: 5
fluency: Diligence
cy: needs-author
claims:
  - approvalTimeoutMs = 180000
  - newMessageCancelsCards = true
  - practiceCardsStayOffPhones = true
  - source = src/telegram.ts :: if (isGroupChat(chatId)) continue;
  - source = src/ntfy.ts :: It is outbound only, on purpose.
---

## why
You will not always be at the screen when a card appears. Knowing what silence does keeps you in charge while you are away.

## ask cold
confidence: yes
A card appears and you go to make a cup of tea. Nobody answers it. What happens?
answer: deny, denied, cancel, cancelled, nothing, time, expire, does not run, doesn't run, won't, stops
pass: 1
hint: Think about which way is safe if nobody is there.
reveal: After three minutes it is denied by itself, and nothing runs. Silence is a no.

## example
Three rules decide what an unanswered card does.

A card waits three minutes, then is denied by itself. If you type a new message while a card is waiting, that card is denied: your new message is the answer. Either way, the thing it asked about does not happen.

If you set up Telegram or Discord, cards also go there, to your private chat only — never a group or a server channel. ntfy alerts only tell you a card is waiting and where to answer; they never carry a button. Practice cards never go to your phone at all.

## real
If you have Telegram or Discord set up, ask your claw for a small real job that raises a card, and answer it from your phone.

If you have neither, ask for the job anyway, and type a new message while its card is waiting. Watch the card go. Press Done when you have.

## recall newmsg
confidence: yes
You type a new message while a card is waiting. What happens to the card?
- [x] It is denied, and nothing it asked about happens
- [ ] It waits until you answer it
- [ ] It runs, because you are clearly busy
reveal: It is denied. A new instruction from you outranks a card you have not answered.

## recall buttons
confidence: yes
multi: yes
Which of these can carry the approve and deny buttons? Choose all that apply.
- [x] Telegram, in your private chat
- [x] Discord, in your private messages
- [ ] ntfy push alerts
reveal: Telegram and Discord carry the buttons, in private chats only. ntfy is outbound only: it says a card is waiting and where to answer it.

## check mastery
A card has been on the screen for three minutes and you have not touched it. What has happened?
- [ ] It ran, because you did not object
- [x] It was denied by itself, and nothing ran
- [ ] It is still waiting
reveal: It was denied by itself after three minutes. Nothing ran.
