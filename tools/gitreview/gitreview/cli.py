"""
CLI. Also the contract the hooks call, so exit codes matter:

  0  proceed
  1  blocked by a deterministic check
  2  internal error (hooks treat this as "proceed", loudly)

Model findings never produce a non-zero exit.
"""

from __future__ import annotations

import argparse
import os
import stat
import sys
from pathlib import Path

from .checks import Finding, run_all
from .diff import (GitError, branch_diff, commits_between, current_branch,
                   merge_base, repo_root, staged_diff)
from .engine import (IgnoreList, ModelUnavailable, draft_commit_message,
                     model_from_env, review_files)


def checked(files, root) -> list[Finding]:
    """
    Deterministic findings, honouring the committed ignore ledger.

    The ledger used to be consulted only for model findings, so a dismissed
    deterministic finding (a documented example key in a redaction test)
    blocked every commit forever with no recourse but --no-verify — which is
    the habit this whole tool exists to prevent.
    """
    ignores = IgnoreList(root)
    return [f for f in run_all(files, cwd=str(root)) if f not in ignores]

BOLD, DIM, RED, YEL, CYA, OFF = (
    "\033[1m", "\033[2m", "\033[31m", "\033[33m", "\033[36m", "\033[0m"
)

if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
    BOLD = DIM = RED = YEL = CYA = OFF = ""

SEV_STYLE = {"block": (RED, "BLOCK"), "warn": (YEL, "warn"), "note": (CYA, "note")}


def render(findings: list[Finding], notes: list[str]) -> None:
    if not findings:
        print(f"{DIM}gitreview: nothing to report{OFF}")
    by_file: dict[str, list[Finding]] = {}
    for f in findings:
        by_file.setdefault(f.file, []).append(f)

    for path, items in by_file.items():
        print(f"\n{BOLD}{path}{OFF}")
        for f in sorted(items, key=lambda x: (x.line or 0)):
            colour, label = SEV_STYLE.get(f.severity, ("", f.severity))
            loc = f":{f.line}" if f.line else ""
            tag = f"{DIM}[model {f.confidence:.0%}]{OFF}" if f.source == "model" else ""
            print(f"  {colour}{label}{OFF}{loc} {f.category}: {f.message} {tag}")
            if f.suggestion:
                print(f"    {DIM}↳ {f.suggestion}{OFF}")
            print(f"    {DIM}dismiss: gitreview ignore {f.fingerprint()}{OFF}")

    for note in notes:
        print(f"{DIM}note: {note}{OFF}")


def cmd_staged(args) -> int:
    root = Path(repo_root())
    files = staged_diff(cwd=str(root))
    if not files:
        print(f"{DIM}gitreview: nothing staged{OFF}")
        return 0

    findings = checked(files, root)
    notes: list[str] = []

    if not args.fast:
        model_findings, notes = review_files(
            files, model_from_env(), root,
            intent=args.intent or "(not stated)", timeout=args.timeout,
        )
        findings.extend(model_findings)

    render(findings, notes)
    blocked = [f for f in findings if f.severity == "block"]
    if blocked:
        print(f"\n{RED}{len(blocked)} blocking issue(s).{OFF} "
              f"{DIM}Override with git commit --no-verify if you are sure.{OFF}")
        return 1
    return 0


def cmd_branch(args) -> int:
    root = Path(repo_root())
    base = args.base
    try:
        mb = merge_base(base, cwd=str(root))
    except GitError:
        print(f"gitreview: cannot resolve base ref '{base}'", file=sys.stderr)
        return 2

    files = branch_diff(base, cwd=str(root))
    if not files:
        print(f"{DIM}gitreview: no changes vs {base}{OFF}")
        return 0

    commits = commits_between(mb, cwd=str(root))
    intent = "; ".join(s for _, s in commits[:10]) or "(not stated)"
    print(f"{BOLD}{current_branch()}{OFF} vs {base} — "
          f"{len(commits)} commit(s), {len(files)} file(s)")

    findings = checked(files, root)
    notes: list[str] = []
    if not args.fast:
        model_findings, notes = review_files(
            files, model_from_env(), root, intent=intent, timeout=args.timeout,
        )
        findings.extend(model_findings)
    render(findings, notes)
    return 1 if any(f.severity == "block" for f in findings) else 0


def cmd_commit_msg(args) -> int:
    root = Path(repo_root())
    files = staged_diff(cwd=str(root))
    if not files:
        return 0
    msg = draft_commit_message(files, model_from_env(), timeout=args.timeout)
    if msg is None:
        return 0

    if args.file:
        target = Path(args.file)
        existing = target.read_text() if target.exists() else ""
        # Never overwrite a message the human already wrote, or one supplied by
        # -m, an amend, a merge, or a squash.
        body = "\n".join(
            ln for ln in existing.splitlines() if not ln.startswith("#")
        ).strip()
        if body:
            return 0
        target.write_text(
            msg + "\n\n# ^ drafted by gitreview — edit freely or delete\n" + existing
        )
    else:
        print(msg)
    return 0


def cmd_ignore(args) -> int:
    root = Path(repo_root())
    path = root / ".gitreview" / "ignore"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fh.write(f"{args.fingerprint}\n")
    print(f"dismissed {args.fingerprint}")
    return 0


# Shared preamble. The fail-open guard is not optional: a hook that aborts every
# commit because the tool moved, the venv changed, or a dependency broke is worse
# than no hook at all. The tool is advisory infrastructure; git must keep working
# without it.
PREAMBLE = """#!/usr/bin/env bash
GR_PY="${{GITREVIEW_PYTHON:-{python}}}"
export PYTHONPATH="{pkgpath}${{PYTHONPATH:+:$PYTHONPATH}}"
if ! command -v "$GR_PY" >/dev/null 2>&1 || \\
   ! "$GR_PY" -c 'import gitreview' >/dev/null 2>&1; then
  echo "gitreview: not runnable, skipping hook (fix with: gitreview install-hooks)" >&2
  exit 0
fi
[ -n "$GITREVIEW_SKIP" ] && exit 0
"""

HOOK_BODIES = {
    # Fast deterministic gates only. No model, no network, no waiting.
    "pre-commit": """
exec "$GR_PY" -m gitreview.cli staged --fast
""",
    # $2 is the source: message|template|merge|squash|commit. Only draft for a
    # plain interactive commit with no message already supplied.
    "prepare-commit-msg": """
case "$2" in
  message|merge|squash|commit) exit 0 ;;
esac
"$GR_PY" -m gitreview.cli commit-msg --file "$1" || true
exit 0
""",
    # The model review lives here: once per push, not once per commit.
    "pre-push": """
base="${GITREVIEW_BASE:-origin/main}"
while read -r _local_ref local_sha _remote_ref _remote_sha; do
  [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue
  "$GR_PY" -m gitreview.cli branch --base "$base"
  exit $?
done
exit 0
""",
}


def cmd_install(args) -> int:
    root = Path(repo_root())
    hooks_dir = root / ".githooks"
    hooks_dir.mkdir(exist_ok=True)

    pkgpath = Path(__file__).resolve().parent.parent
    preamble = PREAMBLE.format(python=sys.executable, pkgpath=pkgpath)

    for name, body in HOOK_BODIES.items():
        target = hooks_dir / name
        target.write_text(preamble + body)
        target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
        print(f"wrote {target.relative_to(root)}")

    # .git/hooks is not cloned; core.hooksPath makes the versioned dir authoritative.
    from .diff import git
    git("config", "core.hooksPath", ".githooks", cwd=str(root))
    print("set core.hooksPath = .githooks")

    gitignore = root / ".gitignore"
    line = ".gitreview/cache/"
    if not gitignore.exists() or line not in gitignore.read_text():
        with gitignore.open("a") as fh:
            fh.write(f"\n{line}\n")
        print(f"added {line} to .gitignore")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gitreview")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("staged", help="review the index")
    p.add_argument("--fast", action="store_true", help="deterministic checks only")
    p.add_argument("--intent", help="what this change is meant to do")
    p.add_argument("--timeout", type=int, default=120)
    p.set_defaults(fn=cmd_staged)

    p = sub.add_parser("branch", help="review this branch vs a base ref")
    p.add_argument("--base", default=os.environ.get("GITREVIEW_BASE", "origin/main"))
    p.add_argument("--fast", action="store_true", help="deterministic checks only")
    p.add_argument("--timeout", type=int, default=120)
    p.set_defaults(fn=cmd_branch)

    p = sub.add_parser("commit-msg", help="draft a commit message from the index")
    p.add_argument("--file", help="COMMIT_EDITMSG path (hook mode)")
    p.add_argument("--timeout", type=int, default=60)
    p.set_defaults(fn=cmd_commit_msg)

    p = sub.add_parser("ignore", help="dismiss a finding by fingerprint")
    p.add_argument("fingerprint")
    p.set_defaults(fn=cmd_ignore)

    p = sub.add_parser("install-hooks", help="write .githooks and point git at it")
    p.set_defaults(fn=cmd_install)

    args = parser.parse_args(argv)
    try:
        return args.fn(args)
    except GitError as exc:
        print(f"gitreview: {exc}", file=sys.stderr)
        return 2
    except ModelUnavailable as exc:
        print(f"gitreview: {exc}", file=sys.stderr)
        return 0
    except KeyboardInterrupt:
        return 2


if __name__ == "__main__":
    sys.exit(main())
