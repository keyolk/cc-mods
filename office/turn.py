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
top; a trigger's own rows follow them, the most recent first (a trigger is a
candidate, and a day of Slack mentions would otherwise push every decision
down; an old one is the least likely to matter); the rest follow by
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


def table(waiting: list[dict], calls: list[dict], reviews: list[dict], coords: list[dict], triggers: list[dict] | None = None, now: float | None = None, held: dict[str, dict] | None = None) -> list[dict]:
    """The rows. `coords`: /command's coordinators, each with its workers. A
    waiting time not known counts as now: it has waited the least we can tell.
    `held`: the deferrals and memos of live sessions (office/defer.py), each
    with `info` ({name, summary, state}) for a session that has no row."""
    now = time.time() if now is None else now
    rows: dict[str, dict] = {}

    def row(key: str, **info) -> dict:
        r = rows.get(key)
        if r is None:
            r = rows[key] = {"key": key, "sid": None, "name": "", "summary": None, "coord": None, "isCoord": False, "relation": None, "state": None, "live": False,
                             "decisions": [], "call": False, "reviews": [], "slx": [], "mcp": [], "at": None, "needKeys": []}
        for k, v in info.items():
            if v is not None and not r.get(k):
                r[k] = v
        return r

    def waited(r: dict, at: float) -> None:
        r["at"] = at if r["at"] is None else min(r["at"], at)

    def mcp_down(r: dict, m: dict | None) -> None:
        """A session's dropped MCP servers (office.py mcp_state) on its row,
        🔌 in its cells. One its cc-mods could not get back on its own
        (`stuck`) needs the person: the row's 다시 연결 is theirs to press."""
        if r["mcp"] or not m:
            return
        r["mcp"] = [x for x in m.get("dropped") or [] if x.get("server")]
        for x in r["mcp"]:
            if x.get("stuck"):
                r["needKeys"].append("m:" + x["server"])
                waited(r, x.get("since") or now)

    by_slug: dict[str, str] = {}
    for c in coords:
        mcp_down(row("s:" + c["sid"], sid=c["sid"], name=c.get("name"), summary=c.get("summary"), isCoord=True, state=c.get("state"), live=c.get("live")), c.get("mcp"))
        for w in c.get("workers") or []:
            if not w.get("sid"):
                continue
            by_slug[w.get("slug") or ""] = w["sid"]
            mcp_down(row("s:" + w["sid"], sid=w["sid"], name=w.get("slug"), summary=w.get("summary"), coord=c["sid"], relation=w.get("relation") or "owned", state=w.get("state"), live=w.get("live")), w.get("mcp"))
    waiting_sids = {c["sid"] for c in calls}
    for c in calls:
        r = row("s:" + c["sid"], sid=c["sid"], name=c.get("slug") or c.get("name"), summary=c.get("summary"), live=True, state="waiting")
        r["call"] = True
        # A wait is known by when it began: a new wait is a new need.
        r["needKeys"].append("c:" + str(c.get("since") or ""))
        waited(r, epoch(c.get("since")) or now)
    for p in waiting:
        d = p.get("decision") or {}
        sid = by_slug.get(d.get("worker") or "") or next((s for s in p.get("sessions") or [] if "s:" + s in rows and (rows["s:" + s]["relation"] or s in waiting_sids)), None) or d.get("coordinator")
        r = row("s:" + sid, sid=sid) if sid else row("b:" + p["file"], name=p.get("title") or p["file"])
        r["decisions"].append(p["file"])
        open_q = [q.get("id") for q in p.get("questions") or [] if isinstance(q, dict) and not q.get("answer")] or [d.get("id") or "q1"]
        r["needKeys"] += ["d:" + p["file"] + ":" + str(q) for q in open_q]
        waited(r, epoch(d.get("asked")) or now)
    for v in reviews:
        sid = by_slug.get(v["id"]) or v.get("coord")
        r = row("s:" + sid, sid=sid, name=v.get("coordName") if sid == v.get("coord") else None)
        r["reviews"].append([v.get("coord"), v["id"]])
        r["needKeys"].append("r:" + str(v.get("coord")) + "|" + v["id"])
        waited(r, epoch(v.get("updatedAt") or v.get("at")) or now)
    for x in triggers or []:
        if x.get("merged") and "s:" + str(x.get("sid")) in rows:
            rows["s:" + x["sid"]]["slx"].append(x["id"])
            rows["s:" + x["sid"]]["needKeys"].append("x:" + x["id"])
        elif not x.get("alive"):
            r = row("x:" + x["id"], name=x.get("from") or x["id"])
            r["slx"].append(x["id"])
            waited(r, epoch(x.get("at")) or now)
    for sid, h in (held or {}).items():
        info = h.get("info") or {}
        if "s:" + sid not in rows:
            row("s:" + sid, sid=sid, name=info.get("name"), summary=info.get("summary"), state=info.get("state"), live=True)
    out = list(rows.values())
    for r in out:
        own = r["key"].startswith("x:")
        r["needs"] = bool(r["decisions"] or r["call"] or r["reviews"] or own or any(x.get("stuck") for x in r["mcp"]))
        r["name"] = r["name"] or (r["sid"] or "")[:8]
        defer(r, (held or {}).get(r["sid"] or ""), now)
    # Among triggers' own rows the latest receipt is on top; the other rows keep the longest wait on top.
    out.sort(key=lambda r: (not r["needs"], r["key"].startswith("x:"), -r["at"] if r["key"].startswith("x:") else r["at"] if r["needs"] else 0, "" if r["needs"] else r["name"]))
    return out


def defer(r: dict, h: dict | None, now: float) -> None:
    """A row's deferral and memos (office/defer.py), set on the row:
    `memos` (the list), `deferred` (until when, while it is set aside),
    `woke` (its time came and it is not opened yet), `wake` (what
    command.view should write: "due" or "new")."""
    r.update(memos=[], deferred=None, woke=False, wake=None, adopt=None)
    if not h:
        return
    r["memos"] = [{"id": m["id"], "text": m["text"], "at": m.get("at")} for m in h.get("memos") or []]
    until = h.get("until")
    if until:
        if now >= until:
            r["wake"] = "due"
        elif woken(r, h):
            r["wake"] = "new"
        else:
            r["deferred"] = until
            r["needs"] = False
            return
    if r["wake"] == "due" or h.get("woke"):
        # Its time came: up, with its memos, until the person opens it.
        r["woke"] = True
        r["needs"] = True
        if not r["at"]:
            r["at"] = until or h.get("woke") or now


def woken(r: dict, h: dict) -> bool:
    """Whether a row set aside holds a new question or a new approval now:
    the only needs that bring it back before its time (the person: "나중에로
    다음주에 보자고 한 세션의 알림이 계속 오는데"). A new decision on a brief
    (`d:`) is one. A wait on the pane (`c:`) is keyed by when it began, and a
    session set aside keeps publishing waiting (an MCP reconnect, a hook, the
    engine's idle reminder), so it counts only when what it asks changed:
    `askNow` (office.py ask_digest, read now) against `ask` (read when it was
    set aside). With none kept (a file from before `ask`), the one read now
    is adopted (`adopt`, written by command.view) and does not wake it. A
    stuck MCP server (`m:`), a review (`r:`) and an slx trigger (`x:`) wait
    for its time: none is a question the session asks."""
    new = set(r["needKeys"]) - set(h.get("seen") or [])
    if any(k.startswith("d:") for k in new):
        return True
    if not any(k.startswith("c:") for k in new):
        return False
    # askNow "": it asks nothing now (idle after a turn that ended on no
    # question); NO_ASK kept: it asked nothing when it was set aside.
    now_ask, kept = h.get("askNow"), h.get("ask")
    if not now_ask:
        return False
    if not kept:
        r["adopt"] = now_ask
        return False
    return now_ask != kept
