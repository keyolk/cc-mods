"""Coordinator ledgers, as the office reads them.

cc-mods writes one ledger per coordinator session
(~/.claude/state/office/coord/<sid>.json, hooks/lib/coord.ts). The office
reads them to draw who works for whom: each live session is the coordinator
itself, an owned or adopted worker of one, or observed (no entry). While a
coordinator is on it adopts every live session by itself (`auto`), so observed
is left for another coordinator's own and the sessions handed back.
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
    """Session id -> its place under a coordinator: `crew` (its live workers)
    for a coordinator, `boss` for a worker. A session can be both (a
    coordinator another one adopted), so the two keys sit side by side."""
    rel: dict[str, dict] = {}
    for d in ledgers():
        name = d.get("name") or d["sid"][:8]
        crew = []
        for w in d.get("workers") or []:
            if w.get("endedAt"):
                continue
            auto = {"auto": True} if w.get("auto") else {}
            crew.append({"sid": w.get("sid"), "slug": w.get("slug"), "relation": w.get("relation") or "owned", "model": w.get("model"), "effort": w.get("effort"), **auto})
            if w.get("sid"):
                rel.setdefault(w["sid"], {})["boss"] = {"sid": d["sid"], "name": name, "relation": w.get("relation") or "owned", "slug": w.get("slug"), "model": w.get("model"), "effort": w.get("effort"), **auto}
        rel.setdefault(d["sid"], {}).update(name=name, crew=crew)
    return rel


def place(rel: dict[str, dict], sid: str) -> dict:
    """The /state fields of one session: `coord` is true for a coordinator,
    `crew` lists its workers, `boss` names the coordinator a worker reports to."""
    r = rel.get(sid) or {}
    return {"coord": "crew" in r, "coordName": r.get("name") if "crew" in r else None, "crew": r.get("crew") or [], "boss": r.get("boss")}


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
