"""The person's turn: one table, a row a session.

The command view (office/command.js) once stacked a decision section, a
waiting-sessions section, a review section and a sessions-at-work table,
and then one list mixing their items. The person found both too long: "one
table that shows several states at once is better". So a row is a session
(a worker, a coordinator, or any session waiting on them), and its cells
overlay what it holds: the decisions its briefs ask, whether it waits on an
answer or an approval, the finished work put up for a look, or that it is at
work or quiet.

Whose is what:
- a decision: the worker its question names, else a session the brief is
  recorded on that is a worker or waits on the person, else the coordinator
  that asked; a brief with none of these is a row of its own;
- a waiting session: itself;
- a review item: the worker its id names (an id is the worker slug or a PR),
  else the coordinator that put it up (most items are a coordinator's own);
- an slx trigger (a Slack mention, a Meerkat incident; office/slx.py): the
  session it opened, when that has a row (`merged`, shown as 📨N on it);
  with no session, or an ended one, a row of its own (`x:<id>`). One whose
  session runs with no row stays in the slx line under the table.

Rows that need the person come first, the one that has waited longest on
top; a trigger's own row follows them (a trigger is a candidate, and a day of
Slack mentions would otherwise push every decision down); the rest follow by
name. A row only names what it holds (brief files, a
session id, review ids): the view draws the details from /command's
`pending`, `calls` and `reviews`, so an answer that takes one out is seen at
once, before the next poll.
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


def table(waiting: list[dict], calls: list[dict], reviews: list[dict], coords: list[dict], triggers: list[dict] | None = None, now: float | None = None) -> list[dict]:
    """The rows. `coords`: /command's coordinators, each with its workers. A
    waiting time not known counts as now: it has waited the least we can tell."""
    now = time.time() if now is None else now
    rows: dict[str, dict] = {}

    def row(key: str, **info) -> dict:
        r = rows.get(key)
        if r is None:
            r = rows[key] = {"key": key, "sid": None, "name": "", "summary": None, "coord": None, "isCoord": False, "relation": None, "state": None, "live": False,
                             "decisions": [], "call": False, "reviews": [], "slx": [], "at": None}
        for k, v in info.items():
            if v is not None and not r.get(k):
                r[k] = v
        return r

    def waited(r: dict, at: float) -> None:
        r["at"] = at if r["at"] is None else min(r["at"], at)

    by_slug: dict[str, str] = {}
    for c in coords:
        row("s:" + c["sid"], sid=c["sid"], name=c.get("name"), summary=c.get("summary"), isCoord=True, state=c.get("state"), live=c.get("live"))
        for w in c.get("workers") or []:
            if not w.get("sid"):
                continue
            by_slug[w.get("slug") or ""] = w["sid"]
            row("s:" + w["sid"], sid=w["sid"], name=w.get("slug"), summary=w.get("summary"), coord=c["sid"], relation=w.get("relation") or "owned", state=w.get("state"), live=w.get("live"))
    waiting_sids = {c["sid"] for c in calls}
    for c in calls:
        r = row("s:" + c["sid"], sid=c["sid"], name=c.get("slug") or c.get("name"), summary=c.get("summary"), live=True, state="waiting")
        r["call"] = True
        waited(r, epoch(c.get("since")) or now)
    for p in waiting:
        d = p.get("decision") or {}
        sid = by_slug.get(d.get("worker") or "") or next((s for s in p.get("sessions") or [] if "s:" + s in rows and (rows["s:" + s]["relation"] or s in waiting_sids)), None) or d.get("coordinator")
        r = row("s:" + sid, sid=sid) if sid else row("b:" + p["file"], name=p.get("title") or p["file"])
        r["decisions"].append(p["file"])
        waited(r, epoch(d.get("asked")) or now)
    for v in reviews:
        sid = by_slug.get(v["id"]) or v.get("coord")
        r = row("s:" + sid, sid=sid, name=v.get("coordName") if sid == v.get("coord") else None)
        r["reviews"].append([v.get("coord"), v["id"]])
        waited(r, epoch(v.get("updatedAt") or v.get("at")) or now)
    for x in triggers or []:
        if x.get("merged") and "s:" + str(x.get("sid")) in rows:
            rows["s:" + x["sid"]]["slx"].append(x["id"])
        elif not x.get("alive"):
            r = row("x:" + x["id"], name=x.get("from") or x["id"])
            r["slx"].append(x["id"])
            waited(r, epoch(x.get("at")) or now)
    out = list(rows.values())
    for r in out:
        own = r["key"].startswith("x:")
        r["needs"] = bool(r["decisions"] or r["call"] or r["reviews"] or own)
        r["name"] = r["name"] or (r["sid"] or "")[:8]
    out.sort(key=lambda r: (not r["needs"], r["key"].startswith("x:"), r["at"] if r["needs"] else 0, "" if r["needs"] else r["name"]))
    return out
