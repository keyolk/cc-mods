"""The slx inbox in the command view (지휘): the Slack mentions and DMs that
look for the person, and the Meerkat incidents, as slx (keyolk/slx) collects
them into one inbox and opens a Claude session per item.

`slx list` prints that inbox as JSON (id, trigger slack|meerkat, from, where,
link, text, received_at, status new|opened|done, the session with its sid and
whether its pane is up, the mute rules). The office reads it, at most every
CACHE_S: each read is a process start. What the person does to a trigger is
slx's own command, which hands it to slx's running TUI (or, with none, writes
its state under its lock):
- 세션 만들기: `slx open <id>`, as the TUI's b key (in the background);
- 무시: `slx done <id>…` (it shows again only on a new mention);
- 이런 것 숨기기: `slx mute -like <id> -by channel|from|service|kind|text`, a
  rule that hides every item like it, now and to come; `slx unmute <rule>`;
- 나중에: `slx snooze <2h|time> <id>…`.
Several ids go in one command: slx leaves their requests at once. The office
never writes slx's state, never talks to Slack, and never touches session
policy.

/command's `slx` is {"items", "old", "tui", "error", "mutes", "muted", "snoozed"}:
- items: the open items received within WINDOW_H hours, and any whose
  session is up however old: the ones waiting on the person (no session, or
  an ended one) the most recent first, then those whose session is up. `merged` marks one
  whose session already has a row in the view (it waits on the person, or a
  coordinator works it): that row carries 📨 and the item gets no row of its own.
- old: the open items left out as older, counted only.
- tui: whether a slx TUI runs; without one 세션 열기 cannot.
- stale: panes that run a slx TUI from before tui.lock (`slx list`'s
  stale_tui), listed while none holds the lock: tui is false although one
  runs, and 다시 시작 quits it first.
- canUp: whether this slx has `up`, which [slx 켜기] runs.

[slx 켜기] (slx_up) runs `slx up`: slx starts its TUI in its own tmux session
(`slx`, window `inbox`) and returns once the TUI takes requests; with `then`,
the 세션 만들기 the person pressed follows. With an older TUI up, `replace`
has slx quit it first as a person would (Escape, q); slx never kills it, and
one that does not quit is the person's to quit.
- error: why the inbox could not be read (no slx, one without `list`).
- mutes: slx's mute rules (id, label, hides); muted, snoozed: how many open
  items they and the snoozes keep out of the list.

A slx from before `list` would start its TUI on `slx list`, so a binary is
asked for its usage first and used only when that names `list`.
"""

import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime

KINDS = ("slx_open", "slx_done", "slx_link", "slx_snooze", "slx_mute", "slx_unmute", "slx_up")
# How a mute is made from an item (slx mute -by), per trigger.
MUTE_BY = {"slack": ("channel", "from", "text"), "meerkat": ("service", "kind", "text")}
MUTE_ID = re.compile(r"^m[0-9a-f]{1,16}$")
# A snooze: a duration slx parses (90m, 3h), or an ISO time.
UNTIL = re.compile(r"^(\d{1,4}[mh]|\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d))$")
MANY = 200  # ids in one bulk action
CACHE_S = 5
# A trigger older than this with no live session is left out of the view (counted only).
WINDOW_H = float(os.environ.get("SLX_WINDOW_H") or 24)
ID = re.compile(r"^[\w][\w:./-]{0,127}$")
PANE = re.compile(r"^%\d{1,6}$")
ICON = {"slack": "📨", "meerkat": "🚨"}
TEXT_MAX = 4000
_cache: dict = {"at": 0.0, "out": None}
# binary path -> (mtime, its usage text)
_knows: dict[str, tuple[float, str]] = {}
# `slx up` waits up to 15 s for the TUI, and -replace up to 5 s more for the old one to quit.
UP_TIMEOUT = 30
# A `slx open` right after up: tries, while slx says it has no TUI yet.
OPEN_TRIES = 3

# What `slx open|done` says, as the person reads it.
NOTES_KO = {
    "opening a session": "세션을 엽니다",
    "resuming the ended session": "끝난 세션을 이어 엽니다",
    "sending the new mentions to the running session": "새 멘션을 실행 중인 세션에 보냅니다",
    "a session is already running": "이미 세션이 실행 중입니다",
    "already opening a session for this item": "이미 세션을 여는 중입니다",
    "done": "무시했습니다",
    "reopened": "다시 열었습니다",
    "unmuted": "숨김을 풀었습니다",
    "no such mute": "그런 숨김 규칙이 없습니다",
    "no such item": "slx에 그런 항목이 없습니다",
    "request expired": "요청이 오래돼 slx가 버렸습니다",
}


def binary() -> str | None:
    """The slx to run: $SLX_BIN, else slx on PATH, else ~/.local/bin/slx (make install)."""
    for p in (os.environ.get("SLX_BIN"), shutil.which("slx"), os.path.expanduser("~/.local/bin/slx")):
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _usage(path: str) -> str:
    """This slx's usage text. Asked again only when the binary changes (a
    reinstall)."""
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return ""
    hit = _knows.get(path)
    if hit and hit[0] == mt:
        return hit[1]
    try:
        r = subprocess.run([path, "-h"], capture_output=True, text=True, timeout=5)
        out = r.stdout + r.stderr
    except (OSError, subprocess.TimeoutExpired):
        out = ""
    _knows[path] = (mt, out)
    return out


def knows_list(path: str) -> bool:
    """Whether this slx has `list`: its usage names it."""
    return "slx list" in _usage(path)


def knows_up(path: str | None) -> bool:
    """Whether this slx can start its own TUI (`slx up`)."""
    return bool(path) and "slx up" in _usage(path)


def _run(args: list[str], timeout: float) -> tuple[subprocess.CompletedProcess | None, str | None]:
    b = binary()
    if not b:
        return None, "slx가 없습니다 (keyolk/slx에서 make install)"
    if not knows_list(b):
        return None, f"{b}는 list를 모릅니다: slx를 새로 설치하세요 (make install)"
    try:
        return subprocess.run([b, *args], capture_output=True, text=True, timeout=timeout), None
    except subprocess.TimeoutExpired:
        return None, f"slx {args[0]}: {timeout:.0f}초 안에 끝나지 않았습니다"
    except OSError as e:
        return None, f"slx {args[0]}: {e}"


def read() -> dict:
    """`slx list` as parsed JSON, {"items": [], "tui": False, "error": why} when it fails."""
    if _cache["out"] is not None and time.time() - _cache["at"] < CACHE_S:
        return _cache["out"]
    r, err = _run(["list"], 10)
    out: dict = {"items": [], "tui": False, "error": err}
    if r is not None:
        try:
            d = json.loads(r.stdout) if r.returncode == 0 else None
        except ValueError:
            d = None
        if isinstance(d, dict) and isinstance(d.get("items"), list):
            stale = [{"pane": str(p.get("pane") or ""), "window": str(p.get("window") or "")[:80]} for p in d.get("stale_tui") or [] if isinstance(p, dict) and PANE.match(str(p.get("pane") or ""))]
            out = {"items": d["items"], "tui": bool(d.get("tui")), "stale": stale, "error": None, "mutes": d.get("mutes") if isinstance(d.get("mutes"), list) else [], "muted": int(d.get("muted") or 0), "snoozed": int(d.get("snoozed") or 0)}
        else:
            out["error"] = "slx list: " + ((r.stderr or r.stdout).strip().splitlines() or [f"exit {r.returncode}"])[-1][:300]
    _cache.update(at=time.time(), out=out)
    return out


def _epoch(iso) -> float:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _row(it: dict, rows: set[str]) -> dict:
    s = it.get("session") if isinstance(it.get("session"), dict) else {}
    sid = str(s.get("sid") or "")
    alive = bool(s.get("alive"))
    trig = "meerkat" if it.get("trigger") == "meerkat" else "slack"
    inc = it.get("incident") if isinstance(it.get("incident"), dict) else {}
    return {
        "id": str(it.get("id") or ""),
        "trigger": trig,
        "icon": ICON[trig],
        "from": str(it.get("from") or ""),
        "where": str(it.get("where") or ""),
        "text": str(it.get("text") or "")[:TEXT_MAX],
        "detail": str(it.get("detail") or "")[:TEXT_MAX],
        "link": str(it.get("link") or ""),
        "alertThread": str(it.get("alert_thread") or ""),
        "at": it.get("received_at"),
        "status": it.get("status") or "new",
        "mentions": int(it.get("mentions") or 0),
        "pending": int(it.get("pending") or 0),
        "unread": bool(it.get("unread")),
        "joinedTo": it.get("joined_to") or None,
        "service": str(inc.get("service") or ""),
        "dm": trig == "slack" and str(it.get("channel_id") or "").startswith("D"),
        "sid": sid or None,
        "pane": s.get("pane") or None,
        "window": s.get("window") or None,
        "alive": alive,
        # The session's own row in the view shows this item as 📨.
        "merged": alive and sid in rows,
    }


def view(rows: set[str], now: float | None = None) -> dict:
    """What the command view draws from the inbox; `rows` are the session
    ids that already have a row there (waiting on the person, or a
    coordinator's worker)."""
    now = time.time() if now is None else now
    d = read()
    items, old = [], 0
    for it in d["items"]:
        if not isinstance(it, dict) or it.get("status") in ("done", "muted", "snoozed") or not ID.match(str(it.get("id") or "")):
            continue
        r = _row(it, rows)
        if not r["alive"] and now - _epoch(r["at"]) > WINDOW_H * 3600:
            old += 1
            continue
        items.append(r)
    # What waits on the person (no session, or an ended one) first, the most
    # recent first (an old trigger is the least likely to still matter); then
    # the items whose session is at work.
    items.sort(key=lambda r: (r["alive"], -_epoch(r["at"])))
    mutes = [
        {"id": str(m.get("id")), "label": str(m.get("label") or m.get("text") or m.get("id"))[:120], "trigger": m.get("trigger") or "", "hides": int(m.get("hides") or 0)}
        for m in d.get("mutes") or []
        if isinstance(m, dict) and MUTE_ID.match(str(m.get("id") or ""))
    ]
    return {"items": items, "old": old, "tui": d["tui"], "stale": d.get("stale") or [], "canUp": knows_up(binary()), "error": d["error"], "windowH": WINDOW_H, "mutes": mutes, "muted": d.get("muted", 0), "snoozed": d.get("snoozed", 0)}


def by_sid(v: dict) -> dict[str, dict]:
    """Session id -> the slx item it works on, for its row's 📨, with how
    many ride on it (incidents joined to one session); the newest is named."""
    out: dict[str, dict] = {}
    for r in v["items"]:
        if r["sid"]:
            n = out.get(r["sid"], {}).get("n", 0) + 1
            out[r["sid"]] = {"id": r["id"], "icon": r["icon"], "from": r["from"], "text": r["text"][:120], "n": n}
    return out


def _note(out: str) -> str:
    """`<id>: <note>` lines from slx, as the person reads them; the same
    note for many ids once, with their count."""
    notes: dict[str, int] = {}
    for line in out.strip().splitlines():
        n = line.split(": ", 1)[-1].strip()
        if n.startswith("snoozed until "):
            n = n.replace("snoozed until ", "") + "까지 미뤘습니다"
        elif m := re.match(r"^muted (m[0-9a-f]+) \((.*)\): hides (\d+)$", n):
            n = f"「{m.group(2)}」 숨김 규칙을 만들었습니다 (지금 {m.group(3)}건)"
        n = NOTES_KO.get(n, n)
        notes[n] = notes.get(n, 0) + 1
    return " · ".join(n + (f" ×{c}" if c > 1 else "") for n, c in notes.items())


def about(iid: str) -> str | None:
    """The item as the coordinator reads it beside a task typed about it:
    who wrote, where, its link and the start of its text. None for an id that
    is not in the inbox."""
    it = _find(iid) if ID.match(iid) else None
    if not it:
        return None
    text = " ".join(str(it.get("text") or "").split())[:200]
    parts = [str(it.get(k) or "") for k in ("from", "where", "link")]
    return f"(re: slx {iid}: " + " · ".join(p for p in parts if p) + (f' · "{text}"' if text else "") + ") "


def open_url(url: str) -> None:
    subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _find(iid: str) -> dict | None:
    for fresh in (False, True):
        if fresh:
            _cache["at"] = 0.0
        hit = next((i for i in read()["items"] if isinstance(i, dict) and i.get("id") == iid), None)
        if hit:
            return hit
    return None


def _ids(body: dict) -> list[str] | None:
    """The ids a request names (`ids`, else `id`), None when one is not an id."""
    raw = body.get("ids") if isinstance(body.get("ids"), list) else [body.get("id")]
    ids = [str(i or "") for i in raw][:MANY]
    if not ids or not all(ID.match(i) for i in ids):
        return None
    return list(dict.fromkeys(ids))


def _slx(args: list[str], timeout: float = 15) -> tuple[int, dict]:
    r, err = _run(args, timeout)
    _cache["at"] = 0.0
    if err:
        return 503, {"error": err}
    if r.returncode != 0:
        why = _note(r.stdout) or (r.stderr.strip().splitlines() or [f"exit {r.returncode}"])[-1]
        if "not running" in why:
            why = "slx가 꺼져 있습니다: [slx 켜기]로 켜면 세션을 열 수 있습니다"
        return 409, {"error": why[:300]}
    return 200, {"ok": True, "sent": _note(r.stdout) or "보냈습니다"}


def _up_error(out: str) -> str:
    """Why `slx up` failed, as the person reads it."""
    if m := re.search(r"older slx TUI is running in (%\d+) \(([^)]*)\)", out):
        return f"slx가 예전 버전으로 떠 있습니다 ({m.group(1)} · {m.group(2)}): [slx 다시 시작]을 고르세요"
    if m := re.search(r"older slx TUI in (%\d+) \(([^)]*)\) did not quit", out):
        return f"예전 slx({m.group(1)} · {m.group(2)})가 꺼지지 않았습니다: 그 창에서 q로 끄고 다시 누르세요 (강제로 끄지 않았습니다)"
    if m := re.search(r"exited at start: (.*)", out):
        return "slx가 켜지자마자 꺼졌습니다: " + m.group(1)[:200]
    if "did not start taking requests" in out:
        return "slx를 띄웠지만 15초 안에 요청을 받지 않습니다: slx tmux 세션의 inbox 창을 보세요"
    if "no tmux server" in out:
        return "office가 tmux 밖에서 돌고 있어 slx를 띄울 수 없습니다"
    return (out.strip().splitlines() or ["slx up 실패"])[-1][:300]


def up(body: dict) -> tuple[int, dict]:
    """[slx 켜기]: `slx up` (with `replace`, `-replace`), then the 세션 만들기
    the person pressed (`then`, an item id) as if pressed again."""
    then = body.get("then")
    if then is not None:
        then = str(then)
        if not ID.match(then):
            return 400, {"error": "bad id"}
        if not _find(then):
            return 404, {"error": "slx inbox에 없는 항목입니다"}
    if not knows_up(binary()):
        return 503, {"error": "이 slx는 스스로 켜지 못합니다: slx를 새로 설치하세요 (keyolk/slx에서 make install)"}
    r, err = _run(["up", *(["-replace"] if body.get("replace") else [])], UP_TIMEOUT)
    _cache["at"] = 0.0
    if err:
        return 503, {"error": err}
    out = r.stdout + r.stderr
    if r.returncode != 0:
        return 409, {"error": _up_error(out)}
    said = "slx가 이미 켜져 있습니다" if "already running" in out else "slx를 다시 시작했습니다" if "quit the older TUI" in out else "slx를 켰습니다"
    if then is None:
        return 200, {"ok": True, "sent": said}
    # The TUI marks its pane once it takes requests, and up waits for that;
    # a retry covers a TUI that a person quit in the moment between.
    for i in range(OPEN_TRIES):
        code, j = _slx(["open", then])
        if code == 200 or "꺼져" not in j.get("error", "") and "did not take" not in j.get("error", ""):
            break
        time.sleep(1)
    if code != 200:
        return code, {"error": said + "만 세션은 못 열었습니다: " + j["error"]}
    return 200, {"ok": True, "sent": said + " · " + j["sent"]}


def act(body: dict) -> tuple[int, dict]:
    """What the person does to triggers still in the inbox: 세션 만들기
    (slx_open), 무시 (slx_done, one or `ids`), 나중에 (slx_snooze: `until`, a
    duration or an ISO time), 이런 것 숨기기 (slx_mute: `by` one of MUTE_BY for
    its trigger, `text` for text), a mute rule taken back (slx_unmute: `rule`),
    or its link opened (slx_link: `which` link or alert, the URL taken from
    slx's list, never from the request) in the default app: Slack opens
    there. Every id must be in the inbox now; unmute names a rule instead."""
    kind = body.get("kind")
    if kind == "slx_up":
        return up(body)
    if kind == "slx_unmute":
        rule = str(body.get("rule") or "")
        if not MUTE_ID.match(rule):
            return 400, {"error": "bad rule"}
        return _slx(["unmute", rule])
    ids = _ids(body)
    if ids is None:
        return 400, {"error": "bad id"}
    found = [_find(i) for i in ids]
    if not all(found):
        return 404, {"error": "slx inbox에 없는 항목입니다" + (f" ({sum(1 for f in found if not f)}건)" if len(ids) > 1 else "")}
    if kind in ("slx_open", "slx_link", "slx_mute") and len(ids) > 1:
        return 400, {"error": "한 번에 하나만 됩니다"}
    it, iid = found[0], ids[0]
    if kind == "slx_link":
        url = str(it.get("alert_thread" if body.get("which") == "alert" else "link") or "")
        if not re.match(r"^https://", url):
            return 404, {"error": "링크가 없습니다"}
        open_url(url)
        return 200, {"ok": True, "sent": "열었습니다"}
    if kind == "slx_open":
        return _slx(["open", iid])
    if kind == "slx_done":
        return _slx(["done", *ids], 15 + len(ids) // 10)
    if kind == "slx_snooze":
        until = str(body.get("until") or "")
        if not UNTIL.match(until):
            return 400, {"error": "bad until"}
        return _slx(["snooze", until, *ids], 15 + len(ids) // 10)
    if kind == "slx_mute":
        by, text = str(body.get("by") or ""), " ".join(str(body.get("text") or "").split())[:200]
        trig = "meerkat" if it.get("trigger") == "meerkat" else "slack"
        if by not in MUTE_BY[trig]:
            return 400, {"error": "bad by"}
        if by == "text" and not text:
            return 400, {"error": "숨길 문구를 적으세요"}
        # -text=<text> as one argument: a text that starts with - stays its
        # value and never reads as a flag of its own.
        return _slx(["mute", "-like", iid, "-by", by, *(["-text=" + text] if by == "text" else [])])
    return 400, {"error": "unknown action"}
