"""The office's periodic cleanup of per-session files nobody removes: inbox
messages past their expiry (inboxfile.sweep) and status records
(~/.claude/state/office/status/<sid>.json, written by the `status` tool) of
sessions that ended.

It runs in the office server: one process per machine, already reading the
session registry, where a coordinator's tick runs once per coordinator (none
when no coordinator is on, several at once otherwise) and inbox files are
for every session, not only a coordinator's workers."""

import glob
import os
import sys
import threading
import time

import hibstate
import inboxfile

EVERY_S = 10 * 60
FIRST_S = 60
# A status record of a session that is not running is removed only this
# long after it was last written: a session the office cannot see (its
# registry file gone, a pid check that failed) still keeps a recent one.
STATUS_KEEP_S = 3 * 86400


def status_folder() -> str:
    # Expanded on each call: a test sets HOME in-process.
    return os.path.expanduser("~/.claude/state/office/status")


def _recent_transcript(sid: str, now: float) -> bool:
    for f in glob.glob(os.path.expanduser("~/.claude/projects/*/" + sid + ".jsonl")):
        try:
            if now - os.stat(f).st_mtime < STATUS_KEEP_S:
                return True
        except OSError:
            continue
    return False


def status(alive: set[str] | None, now: float | None = None) -> list[str]:
    """Remove the status records of sessions that ended. A record goes only
    when all of these hold: the registry was read (None removes nothing),
    its session is not running, not asleep (a dormant card: the office wakes
    it later with --resume), its transcript was not written in
    STATUS_KEEP_S, and the record itself is older than that."""
    if alive is None:
        return []
    now = time.time() if now is None else now
    base = status_folder()
    try:
        names = os.listdir(base)
    except OSError:
        return []
    asleep = {str(c.get("sid")) for c in hibstate.cards()}
    gone = []
    for n in names:
        sid, ext = os.path.splitext(n)
        if ext != ".json" or not inboxfile.SID.match(sid) or sid in alive or sid in asleep:
            continue
        p = os.path.join(base, n)
        try:
            if now - os.stat(p).st_mtime < STATUS_KEEP_S:
                continue
        except OSError:
            continue
        if _recent_transcript(sid, now):
            continue
        try:
            os.unlink(p)
            gone.append(n)
        except OSError:
            pass
    return gone


def tick(alive_sessions, now: float | None = None) -> dict:
    return {"inbox": inboxfile.sweep(now), "status": status(alive_sessions(), now)}


def _loop(alive_sessions) -> None:
    time.sleep(FIRST_S)
    while True:
        try:
            got = tick(alive_sessions)
            if got["inbox"] or got["status"]:
                print(f"cc-office: swept {len(got['inbox'])} inbox and {len(got['status'])} status files", file=sys.stderr, flush=True)
        except Exception as e:  # the sweep must not end the office; say why it failed
            print(f"cc-office: sweep failed: {e!r}", file=sys.stderr, flush=True)
        time.sleep(EVERY_S)


def start(alive_sessions) -> None:
    """`alive_sessions`: office.alive_sessions, the running sessions' ids or
    None when the registry could not be read."""
    threading.Thread(target=_loop, args=(alive_sessions,), name="sweep", daemon=True).start()
