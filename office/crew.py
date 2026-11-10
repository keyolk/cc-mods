"""Ending a session, or taking it off the command view, from the office.

The person asked to end sessions from the command view. What happens depends
on the session's place under a coordinator (its ledger, office/coord.py):

- An owned worker (coord_spawn made it): what coord_close does. Its pane is
  closed and its worktree removed; refused while the worktree has uncommitted
  changes. Its coordinator's next tick sees the session gone and ends it in
  the ledger (hooks/lib/coord.ts observe).
- An adopted session (auto or handed over), or one no coordinator has: the
  person's own Claude session. It ends only on a second, confirming request;
  the first answers what would end (its summary, its pane, and uncommitted
  changes in its directory).

Either way the pane is closed only while tmux says it still holds that
session (@cc_pane_session), so a pane id reused since is never hit. Closing
the pane is how cc-mods already ends what it opened (kill-pane); typing /exit
could land in a permission dialog and pick an option. A coordinator is never
a target, nor anything that is not a Claude session (the office's own TWeb
pane has no @cc_pane_session).

Release takes a session off the view for good and leaves it running. The
ledger is the coordinator's cc-mods' to write (it keeps it in memory and
saves over the file), so the office leaves the request in
coord/ops/<coordinator>.json and the next tick applies it (hooks/coord.ts).

Each tells the coordinator in one line, kept in its inbox until read.
"""

import json
import os
import re
import subprocess
import time

import coord  # office/coord.py, the coordinators' ledgers

KINDS = ("session_end", "session_release")
SID = re.compile(r"[0-9a-f-]{8,64}")


def run(argv: list[str], timeout: int = 5) -> tuple[int, str]:
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)
    return r.returncode, (r.stdout if r.returncode == 0 else r.stderr or r.stdout).strip()


def place(sid: str) -> tuple[dict | None, dict | None]:
    """(ledger, worker entry) of the session under a coordinator, if any."""
    for d in coord.ledgers():
        for w in d.get("workers") or []:
            if w.get("sid") == sid and not w.get("endedAt"):
                return d, w
    return None, None


def is_coordinator(sid: str) -> bool:
    return any(d.get("sid") == sid for d in coord.ledgers())


def dirty(path: str | None, sh=run) -> list[str]:
    """Uncommitted changes in a git directory, at most ten lines; none when it
    is not one."""
    if not path or not os.path.isdir(path):
        return []
    code, out = sh(["git", "-C", path, "status", "--porcelain"])
    return out.splitlines()[:10] if code == 0 and out else []


def end(sid: str, confirm: bool, people: list[dict], inbox_put, sh=run) -> tuple[int, dict]:
    if not SID.fullmatch(sid or ""):
        return 400, {"error": "bad session id"}
    if is_coordinator(sid):
        return 403, {"error": "coordinator 자신은 여기서 끝내지 않습니다"}
    me = next((p for p in people if p.get("id") == sid), None)
    if not me or not me.get("pane"):
        return 404, {"error": "no such session"}
    pane = me["pane"]
    code, held = sh(["tmux", "display-message", "-p", "-t", pane, "#{@cc_pane_session}"])
    if code != 0 or held != sid:
        return 409, {"error": "pane " + pane + "은 이제 이 세션이 아니라서 닫지 않았습니다"}
    d, w = place(sid)
    slug = (w or {}).get("slug") or me.get("name") or sid[:8]
    owned = bool(w) and (w.get("relation") or "owned") == "owned"
    wt = (w or {}).get("worktree") if owned else None
    if owned and wt and dirty(wt, sh):
        return 409, {"error": wt + "에 커밋하지 않은 변경이 있어 닫지 않았습니다", "dirty": dirty(wt, sh)}
    if not owned and not confirm:
        what = coord.summaries().get(sid) or me.get("name") or slug
        return 200, {"confirm": "이 세션을 끝냅니다: " + what + ", pane " + pane, "dirty": dirty(me.get("cwd"), sh), "cwd": me.get("cwd")}
    code, out = sh(["tmux", "kill-pane", "-t", pane])
    if code != 0:
        return 500, {"error": "pane " + pane + "을 닫지 못했습니다: " + out[:200]}
    note = "pane " + pane + " 닫음"
    if wt and os.path.isdir(wt):
        # From the main checkout: git will not remove the worktree it runs in.
        code, out = sh(["git", "-C", w.get("repoDir") or wt, "worktree", "remove", wt], timeout=30)
        note += ", worktree 정리" if code == 0 else ", worktree는 남음 (" + out[:120] + ")"
    if d:
        inbox_put(d["sid"], "[office→coord] 세션 " + slug + " 끝냄 (" + note + ")", keep=True)
    return 200, {"ok": True, "sent": slug + " 끝냄 · " + note}


def ops_file(coord_sid: str) -> str:
    return os.path.join(coord.COORD_DIR, "ops", coord_sid + ".json")


def release(sid: str, inbox_put) -> tuple[int, dict]:
    if not SID.fullmatch(sid or ""):
        return 400, {"error": "bad session id"}
    if is_coordinator(sid):
        return 403, {"error": "coordinator 자신은 목록에서 빼지 않습니다"}
    d, w = place(sid)
    if not w:
        return 404, {"error": "지휘 목록에 없는 세션입니다"}
    path = ops_file(d["sid"])
    try:
        with open(path) as f:
            ops = json.load(f).get("ops") or []
    except (OSError, ValueError, AttributeError):
        ops = []
    ops.append({"op": "release", "sid": sid, "slug": w.get("slug"), "at": time.time()})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"ops": ops}, f)
    os.replace(tmp, path)
    inbox_put(d["sid"], "[office→coord] 세션 " + str(w.get("slug")) + " 지휘 목록에서 뺌 (release; 세션은 계속 돎)", keep=True)
    return 200, {"ok": True, "sent": str(w.get("slug")) + " 목록에서 뺌 · 세션은 계속 돎"}


def act(body: dict, people: list[dict], inbox_put) -> tuple[int, dict]:
    sid = str(body.get("sid") or "")
    if body.get("kind") == "session_release":
        return release(sid, inbox_put)
    return end(sid, body.get("confirm") is True, people, inbox_put)
