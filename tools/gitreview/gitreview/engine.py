"""
The advisory layer: local model backends, prompting, and — most importantly —
the guards that stop a 7B model's confident inventions reaching the user.

Design rule: nothing this module produces may block a commit. It suggests.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional, Protocol

from .checks import Finding
from .diff import FileDiff

REVIEW_PROMPT_VERSION = "3"


class ModelUnavailable(RuntimeError):
    pass


# --- backends --------------------------------------------------------------- #

class LocalModel(Protocol):
    name: str
    def complete(self, system: str, user: str, *,
                 json_mode: bool = True, timeout: int = 120) -> str: ...


def _post_json(url: str, payload: dict, timeout: int) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        raise ModelUnavailable(f"{url}: {exc.reason}") from None
    except TimeoutError:
        raise ModelUnavailable(f"{url}: timed out after {timeout}s") from None


@dataclass
class OllamaModel:
    name: str = "qwen2.5-coder:7b"
    host: str = "http://127.0.0.1:11434"
    num_ctx: int = 8192

    def complete(self, system: str, user: str, *,
                 json_mode: bool = True, timeout: int = 120) -> str:
        payload = {
            "model": self.name,
            "stream": False,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "options": {
                "temperature": 0,        # review output should be reproducible
                "seed": 7,
                "num_ctx": self.num_ctx,
            },
        }
        if json_mode:
            payload["format"] = "json"
        data = _post_json(f"{self.host}/api/chat", payload, timeout)
        return (data.get("message") or {}).get("content", "")


@dataclass
class OpenAICompatModel:
    """llama.cpp's llama-server, vLLM, LM Studio — anything with /v1."""
    name: str = "local-model"
    host: str = "http://127.0.0.1:8080"
    api_key: str = "not-needed"

    def complete(self, system: str, user: str, *,
                 json_mode: bool = True, timeout: int = 120) -> str:
        payload = {
            "model": self.name,
            "temperature": 0,
            "seed": 7,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        data = _post_json(f"{self.host}/v1/chat/completions", payload, timeout)
        return data["choices"][0]["message"]["content"]


def model_from_env() -> LocalModel:
    backend = os.environ.get("GITREVIEW_BACKEND", "ollama").lower()
    if backend == "ollama":
        return OllamaModel(
            name=os.environ.get("GITREVIEW_MODEL", "qwen2.5-coder:7b"),
            host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"),
        )
    return OpenAICompatModel(
        name=os.environ.get("GITREVIEW_MODEL", "local-model"),
        host=os.environ.get("GITREVIEW_HOST", "http://127.0.0.1:8080"),
    )


# --- prompting -------------------------------------------------------------- #

REVIEW_SYSTEM = """\
You are a code reviewer looking at a single file's diff. You report only defects \
you can point at in the added lines shown.

Report only these categories:
  correctness   — the code does not do what it plainly intends to do
  error-handling— a failure path is unhandled or swallowed
  resource      — a handle, lock, connection or subprocess can leak
  security      — injection, missing authz check, unsafe deserialisation
  api-misuse    — a library or syscall used against its contract

Do NOT report: style, formatting, naming, import order, type annotations, missing \
docstrings, test coverage, or anything a linter already catches. Do NOT suggest \
rewrites for taste. Do NOT comment on code that is only shown as context.

If the diff contains no defect in these categories, return an empty list. An empty \
list is a normal and frequent answer.

Respond with JSON only, no prose:
{"findings": [{"line": <int, a line number from the added lines>,
               "category": "<one of the above>",
               "message": "<one sentence, concrete>",
               "suggestion": "<one sentence, optional>",
               "confidence": <float 0-1>}]}
"""

REVIEW_USER = """\
File: {path}
Commit intent: {intent}

Added line numbers you may cite: {allowed}

Diff:
```
{diff}
```
"""

COMMIT_MSG_SYSTEM = """\
Write a git commit message for the staged diff.

Format:
  <type>(<scope>): <subject, imperative mood, <=72 chars>

  <body: what changed and why, wrapped at 72 columns, omit if the subject says it all>

type is one of: feat fix refactor perf test docs build ci chore
Describe what the change does, not what files were touched. No emoji. No trailing \
period on the subject. Output the message only, no fences and no commentary.
"""


# --- grounding guards ------------------------------------------------------- #

VALID_CATEGORIES = {
    "correctness", "error-handling", "resource", "security", "api-misuse",
}

HEDGE_RE = re.compile(
    r"(?i)\b(?:might|may|could|possibly|potentially|consider|perhaps|"
    r"it (?:is|seems) (?:possible|likely)|ensure that|make sure)\b"
)


def _extract_json(raw: str) -> dict:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-z]*\n|\n```$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            return {}
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return {}


def parse_findings(raw: str, fd: FileDiff, *,
                   min_confidence: float = 0.6,
                   max_per_file: int = 5) -> list[Finding]:
    """
    Every guard here exists because a small local model reliably fails that way.
    Do not remove them to "get more findings" — the noise is what kills adoption.
    """
    data = _extract_json(raw)
    items = data.get("findings")
    if not isinstance(items, list):
        return []

    allowed = fd.added_line_numbers
    out: list[Finding] = []
    seen: set[str] = set()

    for item in items:
        if not isinstance(item, dict):
            continue
        category = str(item.get("category", "")).strip().lower()
        if category not in VALID_CATEGORIES:
            continue                                    # invented category

        try:
            line = int(item.get("line"))
        except (TypeError, ValueError):
            continue
        if line not in allowed:
            continue                                    # hallucinated location,
                                                        # or a comment on context

        message = str(item.get("message", "")).strip()
        if len(message) < 12:
            continue
        if HEDGE_RE.search(message) and not item.get("suggestion"):
            continue                                    # vague "consider ensuring"

        try:
            confidence = float(item.get("confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5
        if confidence < min_confidence:
            continue

        finding = Finding(
            file=fd.path, line=line, severity="note", category=category,
            message=message,
            suggestion=(str(item["suggestion"]).strip()
                        if item.get("suggestion") else None),
            source="model", confidence=confidence,
        )
        fp = finding.fingerprint()
        if fp in seen:
            continue
        seen.add(fp)
        out.append(finding)

    out.sort(key=lambda f: -f.confidence)
    return out[:max_per_file]


# --- cache ------------------------------------------------------------------ #

class ReviewCache:
    """Keyed on blob hash + prompt version, so unchanged files are never re-reviewed."""

    def __init__(self, root: Path):
        self.dir = Path(root) / ".gitreview" / "cache"
        self.dir.mkdir(parents=True, exist_ok=True)

    def _key(self, blob: str, model: str) -> Path:
        h = hashlib.sha256(
            f"{blob}|{model}|{REVIEW_PROMPT_VERSION}".encode()
        ).hexdigest()[:16]
        return self.dir / f"{h}.json"

    def get(self, blob: str, model: str) -> Optional[list[dict]]:
        p = self._key(blob, model)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            return None

    def put(self, blob: str, model: str, findings: list[Finding]) -> None:
        try:
            self._key(blob, model).write_text(
                json.dumps([asdict(f) for f in findings])
            )
        except OSError:
            pass


class IgnoreList:
    """Dismissed findings, by fingerprint. A false positive should die once."""

    def __init__(self, root: Path):
        self.path = Path(root) / ".gitreview" / "ignore"
        self._fps: set[str] = set()
        if self.path.exists():
            for line in self.path.read_text().splitlines():
                line = line.split("#", 1)[0].strip()
                if line:
                    self._fps.add(line)

    def __contains__(self, finding: Finding) -> bool:
        return finding.fingerprint() in self._fps

    def add(self, finding: Finding) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as fh:
            fh.write(f"{finding.fingerprint()}  # {finding.file}: {finding.message}\n")
        self._fps.add(finding.fingerprint())


# --- orchestration ---------------------------------------------------------- #

def review_files(files: list[FileDiff], model: LocalModel, root: Path, *,
                 intent: str = "(not stated)",
                 max_files: int = 20,
                 timeout: int = 120,
                 use_cache: bool = True) -> tuple[list[Finding], list[str]]:
    """Returns (findings, notes). Never raises on model failure — degrades."""
    from .diff import blob_hash

    cache = ReviewCache(root) if use_cache else None
    ignores = IgnoreList(root)
    findings: list[Finding] = []
    notes: list[str] = []

    ranked = sorted(files, key=lambda f: -f.added_count)[:max_files]
    if len(files) > max_files:
        notes.append(f"reviewed the {max_files} largest of {len(files)} changed files")

    for fd in ranked:
        blob = blob_hash(fd.path, cwd=str(root))
        if cache and blob:
            hit = cache.get(blob, model.name)
            if hit is not None:
                findings.extend(Finding(**f) for f in hit)
                continue

        prompt = REVIEW_USER.format(
            path=fd.path,
            intent=intent,
            allowed=", ".join(str(n) for n in sorted(fd.added_line_numbers)[:200]),
            diff=fd.render()[:24000],
        )
        started = time.monotonic()
        try:
            raw = model.complete(REVIEW_SYSTEM, prompt, timeout=timeout)
        except ModelUnavailable as exc:
            notes.append(f"model unavailable ({exc}); deterministic checks only")
            break
        elapsed = time.monotonic() - started

        parsed = parse_findings(raw, fd)
        if elapsed > 30:
            notes.append(f"{fd.path} took {elapsed:.0f}s")
        if cache and blob:
            cache.put(blob, model.name, parsed)
        findings.extend(parsed)

    return [f for f in findings if f not in ignores], notes


def draft_commit_message(files: list[FileDiff], model: LocalModel, *,
                         timeout: int = 60) -> Optional[str]:
    body = "\n\n".join(fd.render()[:6000] for fd in files[:12])
    try:
        raw = model.complete(COMMIT_MSG_SYSTEM, body, json_mode=False, timeout=timeout)
    except ModelUnavailable:
        return None
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-z]*\n|\n```$", "", text).strip()
    lines = [ln.rstrip() for ln in text.splitlines()]
    if not lines or not lines[0]:
        return None
    if len(lines[0]) > 72:
        lines[0] = lines[0][:69].rstrip() + "..."
    return "\n".join(lines)
