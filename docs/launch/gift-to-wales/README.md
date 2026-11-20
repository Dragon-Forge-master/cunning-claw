# Rhodd o Gymru · A gift from Wales — launch kit

The idea: innovation made in Wales, given free to Wales first and then to
everyone. "First" is something concrete Chris does, not a restriction on the
software: free one-hour workshops for Welsh libraries, business groups and
chambers of commerce, before anywhere else. The software itself is for
everyone, and its MIT licence means every released version stays free for
good: anyone may use, copy and change it, and a released version's licence
cannot be withdrawn.

Everything here describes **Cunning Claw 0.4.0** ([release notes](../../releases/v0.4.0.md)):
75 tools, 95 connectors, 37 skills, 717 tests, two runtime dependencies, MIT,
alpha. Features not in 0.4.0 appear only as "coming next" (Learn mode, on one
optional slide), or not at all.

**Nothing in this folder has been sent, posted or submitted.**

## The files

| File | What it is | Status |
|---|---|---|
| [PRESS-RELEASE.md](PRESS-RELEASE.md) | "A gift from Wales": headline, standfirst, a 496-word release built on the scam-email demo, two founder quotes, notes to editors, three alternative headlines (business, Welsh-interest, and a brief for the Welsh-language one), and a table of where every claim comes from | Waits for the 0.4.0 release, Chris's approval and the Welsh check |
| `flyer.pdf` (source `flyer.html`, preview `flyer-preview.png`) | A5 portrait flyer: "Made in Wales. Given to everyone, for good.", three benefits, "free to download and start, with a free Google key", a QR code to cunningclaw.com, and the cost and honesty notes | Print-ready; waits for the 0.4.0 release and the Welsh check |
| `flyer-trades.pdf` (source `flyer-trades.html`, preview `flyer-trades-preview.png`) | The same, for trades and small firms, for builders' merchants' and trade counters' noticeboards: "Less paperwork. Nothing sent without your say-so." | As above |
| `workshop-slides.pdf` (source `workshop-slides.html`, preview `workshop-slides-preview.png`) | 16 slides, 16:9, "Using AI safely in your small business": four habits for any AI assistant, the live demo, reading an approval card, an exercise, starting free, the honest bit; slide 16 is the optional "Coming next: Learn mode" | Slides 1 to 12 and 14 to 16 are true today; slides 13 and 15 point at the 0.4.0 download |
| [WORKSHOP-SCRIPT.md](WORKSHOP-SCRIPT.md) | The facilitator's script, minute by minute for one hour, with likely questions and true answers, and the words not to use | Ready; the demo needs rehearsing |
| `workshop-handout.pdf` (source `workshop-handout.html`, preview `workshop-handout-preview.png`) | One A4 page for each learner: the four habits, the three questions before pressing yes, what to do with an email that gives orders (including the NCSC's report address), answers to the exercise, and how to start free | Waits for the 0.4.0 release (its "Try" box) |
| [DEMO-CHECKLIST.md](DEMO-CHECKLIST.md) | The live demo, step by step: the laptop, the free Google key, installing from the 0.4.0 download, approval cards, the scam email, the box, clean-up and what to do when it goes wrong; every "expected" line marked as the code's or the AI's | Waits for the 0.4.0 release |
| `demo/scam-email.eml`, `demo/customers.csv` | The made-up scam email and customer list the demo uses. Every address is on `.example`, which is reserved and never exists | Ready |
| `demo/check-demo.mts` | Runs the real reader, scanner and command classifier on the demo email and fails if any outcome the kit describes has changed: `npx tsx docs/launch/gift-to-wales/demo/check-demo.mts` | Run before each workshop if `src/` has changed |
| [CONTACTS.md](CONTACTS.md) | Who to approach and how: Welsh press, Business Wales, FSB Wales, Chambers Wales South, libraries, Digital Inclusion Wales, Cardiff tech groups, universities, Reddit, awards with 2027 dates. Each route read on the organisation's own site on 20 November 2026, with the URL. Plus a two-week, £70, Wales-only Meta ads test with a stop rule | Research; some routes marked "not verified" |
| `print.css`, `flyer.css` | Shared print look: parchment, ink type, the Forge Claw stamp; the same family as [`../v0.3/print.css`](../v0.3/print.css) | — |
| `qr-cunningclaw.svg` | QR code for `https://cunningclaw.com`, error correction M. Decoded from each rendered PDF on 20 November 2026 to that URL | — |
| `render.cjs` | Renders all four PDFs and their previews; reports anything outside its frame | — |

The slides use [`../v0.3/kit.css`](../v0.3/kit.css) and
`../../assets/forge-mark-cyan.svg`; the print pieces use
[`../v0.3/forge-mark-ink.svg`](../v0.3/forge-mark-ink.svg). Both are reused
in place, not copied.

## Rendering

```bash
node docs/launch/gift-to-wales/render.cjs            # everything
node docs/launch/gift-to-wales/render.cjs slides     # or: flyer, trades, handout
```

Needs Playwright and a Chromium (set `CHROMIUM` if it is not at
`/opt/pw-browsers/chromium`; set `NODE_PATH` to where Playwright is installed
if `require("playwright")` cannot find it), poppler's `pdfinfo` and
`pdftoppm` for page counts and previews, and the network for Google Fonts.

**The QR code** is a static file so that nothing here needs a QR library. It
was made with a throwaway copy of the `qrcode` package, installed outside the
repository, never added to `package.json`. To make it again (from any scratch
folder):

```bash
npm install --prefix /tmp/qrtool --no-save qrcode@1.5.4
node /tmp/qrtool/node_modules/qrcode/bin/qrcode -t svg -e M -q 2 \
  -d '#0a111c' -l '#ffffff' -o docs/launch/gift-to-wales/qr-cunningclaw.svg \
  "https://cunningclaw.com"
```

Then re-render, and scan the printed result with a phone before printing a
batch.

## What waits for what

1. **The v0.4.0 release.** On 20 November 2026 GitHub lists v0.3.0 only, and
   cunningclaw.com offers 0.3.0. The press release, both flyers, slides 13 and
   15, the handout's "Try" box and the demo checklist all describe the 0.4.0
   downloads. They wait until those are published and the site points at
   them. Then re-check the five numbers against the release page.
2. **A Welsh speaker.** Every piece carries "Rhodd o Gymru"; see the next
   section. Nothing with Welsh in it goes out until it is checked.
3. **Welsh-language pitches wait for a Welsh version.** Golwg360, BBC Cymru
   Fyw, BBC Radio Cymru and Newyddion S4C get a release written in Welsh by a
   Welsh speaker, from the brief in PRESS-RELEASE.md (headline 3). Nothing is
   machine-translated. Public bodies hosting a workshop (libraries, councils)
   may also ask for bilingual handouts and slides; those wait for the same
   Welsh speaker.
4. **Chris.** Both quotes are drafts; the workshop offer in the release's
   first paragraph is his commitment to make; every `[bracketed]` item in the
   notes to editors (surname, company number, press contact, Welsh-speaking
   spokesperson, demo availability) is his to fill or delete.
5. **A rehearsed demo** before the first workshop is booked
   ([DEMO-CHECKLIST.md](DEMO-CHECKLIST.md), Part A), and
   `demo/check-demo.mts` passing on the code being demonstrated.
6. **The press goes before the workshop pitches.** Business press on R or
   R+1, Welsh-interest on R+1 or R+2, workshop offers from R+3; dates offered
   from mid-January 2027, so nothing lands in the Christmas weeks.
7. **The Meta ads test** waits for the release, an approved flyer, a
   1080×1080 image made from it (not made here), and the Welsh check.
8. **Awards** wait for evidence: enter only with numbers we can stand behind.
9. **Routes marked "not verified"** in CONTACTS.md (North Wales chamber,
   Cardiff and Swansea libraries, SwanseaCon, Reddit's rules) wait for
   someone to read those pages by hand.
10. **Learn mode** stays "coming next" on slide 16 until it is released. When
    it is, update slide 16 and the script, then re-render.

## Welsh in this kit: to be checked by a Welsh speaker

[`../v0.3/MARKETING-PLAN.md`](../v0.3/MARKETING-PLAN.md) says "Never new
Welsh": use only phrases already on the site. "Rhodd o Gymru" is new, which is
why it is first in this list. Only short set phrases are used, and none was
machine-translated. **Every one is to be checked by a Welsh speaker before
anything is printed, posted or sent.**

| Welsh | Meant as | Where | Note |
|---|---|---|---|
| **Rhodd o Gymru** | A gift from Wales | Both flyers, slides 1 and 15, the handout, the press release headline, the ad copy | **New: to be checked by a Welsh speaker.** Check *rhodd* (rather than another word for gift) and the soft mutation *o Gymru*. Once approved, add it to the marketing plan's list of allowed phrases |
| **Yn lleol yn gyntaf · Caniatâd dynol pan fo canlyniadau** | Local first · human consent where there are consequences | Footer of both flyers and the handout; PRESS-RELEASE.md brief | Already the doctrine line ([SWYN.md](../../SWYN.md)); to be checked by a Welsh speaker all the same, as asked for this kit |
| **dynion hysbys** | the cunning folk (literally "the knowing ones") | Press release body and the Welsh-language brief | From [SWYN.md](../../SWYN.md) and [NAME.md](../../NAME.md); to be checked by a Welsh speaker |
| **llun-gwe**, **sad-llun** | Monday to Friday, Saturday to Monday | PRESS-RELEASE.md brief | Day names the scheduler parses ([SWYN.md](../../SWYN.md)); to be checked by a Welsh speaker |

CONTACTS.md also quotes Welsh from the outlets' own pages (for example
Golwg360's "Datganiadau i'r wasg / stori i Golwg360"). Those are quotations of
their words, given so the right route can be found, not our Welsh.

## Honesty checklist

Tick every line before anything from this folder goes out. The rule is
BRAND.md's rule 8: every claim must survive "how do we know?"

- [ ] **The numbers match 0.4.0**: 75 tools
      (`git show 56c993c:src/tools.ts | grep -c '^    name: "'`), 95
      connectors (`MCP_CATALOGUE.length`), 37 skills (count of
      `workspace/skills/*/SKILL.md`), 717 tests (`npm test`), 2 runtime
      dependencies (`package.json`). If a later release is out, re-count and
      re-render.
- [ ] **Cost**: "free to download and start, with a free Google key", never
      "completely free"; and wherever that line is, the AI brain's cost
      (beyond Google's free allowance, or with a paid key, it is paid to the
      provider) and Google's free-plan data use are beside it.
- [ ] **The box**: Linux yes; Mac built but not yet tested on a real Mac;
      Windows none. Nothing implies otherwise.
- [ ] **Maturity**: "alpha" and "very few users so far" are present wherever
      the product is described at length.
- [ ] **No absolutes about defences**: no "never", "guaranteed",
      "unhackable", "secure" or "safe" without a qualifier; no standard (GDPR,
      ISO, Cyber Essentials, NIST) named as met. In this kit "never" appears
      only as advice to people ("never give it your banking passwords") and in
      the no-token pledge.
- [ ] **The scanner is described as rules that can be got round**, and the
      card as the boundary.
- [ ] **The demo claims match the code**: `demo/check-demo.mts` passes.
- [ ] **Unreleased features** (Learn mode, Pocket Claw, voice notes,
      receipts, the foreman, the website wall) appear only as "coming next",
      or not at all. Today only Learn mode appears, on slide 16, marked
      "Coming next · not in 0.4.0".
- [ ] **No personal data**: no phone numbers, personal email addresses or
      home details for Chris; the release uses `[press contact email]` and
      similar placeholders. Organisations' published routes only.
- [ ] **No statistic, customer, quote, award or partnership we do not have.**
      Connectors are integrations, not partners.
- [ ] **No crypto token, ever.** The flyers, handout and notes to editors say
      so.
- [ ] **Every Welsh phrase** in the table above has been checked by a Welsh
      speaker.
- [ ] **UK English**, plain words.
