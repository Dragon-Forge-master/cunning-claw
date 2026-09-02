"""
Deterministic checks. These run first, they never produce false positives worth
arguing with, and they are the only checks allowed to block a commit.

They also run *before* anything reaches the model, so a staged credential is
caught rather than being pasted into a prompt and written to an inference log.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Iterable, Optional

from .diff import FileDiff, git

MAX_BLOB_BYTES = 2 * 1024 * 1024


@dataclass
class Finding:
    file: str
    line: Optional[int]
    severity: str          # block | warn | note
    category: str
    message: str
    suggestion: Optional[str] = None
    source: str = "check"  # check | model
    confidence: float = 1.0

    def fingerprint(self) -> str:
        import hashlib
        norm = re.sub(r"\d+", "#", self.message.lower())
        key = f"{self.file}|{self.category}|{norm}"
        return hashlib.sha256(key.encode()).hexdigest()[:12]


# --- secret detection ------------------------------------------------------- #

SECRET_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("slack-token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b")),
    ("stripe-key", re.compile(r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b")),
    ("bearer-literal", re.compile(r"[Bb]earer\s+[A-Za-z0-9._\-]{24,}")),
]

ASSIGN_RE = re.compile(
    r"""(?ix)
    \b(?P<name>[A-Za-z0-9_\-\.]*(?:secret|token|passwd|password|api[_\-]?key|
        access[_\-]?key|private[_\-]?key|credential|auth)[A-Za-z0-9_\-\.]*)
    \s*[:=]\s*
    (?P<quote>['"])(?P<value>[^'"\n]{12,})(?P=quote)
    """
)

PLACEHOLDER_RE = re.compile(
    r"(?i)^(?:x{4,}|\.{3,}|<[^>]+>|\$\{[^}]+\}|change[_\-]?me|your[_\-]|"
    r"placeholder|example|dummy|test|fake|redacted|todo|null|none|process\.env)"
)


def _shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    counts = {c: s.count(c) for c in set(s)}
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def scan_secrets(files: Iterable[FileDiff]) -> list[Finding]:
    out: list[Finding] = []
    for fd in files:
        for hunk in fd.hunks:
            for lineno, text in hunk.added_lines():
                for name, pat in SECRET_PATTERNS:
                    if pat.search(text):
                        out.append(Finding(
                            file=fd.path, line=lineno, severity="block",
                            category="secret",
                            message=f"Looks like a committed credential ({name}).",
                            suggestion="Move it to an environment variable or a "
                                       "secrets store, then rotate it — staging it "
                                       "at all means it may already be recoverable.",
                        ))
                        break
                else:
                    m = ASSIGN_RE.search(text)
                    if m:
                        value = m.group("value")
                        if (not PLACEHOLDER_RE.match(value)
                                and _shannon_entropy(value) >= 3.4):
                            out.append(Finding(
                                file=fd.path, line=lineno, severity="block",
                                category="secret",
                                message=f"High-entropy literal assigned to "
                                        f"'{m.group('name')}'.",
                                suggestion="If this is a real credential, remove and "
                                           "rotate it. If not, add it to the "
                                           "allowlist in .gitreview/ignore.",
                            ))
    return out


# --- other deterministic gates ---------------------------------------------- #

# <<<<<<< and >>>>>>> are unambiguous. A bare ======= is also a legitimate
# setext heading underline in Markdown/RST, so it only blocks when the same
# file's added lines contain one of the unambiguous markers too.
CONFLICT_OPEN_RE = re.compile(r"^(?:<{7}|>{7})(?:\s|$)")
CONFLICT_SEP_RE = re.compile(r"^={7}(?:\s|$)")

DEBUG_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("python", re.compile(r"\b(?:breakpoint\(\)|import\s+pdb|pdb\.set_trace\(\))")),
    ("js", re.compile(r"\bdebugger\s*;")),
    ("js", re.compile(r"\bconsole\.(?:log|debug|dir)\s*\(")),
    ("go", re.compile(r"\bfmt\.Print(?:ln|f)?\s*\(")),
    ("rust", re.compile(r"\bdbg!\s*\(")),
]

FOCUS_RE = re.compile(r"\b(?:describe|it|test|context)\.only\s*\(|\bfdescribe\s*\(|\bfit\s*\(")


def scan_markers(files: Iterable[FileDiff]) -> list[Finding]:
    out: list[Finding] = []
    for fd in files:
        added = [(n, t) for h in fd.hunks for n, t in h.added_lines()]
        has_open = any(CONFLICT_OPEN_RE.match(t) for _, t in added)
        for lineno, text in added:
            if CONFLICT_OPEN_RE.match(text) or (has_open and CONFLICT_SEP_RE.match(text)):
                out.append(Finding(
                    file=fd.path, line=lineno, severity="block",
                    category="conflict-marker",
                    message="Unresolved merge conflict marker.",
                ))
            if FOCUS_RE.search(text):
                out.append(Finding(
                    file=fd.path, line=lineno, severity="block",
                    category="focused-test",
                    message="Focused test will silently skip the rest of the suite.",
                ))
            for lang, pat in DEBUG_PATTERNS:
                if pat.search(text):
                    out.append(Finding(
                        file=fd.path, line=lineno, severity="warn",
                        category="debug-statement",
                        message=f"Debug statement left in ({lang}).",
                    ))
                    break
    return out


def scan_blob_sizes(cwd: Optional[str] = None,
                    limit: int = MAX_BLOB_BYTES) -> list[Finding]:
    """
    Reads the raw staged path list rather than the parsed diffs. Binary blobs and
    excluded paths never survive diff parsing, and those are precisely the ones
    that bloat a repo — a 40MB PNG has no hunks to review but every reason to block.
    """
    out: list[Finding] = []
    try:
        listing = git("diff", "--cached", "--name-only", "-z",
                      "--diff-filter=ACMR", cwd=cwd)
    except Exception:
        return out

    for path in filter(None, listing.split("\0")):
        try:
            size = int(git("cat-file", "-s", f":{path}", cwd=cwd).strip())
        except Exception:
            continue
        if size > limit:
            out.append(Finding(
                file=path, line=None, severity="block", category="large-file",
                message=f"{size // 1024}KB staged; over the {limit // 1024}KB limit.",
                suggestion="Use git-lfs, or add it to .gitignore.",
            ))
    return out


def run_all(files: list[FileDiff], cwd: Optional[str] = None) -> list[Finding]:
    return [
        *scan_secrets(files),
        *scan_markers(files),
        *scan_blob_sizes(cwd=cwd),
    ]
