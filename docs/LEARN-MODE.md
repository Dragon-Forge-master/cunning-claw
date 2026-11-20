# Learn mode — design record

Learn mode is a course, taught inside Cunning Claw, in operating an AI agent
safely and well: directing it, reading a turn, reading an approval card,
knowing what the floor and the sandbox can and cannot stop, spotting a
planted instruction, choosing a brain, knowing what leaves the machine, and
arming one standing order safely. This file says what is built, what is not,
and why each decision went the way it did. The research behind it — sources,
quotations and what could not be confirmed — is the Learn mode research note
of 20 November 2026; the references below are the ones this design leans on.

It has not been measured yet. Until it has, nothing — the HUD, the README, the
site — may say more than what it *does* (BRAND.md rule 8, and §7.9 of the
research): "a course inside the claw, with practice on fake email", not a
claim about how well people learn from it.

## What is built (v1)

| Piece | Where | What it does |
|---|---|---|
| Lesson format and grading | `src/learn-format.ts` (a leaf: `node:` imports only) | Parses `learn/<lang>/<module>/<lesson>.md`; grades answers against the key; Leitner scheduling; `data/learn/progress.json`; the plain-English lint |
| Lesson engine | `src/learn.ts` | The state machine. The server, not the prompt, owns the order of the steps |
| Practice ground | `src/learn-sim.ts` | A simulator installed at `executeTool`; fixture inboxes, documents and a standing-order book; scripted beats; grading from observed clicks |
| Approval registry | `src/approvals.ts` | Real and practice cards. Moved out of `server.ts` so it could be tested |
| Agent hooks | `src/agent.ts` | Sets the conversation aside and restores it; practice turns; a real message ends practice; the step line in the volatile half; one doctrine line |
| Tool | `learn_progress` in `src/tools.ts` | Read-only progress for the model. It cannot start, stop or change anything |
| Routes | `src/server.ts`, `/api/learn/*` | The only way anything in Learn mode starts, moves or stops |
| HUD | `public/learn.js`, `public/index.html`, `public/hud.css` | The LEARN drawer, the lesson view, the practice pane and banner, the PRACTICE stripe on cards, due reviews |
| Content | `learn/en/` (12 lessons), `learn/scenarios/` (5 scenarios), `learn/cy/README.md` | Seven core modules and the capstone |
| Record of Learning | `recordOfLearning` in `src/learn.ts` | A Desk markdown file, printed to PDF through `export_pdf`'s own path |
| Tests | `learn-format`, `approvals`, `learn-sim`, `learn`, `learn-agent` (`.test.ts`) | 67 tests; each safety test was run with its fix reverted and failed |

### The course

Seven core modules and a capstone; the Swyn name is shown where a module
teaches one of the wards (docs/SWYN.md), on the HUD only — never in text the
model reads.

| Module | Lessons | Practice | Mastery check |
|---|---|---|---|
| 1 Talking to it | Bring a job, not a question · Check what came back | — (a planted wrong price in the check) | Choice; spot the wrong line |
| 2 How a turn works (*y sarff*) | Chips, states and STOP | — (a looping transcript in the recall) | Choice |
| 3 Consent (*y llw*) | Reading a card · Silence is a no, and answering from a phone | **Four cards** (levels 1–3) | **Safety-critical:** all four as the key says, the lookalike address denied |
| 4 Plans and the floor | One plan instead of ten cards · The floor and the box | **Which layer stops it?** (level 4) | Predictions, 4 of 5 |
| 5 Strangers' words (*y ffens*) | How a planted instruction works · Invisible ink, sticky taint, and testimony | **The invoice that gives orders** (5) · **The invoice with invisible ink** (6) | **Safety-critical:** the card denied and the attempt reported |
| 6 Brains and money | Picking a brain | — | Choice |
| 7 What leaves the machine | What leaves the machine | — (a guessable ntfy topic in the recall) | Keyed from this install's own settings |
| Capstone (*swyn*) | Arm one standing order, safely | **The email that wants a standing order** (8) | **Safety-critical:** the planted order denied and reported, *and* a real order armed by the learner since the step began (read from `workspace/SCHEDULE.md`) |

Every lesson has the research's four parts in order (§7.2): *why* and a cold
question; the learner's **own real task**, done in the main chat on the real
claw; practice; then a self-explanation, recall with a confidence rating, and
the mastery check. Modules 1, 2, 6 and 7 carry their "practice" as a fixture
inside a question rather than as a practice-ground scenario; that is a v1
shortcut, listed below.

## How a lesson runs

`createLearn` (src/learn.ts) holds the current lesson and step. A step's
prompt, and the text of its options, go to the HUD; its key, hint, worked
example and reveal do not, until the learner has answered (`publicStep`;
tested). A question must be settled before the lesson moves on. A wrong answer
earns the hint, a second the worked example, a third the reveal — never a
lock. A mastery check is settled once and is not retried with the key in view;
a failed check is "practise again later", and only the three safety-critical
checks gate anything (research §2.6, Kulik et al. 1990).

**Grading is code.** A short answer passes when enough groups of its key are
met; an alternative matches as a whole word with a common ending (`limit`
meets `limits`, `to` does not meet `tomato`), or as a stem when written
`rephras*`. A key alternative that is only punctuation is refused when the
lesson is parsed: it normalised to nothing, and nothing is in every answer
(found while writing the floor lesson, whose key contained `&&`). A choice
passes on exactly the right options. A scenario check reads the last run's
clicks and predictions. The "what leaves the machine" check builds its key at
the moment of answering from the install's own settings: the brain in use, the
embeddings choice, Telegram, Discord, ntfy and connectors.

**Facts are held to the code (T1).** Each lesson lists `claims:` in its
frontmatter — `hardDenyCount = 12`, `untrusted = read_email`,
`approvalTimeoutMs = 180000`, `planRefuses = write_file :: workspace/SCHEDULE.md`,
and 62 more. `src/learn.test.ts` has one checker per claim key and runs every
claim against the live code: the floor's pattern count, `classifyCommand`,
`isUntrustedToolName`, `stepIsPermitted`, the injection alarm's card wording,
the practice registry, the sandbox settings, `detectEngine` on a simulated
Windows host, and so on. A claim key with no checker fails the test, so a
lesson cannot state a fact nobody has a way to check; a claim that stops being
true fails the test, so a lesson cannot drift from the product. A test also
asserts that a deliberately wrong value fails, so the checker cannot be
vacuous.

## The practice ground

Real HUD, real cards, real fence, real scanner, real floor — fake world (§7.4).

A scenario (`learn/scenarios/<id>/scenario.json`) is a fixture and a short
script of tool calls ("beats"). Each beat goes through `executeTool` with the
simulator installed in front of every real tool, and its result through
`screenOutput`, exactly as `agent.ts` screens a real result. So the amber
"instructions inside" flag, the turn alarm, and a card's
"— after reading text that tried to give instructions" are the product's own.
Cards are built by the product's card code (`sendEmailStep`,
`classifyCommand`, `armingCardSummary`) and raised as practice cards, with the
same three buttons, so the decision transfers. Wording and card order change
between attempts (`forAttempt`): varied warnings resist habituation
(Anderson et al. 2016).

In the drills the practice claw is scripted to have been fooled, and says so:
the lesson is that the card is the boundary (T13). Once a drill is graded the
learner may talk to the practice claw — a real model turn on the practice
conversation, every tool simulated — and try the dangerous thing on purpose
(error-management training: Keith & Frese 2008).

### Safety requirements and the tests that hold them

Each was checked by reverting the fix and watching the test fail.

| Requirement | How it is enforced | Test |
|---|---|---|
| While a scenario runs, no tool has a real effect; a tool with no fixture is refused, never run | `setPracticeSimulator` at the top of `executeTool`; the simulator answers a fixed set of tools from fixtures and refuses all others with one fixed sentence | learn-sim: "while practice runs, a tool with no fixture is refused…", "run_command in practice is classified by the real floor and never executed", "send_email in practice is carded… nothing is sent", "memory_save in practice goes to practice memory…", "arming a standing order in practice… never touches workspace/SCHEDULE.md" |
| A woken beat after practice ends cannot reach a real tool | The run is marked aborted before the cards are cancelled; `runStep` also refuses unless the simulator is installed | learn-sim: "once the practice ground is closed, a beat refuses to run…"; learn: "a real operator message during practice ends it cleanly…" |
| The real fence, scanner and floor run on fake content | Fixtures are wrapped by `fenceUntrusted` and screened by `screenOutput`; `run_command` uses `classifyCommand` and returns `FLOOR_REFUSAL`, the shell's own sentence | learn-sim: "fixture text goes through the real fence and scanner: a planted </untrusted> cannot close the fence", "hidden characters in a fixture are stripped…", "the floor refuses in practice exactly as outside it", "a practice card raised after injected text carries the real alarm wording" |
| A real plan cannot hide a practice card, and practice cannot use up a real plan's step | `gate()` does not consult the work order while the simulator is installed | learn-sim: "a real plan cannot cover a practice send…" |
| Practice cards are flagged and labelled "PRACTICE · nothing real will happen" | `requestPractice` in `src/approvals.ts` broadcasts `practice: true` and `PRACTICE_LABEL`; the HUD draws the stripe from the flag | approvals: "a practice card is labelled, goes to the HUD only…"; Playwright run below |
| …never go to Telegram, Discord or ntfy | `requestPractice` never calls the phone lines or the alert | approvals: same test |
| …have no timeout (WCAG 2.2.1) | No timer is armed for a practice card | approvals: "a practice card has no timeout; a real one is denied by itself…" |
| …cannot be answered from a phone | `settle(…, { by: "phone" })` refuses a practice id; both phone lines settle through `settleFromPhone` | approvals: "a phone line cannot answer a practice card…"; learn: "practice cards are requested only from the practice ground…" |
| …and "allow for this task" on one grants nothing real | `grantForTask` is called for real cards only | approvals: "ALLOW FOR THIS TASK on a practice card grants nothing real" |
| …and vary their wording | Variants and rotation per attempt | learn-sim: "practice card wording and order vary between attempts…" |
| Only server code from an operator action sets the practice flag — never the model, a tool result or a phone line | The engine is built only in `server.ts`; only `/api/learn/*` routes call it; the hook is handed only to the engine; agent.ts may only clear it; no tool other than the read-only `learn_progress` exists | learn: "only server.ts builds the lesson engine…", "the simulator hook is set only by the Learn controller's server wiring…", "no tool can change Learn state…" |
| Injected text cannot make a real card look like practice | Every real card has the label's words taken out (`defusePracticeClaim`, after stripping format characters) | approvals: "text cannot make a real card look like practice…" |
| History is set aside before a scenario and restored after; taint with it | `setAsideHistory` / `restoreHistory`; nothing from practice is written to `data/history.json` | learn-agent: "practice sets the real conversation aside and restores it exactly — the taint with it" |
| Practice memory and journal stay separate | `memory_save` → `data/learn/practice-memory.json`; practice turns journal to `data/learn/practice-journal/` | learn-sim: "memory_save in practice…"; learn-agent: "practice turns are journaled apart…" |
| A real operator message during practice ends practice cleanly | `runTurn` calls the engine's hook before any non-practice operator turn (HUD, Telegram, Discord, a standing order) and, failing that, clears the hook and restores the conversation itself; `/api/chat` and `/api/reset` end practice first; automatic turns wait | learn-agent: "a real message during practice ends it first…", "automatic turns wait while practice runs…"; learn: "a real operator message during practice ends it cleanly…" |

### Checked against the code: the history snapshot and the taint flag

The research asked for this to be checked before building (§7.4). What the
code says:

- **The trusted-brain taint is not a flag.** `historyIsTainted` in
  `src/routing.ts` reads it from the messages: an `<untrusted` fence, an
  untrusted tool's `tool_use`, an image, or non-template `<recorded>` text.
  So setting the messages aside sets the taint aside, and restoring them
  restores it exactly. `spendSummary().tainted` is read from the same messages.
  Test: learn-agent's first test.
- **The per-turn state is module state.** The injection alarm
  (`src/injection.ts`) and the task grant (`src/consequence.ts`) are cleared at
  the start of every turn; the engine also clears the alarm when practice opens
  and closes. A practice card's "allow for this task" never reaches the grant.
- **The work order is module state too**, and would have let a real plan
  cover a practice send. `gate()` now leaves it alone while practice runs.
- **History is persisted on every turn.** `saveHistory` would have written the
  practice conversation — planted email and all — over `data/history.json`;
  it now writes nothing while the real conversation is set aside, so a crash
  mid-scenario leaves the real one on disk.
- **The coherence guard's turn shapes are persisted** (`data/turn-shapes.json`);
  practice turns do not record theirs.

## Progress and review

`data/learn/progress.json` (the shape in §7.5 of the research), written whole
and renamed into place. Retrieval questions join a Leitner queue on their first
attempt, with the confidence the learner gave: right moves up a box, wrong
drops to box 1; boxes are 0, 1, 3, 7, 16 and 35 days — an expanding schedule
inside the range Cepeda et al. (2008) found. A confident wrong answer on a
safety-critical item re-opens that lesson's practice. Due questions are
interleaved across lessons (Kornell & Bjork 2008).

Review is offered only when something is due: the heartbeat
(`src/heartbeat.ts`) calls the engine on every tick, which emits one
`learn_due` notice a local day at most, and only if the learner switched
reminders on — off by default (T11). It is a file read and a date comparison:
no model turn, no tokens, and the heartbeat's own HEARTBEAT_OK silence is
untouched. The LEARN button shows a count whenever something is due.

## Mapping

Outcomes O1–O8 are the research's (§7.1). The Skills England benchmark's six
skills ([AI foundation skills for work](https://www.gov.uk/government/publications/ai-foundation-skills-for-work/ai-foundation-skills-for-work-benchmark))
are numbered 1–6 in each lesson's `benchmark:` field. The AI Fluency
framework's four Ds (Anthropic with Rick Dakan and Joseph Feller) are named in
each lesson's `fluency:` field. **The AI Fluency framework is licensed CC
BY-NC-SA 4.0 and Cunning Claw is a commercial product: Learn mode maps to it
and cites it, and must never copy its text.**

| Module | Outcomes | Skills England | AI Fluency |
|---|---|---|---|
| Talking to it | O1 | 1, 2, 6 | Description, Delegation, Discernment |
| How a turn works | O2 | 6 | Discernment |
| Consent | O3 | 5 | Diligence |
| Plans and the floor | O4 | 5 | Delegation, Diligence |
| Strangers' words | O5 | 5, 6 | Discernment |
| Brains and money | O6 | 4 | Delegation |
| What leaves the machine | O7 | 4, 5 | Diligence |
| Capstone | O8 | 3 | Delegation (the Agency mode), Diligence |

## The tutor rules

| Rule | v1 enforcement | Evidence (from the research note) |
|---|---|---|
| T1 Facts come only from answer keys checked against the code | Authored keys; `claims:` asserted by `learn.test.ts` | Kestin et al. 2025 (instructor-written answers in the prompt); Bastani et al. 2025 (GPT Base right 51% of the time) |
| T2 One step at a time; the server owns the sequence | `src/learn.ts`; a question must be settled first | Kestin et al. 2025 ("a system prompt could not reliably provide enough structure") |
| T3 Ask before telling; hint, then worked example, then fade | `ladder()`; cold question first | Richland, Kornell & Kao 2009; Sinha & Kapur 2021; Kirschner, Sweller & Clark 2006; Renkl & Atkinson 2003 |
| T4 Never write the learner's request, pre-empt their card, or answer its own question | Keys withheld from the HUD; card decisions only from the learner's click; the step line and doctrine line tell the model so | Bastani et al. 2025; Shen & Tamkin 2026; Fan et al. 2025 |
| T5 Feedback names the task, never the person | `feedback()` reports what the answer covered; debriefs quote the card | Kluger & DeNisi 1996; Hattie & Timperley 2007 |
| T6 Ask "why?" once per scenario | An `explain` step after each practice | Chi et al. 1989; Shen & Tamkin 2026 |
| T7 Confidence before the reveal | `confidence: yes`; the server refuses an answer without it | Bastani et al. 2025; Kornell & Bjork 2008; EEF |
| T8 Plain English, one idea at a time | `lintLesson`: sentences of at most 32 words, paragraphs of at most 80, banned jargon; tested on every lesson | GOV.UK plain-English guidance (via secondary summaries); Kirschner et al. 2006 |
| T9 Errors welcome, blameless debriefs; reporting is the win | Debriefs say what the card said; the report step is graded | Keith & Frese 2008; NCSC phishing guidance |
| T10 Interleaved spaced review | `dueItems`; review in the LEARN drawer | Cepeda et al. 2006, 2008; Dunlosky et al. 2013; Kornell & Bjork 2008 |
| T11 Offer, don't nag | One heartbeat notice a day at most, opt-in | Oreopoulos & Low, NBER w35620; Ryan & Deci 2000 |
| T12 Fade once mastered | Not yet: a mastered lesson is not taught again unless chosen, but the step line does not yet tell the model to stop explaining it | Kalyuga et al. 2003 |
| T13 Name the tutor's own fallibility early | Lesson 1.2 and every drill's "the practice claw was fooled" | De Simone et al. 2025 (World Bank WP 11125); NCSC 2025 |
| T14 Fixture text is untrusted | Fenced, scanned, under the real untrusted tool names | CONTRIBUTING.md invariant 2 |
| T15 Only the operator starts, pauses or ends Learn mode | HUD routes only; tests above | The threat model |

## Welsh

Every lesson carries `cy: needs-author`, and the HUD says "Welsh version:
needs a Welsh-speaking author" when Cymraeg is chosen. `learn/cy/README.md`
is the author's brief. Nothing is machine-translated: the Welsh Government's
bilingual toolkit asks for both languages to be equal from the outset, and
the Welsh Language Commissioner's AI statement (July 2025) asks organisations
to test AI systems in Welsh. A half-Welsh course would meet neither. The
language choice is saved in the progress file; the lessons fall back to
English with the notice, rather than mixing languages on one screen.

## Deferred

- **Teacher and trainer track** (§7.7): facilitator guide, classroom machine,
  pairs, trainer review of capstone paragraphs.
- **Levels 7 and 9** of the scenario progression: an authority spoof with a
  plan in force, and the busy morning of four ordinary cards and one bad one.
- **Module 0**: placement questions and testing out of lessons; the learner's
  running real task is saved, but not yet asked for at the start.
- **Welsh lessons**, a Welsh-language planted email, testing each brain's
  Welsh before it tutors in Welsh, and a Welsh read-aloud voice (not confirmed
  to exist).
- **The measurement study** (§7.9): parallel pre/post forms, the delayed
  check, time-to-first-real-task, calibration shown to the learner,
  "share my anonymous results", and a waitlist trial with a partner cohort.
  `progress.json` keeps decision times and confidence histories so this can be
  built on, and nothing leaves the machine.
- **A verified Open Badge** (Open Badges 3.0, signed with Ed25519 from
  `node:crypto`), issued by Dragon Forge after a reviewed capstone. The Record
  of Learning says plainly that it is not a certificate.
- **Practice scenarios for modules 1, 2, 6 and 7**, the practice phone pane,
  and the phone-line lesson's one opt-in practice card on the learner's real
  phone.
- **The connector capstone** (the research offers a standing order *or* a
  connector; v1 builds the standing order).
- **A model-led tutor for the steps themselves.** In v1 the panel delivers
  authored steps and grades them in code; the model coaches the real task
  through the step line and plays the practice claw. Conversational tutoring
  of the questions, with the key in the volatile half, is the next step and
  needs T4 tested against real transcripts first.
- **Offering Learn mode** at the end of first-run setup and just in time, the
  first time a real card appears (§7.6).

## Honest limits

- Keyword grading can be gamed by someone who wants to, and can mark down a
  right answer phrased unexpectedly; the key is in the lesson file for anyone
  who disagrees, and the hint ladder always ends in the reveal.
- The scanner is heuristics. The drills show it catching planted text; the
  lessons say it can be evaded and that the card is the boundary.
- A record made on the learner's own machine proves little to a third party.
- No learning gain has been measured. The research is clear that design
  decides whether an AI tutor helps or harms (Bastani et al. 2025), and that
  locally made tests flatter (Kulik & Fletcher 2016).

## Adding a lesson

Write `learn/en/<module>/<n>-<slug>.md` in the format above — `why`, `ask`,
`real`, practice, `recall`, `check` — and list every fact it states about the
product under `claims:`. If a fact needs a new kind of check, add a checker to
`CHECKS` in `src/learn.test.ts` first. A practice step names a scenario under
`learn/scenarios/`; a scenario may only use tools the simulator has fixtures
for, and each card beat needs `expect`. `npm test` parses, lints and checks
every lesson.

## References

From the research note, as cited there:
Kestin et al. 2025, *Scientific Reports* (doi:10.1038/s41598-025-97652-6) ·
Bastani et al. 2025, *PNAS* (doi:10.1073/pnas.2422633122) ·
Dunlosky et al. 2013 (doi:10.1177/1529100612453266) ·
Cepeda et al. 2006 (doi:10.1037/0033-2909.132.3.354) and 2008 (doi:10.1111/j.1467-9280.2008.02209.x) ·
Kornell & Bjork 2008 (doi:10.1111/j.1467-9280.2008.02127.x) ·
Kirschner, Sweller & Clark 2006 (doi:10.1207/s15326985ep4102_1) ·
Kalyuga et al. 2003 (doi:10.1207/S15326985EP3801_4) ·
Renkl & Atkinson 2003 (doi:10.1207/S15326985EP3801_3) ·
Richland, Kornell & Kao 2009 (doi:10.1037/a0016496) ·
Sinha & Kapur 2021 (doi:10.3102/00346543211019105) ·
Keith & Frese 2008 (doi:10.1037/0021-9010.93.1.59) ·
Kluger & DeNisi 1996 (doi:10.1037/0033-2909.119.2.254) ·
Hattie & Timperley 2007 (doi:10.3102/003465430298487) ·
Chi et al. 1989 (doi:10.1207/s15516709cog1302_1) ·
Kulik, Kulik & Bangert-Drowns 1990 (doi:10.3102/00346543060002265) ·
Kulik & Fletcher 2016 (doi:10.3102/0034654315581420) ·
Ryan & Deci 2000 (doi:10.1037/0003-066X.55.1.68) ·
Anderson et al. 2016 (doi:10.1080/07421222.2016.1243947) ·
Oreopoulos & Low, NBER w35620 ·
De Simone et al. 2025, World Bank WP 11125 ·
Shen & Tamkin 2026, arXiv 2601.20245 ·
Fan et al. 2025, arXiv 2412.09315 ·
NCSC, [phishing guidance](https://www.ncsc.gov.uk/guidance/phishing) and
[prompt injection is not SQL injection](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection) ·
W3C, [WCAG 2.2](https://www.w3.org/TR/WCAG22/) ·
Welsh Government, [bilingual technology toolkit](https://gov.wales/sites/default/files/publications/2024-11/bilingual-technology-toolkit-for-good-user-experience.pdf) ·
Anthropic, [AI Fluency framework](https://assets.claude.com/b383cf6baddbfc72fdf8b0ed533a518e2872d531.pdf) (CC BY-NC-SA 4.0).
