"""The person's turn: one list of what waits on their input.

The command view (office/command.js) once drew a decision section, a
waiting-sessions section and a review section, each on its own. The person
asked for one list: a decision a brief asks, a session waiting on an answer
or an approval, and finished work to look at, mixed and ordered by how long
each has waited, oldest first. A worker's rows stay together, at the place of
its oldest one, so its decision, its question and its review read as one.

Each row only points at the thing it lists (a brief file, a session id, a
review id): the view keeps drawing the details from /command's `pending`,
`calls` and `reviews`, so a row is never stale against them.
"""

import re
import time
from datetime import datetime


def epoch(v) -> float:
    """A time as the sources write it: epoch seconds or milliseconds, or ISO
    (the brief CLI writes minutes only, 2026-11-08T01:00Z). 0 when unknown."""
    if isinstance(v, bool):
        return 0.0
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else float(v)
    s = str(v or "")
    if re.fullmatch(r".*T\d\d:\d\dZ", s):
        s = s[:-1] + ":00Z"
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def rows(waiting: list[dict], calls: list[dict], reviews: list[dict], workers: dict[str, str], triggers: list[dict] | None = None, now: float | None = None) -> list[dict]:
    """The turn list. `workers`: session id -> worker slug, every coordinator's.
    A decision belongs to the worker its question names, else to a session
    the brief is recorded on; a waiting session to its slug; a review item to
    the worker its id names (an id is the worker slug or a PR). A time not
    known sorts as now: it has waited the least we can tell. `triggers`:
    /command's slx items (office/slx.py); one waits on the person while no
    session of its own is up and no row above carries it (`merged`). They
    follow every decision, session and review, oldest first among themselves."""
    now = time.time() if now is None else now
    slugs = set(workers.values())
    out = []
    for p in waiting:
        d = p.get("decision") or {}
        who = d.get("worker") or next((workers[s] for s in p.get("sessions") or [] if s in workers), None)
        out.append({"kind": "decision", "file": p["file"], "at": epoch(d.get("asked")) or now, "worker": who})
    for c in calls:
        out.append({"kind": "session", "sid": c["sid"], "at": epoch(c.get("since")) or now, "worker": workers.get(c["sid"]) or c.get("slug")})
    for r in reviews:
        out.append({"kind": "review", "coord": r.get("coord"), "id": r["id"], "at": epoch(r.get("updatedAt") or r.get("at")) or now, "worker": r["id"] if r["id"] in slugs else None})

    for x in triggers or []:
        if not x.get("merged") and not x.get("alive"):
            out.append({"kind": "slx", "id": x["id"], "at": epoch(x.get("at")) or now, "worker": None})

    def group(r: dict) -> str:
        return "w:" + r["worker"] if r["worker"] else r["kind"] + ":" + str(r.get("file") or r.get("sid") or r.get("id"))

    first: dict[str, float] = {}
    for r in out:
        first[group(r)] = min(first.get(group(r), r["at"]), r["at"])
    # Triggers come after what a session or a brief already waits on: they
    # are candidates, and a day of Slack mentions (26 rows in the live inbox)
    # would otherwise fill the first rows and push every decision under 더 보기.
    out.sort(key=lambda r: (r["kind"] == "slx", first[group(r)], group(r), r["at"]))
    return out
