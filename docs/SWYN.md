# Y Swyn — the claw's Welsh

Cunning Claw is named for the *dynion hysbys*, the Welsh cunning folk — and a
cunning man's tools had proper names. This is the official lexicon: real Welsh,
naming real subsystems, doing real work. Nothing here is obfuscation; everything
here is documented. It reads as magic to the hurried and as a glossary to the
curious, which is exactly the intended ratio.

## The lexicon

| Welsh | Says | Names |
|---|---|---|
| **y dyn hysbys** | the knowing one | the assistant itself |
| **y crafanc** | the claw | the whole system |
| **y ffens** | the fence | the `<untrusted>` quarantine around outside words |
| **y llw** | the oath | the approval system — consequences wait for a human |
| **y sarff** | the serpent | the Ouroboros guard that stops tail-chasing |
| **y curiad** | the heartbeat | the 30-minute pulse |
| **y ddesg** | the desk | shared documents in ~/Documents/CunningClaw |
| **y llygaid** | the eyes | screenshots, and the always-asking camera glance |
| **swyn** (pl. **swynion**) | a spell/charm | a scheduled task — a working left to fire on its own |
| **y llyfr swynion** | the spellbook | workspace/SCHEDULE.md |
| **gramadeg** | grammar | a skill — a learned way of working |
| **y llyfrgell** | the library | workspace/skills |
| **cof** | memory | MEMORY.md and the journal |
| **awen** | poetic inspiration | the creative pipeline — images, films, music |
| **yr efail** | the forge | the build system; the Board is *Bwrdd yr Efail* |
| **nos da** | good night | a clean shutdown |
| **yr Archdderwydd** | the Archdruid | an honorific, never a default — the claw does not presume titles on strangers. The cunning folk were always human; the claw is only the familiar, and an owner takes a title only by claiming one themself |
| **penblwydd** | birthday | an annual swyn (`08:30:20/04`) — the spellbook learned about years for this |
| **ar-lein** | online | the boot banner's first status line |
| **llais** | voice | the TTS engine (Piper) |
| **offer** | tools | the tool roster on the bench |
| **arysgrif y dydd** | the day's inscription | the boot banner's rotating proverb — real Welsh, glossed, one per day |

## Welsh that executes

The spellbook takes Welsh day names as first-class syntax — these parse and fire:

```
- [x] schedule: `08:00:llun-gwe` | target: `briefing` | instruction: Morning briefing on the Desk.
- [x] schedule: `17:00:gwener`   | target: `nudge`    | instruction: Friday invoices check.
- [x] schedule: `12:00:mer`      | target: `reminder` | instruction: Stretch, water, walk.
```

Days: `sul` (Sun) · `llun` (Mon) · `maw`/`mawrth` (Tue) · `mer`/`mercher` (Wed)
· `iau` (Thu) · `gwe`/`gwener` (Fri) · `sad`/`sadwrn` (Sat). Ranges wrap:
`sad-llun` is the weekend and Monday. English names work equally; the machine is
bilingual, like its country.

Annual dates also parse — `20/04` (fires 09:00) or `08:30:20/04` — so a
penblwydd is a spell like any other, cast once a year:

```
- [x] schedule: `08:30:20/04` | target: `penblwydd` | instruction: Penblwydd hapus, Archdderwydd.
```

## The doctrine line

Every claw carries this, and it is the whole philosophy in one breath:

> **Yn lleol yn gyntaf · Caniatâd dynol pan fo canlyniadau**
> *Local first · Human consent where there are consequences*

## The boot liturgy

The terminal a downloader watches is a human-facing surface, so it speaks the
Swyn: the doctrine line under the wordmark, the three wards (**y ffens**,
**y llw**, **y sarff** — each naming a subsystem that is unconditionally
active; no ward is printed that is not real), and the *arysgrif y dydd* — a
genuine Welsh proverb rotated daily in `src/banner.ts`:

> Dyfal donc a dyr y garreg · Deuparth gwaith yw ei ddechrau · A fo ben, bid
> bont · Gwell dysg na golud · Nid aur popeth melyn · Hir yw pob ymaros ·
> Gwell hwyr na hwyrach · Cenedl heb iaith, cenedl heb galon

Each prints with its English gloss. The magic is that every riddle checks out.

## Rules for extending the Swyn

1. Welsh appears on **human-facing surfaces** — logs, docs, the HUD, film
   endcards — never in model-facing tool results, where a cheap brain might
   trip over it.
2. Every Welsh term lands in this table the day it enters the code. Magic that
   cannot be looked up is just bad documentation.
3. Real Welsh only — checked against a dictionary, not invented. The audience
   this must never embarrass is Wales.
