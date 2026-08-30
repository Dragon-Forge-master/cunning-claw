# Cunning Claw — Brand

The visual identity, its reasons, and its rules. The verbal identity (the Swyn,
the doctrine line, the lexicon) lives in [SWYN.md](SWYN.md); this file is the
eyes to its voice.

## The primary mark: the Forge Claw

A dragon's claw gripping an anvil, scales on the wrist, a gear in the base.
Chosen by the founder; it says *Dragon Forge* and *work gets done here* in a
single image — a trade sign, in the tradition of hanging an anvil over the
smithy door.

Provenance, stated per the epistemic firewall: the illustration was generated
by Gemini at Chris's direction (original plate kept at
[`assets/forge-mark-original.jpeg`](assets/forge-mark-original.jpeg)) and
traced to vector locally with vtracer. The claw grips the anvil; it does not
crush it — the forge serves the work.

Files: [`assets/forge-mark.svg`](assets/forge-mark.svg) (master,
`currentColor` — inherits when inlined) ·
[`assets/forge-mark-cyan.svg`](assets/forge-mark-cyan.svg) (explicit cyan for
`<img>` on dark grounds) ·
[`assets/logo-lockup.svg`](assets/logo-lockup.svg) (mark + wordmark).

**Size floor: 48px.** Below that the illustration turns to mud — hand small
sizes to the secondary mark.

## The secondary mark: the spark triskele

Three hooked talons in rotation around the spark
([`assets/mark.svg`](assets/mark.svg), [`assets/mark-mono.svg`](assets/mark-mono.svg))
— one talon per ward: *y ffens*, *y llw*, *y sarff*. Its job is the small
squares the Forge Claw cannot survive: favicons, app icons, avatars, 16–48px.
Below 16px, the spark (ring + dot) stands alone.

The Forge Claw has its own ASCII kin for monospace contexts where an image
cannot go: the boot banner's block-glyph art (`src/banner.ts`), derived
pixel-for-pixel from `forge-mark.svg` — same dragon, same anvil, same grip.
Where even that is too tall (nav bars, commit art, one-line contexts), the
triskele's glyph `▟█▙` stands in.

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

1. **One orientation each.** The Forge Claw grips down-left onto the anvil;
   the triskele's first knuckle sits upper-left. Never rotate, mirror, or
   animate either spinning.
2. **Clear space**: a quarter of the mark's width on all sides.
3. **The Forge Claw is the face everywhere it can be seen** — founder's
   ruling: navs, banners, sites, print, down to ~24px. The triskele serves
   only the square tiny formats (favicons, app icons, 16–48px squares); the
   bare spark below 16px.
4. **One colour at a time.** The Forge Claw is always a single colour — ink
   on light grounds (the stamp), cyan on ink. Never gradients, never outlines
   added. (Note: `currentColor` does not inherit through an `<img>` tag;
   inline the SVG or use the explicit-colour file.)
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
