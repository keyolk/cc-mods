"""The office inbox's files (~/.claude/state/office/inbox/<sid>.json): the
lock every writer and the taker share, the append, and the sweep.

Writers: office.py inbox_put, bin/coord-report, and cc-mods itself (coord.ts
coord_send, register.ts putting a message back or waking a coordinator),
which takes the same lock through bin/inbox-lock. The taker: register.ts
officeInbox renames <sid>.json to <sid>.json.sending. A writer reads the
file, appends, and replaces it. Unlocked, two writers at once lost one of the
two texts, and a writer that read the file just before the taker renamed it
wrote the taken text back, so it went in twice. So every writer's
read-append-replace, and the taker's rename, runs holding <sid>.json.lock: a
file created with O_EXCL, which Python, a shell and the mod's subprocesses
can all make, and which a holder that dies leaves behind (broken after
LOCK_STALE_S; a hold lasts milliseconds)."""

import json
import os
import random
import re
import secrets
import time
from contextlib import contextmanager

from registry import leading_json

LOCK_STALE_S = 10.0
LOCK_WAIT_S = 15.0
# lib/inbox.ts INBOX_STALE_S and INBOX_KEEP_S: past these the taker drops a
# message instead of submitting it.
STALE_S = 120
KEEP_S = 24 * 3600
# The sweep leaves a file this much longer than the taker would, so it never
# races a taker that is about to read it anyway.
SWEEP_GRACE_S = 10 * 60
# Leftovers of a writer or a taker that died: a temp file, a lock nobody
# releases, a .sending a reloaded module never put back.
LEFTOVER_S = 3600
SID = re.compile(r"^[0-9a-fA-F-]{8,64}$")
# The line cc-mods puts over a submitted inbox text (lib/inbox.ts
# provenance), followed by a newline or, in a whitespace-folded prompt, a space.
PROVENANCE = re.compile(r"^\s*\[cc-mods inbox\][^\n]*?not typed by the user:[ \t]*\n?")


def strip_provenance(text: str) -> str:
    """A prompt without the inbox's provenance line: readers that judge what
    a prompt says (the person's words, a relay head) see it as before."""
    return PROVENANCE.sub("", text or "", count=1)


def folder() -> str:
    # Expanded on each call: a test sets HOME in-process.
    return os.path.expanduser("~/.claude/state/office/inbox")


def _stale(lock: str) -> bool:
    try:
        return time.time() - os.stat(lock).st_mtime > LOCK_STALE_S
    except FileNotFoundError:
        return False


def _break(lock: str, token: str) -> None:
    """Take a stale lock away. Renamed first, so of two waiters that both
    found it stale only one removes it; one that renamed a lock taken fresh
    in the meantime links it back (link fails rather than overwrite)."""
    aside = lock + ".stale." + token
    try:
        os.rename(lock, aside)
    except FileNotFoundError:
        return
    try:
        if time.time() - os.stat(aside).st_mtime <= LOCK_STALE_S:
            try:
                os.link(aside, lock)
            except FileExistsError:
                pass
    finally:
        try:
            os.unlink(aside)
        except FileNotFoundError:
            pass


def acquire(path: str, wait: float = LOCK_WAIT_S) -> str:
    """Hold path's lock; the token release() needs. TimeoutError when another
    holder kept it past `wait` without going stale."""
    lock = path + ".lock"
    token = f"{os.getpid()}.{secrets.token_hex(6)}"
    deadline = time.monotonic() + wait
    while True:
        try:
            fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            if _stale(lock):
                _break(lock, token)
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError("inbox lock held: " + lock)
            time.sleep(0.002 + random.random() * 0.008)
            continue
        with os.fdopen(fd, "w") as f:
            f.write(token)
        return token


def release(path: str, token: str) -> None:
    """Let path's lock go, only when it is still this holder's: one broken as
    stale and taken by another is that other's now."""
    lock = path + ".lock"
    try:
        with open(lock) as f:
            if f.read().strip() != token:
                return
        os.unlink(lock)
    except FileNotFoundError:
        pass


@contextmanager
def locked(path: str):
    token = acquire(path)
    try:
        yield
    finally:
        release(path, token)


def read(path: str) -> dict:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            d = leading_json(f.read())
    except OSError:
        return {}
    return d if isinstance(d, dict) else {}


def _write(path: str, d: dict) -> None:
    # A temp name of its own: a shared `<path>.tmp` let two writers replace
    # each other's half-written file.
    tmp = f"{path}.tmp.{os.getpid()}.{secrets.token_hex(4)}"
    with open(tmp, "w") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, path)


def senders(old, new) -> list[str]:
    """Who wrote the texts a file holds, oldest first, each once (lib/inbox.ts
    provenance names them)."""
    out: list[str] = []
    for v in (old, new):
        for s in [v] if isinstance(v, str) else v if isinstance(v, list) else []:
            if isinstance(s, str) and s and s not in out:
                out.append(s)
    return out


def put(path: str, text: str, keep: bool = False, by: str | None = None) -> None:
    """Append text to the message waiting in path, under the lock. A message
    not taken yet keeps its other fields (a coordinator's from and slug, its
    tries), so a reply appended to an instruction does not drop who to tell
    when it never goes in."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with locked(path):
        prev = read(path)
        old = str(prev.get("text") or "")
        d = {**prev, "text": (old + "\n\n" + text) if old else text, "at": time.time()}
        if keep or prev.get("keep") is True:
            d["keep"] = True
        who = senders(prev.get("by"), by)
        if who:
            d["by"] = who
        _write(path, d)


def expired(d: dict, now: float, grace: float = SWEEP_GRACE_S) -> bool:
    """Whether the taker would drop this message rather than submit it, with
    `grace` to spare."""
    try:
        at = float(d.get("at") or 0)
    except (TypeError, ValueError):
        at = 0.0
    return now - at > (KEEP_S if d.get("keep") is True else STALE_S) + grace


def sweep(now: float | None = None) -> list[str]:
    """Remove inbox files no session will ever take, whoever they were for:
    the taker checks a message's age only when it takes it, so one left for
    a session that ended stayed for good (one from 2026-11-11 was still there
    on 11-20), and kept the office from putting its session to sleep
    (hibernate.waiting_for_it). Leaves failed/ and long/ alone. The names of
    what it removed."""
    now = time.time() if now is None else now
    base = folder()
    try:
        names = os.listdir(base)
    except OSError:
        return []
    gone = []
    for n in names:
        p = os.path.join(base, n)
        if not os.path.isfile(p):
            continue
        sid, _, rest = n.partition(".")
        if not SID.match(sid):
            continue
        try:
            age = now - os.stat(p).st_mtime
        except FileNotFoundError:
            continue
        if rest == "json":
            # Under the lock: a writer appending now must not lose its text
            # to a removal decided on what the file said before.
            try:
                with locked(p):
                    d = read(p)
                    if (expired(d, now) if d else age > KEEP_S + SWEEP_GRACE_S):
                        os.unlink(p)
                        gone.append(n)
            except (TimeoutError, OSError):
                continue
        elif rest == "json.sending" or rest.startswith("json.tmp.") or rest.startswith("json.lock"):
            # A .sending is the taker's while its submit waits (minutes at
            # most); a stale lock is broken by the next writer anyway.
            if age > max(LEFTOVER_S, KEEP_S + SWEEP_GRACE_S if rest == "json.sending" else 0):
                try:
                    os.unlink(p)
                    gone.append(n)
                except OSError:
                    pass
    return gone
