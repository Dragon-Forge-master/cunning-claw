# Welsh lessons — needs a Welsh-speaking author

This folder is the Welsh slot for Learn mode. It is empty on purpose.

Every English lesson under `learn/en/` carries `cy: needs-author` in its
frontmatter, and the HUD shows "Welsh version: needs a Welsh-speaking author"
beside it until a file with the same path exists here — for example
`learn/cy/consent/1-reading-a-card.md` for `learn/en/consent/1-reading-a-card.md`.
The check is `welshStatus` in `src/learn-format.ts`.

Why nothing is here yet: the Welsh Government's bilingual technology toolkit
asks for both languages to be equal from the outset, and the Welsh Language
Commissioner's policy statement on AI (July 2025) asks organisations to test AI
systems in Welsh and not to treat AI as an excuse for poor Welsh. A
machine-translated course would fail both. So the lessons are written in Welsh,
by a Welsh speaker, or not at all — see docs/LEARN-MODE.md, "Welsh".

## For the author

- Copy the English file to the same path here and write it in Welsh. Keep the
  frontmatter keys, step headings (`## why`, `## ask cold`, …), step ids,
  option order and `claims:` exactly as they are: the server, the review
  queue and `src/learn.test.ts` read them. Change `cy: needs-author` to
  `cy: authored`.
- The `answer:` keys are matched by code. Write Welsh alternatives, including
  mutated forms (`cyfarwyddiadau`, `gyfarwyddiadau`, `nghyfarwyddiadau`) —
  `src/injection.ts` already handles mutations the same way.
- Use the Swyn names for the wards as they stand in docs/SWYN.md: *y ffens*,
  *y llw*, *y sarff*. Day names in standing orders (`08:00:llun-gwe`) are
  already real syntax.
- The practice scenarios' fixtures are English. The Welsh injection scenario
  should use a Welsh-language planted email, so learners see the scanner's
  Welsh rules catch it; that fixture is part of this job.
- No mixed-language screens, except a deliberate glossary pair.
- Real Welsh only, checked against a dictionary — the rule in docs/SWYN.md.
