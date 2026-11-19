"""Claude Code's session registry (~/.claude/sessions/<pid>.json), read one
file at a time.

Claude Code rewrites a registry file in place, and a shorter record written
over a longer one leaves the old tail behind: on 2026-11-20, 4 of 23 files
ended with one extra `}` after a complete object, all four sessions alive.
`json.load` refused them and the office called those sessions dead. A file
is read as the first JSON value in it; whatever follows is ignored, and a
file that still does not parse hides only itself."""

import glob
import json
import os

_DECODER = json.JSONDecoder()


def leading_json(raw: str):
    """The first JSON value in raw, or None. Trailing bytes after a complete
    value (a torn rewrite's leftover tail) do not make it unreadable."""
    s = (raw or "").lstrip()
    if not s:
        return None
    try:
        return _DECODER.raw_decode(s)[0]
    except ValueError:
        return None


def load(path: str) -> dict | None:
    """One registry file as a dict, or None when it cannot be read."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            d = leading_json(fh.read())
    except OSError:
        return None
    return d if isinstance(d, dict) else None


def files() -> list[str]:
    # Expanded on each call: a test sets HOME in-process.
    return glob.glob(os.path.expanduser("~/.claude/sessions/*.json"))


def entries() -> tuple[list[tuple[str, dict]], bool]:
    """Every readable record with its file, and whether the folder held any
    file at all (an empty or missing folder is no answer about who is alive)."""
    fs = files()
    out = []
    for f in fs:
        d = load(f)
        if d is not None:
            out.append((f, d))
    return out, bool(fs)
