# Cunning Claw — Brand

The visual identity, its reasons, and its rules. The verbal identity (the Swyn,
the doctrine line, the lexicon) lives in [SWYN.md](SWYN.md); this file is the
eyes to its voice.

## The mark: the triskele claw

Three hooked talons in rotation, gripping a spark.

- **Three talons, three wards.** One each for *y ffens*, *y llw*, *y sarff* —
  the fence, the oath, the serpent. The mark is the safety model drawn.
- **The spark is the hearth** — the user's machine, held but never pierced.
  The talons grip; they do not touch it.
- **The triskele is honest heritage.** Rotational triple-spiral geometry is
  carved at Newgrange (~3200 BC) and runs through Celtic art since. No
  invented lore, no borrowed sigils — per the epistemic firewall, the brand
  makes no claim a museum couldn't back.

Files: [`assets/mark.svg`](assets/mark.svg) (gradient, dark grounds) ·
[`assets/mark-mono.svg`](assets/mark-mono.svg) (one colour, `currentColor`) ·
[`assets/logo-lockup.svg`](assets/logo-lockup.svg) (mark + wordmark).

The terminal glyph `▟█▙` is the mark's ASCII kin — correct in monospace
contexts (boot banner, nav bars, commit art) where an image cannot go.

## Palette

| Token | Hex | Use |
|---|---|---|
| Ink | `#0a111c` | the ground — near-black blue, the claw's glass |
| Ink-2 | `#0e1826` | raised surfaces, cards |
| Cyan | `#35d6ed` | THE brand colour — the reactor, links, the mark |
| Ice | `#7ff0ff` | gradient highlight only, never a text colour |
| Deep cyan | `#1a8ba0` | gradient tail, borders, quiet accents |
| Dragon red | `#e0442e` | one strike per surface — the buy button, the warning |
| Gold | `#f5a623` | caution and honesty notes ("alpha", "no token") |
| Text | `#dfe9f2` | body text on ink |
| Dim | `#8496a8` | secondary text |
| Parchment | `#f2ede3` | light-ground contexts (print, stamps) — mono mark only |

The brand is **dark-first**: ink ground, cyan light. On light/print grounds,
use the mono mark in ink — like a maker's stamp — never the gradient.

## Typography

| Role | Face | Fallback |
|---|---|---|
| Display / headlines | **Fraunces** (600–700) | Georgia, serif |
| Body | **Public Sans** | system-ui, sans-serif |
| Terminal, liturgy, code, wordmark | **IBM Plex Mono** | ui-monospace |

The wordmark is always monospace, letterspaced, cyan on ink. The Welsh
strapline beneath it is dim, wider-spaced, and never larger than a third of
the wordmark height.

## Rules

1. **The mark has one orientation.** Knuckle of the first talon upper-left,
   its tip at upper-right. Never rotate, mirror, or animate it spinning —
   it is a grip, not a fan.
2. **Clear space** around the mark: the spark's diameter on all sides.
3. **Never below 16px.** At 16px it reads as the swirl-and-spark; below that
   use the plain spark (ring + dot) alone.
4. **Gradient on ink only.** Anywhere else — light grounds, single-colour
   print, embroidery — use `mark-mono.svg`. (Note: `currentColor` does not
   inherit through an `<img>` tag; inline the SVG or set the colour in the
   file for those contexts.)
5. **Dragon red strikes once** per page/screen/document. Two red elements on
   one surface means one of them is wrong.
6. **No glow below 64px.** Glow is atmosphere, not identity; small sizes get
   clean edges.
7. **No borrowed symbols.** No /|\, no triple-ray, no runes, nothing from
   another tradition's liturgy or another model's persona. The triskele, the
   talons, the spark, and the Swyn lexicon are the whole symbol set.
8. **Every claim the brand makes must survive "how do we know?"** — same rule
   as the soul. Marketing copy included.

## Voice (summary — SWYN.md and SOUL.md govern)

UK English. Trade register, not mystic register: the cunning folk were
tradespeople. Doctrine line wherever a tagline is wanted:
**Yn lleol yn gyntaf · Caniatâd dynol pan fo canlyniadau** — always with the
English gloss nearby. There is no Cunning Claw token, and there never will be.
