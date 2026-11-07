"""Coordinator ledgers, as the office reads them.

cc-mods writes one ledger per coordinator session
(~/.claude/state/office/coord/<sid>.json, hooks/lib/coord.ts). The office
reads them to draw who works for whom: each live session is the coordinator
itself, an owned or adopted worker of one, or observed (no entry).
"""

import glob
import json
import os
import time

COORD_DIR = os.path.expanduser("~/.claude/state/office/coord")
_cache: dict = {"at": 0.0, "ledgers": []}


def ledgers() -> list[dict]:
    """Ledgers of coordinators that are on, read at most every 2 s."""
    if time.time() - _cache["at"] < 2:
        return _cache["ledgers"]
    out = []
    for f in glob.glob(os.path.join(COORD_DIR, "*.json")):
        try:
            with open(f) as fh:
                d = json.load(fh) or {}
        except (OSError, ValueError):
            continue
        if d.get("on") and d.get("sid"):
            out.append(d)
    _cache.update(at=time.time(), ledgers=out)
    return out


def relations() -> dict[str, dict]:
    """Session id -> its place under a coordinator."""
    rel: dict[str, dict] = {}
    for d in ledgers():
        rel[d["sid"]] = {"role": "coordinator", "name": d.get("name") or d["sid"][:8], "workers": sum(1 for w in d.get("workers") or [] if not w.get("endedAt"))}
        for w in d.get("workers") or []:
            if w.get("endedAt") or not w.get("sid"):
                continue
            rel[w["sid"]] = {"role": w.get("relation") or "owned", "by": d.get("name") or d["sid"][:8], "slug": w.get("slug"), "model": w.get("model"), "effort": w.get("effort")}
    return rel


def view() -> list[dict]:
    """What the office's coordinator view draws: each ledger, newest log last."""
    return [
        {
            "sid": d["sid"],
            "name": d.get("name"),
            "pane": d.get("pane"),
            "limits": d.get("limits"),
            "workers": [w for w in d.get("workers") or [] if not w.get("endedAt")],
            "log": (d.get("log") or [])[-30:],
        }
        for d in ledgers()
    ]
