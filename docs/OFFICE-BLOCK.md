# The office block — design and state

**If you are picking this up on another machine:** this is the live design for the
multi-machine upgrade. Phase 1 is built and pushed; everything after it is not.

- Branch: `claude/cunning-claw-repo-m82hzk` (the GitHub branch is the master copy —
  the working copy on the office machine is not).
- Standing gates before any commit: `npm run check` (tsc) and `npm test`
  (296 passing as of 31 Aug 2026). Both must stay green.
- New modules this work added: `src/remote.ts`, `src/remote-watch.ts`,
  `src/workorder.ts`, and the `remote-box` skill.
- Read `SECURITY.md`'s "Design notes for anyone auditing" first. Six claims are
  load-bearing and three of them now depend on code in `src/remote.ts`.


---

## Context

Today Cunning Claw is one practitioner on one machine. That singleness is his
character — but the system prompt states it as a prohibition: *"You are one butler
with several brains… Do not spawn sub-agents or hand work to an imaginary colleague."*

The upgrade keeps the butler and gives him staff. He becomes the **foreman of an
office block**: he takes the job, breaks it up, hands pieces to workers who each have
their own computer, watches the floor, and reports back. You still talk to one person.
You can see everyone working.

Three rules follow, and they decide every choice below:

1. **The butler stays the front of house.** You never manage workers directly.
2. **A worker is hands, not a colleague** — no personality, no chat. It takes a piece
   of work, does it on its own machine, and reports.
3. **The floor must be visible** — that is the board, and it is the feature you will
   actually look at every day.

This is also the paid tier from the distribution plan: the free claw works alone; the
upgrade gives him staff.

### The finding that shapes everything

Two exploration passes turned up something unexpected: **the server's own HTTP surface
is already a complete remote-agent API.** `POST /api/chat`, `GET /api/events` (SSE),
`POST /api/approve`, `POST /api/cancel`, `GET /api/status` — authenticated by a bearer
token each install mints for itself (`src/auth.ts:29-47`).

So a **worker is simply Cunning Claw, installed on its own box, driven by the foreman
over that API.** No new agent to write, no protocol to design, and workers inherit all
64 tools, the approval gates, the denylist and the fencing on day one.

This also dissolves the concurrency problem. The agent core is a hard singleton —
`history`, `busy`, `abortTurn` and `spend` are module-scoped (`src/agent.ts:315-348`),
and so are the *hands*: one Chrome ref table (`src/browser.ts:180-183`), one debug port
9222, one screenshot scale factor, one viewport, one task grant. Running several
workers **in one process** would need all of that made per-instance — roughly 2,500
lines across the largest files in the repo. Running each worker **on its own machine**
makes every one of those collisions disappear, because they are per-machine globals.
"Each with their own computer" is not just the product story; it is the cheapest
architecture available.

### What this deliberately changes

The "no sub-agents" doctrine appears in four places and must be amended on purpose:
`src/agent.ts:76` (SYSTEM_PROMPT), `workspace/AGENTS.md:3`, and the skills
`forge-doctrine/SKILL.md:10` and `code-on-this-machine/SKILL.md:20`. The new rule:
the claw may delegate to workers **that actually exist**, on real machines, whose work
is visible on the board and whose consequential actions still stop at one human.

---

## What you actually get from one £5 droplet

Worth being concrete, because "a computer in the cloud" is vague and some of the gains
are things the product cannot do at all today:

1. **Long work becomes possible at all.** Right now `run_command` waits for the command
   to finish and kills it at the timeout — the code itself tells the model "servers and
   watchers cannot be hosted here, they get reaped at the timeout, every time"
   (`src/tools.ts:1179-1186`). A build, a scrape, a test suite, a dev server: none of
   them can run. On a box with detached jobs they can, and they survive the claw
   restarting, the conversation ending, and your laptop closing.
2. **It doesn't stop when your desk does.** Close the lid and today everything stops —
   heartbeat, schedule, the lot. A droplet is awake at 3am.
3. **Parallel hands.** The desk claw takes one turn at a time; the `busy` guard refuses
   a second (`src/agent.ts:456`). Three boxes is three jobs at once. That is the office.
4. **Blast radius.** A dodgy install, an untrusted repo, a scrape that pulls who-knows-
   what — that happens on a machine you can destroy and rebuild in ninety seconds,
   not on the one holding your email, your customer files and your keys.
5. **It has a real address.** A droplet has a public IP, so a webhook, a demo site or a
   test server actually works. Your desktop behind a home router does not.

And the honest costs: it is another machine to keep patched; it has *less* protection
than your desktop, not more (no undo snapshots, no sensitive-path denylist out there);
once a shell runs on it the HTTP allowlist is meaningless, because `curl` on the box can
reach anything; and each worker costs a box plus its own token spend.

DigitalOcean is a good first target specifically — a basic droplet is a few pounds a
month, and it is plain Ubuntu with ssh on port 22, which is exactly the shape this
design assumes.

## Who sets the box up — the honest split

Yes: the desktop claw controls the workers, and you only ever talk to him. That is the
point of the foreman. Setup is *mostly* his job too, but not all of it, and the gaps are
deliberate rather than missing features:

**He does:** install Node, clone the repo, run `install.sh`, write the worker's config,
start it, health-check it, and afterwards start, stop, restart and update it. All of it
through `remote_run`, each step raising an approval card you can read.

**You do, once per box:**
- **Create the droplet** in DigitalOcean's panel and paste the IP in. Provisioning means
  an API token with billing rights and a spend gate this codebase has nothing like, and
  it collides with `ship-a-site/SKILL.md:107`, which already refuses billing outright.
  Two minutes of clicking buys a much smaller risk surface.
- **Accept the host key once**, by running a single `ssh` command yourself. That is the
  one moment where a human verifies the machine really is the machine — automating it
  away silently deletes the only authentication you have *of the server*.

So the realistic flow is: make the droplet, paste the IP, run one ssh command, then say
*"set up a worker on that box"* and he does the rest. If you later want him creating and
destroying droplets on his own, DigitalOcean's API is the easiest one to add — it is a
single POST — but it wants its own phase, with a spend gate and a hard cap.

## The shape

Two layers, both needed:

- **SSH — the caretaker layer.** Reach a box, install and start a worker, check its
  health, and run plain long jobs. No provisioning: the operator brings a machine that
  already exists (a spare PC, an EC2 instance, a GCE VM, Hetzner, Oracle's free tier).
  Universal, and it needs no provider SDKs and no new dependency.
- **HTTP — the command layer.** Give a worker a job and watch its event stream.

**How many workers: start with 3, cap at 6.** The limit is not the machines — it is
that one human approves everything, thumbnails stay legible to about six, each worker
costs a box plus its own token spend, and the foreman has to hold the floor in its own
context.

**What workers can do — the "superpowers" question.** Every worker is a full claw, so
it already has shell, browser, files and MCP. Specialisation is **configuration, not
code**: a worker profile names its skills, its MCP connectors and its brain. A GitHub
researcher is a worker with the GitHub MCP connected (already in
`src/mcp-catalog.ts:171`) plus a research skill; a builder is one with a beefy box and
a cheap brain. Adding a speciality means adding a profile, never writing a new agent.

---

## Build state — overnight, 31 Aug

**Done and pushed** to `claude/cunning-claw-repo-m82hzk`, 284 tests passing:

- **Phase 1 complete.** `src/remote.ts`, the three tools, config block, the whole
  safety story (floor via `classifyCommand`, fencing, redaction, `remote_*` tainting
  in routing.ts, job index on the sensitive-path list), per-box doctor checks, the
  `remote-box` skill, prompt doctrine and a live box roster. 13 tests.
- **The floor**, on `/board` — every box, every job, state in colour. Plus a HUD
  line when a job starts, finishes or dies.
- **The watcher** (`src/remote-watch.ts`) — finished jobs report themselves rather
  than waiting to be asked, one ssh call per box, hostile logs fenced. 7 tests.
- **Phase 2 unblocked** — `CLAW_DATA_DIR` / `CLAW_CONFIG` / `CLAW_ROOT`, so a second
  claw can run beside the first with its own state. Proven by test.

**Not built, and deliberately:** the worker layer itself — a claw on a box, driven by
the foreman over the HTTP API. It needs a real box to build against; writing
distributed code that cannot be run is how untested software ships. The groundwork is
laid, and one afternoon with a droplet finishes it.

---

## Phase 1 — Make a second machine real

`src/remote.ts` plus three tools. Useful on its own, before any worker exists: it fixes
a limitation the code already complains about — `execIn` reaps everything at
`commandPolicy.timeoutMs`, so servers, builds and watchers **cannot run at all today**
(`src/tools.ts:1179-1186` says so to the model).

- **`remote_run`** — short command on a named box.
- **`remote_job`** — `start | list | status | logs | stop | wait | reap`, following the
  per-action approval pattern of `email_action` (`src/tools.ts:707`, dispatch `:1708`).
  Detached jobs use a POSIX job directory (`cmd`, `pid`, `out`, `err`, `exit`, `ended`)
  launched with `setsid` — no daemon, no agent, works on a Pi in a cupboard.
- **`remote_copy`** — `push | pull`, confined to the box's declared workdir.

Config: a `remote?: { boxes: [...] }` block on `ClawConfig` (`src/config.ts:25-159`),
each box giving `id`, `host`, `user`, `identityFile`, `workdir`. **The model never
supplies a host, a user or an ssh option** — boxes are chosen by id from config. That
single rule is the whole transport safety story: `-o ProxyCommand=…` is local code
execution.

Non-negotiables: `execFile` with an argv array, never `shell: true`; `BatchMode=yes`,
`StrictHostKeyChecking=yes`, `ForwardAgent=no`; every remote command routed through the
existing `classifyCommand` so `HARD_DENY` transfers intact; remote output `redact()`ed
and wrapped in `fenceUntrusted("remote:<box>", …)`; `remote_*` added to
`UNTRUSTED_TOOLS` (`src/routing.ts:24`) so a turn that touches a box takes a trusted
brain. A build log is other people's code talking.

**Never poll a job in a turn.** The Ouroboros guard punishes it (`src/agent.ts:669-703`)
and the watchdog kills it. `start` returns a handle and the turn ends; `wait` covers the
short case in one call; `status` text must be **non-volatile** (bytes and last line, no
free-running clock) or the guard's frozen-answer detection is permanently disabled.

## Phase 2 — Workers

A worker is a Cunning Claw install on a box, started and supervised over SSH, commanded
over HTTP.

Three small blockers to clear first, all in the same place: `DATA_DIR` and `ROOT` are
derived from the module's own location and `claw.config.json` is read from `ROOT`
(`src/config.ts:6,23,161`) with no env override. Add `CLAW_ROOT` / `CLAW_DATA_DIR`
escape hatches. Then: voice off on workers (or several boxes talk at once through one
set of speakers), and the foreman stores each worker's bearer token.

`src/foreman.ts` holds the roster, starts and stops workers, assigns a job by POSTing to
the worker's `/api/chat`, and subscribes to its `/api/events`.

## Phase 3 — The office view

The board is a green field: `src/board.ts` today returns a flat derived object with no
entity that has an owner or a state, no persistence, and no writes — and `public/app.js`
contains no board code at all. Nothing to unpick.

Build the view you described: **a grid of live terminal thumbnails, click one to open it
full-screen.** Each tile is a worker — name, current job, elapsed, the last few lines
streaming, and a clear flag when one is stuck or waiting on you. The data is each
worker's SSE stream, multiplexed by the foreman; `broadcast` (`src/server.ts:93`) gains
a worker id so the HUD can route events per tile.

## Phase 4 — Escalation and approvals

A worker that needs a decision must not auto-approve — the whole safety model depends on
it. The worker's approval request is forwarded to the foreman, who triages and puts it to
you in his own voice, while the board still shows everything raised, including what he
handled himself. Two known gaps to fix here: `cancelPendingApprovals`
(`src/server.ts:144`) currently denies *every* pending approval on any new message, which
would kill other workers' cards; and `broadcast` never reaches Telegram, so a floor you
are away from is currently invisible on your phone.

## Phase 5 — Profiles

Named worker profiles (skills + connectors + brain), so "a GitHub researcher" and "a
build box" are config entries. This is where `draig-digital` and the other Dragon Forge
repos become the workers' actual subject matter.

---

## Verification

Per phase, plus the standing gates (`npm run check`, `npm test`, currently 251 passing).

- **Phase 1, without any box:** pure-logic tests in the repo's established style —
  `sshArgs` produces the exact argv and a command containing `; rm -rf /` arrives as one
  element; `classifyRemoteCommand` replays the whole local `HARD_DENY` table; job-status
  parsing handles running / exited / **pid dead with no exit code**; status text for a
  silent job is byte-identical across calls (the Ouroboros invariant).
- **Phase 1, with a box:** point one at `127.0.0.1` with the operator's own key — that
  exercises the entire path free, including a job surviving a claw restart. Gate it on an
  env var and skip otherwise.
- **Phase 2:** start a worker on a box, assign a one-line job, confirm the foreman sees
  it complete; confirm a worker's approval request reaches the operator and that denying
  it stops the work.
- **Phase 3:** three workers running visibly different jobs, thumbnails updating, click
  through to full screen, one deliberately wedged so the stuck flag shows.
- **Manual matrix** (documented, needs real hardware): job survives laptop sleep and
  `pkill ssh`; box reboots mid-job → reported once as died; host-key change is refused.

## Open items

- **`draig-digital`** — found it (the Welsh spelling), private and not attached to this
  session. First step: attach and read it, to see whether it is a worker's subject
  matter or something the office should be built around.
- **Cloudflare** stays what it is today — Workers and Pages for deploys, driven by
  `wrangler` through the existing skills. A Worker is not a Linux box and cannot host a
  worker; Containers could later, once the SSH path exists to compare against.
- **Provisioning is deliberately out.** Creating and paying for machines needs a
  credential per cloud and a spend gate the codebase has nothing like, and it collides
  with `ship-a-site/SKILL.md:107`, which already refuses billing and DNS.
- **Do not call a box a sandbox.** It has *less* protection than the local machine — no
  `isSensitivePath`, no undo snapshots. The honest doctrine is: the box holds no secrets
  and receives none.
