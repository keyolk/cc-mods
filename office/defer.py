"""Input the person puts off: a session set aside until a time (⏰ 나중에), and
memos left on it instead of being sent (📝 메모).

The person asked for "input I can defer, to look at later". A session that
waits on an answer, a decision or a look can go out of 내 차례 until a time
(1 h, 3 h, tomorrow 9:00, next Monday 9:00, the slx 나중에 choices); a thought
about a session can be kept as a memo and sent to it later, or thrown away.

One file per session, ~/.claude/state/office/defer/<sid>.json:

  {"until": epoch|null, "since": epoch, "seen": [need keys], "ask": digest|null,
   "woke": epoch|null, "memos": [{"id", "text", "at"}]}

- until: set aside until then. `seen` are the needs the row held when it was
  set aside (office/turn.py need_keys); a need not among them (a new
  decision, a new review, a new trigger) brings it back at once, and the
  time is dropped. A wait on the session's own pane is told apart by what it
  asks (`ask`, office.py ask_digest: the dialog on its screen, else the end
  of its last answer), not by when the wait began: a session set aside goes
  on idling, an MCP reconnect or a hook publishes waiting again, and the same
  question asked again is not a new one (live 2026-11-11: gavin-jeong-f1,
  set aside until Monday, was a new `c:<since>` within the hour).
- Quiet everywhere while set aside (deferred_now): the floor's waiting
  queue, the coordinator's wakes (hooks/coord.ts), the MCP auto-reconnect
  (register.ts, whose /mcp reconnect makes the engine fire idle_prompt a
  minute later) and the Notification hook's banner read this folder too.
- woke: the time came. The row is in 내 차례 again (with its memos) until
  the person opens it.
- memos: kept until sent (the session's reply, office.py memo_send) or
  thrown away. A session that ended keeps its file: the view only lists
  live sessions, so its memos are kept, out of sight.

This is not the floor's 미루기 (office.py mute.json): that one hides a
session's call until a time or until the person speaks to it, and lifts on
any prompt. This one is the command view's, and lifts on a new need.
"""

import json
import os
import re
import threading
import time
from datetime import datetime

KINDS = ("defer_set", "defer_clear", "defer_seen", "memo_add", "memo_del", "memo_send")
SID = re.compile(r"^[0-9a-f-]{8,64}$")
MEMO_ID = re.compile(r"^m[0-9a-z]{1,24}$")
DIGEST = re.compile(r"^[0-9a-f]{8,64}$")
# What a session that asked nothing when it was set aside is kept as.
NO_ASK = "0" * 16
# A time: a duration (90m, 3h), or an ISO time (the slx 나중에 choices).
UNTIL = re.compile(r"^(\d{1,4}[mh]|\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d))$")
MAX_AHEAD = 31 * 86400
# The session's reply refuses more (office.py `reply`).
MEMO_MAX = 4000
MEMOS_MAX = 50
SEEN_MAX = 200
# One read-modify-write at a time: a poll's wake beside a memo_add must not drop the memo.
_lock = threading.RLock()


def folder() -> str:
    # Read on each call: a test sets HOME in-process.
    return os.path.expanduser("~/.claude/state/office/defer")


def _path(sid: str) -> str:
    return os.path.join(folder(), sid + ".json")


def _clean(d) -> dict:
    d = d if isinstance(d, dict) else {}
    num = lambda v: float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None  # noqa: E731
    memos = [
        {"id": m["id"], "text": m["text"][:MEMO_MAX], "at": num(m.get("at")) or 0.0}
        for m in d.get("memos") or []
        if isinstance(m, dict) and isinstance(m.get("id"), str) and MEMO_ID.match(m["id"]) and isinstance(m.get("text"), str)
    ]
    ask = d.get("ask") if isinstance(d.get("ask"), str) and DIGEST.match(d.get("ask")) else None
    return {"until": num(d.get("until")), "since": num(d.get("since")), "seen": [s for s in d.get("seen") or [] if isinstance(s, str)][:SEEN_MAX], "ask": ask, "woke": num(d.get("woke")), "memos": memos}


def load(sid: str) -> dict:
    if not SID.match(sid or ""):
        return _clean(None)
    try:
        with open(_path(sid)) as f:
            return _clean(json.load(f))
    except (OSError, ValueError):
        return _clean(None)


def save(sid: str, d: dict) -> None:
    """Written whole (tmp, then replace). Nothing left to keep: the file goes."""
    p = _path(sid)
    if not d.get("until") and not d.get("woke") and not d.get("memos"):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass
        return
    os.makedirs(folder(), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, p)


def held(live: set[str]) -> dict[str, dict]:
    """sid -> its file, for the live sessions that have one."""
    out = {}
    try:
        names = os.listdir(folder())
    except OSError:
        return out
    for n in names:
        sid = n[:-5] if n.endswith(".json") else ""
        if sid in live and SID.match(sid):
            d = load(sid)
            if d["until"] or d["woke"] or d["memos"]:
                out[sid] = d
    return out


def deferred_now(now: float | None = None) -> dict[str, float]:
    """sid -> until, for every session set aside now (its time not come).
    Live or not: a reader outside the office (the Notification hook, a
    coordinator) has no list of live sessions, and an ended one's file
    names nothing that can ring."""
    now = time.time() if now is None else now
    out = {}
    try:
        names = os.listdir(folder())
    except OSError:
        return out
    for n in names:
        sid = n[:-5] if n.endswith(".json") else ""
        if SID.match(sid):
            u = load(sid)["until"]
            if u and u > now:
                out[sid] = u
    return out


def until_of(v: str, now: float | None = None) -> float | None:
    """A time the person picked as epoch seconds; None when it is not one, is
    past, or is more than a month away."""
    now = time.time() if now is None else now
    s = str(v or "")
    if not UNTIL.match(s):
        return None
    if s[-1] in "mh" and s[:-1].isdigit():
        t = now + int(s[:-1]) * (60 if s[-1] == "m" else 3600)
    else:
        try:
            t = datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return t if now < t <= now + MAX_AHEAD else None


def wake(sid: str, why: str, now: float | None = None) -> None:
    """The row comes back: `due`, its time came (it stays up until opened);
    `new`, a need it did not hold came (that need holds it up)."""
    with _lock:
        _wake(sid, why, now)


def _wake(sid: str, why: str, now: float | None) -> None:
    d = load(sid)
    if not d["until"]:
        return
    d.update(until=None, seen=[], since=None, ask=None)
    if why == "due":
        d["woke"] = time.time() if now is None else now
    save(sid, d)


def adopt(sid: str, digest: str) -> None:
    """A deferral kept without `ask` (set before it existed) takes the
    question its session asks now as the one it was set aside on."""
    if not DIGEST.match(digest or ""):
        return
    with _lock:
        d = load(sid)
        if d["until"] and not d["ask"]:
            d["ask"] = digest
            save(sid, d)


def memo(sid: str, mid: str) -> dict | None:
    return next((m for m in load(sid)["memos"] if m["id"] == mid), None)


def memo_del(sid: str, mid: str) -> bool:
    with _lock:
        return _memo_del(sid, mid)


def _memo_del(sid: str, mid: str) -> bool:
    d = load(sid)
    left = [m for m in d["memos"] if m["id"] != mid]
    if len(left) == len(d["memos"]):
        return False
    d["memos"] = left
    save(sid, d)
    return True


def act(body: dict, live: set[str], ask=None) -> tuple[int, dict]:
    """The person's choices on a session (memo_send is office.py's: it is the
    session's reply). `live`: the sessions up now; only those take a new
    deferral or memo, a memo can still be thrown away. `ask`: sid -> what it
    asks now (office.py ask_digest), read by the server when a deferral is
    set, not taken from the page."""
    kind, sid = body.get("kind"), str(body.get("sid") or "")
    if not SID.match(sid):
        return 400, {"error": "bad sid"}
    if kind in ("defer_set", "memo_add") and sid not in live:
        return 404, {"error": "이 세션이 없습니다 (끝났거나 창이 닫혔습니다)"}
    with _lock:
        return _act(kind, sid, body, ask)


def _act(kind, sid: str, body: dict, ask=None) -> tuple[int, dict]:
    d = load(sid)
    if kind == "defer_set":
        until = until_of(body.get("until"))
        if until is None:
            return 400, {"error": "bad until"}
        seen = body.get("seen") if isinstance(body.get("seen"), list) else []
        # Read here, not taken from the page. Asking nothing is kept too
        # (NO_ASK), so a question asked later is new; None is a file from
        # before `ask`, or no reader.
        digest = (ask(sid) or NO_ASK) if ask else None
        d.update(until=until, since=time.time(), seen=[str(s)[:300] for s in seen][:SEEN_MAX], ask=digest if isinstance(digest, str) and DIGEST.match(digest) else None, woke=None)
        save(sid, d)
        return 200, {"ok": True, "until": until, "sent": datetime.fromtimestamp(until).strftime("%m/%d %H:%M") + "까지 미뤘습니다"}
    if kind == "defer_clear":
        d.update(until=None, seen=[], since=None, ask=None, woke=None)
        save(sid, d)
        return 200, {"ok": True, "sent": "다시 올렸습니다"}
    if kind == "defer_seen":
        d["woke"] = None
        save(sid, d)
        return 200, {"ok": True}
    if kind == "memo_add":
        text = str(body.get("text") or "").strip()
        if not text:
            return 400, {"error": "메모가 비었습니다"}
        if len(text) > MEMO_MAX:
            return 400, {"error": f"메모는 {MEMO_MAX}자까지입니다"}
        if len(d["memos"]) >= MEMOS_MAX:
            return 409, {"error": f"메모는 세션당 {MEMOS_MAX}개까지입니다"}
        now = time.time()
        m = {"id": "m" + format(int(now * 1000), "x") + format(len(d["memos"]), "x"), "text": text, "at": now}
        d["memos"].append(m)
        save(sid, d)
        return 200, {"ok": True, "memo": m, "sent": f"메모로 남겼습니다 ({len(d['memos'])}개)"}
    if kind == "memo_del":
        mid = str(body.get("id") or "")
        if not MEMO_ID.match(mid) or not memo_del(sid, mid):
            return 404, {"error": "그런 메모가 없습니다"}
        return 200, {"ok": True, "sent": "메모를 지웠습니다"}
    return 400, {"error": "unknown action"}
