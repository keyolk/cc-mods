"""Files and lookups behind a session's sleep (office/hibernate.py): the
config, the dormant cards and pins under ~/.claude/state/office/dormant, the
registry of running sessions, and what its transcript says it last did."""

import glob
import json
import os
import re
import threading
import time
from datetime import datetime

SID = re.compile(r"^[0-9a-f-]{8,64}$")
CONFIG = os.path.expanduser("~/.config/cc-mods/office.json")
DEFAULTS = {"idleHours": 12.0, "typedMinutes": 30.0, "auto": "pressure", "pane": "close", "swapFreeMB": 512.0, "pressureLevel": 2}
_lock = threading.RLock()


def folder() -> str:
    # Read on each call: a test sets HOME in-process.
    return os.path.expanduser("~/.claude/state/office/dormant")


def config() -> dict:
    try:
        with open(CONFIG) as f:
            got = (json.load(f) or {}).get("hibernate") or {}
    except (OSError, ValueError, AttributeError):
        got = {}
    out = dict(DEFAULTS)
    choices = {"auto": ("off", "pressure", "always"), "pane": ("keep", "close")}
    for k, v in got.items() if isinstance(got, dict) else []:
        want = DEFAULTS.get(k)
        if isinstance(want, float) and isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
            out[k] = float(v)
        elif isinstance(want, int) and not isinstance(want, bool) and isinstance(v, int) and not isinstance(v, bool):
            out[k] = v
        elif k in choices and v in choices[k]:
            out[k] = v  # a value it does not know keeps the default
    return out


def only() -> set[str] | None:
    v = os.environ.get("OFFICE_HIBERNATE_ONLY")
    return {s for s in v.split(",") if s} if v else None


def allowed(sid: str) -> bool:
    o = only()
    return o is None or sid in o


def transcript(sid: str) -> str | None:
    hits = glob.glob(os.path.expanduser("~/.claude/projects/*/" + sid + ".jsonl"))
    return max(hits, key=os.path.getmtime) if hits else None


def registry() -> dict[str, dict]:
    out = {}
    for f in glob.glob(os.path.expanduser("~/.claude/sessions/*.json")):
        try:
            with open(f) as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and d.get("sessionId") and d.get("pid"):
            alive = True
            try:
                os.kill(int(d["pid"]), 0)
            except PermissionError:
                pass
            except (OSError, ValueError, TypeError):
                alive = False
            if alive:
                out[d["sessionId"]] = d
    return out


def _epoch(iso: str) -> float:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


_turn_cache: dict[str, tuple[float, dict]] = {}


def turn_of(path: str | None) -> dict:
    """last_turn, read again only when the file changed."""
    if not path:
        return {}
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return {}
    hit = _turn_cache.get(path)
    if hit and hit[0] == mt:
        return hit[1]
    t = last_turn(path)
    _turn_cache[path] = (mt, t)
    return t


def idle_since(p: dict, path: str | None) -> float:
    """When the session last did anything: its tmux state change, or the
    last message in its transcript. Not the file's mtime: Claude Code
    rewrites bookkeeping lines (cost-state) into an idle transcript."""
    t = turn_of(path).get("at") or 0.0
    return max(float(p.get("since") or 0), t)


def _text(c) -> str:
    if isinstance(c, str):
        return c
    return "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")


TAIL = 600_000
TAIL_MAX = 4_000_000  # one session at a time, in the view thread (cf. #110)


def _tail(path: str, size: int) -> list[str]:
    with open(path, "rb") as f:
        f.seek(0, 2)
        start = max(0, f.tell() - size)
        f.seek(start)
        # A read from the middle starts in a line: that one is cut.
        return f.read().decode("utf-8", "replace").splitlines()[1 if start else 0:]


def last_turn(path: str | None) -> dict:
    """The last request the person typed, the first line of its answer, and
    when the conversation last moved. Read from the end, further back while
    no request is found: one request's api-request-blob lines can be
    hundreds of KB (live run: 861 KB, the request outside the last 600)."""
    if not path:
        return {}
    size = TAIL
    while True:
        try:
            lines = _tail(path, size)
            whole = size >= os.path.getsize(path)
        except OSError:
            return {}
        t = _turn(lines)
        if t["ask"] or whole or size >= TAIL_MAX:
            return t
        size *= 4


def _turn(lines: list[str]) -> dict:
    ask, said, at = "", "", 0.0
    for line in lines:
        # Every message counts as activity (a tool call too); bookkeeping
        # lines (cost-state, pr-link) carry no message.
        if '"message"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("isMeta") or d.get("isSidechain") or d.get("isCompactSummary"):
            continue
        m = d.get("message") or {}
        c = m.get("content")
        if d.get("type") in ("user", "assistant") and d.get("timestamp"):
            at = max(at, _epoch(d["timestamp"]))
        if d.get("type") == "user" and m.get("role") == "user":
            if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                continue
            t = _text(c).strip()
            if t and not t.startswith(("<", "[cc-mods context")):
                ask, said = t, ""
        elif m.get("role") == "assistant":
            t = _text(c).strip()
            if t:
                said = t
    gist = next((ln.strip(" #*-`>") for ln in said.splitlines() if ln.strip(" #*-`>|")), "")
    return {"ask": ask[:600], "said": gist[:300], "at": at}


HINT = re.compile(r'^Try "[^"]*"$')
# A grey or faint start: the empty box's hint, drawn dim (capture-pane -e).
DIM = re.compile(r"^(\x1b\[[0-9;]*m)*\x1b\[(2|90|38;5;(2[34][0-9]|8|59|102|145))(;[0-9;]*)?m")
SGR = re.compile(r"\x1b\[[0-9;]*m")


def continued(path: str | None) -> bool:
    """The transcript's last line hands the conversation on (continued-in)."""
    if not path:
        return False
    try:
        lines = _tail(path, 4096)
    except OSError:
        return False
    return bool(lines) and '"type":"continued-in"' in lines[-1]


def draft(lines: list[str]) -> str:
    """Text typed into the prompt box and not sent (it would be lost). The
    lines are capture-pane -e's: an empty box shows a grey `Try "…"` hint."""
    for ln in reversed(lines[-30:]):
        plain = SGR.sub("", ln).strip()
        if not plain.startswith("❯"):
            continue
        raw = ln[ln.index("❯") + 1:] if "❯" in ln else ""
        text = plain[1:].strip()
        if not text or HINT.match(text) or DIM.match(raw.lstrip(" ")):
            return ""
        return text
    return ""


def pins() -> dict:
    try:
        with open(os.path.join(folder(), "pins.json")) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def pin(sid: str, on: bool) -> dict:
    with _lock:
        d = pins()
        if on:
            d[sid] = time.time()
        else:
            d.pop(sid, None)
        _write(os.path.join(folder(), "pins.json"), d)
        return d


def _write(path: str, d: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def cards() -> list[dict]:
    out = []
    for f in sorted(glob.glob(os.path.join(folder(), "*.json"))):
        if os.path.basename(f) == "pins.json":
            continue
        try:
            with open(f) as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and SID.match(str(d.get("sid") or "")):
            out.append(d)
    return out


def card(sid: str) -> dict | None:
    return next((c for c in cards() if c["sid"] == sid), None)


def drop_card(sid: str) -> None:
    try:
        os.remove(os.path.join(folder(), sid + ".json"))
    except OSError:
        pass
