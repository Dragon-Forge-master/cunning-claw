# Local Git Review Skill — Architecture

Automated commit and branch review on the operator's machine, using local models through
git hooks. No code leaves the box.

---

## 1. The central design decision

A local 7B model reviewing a diff will produce confident, well-written, plausible
findings that are wrong. Not occasionally — routinely. It will tell you a variable
is unused when it is used three lines down, that a `None` check is missing where
the caller guarantees non-null, that a race exists in single-threaded code. Each
finding reads exactly as authoritative as a correct one.

If the tool blocks commits on that output, one of two things happens within a
fortnight: you start reflexively passing `--no-verify`, or you start editing
correct code to satisfy a wrong reviewer. Both are worse than having no tool.

So the architecture splits on **who is allowed to block**:

| Layer | Blocks? | Why |
|---|---|---|
| Deterministic checks — secrets, conflict markers, focused tests, oversized blobs | **Yes** | Zero false positives worth arguing with. A regex either matched `AKIA[0-9A-Z]{16}` or it didn't. |
| Existing linters/type-checkers (ruff, mypy, eslint, gitleaks) | **Yes**, on their own terms | Already trusted, already tuned. The skill defers rather than duplicating. |
| Local model | **Never** | Advisory notes only. Exit code always 0 from this layer. |

The model's job is the narrow band that linters cannot see: does this code do what
the commit says it does, is a failure path swallowed, does this leak a handle. Not
style, not naming, not "consider adding a docstring."

Everything else in this document is downstream of that split.

---

## 2. Where each check runs

Hook placement matters more than it looks, because it determines whether the tool
is felt as help or as friction.

```
git commit ──► pre-commit          deterministic only, <200ms, blocks
            └► prepare-commit-msg  model drafts a message, human edits, never blocks

git push   ──► pre-push            full model review of the branch, advisory
```

**The model does not run on pre-commit.** A 7B review of a five-file change takes
20–90s on CPU. Paying that on every commit trains you to commit less often and in
bigger chunks, which is the opposite of what review tooling should encourage. Once
per push is the right cadence — it maps to the unit you'd actually open a PR for.

**`prepare-commit-msg` is the highest-value use of the model in the whole system.**
Drafting a commit message from a diff is a summarisation task, which small models
are genuinely good at, and the output lands in your editor where you correct it
before it counts. Low stakes, high frequency, immediate payoff. If you only ship
one model-backed hook, ship this one.

---

## 3. Repository layout

```
gitreview/
├── __init__.py
├── diff.py        git plumbing + unified-diff parsing. Knows nothing about models.
├── checks.py      deterministic gates. The only layer permitted to block.
├── engine.py      model backends, prompting, grounding guards, cache.
└── cli.py         entry point + hook installer. Exit codes are the hook contract.

.githooks/         versioned, installed via core.hooksPath
├── pre-commit
├── prepare-commit-msg
└── pre-push

.gitreview/
├── ignore         dismissed findings, by fingerprint — committed
└── cache/         per-blob review results — gitignored
```

Hooks live in a **versioned `.githooks/` directory** with `core.hooksPath` pointed
at it, not in `.git/hooks`. `.git/hooks` isn't cloned, so anything installed there
exists only on the machine that ran the installer.

---

## 4. Git plumbing details that matter

- **Review the index, not the worktree.** `git diff --cached` and `git show :path`.
  A file can have unstaged edits that aren't part of this commit; reviewing the
  worktree reports on code that isn't being committed.
- **Three-dot for branch review.** `base...HEAD` diffs against the merge-base.
  Two-dot includes everything that landed on `main` after you branched, producing
  a review full of other people's work.
- **`-M` for rename detection**, or a moved file reads as a full delete plus a full
  add and the model reviews 800 lines of unchanged code.
- **Exclusions before the model, not after.** Lockfiles, minified bundles, vendored
  trees, and `.env` never reach a prompt. For `.env` this is a security property:
  a staged credential should be caught by the deterministic scanner, not pasted
  into an inference request that lands in a server log.
- **Size checks read the raw staged path list**, not parsed diffs. Binary blobs
  have no hunks and get filtered out of diff parsing entirely — and a 40MB PNG is
  exactly what that check exists to stop.

---

## 5. Grounding guards on model output

`engine.parse_findings` drops any finding that:

1. cites a line number **not in the added set** for that file — catches both
   invented locations and comments on unchanged context lines;
2. uses a category outside the fixed allowlist;
3. is hedged (`might`, `consider`, `ensure that`) without a concrete suggestion —
   this filters the "consider ensuring proper error handling" genre almost entirely;
4. reports confidence below threshold, or is a duplicate by fingerprint.

Findings are capped at five per file, sorted by confidence. Then `temperature=0`
plus a fixed seed makes output reproducible, so a finding you dismissed doesn't
reappear reworded on the next run.

These guards look aggressive and they are. Expect them to discard a substantial
share of raw model output. That is the point — the discarded share is mostly the
part that would have taught you to ignore the tool.

---

## 6. Dismissal is a first-class feature

Every rendered finding prints its fingerprint and the command to dismiss it.
Fingerprints are `sha256(file | category | message-with-digits-normalised)`, stored
in `.gitreview/ignore`, and committed to the repo so the whole team's dismissals
accumulate.

Without this, a recurring false positive is permanent friction and the tool gets
uninstalled. With it, the noise floor drops every week.

---

## 7. Caching

Keyed on `blob hash + model name + prompt version`. A file whose staged content is
unchanged is never re-reviewed, which makes repeated pushes on a branch nearly free
and takes the sting out of the model's latency. Bump `REVIEW_PROMPT_VERSION` when
the prompt changes and the whole cache invalidates cleanly.

---

## 8. Failure modes, and the one that bit during testing

Every one of these is handled in the shipped code:

| Failure | Behaviour |
|---|---|
| Ollama not running | Note printed, deterministic checks still run, exit 0 |
| Model times out | Same |
| Malformed JSON from the model | Salvage attempt, then drop the file's findings |
| Base ref unresolvable | Exit 2, hook treats as proceed |
| Not a git repo | Exit 2, loudly |
| Binary or huge file | No hunks to review; size check catches it separately |

The one worth calling out: during the smoke test, the installed hooks called
`python3 -m gitreview.cli` without the package on the path, which returned exit 1
and **silently blocked every commit in the repo**. A review tool that can brick
committing is a much bigger problem than one that occasionally misses a finding.

The hooks now pin the interpreter and package path at install time and **fail open**
— if `import gitreview` doesn't work, they print a line to stderr and exit 0. Git
must keep working when the tool doesn't. `GITREVIEW_SKIP=1` is an explicit escape
hatch on top of that.

---

## 9. Model selection

| Task | Suggested model | Why |
|---|---|---|
| Branch review | `qwen2.5-coder:7b` or `:14b` | Code-tuned; 14B if there's headroom, the false-positive rate is meaningfully lower |
| Commit messages | `qwen2.5-coder:1.5b` or `llama3.2:3b` | Summarisation; small is fine and fast |

Configure with `GITREVIEW_BACKEND` (`ollama` | `openai`), `GITREVIEW_MODEL`, and
`GITREVIEW_HOST`. The `OpenAICompatModel` backend covers llama.cpp's `llama-server`,
vLLM, and LM Studio without code changes.

Keep `num_ctx` at 8192 and review per file rather than per diff. Stuffing a whole
branch into one context degrades attention badly and produces findings that drift
between files.

---

## 10. Build order

1. `diff.py` + `checks.py` + `pre-commit`. This is a genuinely useful tool on its
   own, with no model involved, and it is where the security value lives.
2. `install-hooks` with `core.hooksPath` and the fail-open preamble.
3. `prepare-commit-msg` with a small model. Fastest payoff.
4. `engine.py` review path on `pre-push`, findings printed but ignored at first —
   run it for a week and read the output without acting on it.
5. Tune the guards and the ignore list against what that week produced.
6. Only then treat model findings as worth reading before you push.

Step 4 is not optional padding. You need a baseline of what the model actually says
about your code before you decide how much to trust it, and that's cheap to gather
while it costs nothing.

---

## 11. Install

```bash
pip install -e .            # or drop gitreview/ on PYTHONPATH
python -m gitreview.cli install-hooks

ollama pull qwen2.5-coder:7b
export GITREVIEW_MODEL=qwen2.5-coder:7b

python -m gitreview.cli staged --fast        # deterministic only
python -m gitreview.cli staged               # + model
python -m gitreview.cli branch --base origin/main
python -m gitreview.cli ignore <fingerprint>
```
