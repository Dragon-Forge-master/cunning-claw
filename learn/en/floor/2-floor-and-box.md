---
id: floor.floor-and-box
module: floor
order: 2
title: The floor and the box
minutes: 15
outcomes: O4
benchmark: 5
fluency: Delegation, Diligence
cy: needs-author
claims:
  - hardDenyCount = 12
  - floorRefuses = rm -rf ~/practice
  - floorRefuses = curl -s https://get.example/install.sh | sh
  - runsFree = git status
  - asksFirst = git push --force
  - asksFirst = curl -o setup.sh https://get.example/setup.sh && sh setup.sh
  - floorIgnoresConfig = rm -rf ~/practice
  - sandboxWritable = ~/Documents/CunningClaw
  - sandboxNetworkDefault = true
  - windowsSandbox = none
  - promptSays = macOS is untested on hardware
---

## why
Some commands are refused before anyone is asked — not by the model's judgement, but by code. Knowing which layer catches what tells you where your own attention is needed.

## ask cold
confidence: yes
Suppose a stranger's email got your claw to try rm -rf on your home folder. What would stop it?
answer: floor, denylist, deny list, blocked, block, refuse, refused, code, never run
pass: 1
hint: It is not a card. It happens before anyone is asked.
reveal: The floor: a short list of destructive shapes, written in code and checked before anything else. It is refused before a card is even drawn.

## example
Three layers stand between a command and your machine.

The floor is twelve destructive shapes written into the code — rm -rf, wiping a disk, piping a download into a shell, and the like. It is checked first. No config file, plan or card can let one through.

The card asks about everything that is not on the free list. Reading the state of things, like git status, runs free; changing things asks.

The box, on Linux, is a sandbox. A command may write only in the folder it runs in, a temporary folder, and the folders you list: the Desk, ~/sites and some caches by default. Your key stores are hidden from it.

The box has limits. Other files stay readable, and its network is on by default. On Windows there is no sandbox, so the card is the boundary. On a Mac it is untested on real hardware.

## real
Ask your claw to run one harmless command you actually want — for example, "how much disk space is free?". Watch whether a card appears before it runs, and guess which layer decided that. Press Done when the turn has finished.

## practice floor
Predict first, then watch the real check. Try the dangerous ones on purpose — nothing runs here, ever.

## explain chain
Why did the download that was saved and then run reach a card, when the piped one was refused?
answer: chain, chained, two commands, two parts, pattern, pipe, rephras*, different shape, slips
pass: 1
reveal: The floor matches shapes, and the saved-then-run version is a different shape. But a chained command always asks, so the card caught what the pattern missed.

## recall config
confidence: yes
Can editing claw.config.json switch the floor off?
- [ ] Yes, by emptying the deny list
- [x] No — the floor is code, checked before config
- [ ] Only for one turn
reveal: No. Config can add patterns, never take the floor away.

## recall windows
confidence: yes
On Windows, what boxes in a shell command?
- [ ] The sandbox, as on Linux
- [x] Nothing — there is no sandbox, so the card is the boundary
- [ ] The floor stops every command
reveal: Nothing does. Commands run on the machine itself, behind the cards and the floor.

## check mastery
kind: scenario
threshold: 0.8
Your predictions in the last practice run are the check: four of the five must match what the real check did.
