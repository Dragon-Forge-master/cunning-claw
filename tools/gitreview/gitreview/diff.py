"""
Git plumbing and unified-diff parsing.

Everything that touches git lives here. Nothing in this module knows about LLMs.
"""

from __future__ import annotations

import fnmatch
import re
import subprocess
from dataclasses import dataclass, field
from typing import Iterable, Optional

# Paths never worth reviewing, and in the case of .env, never worth putting in
# front of a model at all.
DEFAULT_EXCLUDES = [
    "*.lock", "*-lock.json", "*.lockb", "package-lock.json", "poetry.lock",
    "Cargo.lock", "pnpm-lock.yaml", "yarn.lock", "go.sum",
    "*.min.js", "*.min.css", "*.map",
    "*.svg", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.ico", "*.pdf",
    "*.woff", "*.woff2", "*.ttf", "*.eot",
    "*.snap", "__snapshots__/*",
    "vendor/*", "node_modules/*", "dist/*", "build/*", ".venv/*",
    "*.env", ".env*", "*.pem", "*.key", "*.p12", "*.keystore",
    "*.parquet", "*.csv", "*.sqlite", "*.db",
]

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")


class GitError(RuntimeError):
    pass


def git(*args: str, cwd: Optional[str] = None, stdin: Optional[str] = None) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=cwd, input=stdin,
        capture_output=True, text=True, errors="replace",
    )
    if proc.returncode != 0:
        raise GitError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def repo_root(cwd: Optional[str] = None) -> str:
    return git("rev-parse", "--show-toplevel", cwd=cwd).strip()


def current_branch(cwd: Optional[str] = None) -> str:
    return git("rev-parse", "--abbrev-ref", "HEAD", cwd=cwd).strip()


def _unquote(path: str) -> str:
    """git quotes paths containing specials as "a\\tb"."""
    if path.startswith('"') and path.endswith('"'):
        return path[1:-1].encode().decode("unicode_escape")
    return path


@dataclass
class Hunk:
    old_start: int
    old_len: int
    new_start: int
    new_len: int
    header: str
    lines: list[str] = field(default_factory=list)   # raw, with +/-/' ' prefix

    def added_lines(self) -> list[tuple[int, str]]:
        """[(line number in the new file, text without prefix), ...]"""
        out, lineno = [], self.new_start
        for raw in self.lines:
            if raw.startswith("+"):
                out.append((lineno, raw[1:]))
                lineno += 1
            elif raw.startswith("-"):
                pass
            else:
                lineno += 1
        return out

    def render(self) -> str:
        head = f"@@ -{self.old_start},{self.old_len} +{self.new_start},{self.new_len} @@{self.header}"
        return "\n".join([head, *self.lines])


@dataclass
class FileDiff:
    path: str
    status: str                       # A, M, D, R
    old_path: Optional[str] = None
    is_binary: bool = False
    hunks: list[Hunk] = field(default_factory=list)

    @property
    def added_count(self) -> int:
        return sum(len(h.added_lines()) for h in self.hunks)

    @property
    def added_line_numbers(self) -> set[int]:
        return {n for h in self.hunks for n, _ in h.added_lines()}

    def render(self) -> str:
        head = f"--- {self.old_path or self.path}\n+++ {self.path}"
        return "\n".join([head, *(h.render() for h in self.hunks)])


def _excluded(path: str, patterns: Iterable[str]) -> bool:
    return any(
        fnmatch.fnmatch(path, pat) or fnmatch.fnmatch(path.split("/")[-1], pat)
        for pat in patterns
    )


def parse_unified(text: str, excludes: Optional[Iterable[str]] = None) -> list[FileDiff]:
    excludes = list(DEFAULT_EXCLUDES if excludes is None else excludes)
    files: list[FileDiff] = []
    cur: Optional[FileDiff] = None
    hunk: Optional[Hunk] = None

    for line in text.splitlines():
        if line.startswith("diff --git "):
            cur, hunk = None, None
            # "diff --git a/old b/new" — take the b/ side; rename lines refine it
            m = re.match(r'^diff --git (?:a/)?(.+?) (?:b/)?(.+)$', line)
            if not m:
                continue
            old, new = _unquote(m.group(1)), _unquote(m.group(2))
            cur = FileDiff(path=new, status="M", old_path=old if old != new else None)
            if _excluded(new, excludes):
                cur = None
            else:
                files.append(cur)
            continue

        if cur is None:
            continue

        if line.startswith("new file mode"):
            cur.status = "A"
        elif line.startswith("deleted file mode"):
            cur.status = "D"
        elif line.startswith("rename from "):
            cur.status = "R"
            cur.old_path = _unquote(line[len("rename from "):])
        elif line.startswith("rename to "):
            cur.path = _unquote(line[len("rename to "):])
        elif line.startswith("Binary files ") or line.startswith("GIT binary patch"):
            cur.is_binary = True
        elif line.startswith("@@"):
            m = HUNK_RE.match(line)
            if not m:
                continue
            hunk = Hunk(
                old_start=int(m.group(1)), old_len=int(m.group(2) or 1),
                new_start=int(m.group(3)), new_len=int(m.group(4) or 1),
                header=m.group(5),
            )
            cur.hunks.append(hunk)
        elif hunk is not None and line[:1] in ("+", "-", " "):
            if line.startswith(("+++ ", "--- ")):
                continue
            hunk.lines.append(line)
        elif line.startswith("\\ No newline"):
            continue

    return [f for f in files if f.hunks and not f.is_binary and f.status != "D"]


def staged_diff(context: int = 3, cwd: Optional[str] = None,
                excludes: Optional[Iterable[str]] = None) -> list[FileDiff]:
    """What is actually about to be committed — the index, not the worktree."""
    raw = git(
        "diff", "--cached", "--no-color", "--no-ext-diff", "-M",
        f"--unified={context}", "--diff-filter=ACMR",
        cwd=cwd,
    )
    return parse_unified(raw, excludes)


def branch_diff(base: str = "origin/main", context: int = 3,
                cwd: Optional[str] = None,
                excludes: Optional[Iterable[str]] = None) -> list[FileDiff]:
    """
    Changes this branch introduced since it diverged from base.

    Three-dot is deliberate: `base...HEAD` diffs against the merge-base, so
    commits that landed on base after you branched don't show up as your changes.
    Two-dot here is the classic way to produce a review full of other people's work.
    """
    raw = git(
        "diff", "--no-color", "--no-ext-diff", "-M",
        f"--unified={context}", "--diff-filter=ACMR",
        f"{base}...HEAD", cwd=cwd,
    )
    return parse_unified(raw, excludes)


def staged_content(path: str, cwd: Optional[str] = None) -> str:
    """File as it exists in the index. Not the worktree — those can differ."""
    try:
        return git("show", f":{path}", cwd=cwd)
    except GitError:
        return ""


def blob_hash(path: str, cwd: Optional[str] = None) -> str:
    """Stable cache key for the staged version of a file."""
    try:
        out = git("ls-files", "-s", "--", path, cwd=cwd).split()
        return out[1] if len(out) > 1 else ""
    except GitError:
        return ""


def merge_base(base: str, head: str = "HEAD", cwd: Optional[str] = None) -> str:
    return git("merge-base", base, head, cwd=cwd).strip()


def commits_between(base: str, head: str = "HEAD",
                    cwd: Optional[str] = None) -> list[tuple[str, str]]:
    raw = git("log", "--format=%h%x00%s", f"{base}..{head}", cwd=cwd)
    out = []
    for line in raw.splitlines():
        if "\x00" in line:
            sha, subject = line.split("\x00", 1)
            out.append((sha, subject))
    return out
