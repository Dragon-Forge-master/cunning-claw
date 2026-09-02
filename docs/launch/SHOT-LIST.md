# Launch video — shot list

One 80-second hero film, three 15-second cutdowns. Everything on screen is the
real software doing real work on a real machine. Nothing is mocked, staged in an
editor, or typed into a fake transcript. If the model is slow, film the wait and
cut it in the edit. If it does something other than the plan, film that too and
decide in the edit — never re-stage a moment to make the software look better
than it is. The brand rule applies to film exactly as it applies to copy: every
claim must survive "how do we know?"

Companion files: `NARRATION.md` (the voice track), `title-card.html` /
`end-card.html` (the two static cards, rendered to `.png` alongside).

---

## Before you roll

Do these in order. Tick them off; the film is only as honest as this list.

**The machine**

- [ ] **Shoot from a throwaway Linux user, not your own.** The telemetry
      panel prints the install path (on the current tree it is collapsed to
      `~/cunning-claw`, but check — an older build prints `/home/<user>/…`),
      and every `write_file` / `run_command` chip in the transcript shows the
      path exactly as the model wrote it, which is often absolute:
      `/home/<user>/sites/…`. A user called something plain
      (`sudo adduser forge`) means nothing personal can reach the frame, and
      nothing on screen is fake — it is just a clean home folder. Log in to a
      Cinnamon session as that user for the whole shoot.
- [ ] Fresh clone of **this branch** in that user's home:
      `git clone https://github.com/Dragon-Forge-master/cunning-claw.git && cd cunning-claw && git checkout claude/cunning-claw-repo-m82hzk && git pull`
- [ ] `./install.sh` (Node 22+, `npm install`, `.env`, the OpenRouter key, the
      offline voice — say **yes** to the voice, the film needs Piper), then
      `npm run build` and `npm run doctor` until doctor is clean.
- [ ] `.env`: leave `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` **empty**. The
      telemetry panel prints `Telegram: on (<chat id>)` when they are set; empty
      means it prints `Telegram: off`. Your chat id must not be on camera.
- [ ] Brain: leave the default (`google/gemini-2.5-flash` in `claw.config.json`).
      The brain picker in the header shows the roster with prices — that is fine
      on camera, it is public pricing.
- [ ] Create the scratch folder for the approval shot (see *Getting the card to
      appear* below) and the site folder does not need pre-creating — the claw
      writes to `~/sites` or a new folder under home on its own, both are
      free-write zones, no card.
- [ ] Start it: `npm run dev`. Keep that terminal on a second workspace or a
      second monitor; it is not in any shot.

**The screen**

- [ ] Display 1920×1080. If the panel is higher, set it to 1920×1080 for the
      shoot rather than scaling in the edit.
- [ ] Chrome (or Chromium), a **fresh profile** (`google-chrome --user-data-dir=/tmp/shoot-profile`)
      so no bookmarks bar, no extensions, no account avatar, no autofill.
- [ ] Open `http://127.0.0.1:3900`, press **F11** for full screen (hides the
      Cinnamon panel, tabs and address bar), then **Ctrl and +** once for
      **110 % zoom**. Check the three panels — telemetry, reactor, transcript —
      all fit with nothing clipped.
- [ ] Close every other window. Disable desktop notifications (Cinnamon: the
      notifications applet, or `gsettings set org.cinnamon.desktop.notifications display-notifications false`
      for the session). No desklets, no clock overlays, no chat clients.
- [ ] Wallpaper is irrelevant — it is never seen — but close the file manager.
- [ ] Press **RESET** in the HUD header so the transcript is empty, then reload
      the page so the boot overlay plays out and the reactor settles at STANDBY.

**The recorder (Cinnamon's built-in recorder, .webm)**

- [ ] Frame rate 30 fps: `gsettings set org.cinnamon.recorder framerate 30`
      (list the keys with `gsettings list-keys org.cinnamon.recorder` if the
      name differs on your version). Leave the default VP8 pipeline; 1080p30
      is plenty for the HUD, which is mostly still.
- [ ] Start/stop is **Ctrl+Shift+Alt+R**. It records the whole screen — good,
      that is the frame we want. Files land in `~/Videos`.
- [ ] **Record audio separately; the recorder does not capture it well.** Two
      tracks, both as WAV:
      - the claw's own voice (Piper, out of the speakers):
        `parecord --device="$(pactl get-default-sink).monitor" --file-format=wav claw-voice.wav`
      - the room / the founder, if used: a USB mic into Audacity or
        `arecord -f cd founder.wav`.
      Clap once on camera at the start of every take — you will sync to it.
- [ ] Do one throwaway take of the whole running order end to end before the
      real one. Check the .webm plays, check the audio has level.

---

## The two set pieces, and how to make them happen for real

### Getting the approval card to appear (shot 3)

Building the website will **not** raise a card. The claw may write freely in
its own ground (the Desk, `workspace/`, `~/sites`, tmp) and may create brand-new
non-hidden files anywhere under home; that is deliberate — a card on every draft
teaches people to click cards on reflex. So the card needs a command with a
genuine consequence: something that changes files that already exist.

`run_command` asks for anything that is not on the read-only auto-approve list
(`ls`, `cat`, `git status`, `mkdir`, `touch`, …). A `mv` or an `rm` of an
existing file is exactly that. So, **before rolling**, make a scratch folder
with something real in it:

```bash
mkdir -p ~/claw-demo/quotes
printf 'Quote 2019-03 — MOT + service, £184\n' > ~/claw-demo/quotes/quote-2019-03.txt
printf 'Quote 2019-07 — brake pads, £96\n'     > ~/claw-demo/quotes/quote-2019-07.txt
printf 'Quote 2024-11 — MOT, £54.85\n'         > ~/claw-demo/quotes/quote-2024-11.txt
```

Then the line to type, verbatim:

> `Move the 2019 quotes in ~/claw-demo/quotes into an archive folder next to them.`

Expected: a `▸ run_command: mkdir …` chip (auto, no card), then the card:

```
⚠ APPROVAL REQUIRED — Run shell command
mv ~/claw-demo/quotes/quote-2019-*.txt ~/claw-demo/quotes/archive/
[ EXECUTE ]  [ ALLOW FOR THIS TASK ]  [ DENY ]
```

The card is amber-bordered and pulses. The moment it appears the claw says,
out loud, **"Requesting authorisation, sir."** — that is the software, keep it.

The exact command text is the model's, not ours; it may write two `mv` lines,
or use `mkdir -p` first. All fine — the point is a real command with a real
consequence, read by a human, then run. **Do not send another message while
the card is up:** a new instruction cancels pending approvals, and the card
times out on its own after **180 seconds** (`approvalTimeoutMs`). Hold it for
up to ten seconds, no longer.

If the model does the move without a card, it found a path you did not expect
(check: did it write new files instead of moving?). Reset the folder with the
four lines above and use the fallback ask, which is unambiguous:

> `Delete ~/claw-demo/quotes/quote-2019-07.txt — it's a duplicate.`

That is `rm` of one file, not on the auto list, so it asks.

### Getting the refusal (shot 6)

The floor is `HARD_DENY` in `src/tools.ts` — eleven patterns checked in code
before any config, and config can add to it, never subtract. What it refuses:
`rm -rf` (any flag order), `mkfs`, `dd` onto a block device, redirects onto a
disk, the fork bomb, `shutdown`/`reboot`/`poweroff`/`halt`, recursive
`chmod`/`chown` on `/`, `curl | sh` and `wget | sh`, `history -c` and `shred`,
and any mention of `/etc/shadow` or `/etc/sudoers`.

**The one to film is `rm -rf`.** It is the command everyone already knows, it
is the first example on the site and in the README, and it is the entry the
whole floor was written around. The entry, from `src/tools.ts`:

```ts
/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, // rm -rf in any flag order
```

and what the tool returns when it matches — `runCommand`, same file:

```
BLOCKED: this command matches the destructive-command denylist and will never be run.
```

The line to type, verbatim — aimed at the scratch folder so it is a fair ask,
not a trick:

> `Clear out ~/claw-demo now, rm -rf the lot. It's only scratch.`

**What you will actually see.** The transcript shows tool calls as chips —
`▸ run_command: rm -rf ~/claw-demo` then `✓ run_command complete` — and then
the claw's own sentence. The `BLOCKED:` string above goes to the model, not to
the glass; the HUD does not print tool results. So the words on screen are the
claw's, in his voice (he will say it is on the denylist and will not run; the
phrasing is his). The film is honest about this: the chip proves the command
was attempted, the reply proves it did not run. Do not add the `BLOCKED:` text
to the screen in the edit unless you show where it comes from (the source line
above, as an insert).

Two things the model may do instead, both fine, both film-worthy:

- **Refuse in prose without calling the tool.** The system prompt tells him
  never to run genuinely destructive commands, so he may just say no. That is a
  refusal, but it is model behaviour, not the floor. If that is the take you
  get, the narration line still stands (he did not run it) — but the cutdown
  caption must not say "blocked in code". Try once more with the same line;
  the second attempt usually calls the tool.
- **Retry with `rm -r`** (no `-f`). That is not on the floor, so it raises an
  approval card. Press **DENY**. Floor and gate in one shot — keep it.

Backup ask if you want a second refusal in the can: `Reboot the machine.` —
the model will nearly always call `run_command` with `sudo reboot`, and
`\breboot\b` is on the floor. Less cinematic, more reliable.

### The claw's voice, on cue

The claw speaks every final reply through Piper (`en_GB-alan-medium`) — that
audio is real and goes on the voice track. For the lines in `NARRATION.md`
that are not replies to anything (the cold-open "At your service, sir." and
the narration itself), have the claw say them through his own voice engine:

```bash
export $(grep CLAW_TOKEN .env)     # written to .env on first run, mode 600
curl -s -X POST http://127.0.0.1:3900/api/voice/sample \
  -H "Authorization: Bearer $CLAW_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"At your service, sir."}'
```

(`/api/voice/sample` is the voice auditioner's endpoint; without a `model` it
uses the configured voice. A curl has no `Origin` header, so the cross-site
check lets it through; the Bearer token is what authenticates it.)

Same engine, same model, same speakers, recorded by the same `parecord` — it
is his voice because it is his voice engine. Record the narration lines this
way in a quiet pass after the screen takes; do not try to speak them live over
the takes.

---

## Running order — the 80-second hero

Frame throughout: the HUD full-screen at 1920×1080, 110 %. Never the desktop.
Never the terminal. Never another window.

| Time | Shot | On screen | Must NOT be on screen | Type exactly | If it runs long |
|---|---|---|---|---|---|
| **0:00–0:06** | **Cold open.** Reactor at STANDBY, its rings breathing; state label `STANDBY`; transcript empty; input placeholder `At your service, sir…`. No logo card, no title. Voice: *"At your service, sir."* (claw, via `/api/voice/sample`, see above). | Header (`CUNNING CLAW · dyn hysbys · Cardiff`, brain picker, buttons), telemetry panel, empty transcript. | Boot overlay still playing (wait for `All systems nominal. Good day, sir.` to clear before rolling). Any chips left from a previous take — RESET first. | — | It cannot; this is a still. Hold 6 s. |
| **0:06–0:18** | **The ask.** Cursor in the input. Type, press Enter (or SEND). Reactor goes to THINKING. Chips fire down the transcript: `▸ write_file: {"path":"…/index.html"…`, `✓ write_file complete`, possibly `▸ run_command: mkdir -p …`, then `▸ preview: {"path":"…"}`. The viewport opens on the right, the reactor slides away, and he says *"Preview on the glass, sir."* | The chips, one after another, in real time. | Paths are the model's choice; with the throwaway user they are `/home/forge/…` — acceptable. If he reads a file outside home for any reason, that chip is out. | `Build me a website for a Cardiff MOT garage.` | Gemini Flash usually takes 30–90 s to write a page. **Film the whole wait.** In the edit, hold the first two chips at real speed, then time-lapse the middle at 4–8× (the chips stacking up read well fast), and land at real speed on the `preview` chip. Never cut the ask and the preview together as if it were instant. |
| **0:18–0:30** | **The money shot: the approval card.** Type the archive line. `▸ run_command: mkdir …` chip, then the amber card: `⚠ APPROVAL REQUIRED — Run shell command`, the `mv` command in full, three buttons. He says *"Requesting authorisation, sir."* **Hold** — let the viewer read the command (4–5 s). Move the mouse to **EXECUTE**, press. The title flips to `▸ EXECUTING…`, the card clears, `✓ run_command complete`, his one-line reply. | The full command on the card, legible. The mouse travelling to the button. | Do not click ALLOW FOR THIS TASK (it is real, but it is the wrong story for 12 seconds). No second message while the card is up. | `Move the 2019 quotes in ~/claw-demo/quotes into an archive folder next to them.` | The card appears within a few seconds of the ask. If he thinks for longer, film it; cut the thinking to a beat in the edit. Card expires at 180 s — you will not get near it. If the viewport from shot 2 is still open, press CLOSE on the viewport bar **before** typing so the card lands next to the reactor, not squeezed beside a browser pane. |
| **0:30–0:42** | **The site, in a real browser.** Re-open the viewport if closed (VIEWPORT button, or the model's preview is still remembered) and press **POP** on the viewport bar — it opens the served page (`http://127.0.0.1:3900/served/<token>/`) in a new Chrome tab. F11 that tab too. Scroll slowly, top to bottom, one pass. | The garage site, whatever he built. The address bar is hidden by F11; if you want it visible for one beat, exit F11 for that beat — `127.0.0.1:3900/served/…` is fine on camera. | Tabs strip, bookmarks, extensions (fresh profile handles this). Your own Chrome. | — | Nothing to wait for. If the page is ugly, it is ugly — that is the model's taste, not our claim. Cut to 12 s of the best scroll. |
| **0:42–0:52** | **The bill.** Back to the HUD tab. CLOSE the viewport so the reactor returns. Under the reactor sit two chips: the route chip (`google/gemini-2.5-flash · $0.3/$2.5 per Mtok`) and the **spend chip** — `$0.0412 · 3 turns` or whatever it truly is: session total in dollars to four places, and the turn count. Zoom in on that in the edit (a slow 1.3× push). Optionally cut to `/board` (the BOARD button) — its SPEND panel shows the same total large, with the per-turn average. | The real number. | Do not read a number aloud in the narration that is not on screen; the narration is written to avoid quoting one. The old "0.4p" line is not something the software displays — it shows dollars, and a full site build on Flash is typically a few cents. | — | Nothing to wait for. |
| **0:52–1:04** | **The refusal.** Type the `rm -rf` line. Chip: `▸ run_command: rm -rf ~/claw-demo`. `✓ run_command complete`. His reply: it is on the denylist and he will not run it. If he retries with `rm -r`, an approval card appears — press **DENY**; the title flips to `▸ DENIED`. | The chip with `rm -rf` in it, legible. His reply. | Anything from your real home. The scratch folder is the only thing named. | `Clear out ~/claw-demo now, rm -rf the lot. It's only scratch.` | He answers in seconds. If he refuses in prose without the chip, see *Getting the refusal* above — take it again once, and label the take. |
| **1:04–1:16** | **Connectors.** Press **CONNECT** in the header. The sheet opens: `CONNECTORS  90 connectors · 0 connected` (the count is `MCP_CATALOGUE.length`; "0 connected" is whatever is true on this machine), the Popular row — Canva, GitHub, Notion, Figma, Slack, Linear, Stripe, Sentry, Xero, **Lovable**, v0 — and the category chips. Hover the Popular row, settle on **Lovable** (`Build and edit full-stack apps by prompt`), press **Connect**. It writes `mcp.json` and tries the server; Lovable wants sign-in, so the card turns to `! Action required` with a **Reconnect** button. Stop there. | The count line, the Popular cards, the Lovable card changing state. | **Do not press Reconnect on camera** — it opens the system browser on the Lovable OAuth page, which is your account. The sheet's hint text and the `mcp.json` path (`~/.config/cunningclaw/mcp.json`) are fine. | — (search box: typing `lovable` also works, and reads well) | Connect answers in a second or two. If the machine already has Lovable connected from an earlier session, it shows `✓ N tools` — film that instead, it is truer. |
| **1:16–1:20** | **Close.** CLOSE the sheet. Reactor at STANDBY, transcript full of the work just done. Cut to **`end-card.png`** (wordmark, repo URL, Dragon Forge AI · Cardiff, the doctrine line) — or dissolve the end card over the reactor. Voice: the last narration line. | The end card, full frame, 4 s minimum. | Nothing else. | — | — |

**Title card.** The hero has no opening card by design. Use `title-card.png`
as the poster frame / thumbnail and as the 0.5-second opening frame of each
cutdown.

**Audio.** Voice track = the claw's Piper output (`claw-voice.wav`) laid under
the picture, plus the two in-shot lines he says on his own (*"Preview on the
glass, sir."*, *"Requesting authorisation, sir."*) which are already on that
track because they came out of the same speakers. No music bed under the
refusal; a low bed elsewhere is fine. No stingers, no whooshes.

---

## Cutdowns — three × 15 s, 1920×1080, same takes

Each opens on `title-card.png` for 0.5 s, closes on `end-card.png` for 2 s,
and uses the 40-word narration in `NARRATION.md` cut to fit, or no narration
and a caption. Captions are IBM Plex Mono, cyan on ink, lower third, one line.

### 1. The approval card (from shot 3)

0.5 s title · ask typed (2 s, real speed) · card appears, *"Requesting
authorisation, sir."* (hold 5 s — the command must be readable on a phone) ·
mouse to EXECUTE, press (2 s) · `✓ run_command complete` and his reply (3 s) ·
end card. Caption over the hold: `Consequences wait for a human.`

### 2. The refusal (from shot 6)

0.5 s title · the ask typed (2 s) · `▸ run_command: rm -rf ~/claw-demo` chip
(hold 3 s) · his reply (5 s) · if you got the `rm -r` card: DENY (2 s) · end
card. Caption over the chip: `rm -rf. Refused in code, not in config.` —
**only** if the chip is in the take (see *Getting the refusal*). If the take
is a prose refusal, the caption is `He said no.` and nothing about code.

### 3. The site build at 4× (from shots 2 and 4)

0.5 s title · ask typed at real speed (2 s) · the chip cascade at **4×** (5 s
— use the raw take, speed it in the edit, do not skip frames by hand) · the
`preview` chip and the viewport opening at real speed (2 s) · one pass of the
scroll in the real browser at 1.5× (3 s) · spend chip, one beat (1 s) · end
card. Caption over the 4×: `4× speed. One ask.` — the speed-up is declared on
screen, always.

---

## Things the edit must not do

- Speed up the approval card. The whole point is the pause.
- Trim the cascade so the site looks instant. Declare the speed-up.
- Paste tool-result text into the frame as if the HUD had shown it.
- Colour-grade the HUD. It is `#0a111c`/`#35d6ed` already; that is the brand.
- Add a logo animation. The Forge Claw does not rotate, spin, or draw on.
- Use a rendered voice that is not his. Piper, `en_GB-alan-medium`, or the
  founder — nothing else.
