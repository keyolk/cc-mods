"""One-shot grants: a person's press on a brief's option, made into a pass for
one outward action of one session.

A worker that needs a gated action (today: one Slack message) declares it on
its decision brief, on the option that means "yes" (`grants` beside
`options` in the sidecar, written by `bin/brief-grant`):

  "grants": {"<option label>": {"kind": "slack_send", "channel": "C…",
                                 "thread": "<ts>"|null, "text": "<the message>"}}

The office shows the declared action under that option. When the person
presses it, command.answer calls `issue` *in the office process*, and only
from the HTTP /act handler. The grant is kept in this process's memory, never
on disk:

  - the sidecar is not the source of authority: ~/briefs is writable by the
    worker, and `brief answer … --by office` is a plain flag anyone can pass;
  - the action is copied from the sidecar at the press, the hash is computed
    here from the text the office showed (never taken from the declaration),
    and the press carries the digest of what the page drew, so a declaration
    changed between drawing and pressing is refused;
  - the grantee is the worker the coordinator's ledger names for the brief's
    `worker` slug, not a session id read from the request or the sidecar.

Redeeming: the worker's session policy stays slack_send=block. Its send is
denied by slack_send_guard.py; its cc-mods then asks the office (POST
/redeem) with the call's channel, thread and message. The office matches
them against a live grant for that session, spends it, opens that one
channel for that session with session_policy.py (the same CLI the office's
other grants run) for at most OPEN_S seconds, and the mod retries the call
once and closes the channel again. If cc-mods is not running in the worker,
nothing asks and the send stays blocked.
"""

import hashlib
import json
import os
import re
import secrets
import subprocess
import threading
import time

HOOKS = os.path.expanduser("~/.claude/hooks/")
SID = re.compile(r"^[0-9a-f-]{8,64}$")
CHANNEL = re.compile(r"^[CDGU](?=[A-Z]*\d)[A-Z0-9]{6,}$")
THREAD = re.compile(r"^\d{6,}\.\d{1,9}$")
KINDS = ("slack_send",)
TTL_S = 60 * 60  # a press is good for an hour: the worker may be mid-turn
OPEN_S = 30  # the channel is open to the session at most this long per send
MAX_TEXT = 5000  # Slack takes 5000 characters a text element; the POST that carries it is read up to 20 KB

_lock = threading.Lock()
_grants: dict[str, dict] = {}  # id -> grant
_open: dict[str, threading.Timer] = {}  # "sid channel" -> the timer that closes it


def text_hash(text: str) -> str:
    """The message as the guard compares it: line ends and trailing
    whitespace normalized, so the same message typed through a tool call
    matches what the office showed."""
    t = "\n".join(line.rstrip() for line in str(text).replace("\r\n", "\n").split("\n")).strip()
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def action(raw) -> dict | None:
    """A declared action, checked and reduced to what a grant binds, or None."""
    if not isinstance(raw, dict) or raw.get("kind") not in KINDS:
        return None
    ch = str(raw.get("channel") or "").strip().upper()
    th = raw.get("thread")
    th = str(th).strip() if th not in (None, "") else None
    text = raw.get("text")
    if not CHANNEL.match(ch) or (th is not None and not THREAD.match(th)) or not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        return None
    return {"kind": "slack_send", "channel": ch, "thread": th, "text": text}


def digest(a: dict) -> str:
    """What the page drew for an action: the press sends it back, and a
    declaration changed since the drawing no longer matches."""
    return hashlib.sha256(json.dumps([a["kind"], a["channel"], a["thread"], text_hash(a["text"])]).encode()).hexdigest()[:16]


def shown(raw) -> dict | None:
    """The action as the page draws it under an option, with its digest."""
    a = action(raw)
    return {**a, "digest": digest(a)} if a else None


def issue(sid: str, a: dict, src: str, now: float | None = None) -> dict:
    """A grant for one action of one session, from a person's press. Only
    command.answer calls this, inside the office's /act handler."""
    now = time.time() if now is None else now
    gid = secrets.token_hex(8)
    g = {"id": gid, "sid": sid, "kind": a["kind"], "channel": a["channel"], "thread": a["thread"], "hash": text_hash(a["text"]), "src": src, "at": now, "until": now + TTL_S}
    with _lock:
        _sweep(now)
        _grants[gid] = g
    return g


def _sweep(now: float) -> None:
    for k in [k for k, g in _grants.items() if g["until"] < now]:
        del _grants[k]


def live(sid: str | None = None, now: float | None = None) -> list[dict]:
    now = time.time() if now is None else now
    with _lock:
        _sweep(now)
        return [dict(g) for g in _grants.values() if sid is None or g["sid"] == sid]


def match(sid: str, channel: str, thread, text: str, now: float | None = None) -> dict | None:
    """The live grant this call fits, spent (removed) when found."""
    now = time.time() if now is None else now
    ch, th, h = str(channel or "").strip().upper(), (str(thread).strip() or None) if thread not in (None, "") else None, text_hash(text or "")
    with _lock:
        _sweep(now)
        for gid, g in list(_grants.items()):
            if g["sid"] == sid and g["channel"] == ch and g["thread"] == th and g["hash"] == h:
                return _grants.pop(gid)
    return None


def why_not(sid: str, channel: str, thread, text: str) -> str:
    """For a call no grant fits: what differs, so the worker asks again
    instead of retrying the same thing."""
    gs = [g for g in live(sid) if g["kind"] == "slack_send"]
    if not gs:
        return "no approved send for this session (ask the person on a brief with bin/brief-grant)"
    ch = str(channel or "").strip().upper()
    same = [g for g in gs if g["channel"] == ch]
    if not same:
        return "the approved send is to " + ", ".join(sorted({g["channel"] for g in gs})) + ", not " + ch
    th = (str(thread).strip() or None) if thread not in (None, "") else None
    if not any(g["thread"] == th for g in same):
        return "the approved send is in thread " + ", ".join(str(g["thread"]) for g in same) + ", not " + str(th)
    return "the message differs from the approved text: send it exactly as approved, or ask again"


def policy(sid: str, argv: list[str]) -> bool:
    env = {**os.environ, "CLAUDE_CODE_SESSION_ID": sid}
    try:
        r = subprocess.run(["python3", HOOKS + "session_policy.py", *argv], capture_output=True, text=True, timeout=10, env=env)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


def close(sid: str, channel: str) -> bool:
    """Close a channel this module opened for the session. One it did not
    open (a scope the person granted with /policy) is left alone."""
    key = sid + " " + channel
    with _lock:
        t = _open.pop(key, None)
    if not t:
        return True
    t.cancel()
    return policy(sid, ["inherit", "slack_send", "--scope", channel])


def redeem(body: dict) -> tuple[int, dict]:
    """POST /redeem from a worker's cc-mods after the guard denied its send:
    spend the grant this call fits and open its channel to that session for
    OPEN_S seconds. `done` (after the retry) closes it at once."""
    sid = str(body.get("sid") or "")
    if not SID.match(sid):
        return 400, {"error": "bad sid"}
    if body.get("kind") != "slack_send":
        return 400, {"error": "unknown kind"}
    channel = str(body.get("channel") or "").strip().upper()
    if not CHANNEL.match(channel):
        return 400, {"error": "bad channel"}
    if body.get("done"):
        return (200, {"ok": True, "closed": channel}) if close(sid, channel) else (500, {"error": "could not close"})
    text = body.get("text")
    if not isinstance(text, str):
        return 400, {"error": "no text"}
    g = match(sid, channel, body.get("thread"), text)
    if not g:
        return 403, {"error": why_not(sid, channel, body.get("thread"), text)}
    if not policy(sid, ["allow", "slack_send", "--scope", channel]):
        with _lock:
            _grants[g["id"]] = g  # not spent: nothing was opened
        return 500, {"error": "could not open the channel for this session"}
    key = sid + " " + channel
    t = threading.Timer(OPEN_S, lambda: close(sid, channel))
    t.daemon = True
    with _lock:
        old = _open.pop(key, None)
        _open[key] = t
    if old:
        old.cancel()
    t.start()
    return 200, {"ok": True, "grant": g["id"], "src": g["src"], "open_s": OPEN_S}
