"""The person's schedule in the command view (지휘): today's meetings from
gcl (keyolk/gcl), the one under way, the next and how long until it, and the
free stretches between them (focus time).

`gcl -json -days 2` prints today's and tomorrow's events of the person's calendar as JSON
(id, title, start/end RFC3339 or date/endDate for all-day, link, conference,
organizer, myResponse, attendees [{email, name, response, self,
organizer}]). Each run is a process start and one or two Google Calendar API
calls, and the view polls every few seconds, so the office runs it at most
every CACHE_S, never on the request's thread: a read past that age hands back
the last result at once and starts one refresh in the background (one at a
time). A failed run keeps the last good events and says why beside them.

A gcl from before -json would start its TUI, so a binary is asked for its
usage first and used only when that names -json (asked again only when the
binary changes, a reinstall).

view(now) is {"events", "now", "next", "untilNext" (s), "free", "at",
"error", "stale"}; events are today's and tomorrow's (`day`
0|1), sorted, each with its attendees and `mine` (my reply); next may be
tomorrow's first, so the evening still shows it. A declined event does not count as busy, nor does an
all-day one (a working location, a holiday); free stretches are gaps of at
least FREE_MIN minutes inside the work day (dayStart..dayEnd local hours,
~/.config/cc-mods/office.json "agenda", default 9..19).

people (link_people) puts beside each attendee what in the office names
them (sessions, briefs, reviews, slx items) and the open PRs they wrote or
review (office/ghprs.py).

Writes go out only through gcl, after the person's confirm press in the view
(the press is the request): `agenda_rsvp` runs `gcl rsvp <id> yes|no|maybe`;
`agenda_find` runs `gcl find -with …`, a read, to propose times. A gcl
without them (its usage does not name `gcl rsvp`) is not run.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime

import ghprs

CACHE_S = int(os.environ.get("OFFICE_GCL_CACHE_S") or 300)
RUN_TIMEOUT = 30
FREE_MIN = 30
CONFIG = os.path.expanduser("~/.config/cc-mods/office.json")
KINDS = ("agenda_rsvp", "agenda_find", "agenda_open")
REPLIES = ("yes", "no", "maybe")
EVENT_ID = re.compile(r"^[A-Za-z0-9_@.-]{1,200}$")
EMAIL = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}$")
TITLE_MAX = 200
PEOPLE_MAX = 60

_cache: dict = {"at": 0.0, "events": None, "error": None, "day": ""}
# The links the last view showed (a meeting's page and call, a linked PR or
# Slack item): agenda_open opens only one of these, never a URL the page made.
_shown: set[str] = set()
_lock = threading.Lock()
_running = {"on": False}
# binary path -> (mtime, its usage text)
_knows: dict[str, tuple[float, str]] = {}


# Where `make install` puts a gcl that knows -json, rsvp and find: the
# checkout ($GCL_SRC, else ~/src/keyolk/gcl) on its main.
def install_cmd() -> str:
    src = os.environ.get("GCL_SRC") or "~/src/keyolk/gcl"
    return f"cd {src} && git switch main && git pull --ff-only && make install"


def binary() -> str | None:
    """The gcl to run: $GCL_BIN, else gcl on PATH, else ~/.local/bin/gcl (make install)."""
    for p in (os.environ.get("GCL_BIN"), shutil.which("gcl"), os.path.expanduser("~/.local/bin/gcl")):
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _usage(path: str) -> str:
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


def knows_json(path: str) -> bool:
    return "-json" in _usage(path)


def _person(p) -> dict | None:
    if not isinstance(p, dict) or not p.get("email"):
        return None
    return {"email": str(p["email"])[:200].lower(), "name": str(p.get("name") or "")[:120], "response": str(p.get("response") or ""), "self": bool(p.get("self")), "organizer": bool(p.get("organizer"))}


def _event(e) -> dict | None:
    """One event of gcl's JSON in the shape the view uses, None when it is not one."""
    if not isinstance(e, dict) or not e.get("id"):
        return None
    people = [p for p in (_person(x) for x in (e.get("attendees") or [])[:PEOPLE_MAX]) if p]
    out = {"id": str(e["id"])[:200], "title": str(e.get("title") or "(제목 없음)")[:TITLE_MAX], "allDay": bool(e.get("allDay")), "link": str(e.get("link") or ""), "conference": str(e.get("conference") or ""), "location": str(e.get("location") or "")[:200], "organizer": str(e.get("organizer") or "").lower(), "mine": str(e.get("myResponse") or ""), "attendees": people}
    if out["allDay"]:
        out["date"] = str(e.get("date") or "")
        out["day"] = 0 if out["date"] <= datetime.now().strftime("%Y-%m-%d") else 1
        return out
    try:
        out["start"] = datetime.fromisoformat(str(e["start"]).replace("Z", "+00:00")).timestamp()
        out["end"] = datetime.fromisoformat(str(e["end"]).replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError):
        return None
    out["day"] = 0 if datetime.fromtimestamp(out["start"]).date() <= datetime.now().date() else 1
    return out


def parse(stdout: str) -> list[dict]:
    """gcl -json's output as events; ValueError when it is not that."""
    d = json.loads(stdout)
    if not isinstance(d, dict) or not isinstance(d.get("events"), list):
        raise ValueError("no events list")
    evs = [x for x in (_event(e) for e in d["events"]) if x]
    evs.sort(key=lambda x: (x["day"], not x["allDay"], x.get("start") or 0))
    return evs


def _fetch() -> tuple[list[dict] | None, str | None]:
    b = binary()
    if not b:
        return None, "gcl이 없습니다"
    if not knows_json(b):
        return None, f"{b}가 옛 버전입니다 (-json 없음)"
    try:
        r = subprocess.run([b, "-json", "-days", "2"], capture_output=True, text=True, timeout=RUN_TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, f"gcl -json: {RUN_TIMEOUT}초 안에 끝나지 않았습니다"
    except OSError as e:
        return None, f"gcl -json: {e}"
    if r.returncode != 0:
        return None, "gcl -json: " + ((r.stderr or r.stdout).strip().splitlines() or [f"exit {r.returncode}"])[-1][:300]
    try:
        return parse(r.stdout), None
    except ValueError as e:
        return None, f"gcl -json: 읽을 수 없는 출력 ({e})"


def _refresh() -> None:
    try:
        evs, err = _fetch()
        with _lock:
            _cache["at"] = time.time()
            _cache["error"] = err
            if evs is not None:
                _cache["events"] = evs
                _cache["day"] = datetime.now().strftime("%Y-%m-%d")
    finally:
        _running["on"] = False


def read(wait: bool = False) -> tuple[list[dict] | None, str | None, float]:
    """The cached events, the last error, and when they were read. A cache past
    CACHE_S (or from another day) starts one refresh; wait=True runs it here."""
    with _lock:
        stale = time.time() - _cache["at"] >= CACHE_S or _cache["day"] != datetime.now().strftime("%Y-%m-%d")
        start = stale and not _running["on"]
        if start:
            _running["on"] = True
    if start:
        if wait:
            _refresh()
        else:
            threading.Thread(target=_refresh, name="office-gcl", daemon=True).start()
    with _lock:
        return _cache["events"], _cache["error"], _cache["at"]


def day_hours() -> tuple[int, int]:
    try:
        with open(CONFIG) as f:
            got = (json.load(f) or {}).get("agenda") or {}
    except (OSError, ValueError, AttributeError):
        got = {}
    a, b = (got.get("dayStart"), got.get("dayEnd")) if isinstance(got, dict) else (None, None)
    a = a if isinstance(a, int) and not isinstance(a, bool) and 0 <= a <= 23 else 9
    b = b if isinstance(b, int) and not isinstance(b, bool) and a < b <= 24 else max(19, a + 1)
    return a, b


def busy(e: dict) -> bool:
    return not e["allDay"] and e.get("mine") != "declined"


def free_spans(events: list[dict], now: float, day_start: int | None = None, day_end: int | None = None, min_s: int = FREE_MIN * 60) -> list[dict]:
    """The gaps of at least min_s between busy events, from now to the end of
    the work day (local)."""
    if day_start is None or day_end is None:
        day_start, day_end = day_hours()
    d = datetime.fromtimestamp(now)
    if d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() + day_end * 3600 <= now:
        return []
    lo = max(now, d.replace(hour=day_start, minute=0, second=0, microsecond=0).timestamp())
    hi = d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() + day_end * 3600
    out, cur = [], lo
    for e in sorted((e for e in events if busy(e)), key=lambda e: e["start"]):
        if e["end"] <= cur:
            continue
        if e["start"] >= hi:
            break
        if e["start"] - cur >= min_s:
            out.append({"start": cur, "end": e["start"]})
        cur = max(cur, e["end"])
    if hi - cur >= min_s:
        out.append({"start": cur, "end": hi})
    return out


def summarize(events: list[dict], now: float) -> dict:
    """What is under way, what is next and how long until it, the free stretches."""
    timed = [e for e in events if busy(e)]
    now_ev = [e["id"] for e in timed if e["start"] <= now < e["end"]]
    nxt = next((e for e in timed if e["start"] > now), None)
    return {"now": now_ev, "next": nxt["id"] if nxt else None, "untilNext": int(nxt["start"] - now) if nxt else None, "free": free_spans(events, now)}


def view(now: float | None = None) -> dict:
    now = time.time() if now is None else now
    evs, err, at = read()
    b = binary()
    can = bool(b) and knows_cli(b)
    # A gcl missing or too old: the command that fixes it, shown with a copy button.
    fix = install_cmd() if not b or not knows_json(b) or not can else None
    if evs is None:
        return {"events": [], "now": [], "next": None, "untilNext": None, "free": [], "at": at or None, "error": err or ("일정을 읽는 중입니다" if _running["on"] else None), "loading": _running["on"], "canWrite": can, "fix": fix}
    return {"events": evs, **summarize(evs, now), "at": at, "error": err, "stale": bool(err), "canWrite": can, "fix": fix}


def knows_cli(path: str) -> bool:
    """Whether this gcl has `gcl rsvp` and `gcl find`: its usage names them."""
    u = _usage(path)
    return "gcl rsvp" in u and "gcl find" in u


# --- people: who is in a meeting, and what in the office mentions them -------
#
# An attendee is known by keys: the email, its local part ("jace.son"), that
# part as a name ("jace son"), the calendar's display name, and any aliases in
# PEOPLE_FILE ({"<email>": {"github": "login", "slack": "Display Name",
# "aliases": ["준성"]}}), which is how a Korean name or a GitHub login the
# org's SAML does not know reaches the same person. A key shorter than MIN_KEY is not used: "ai" would match
# every summary.
PEOPLE_FILE = os.path.expanduser("~/.config/cc-mods/people.json")
MIN_KEY = 4
LINKS_MAX = 8
PER_KIND = 2  # a person named in ten Slack threads shows two: the line stays readable
_people: dict = {"mt": None, "map": {}}


def people_map() -> dict:
    """PEOPLE_FILE, read again only when it changes; {} when absent or bad."""
    try:
        mt = os.path.getmtime(PEOPLE_FILE)
    except OSError:
        return {}
    if _people["mt"] != mt:
        try:
            with open(PEOPLE_FILE) as f:
                d = json.load(f)
            _people["map"] = {str(k).lower(): v for k, v in d.items() if isinstance(v, dict)} if isinstance(d, dict) else {}
        except (OSError, ValueError):
            _people["map"] = {}
        _people["mt"] = mt
    return _people["map"]


def keys_of(p: dict, extra: dict | None = None) -> list[str]:
    email = p["email"]
    local = email.split("@", 1)[0]
    ks = {email, local, local.replace(".", " ").replace("_", " ").replace("-", " "), p.get("name", "").lower()}
    x = (extra or {}).get(email) or {}
    for k in ("github", "slack"):
        if x.get(k):
            ks.add(str(x[k]).lower())
    for a in x.get("aliases") or []:
        ks.add(str(a).lower())
    return sorted((k for k in ks if len(k) >= MIN_KEY), key=len, reverse=True)


def _hay(command_view: dict) -> list[dict]:
    """The things in the office a person can be named in: {kind, label, text, ref}."""
    out = []
    for r in command_view.get("table") or []:
        if not r.get("sid"):
            continue  # a slx trigger's own row (x:…): the slx items below carry it
        # A session is named by what it does (its summary), as the table names it.
        out.append({"kind": "session", "label": r.get("summary") or r.get("name") or "", "text": f"{r.get('name') or ''} {r.get('summary') or ''}", "ref": {"sid": r.get("sid")}})
    for r in command_view.get("reviews") or []:
        out.append({"kind": "review", "label": r.get("title") or "", "text": " ".join(str(r.get(k) or "") for k in ("title", "changed", "check", "risk")) + " " + " ".join(map(str, r.get("links") or [])), "ref": {"id": r.get("id"), "coord": r.get("coord")}})
    for b in (command_view.get("recent") or []) + (command_view.get("pending") or []):
        out.append({"kind": "brief", "label": b.get("title") or "", "text": b.get("title") or "", "ref": {"file": b.get("file")}})
    for i in (command_view.get("slx") or {}).get("items") or []:
        out.append({"kind": "slack" if i.get("trigger") != "meerkat" else "meerkat", "label": f"{i.get('from') or ''} · {i.get('where') or ''}", "text": f"{i.get('from') or ''} {i.get('text') or ''}", "ref": {"id": i.get("id"), "link": i.get("link")}})
    return out


def link_people(events: list[dict], command_view: dict, extra: dict | None = None) -> dict[str, list[dict]]:
    """email -> the office things that name that attendee (not me), at most
    LINKS_MAX each, one per thing."""
    extra = people_map() if extra is None else extra
    hay = [(h, h["text"].lower()) for h in _hay(command_view)]
    out: dict[str, list[dict]] = {}
    for e in events:
        for p in e["attendees"]:
            if p["self"] or p["email"] in out:
                continue
            ks = keys_of(p, extra)
            hits, per, seen = [], {}, set()
            for h, low in hay:
                k = next((k for k in ks if k in low), None)
                ref = json.dumps(h["ref"], sort_keys=True)
                if not k or ref in seen or per.get(h["kind"], 0) >= PER_KIND:
                    continue
                seen.add(ref)
                per[h["kind"]] = per.get(h["kind"], 0) + 1
                hits.append({"kind": h["kind"], "label": h["label"][:120], "ref": h["ref"], "by": k})
                if len(hits) >= LINKS_MAX:
                    break
            out[p["email"]] = hits
    return {k: v for k, v in out.items() if v}


def attendees(events: list[dict]) -> set[str]:
    return {p["email"] for e in events for p in e["attendees"] if not p["self"]}


def people(events: list[dict], command_view: dict) -> dict:
    """{"links": email -> office things and PRs, "prs": {"error"}}: link_people
    plus the open PRs each attendee wrote or reviews."""
    extra = people_map()
    out = link_people(events, command_view, extra)
    items, err = ghprs.prs()
    if items:
        for email, hits in ghprs.link(attendees(events), items, ghprs.people(), extra).items():
            seen = {h["ref"].get("url") for h in out.get(email, [])}
            out.setdefault(email, []).extend(h for h in hits if h["ref"]["url"] not in seen)
    shown = {u for e in events for u in (e.get("link"), e.get("conference")) if u}
    shown |= {h["ref"].get("url") or h["ref"].get("link") for hs in out.values() for h in hs if h["ref"].get("url") or h["ref"].get("link")}
    with _lock:
        _shown.clear()
        _shown.update(u for u in shown if isinstance(u, str) and u.startswith("https://"))
    return {"links": out, "prs": {"error": err, "count": len(items or [])}}


def _event_by_id(eid: str) -> dict | None:
    with _lock:
        return next((e for e in _cache["events"] or [] if e["id"] == eid), None)


def _run_cli(args: list[str], timeout: float = RUN_TIMEOUT) -> tuple[dict | None, str | None]:
    b = binary()
    if not b:
        return None, "gcl이 없습니다"
    if not knows_cli(b):
        return None, f"{b}가 옛 버전입니다 (rsvp/find 없음)"
    try:
        r = subprocess.run([b, *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, f"gcl {args[0]}: {timeout:.0f}초 안에 끝나지 않았습니다"
    except OSError as e:
        return None, f"gcl {args[0]}: {e}"
    if r.returncode != 0:
        return None, f"gcl {args[0]}: " + ((r.stderr or r.stdout).strip().splitlines() or [f"exit {r.returncode}"])[-1][:300]
    try:
        d = json.loads(r.stdout)
    except ValueError:
        return None, f"gcl {args[0]}: 읽을 수 없는 출력"
    return (d, None) if isinstance(d, dict) else (None, f"gcl {args[0]}: 읽을 수 없는 출력")


REPLY_KO = {"accepted": "수락", "declined": "거절", "tentative": "미정"}


def act(body: dict) -> tuple[int, dict]:
    """agenda_rsvp {id, reply yes|no|maybe}: the person's confirmed answer to
    an invitation in today's list; agenda_find {with: [email], minutes, days}:
    times to meet them."""
    kind = body.get("kind")
    if kind == "agenda_rsvp":
        eid, reply = str(body.get("id") or ""), str(body.get("reply") or "")
        if not EVENT_ID.match(eid) or reply not in REPLIES:
            return 400, {"error": "bad id or reply"}
        ev = _event_by_id(eid)
        if not ev:
            return 404, {"error": "오늘·내일 일정에 없는 회의입니다"}
        if not any(p["self"] for p in ev["attendees"]):
            return 409, {"error": "초대받은 회의가 아닙니다"}
        out, err = _run_cli(["rsvp", eid, reply])
        if err:
            return 502, {"error": err}
        with _lock:
            for p in ev["attendees"]:
                if p["self"]:
                    p["response"] = out.get("response") or p["response"]
            ev["mine"] = out.get("response") or ev["mine"]
            # The next read shows what Google now has.
            _cache["at"] = 0.0
        return 200, {"ok": True, "note": f"'{ev['title']}'에 {REPLY_KO.get(out.get('response'), out.get('response'))}으로 답했습니다", **out}
    if kind == "agenda_find":
        people_ = [str(x).strip().lower() for x in body.get("with") or [] if isinstance(x, str)]
        people_ = [x for x in dict.fromkeys(people_) if EMAIL.match(x)][:20]
        mins, days = body.get("minutes", 30), body.get("days", 7)
        if not people_ or not isinstance(mins, int) or not 5 <= mins <= 480 or not isinstance(days, int) or not 1 <= days <= 30:
            return 400, {"error": "bad people, minutes or days"}
        a, b = day_hours()
        out, err = _run_cli(["find", "-with", ",".join(people_), "-d", str(mins), "-days", str(days), "-n", "8", "-hours", f"{a}-{b}", "-weekdays"], timeout=60)
        if err:
            return 502, {"error": err}
        return 200, {"ok": True, **out}
    if kind == "agenda_open":
        # The default browser's `open`, as a brief's ↗ 밖으로: never the
        # office's own pane.
        url = str(body.get("url") or "")
        with _lock:
            ok = url in _shown
        if not ok:
            return 400, {"error": "not a link the agenda shows"}
        subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 200, {"ok": True, "sent": "열었습니다"}
    return 400, {"error": "unknown kind"}
