# Launch video — narration

The claw's own voice, per `SWYN.md`: a tradesman, not a mystic. Butler
register, dry, short sentences, UK English. He states what he did; he does not
sell. He never says "AI-powered" and never describes himself as an AI at all.

**Who speaks.** Every line below is marked **CLAW** or **FOUNDER**.

- **CLAW** lines are spoken by the software's own voice engine — Piper,
  `en_GB-alan-medium`, the voice `./setup-voice.sh` installs — through
  `POST /api/voice/sample` (recipe in `SHOT-LIST.md`, *The claw's voice, on
  cue*). Record them in a quiet pass and lay them under the picture. Two of
  the lines in the film are not narration at all: *"Preview on the glass,
  sir."* and *"Requesting authorisation, sir."* come out of the software on
  their own during the takes, and stay.
- **FOUNDER** lines are read by a person. There is one, and it is optional.

Word count of the hero script: **155** (limit 190). At a spoken 140–150 words
a minute that is a little over a minute against an 80-second cut, which leaves
the card and the refusal room to breathe.

---

## The 80-second hero

| Time | Speaker | Line |
|---|---|---|
| 0:00 | **CLAW** | At your service, sir. |
| 0:07 | **CLAW** | A website for an MOT garage in Cardiff. Very well. I'll write it, then put it on the glass. |
| 0:19 | **CLAW** | *(after his own "Requesting authorisation, sir.")* This is the part that matters. Anything with a consequence stops here and waits for a human hand. Read it. Then press. |
| 0:31 | **CLAW** | Not a mock-up. A folder on your own machine, served by me. |
| 0:43 | **CLAW** | The figure under the reactor is the bill, to four decimal places. Cheap brains for quiet work; a capable one the moment a stranger's words are in play. |
| 0:53 | **CLAW** | And this I will not run. Not for a web page, and not for you. It's a floor, written in code. Config can add to it. It can't take from it. |
| 1:05 | **CLAW** | Ninety connectors. Lovable, Canva, GitHub. Seeing a name doesn't connect it — Connect does, and the sign-in happens in your own browser. |
| 1:16 | **CLAW** | Cunning Claw. Y dyn hysbys — the knowing one. Local first. Human consent where there are consequences. |

**Optional FOUNDER alternative for 1:16**, if a human should close: *"Cunning
Claw. Built in Cardiff. Local first; human consent where there are
consequences."* — one voice or the other for the sign-off, not both.

### Why each line is allowed

Every sentence is checked against the code, not the pitch.

- *"put it on the glass"* — the `preview` tool serves the folder from the HUD's
  own Express and opens the in-HUD viewport (`src/preview.ts`).
- *"waits for a human hand"* — `run_command` asks for anything not on the
  read-only auto list; the card blocks the turn until EXECUTE, DENY, or the
  180-second timeout (`src/server.ts`, `requestApproval`).
- *"served by me"* — `servePath()` in `src/preview.ts`; no second web server.
- *"to four decimal places"* — the spend chip renders `$${usd.toFixed(4)}`
  (`public/app.js`). No figure is quoted aloud because it is whatever it is.
- *"a capable one the moment a stranger's words are in play"* — the
  trusted-brain guard in `src/routing.ts`; taint is sticky.
- *"Not for you"* — `HARD_DENY` is checked before config and cannot be turned
  off by editing JSON; and `runCommand` returns the BLOCKED result before it
  ever reaches the approval gate, so an approved plan cannot clear a
  denylisted command either (`src/tools.ts`, `classifyCommand`, `runCommand`).
- *"Config can add to it. It can't take from it."* — `denyPatterns` extends
  the floor; nothing in config subtracts from it.
- *"Ninety connectors"* — `MCP_CATALOGUE.length` is 90 (`src/mcp-catalog.ts`);
  Lovable, Canva and GitHub are all on the Popular row.
- *"Seeing a name doesn't connect it"* — the sheet's own hint text, and
  `connectors.js`: Connect writes `mcp.json`; sign-in is `mcp_login` in the
  system browser.
- The sign-off is the doctrine line from `SWYN.md`, English gloss, and the
  strapline from the site.

Nothing here mentions a second machine or an office block. The remote box
exists but is not in the film; the office block is not built.

---

## The 40-word version (cutdowns)

One script, 40 words, for all three cutdowns; cut it to the take you have.

| Speaker | Line |
|---|---|
| **CLAW** | Most assistants will do whatever a web page tells them. I won't. Anything with a consequence stops and waits for your hand. Some commands — rm -rf among them — I will not run at all. Cunning Claw. Local first. |

Per cutdown:

- **Approval card** — sentences 1–3, then "Cunning Claw. Local first."
- **Refusal** — sentences 1, 2 and 4, then "Cunning Claw. Local first."
  Use sentence 4 only if the `rm -rf` chip is in the take (see `SHOT-LIST.md`).
- **Site build at 4×** — no narration; caption only. Or sentence 1 and the
  sign-off, nothing in between.

How Piper pronounces `rm -rf` is a matter for the take — listen to it. If it
stumbles, write it `r m, dash r f` in the text you POST and keep the caption
as `rm -rf`.
