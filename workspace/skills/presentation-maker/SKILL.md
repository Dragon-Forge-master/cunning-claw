---
name: presentation-maker
label: Presentations
category: projects
description: Make a presentation — outline first, then speaker notes, then the slides (Gamma or Canva when connected, otherwise a 16:9 HTML deck printed with export_pdf), text checked to fit, licensed images only, optional handout. Use for "make me a deck", a pitch, a talk, a board or funder presentation.
author: cunningclaw
written: 2026-11-20
---

# Presentation maker

A deck is an argument with pictures. Get the argument right before anything
is drawn.

## 1. Brief (two minutes, not twenty)

Ask only what changes the deck: **audience**, **the one thing they should
believe or do afterwards**, **length** (minutes, and so slides — roughly one
a minute), **where it is shown** (a room, a call, sent as a PDF), and any
**brand** (colours, logo file, fonts). Facts and figures come from the
operator or from cited research (the `deep-research` skill) — never
invented, never "illustrative" numbers left in.

## 2. Outline on the Desk — and wait

`write_file` `~/Documents/CunningClaw/<Deck> - outline.md`: one line per
slide — a headline that is a sentence ("Councils lose 30 hours a week to
X"), not a label ("The problem") — and the evidence under it, with its
source. Show the operator; change it until they say go. This is the cheap
place to change their mind.

## 3. Speaker notes

`<Deck> - speaker notes.md` on the Desk: for each slide, what is *said*
(the slide carries the headline and the proof; the voice carries the
story), 60–120 words a slide. Add timings that sum to the slot.

## 4. Build the slides — the best hands that are actually here

`mcp_status` first: which of these is live?

- **Gamma** (decks from an outline) or **Canva** (designs, brand kits,
  exports) connected — read the tool arguments with `mcp_schema`, send the
  outline and notes, and bring back the link or export. Creating a design in
  someone's account is a write: say what you will create before you call it.
  Not connected and the operator wants one? `connector_guide` with "gamma"
  or "canva" gives the real sign-in steps. Do not recite setup from memory.
- **Neither**: write a self-contained HTML deck yourself —
  `~/Documents/CunningClaw/<Deck>/index.html` (a folder per deck, with its
  images beside it):
  - each slide `<section class="slide">…</section>`, designed at
    **1280 × 720 px**; `export_pdf` with `landscape: true` makes each one a
    16:9 page;
  - all CSS in a `<style>` in the head; **no JavaScript** (it is switched
    off when printing) and no iframes;
  - big type — 28 px minimum for body, 48 px+ headlines; one idea a slide;
    at most about 30 words on a content slide;
  - fonts: system fonts, or Google Fonts via a `<link>` (the only web fonts
    the printer will fetch);
  - `preview` with the deck's path puts it on the glass while you work.

## 5. Images — licensed, or not at all

Use only: the operator's own files; images made with `generate_image`
(saved under `workspace/images/`, which `export_pdf` may embed); or openly
licensed images whose licence you have read on the source page — record
the creator, source URL and licence in the speaker notes, and credit on the
slide when the licence asks (CC BY does). Never lift an image from a search
result, a news site or a competitor's page. Local images must sit in the
deck's folder, on the Desk or in `workspace/images/`; others are left out
and the export says so.

## 6. Print and check

1. `export_pdf` with the deck's `index.html` path and `landscape: true`.
2. Read the result line. It names every slide whose text **runs past the
   edge** and says if slides spilled onto extra pages — fix those slides
   (fewer words, smaller type, split the slide) and export again until it
   names none.
3. `read_document` the PDF to check the words; `open` it so the operator
   can see it.
4. **Handout** (optional): `export_pdf` the speaker-notes document — A4,
   page numbers — or a one-page summary written for the room.

Tell the operator: slide count, run time from the notes, where the PDF and
source are, and anything you could not source.

## Honest limits

- A PDF has no animations, transitions or embedded video; say so if the
  talk relies on them, and offer Gamma or Canva for those.
- A PDF deck is not a .pptx. If the operator needs to edit it in
  PowerPoint, Canva's export (when connected) is the honest route; do not
  promise a .pptx you cannot produce.
- You cannot see how it looks on the venue's projector. The 16:9 page is
  the common shape; ask if the room is 4:3.
