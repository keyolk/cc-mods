"""Putting one session to sleep and waking it (office/hibernate.py says who
and when; its docstring says how)."""

import os
import shlex
import signal
import subprocess
import sys
import time

import coord  # office/coord.py: the summary a card keeps
from hibproc import ENV_KEEP, ENV_SECRET, launcher, procargs, resume_argv, run, subtree_kb
from hibstate import SID, _lock, _write, allowed, card, drop_card, folder, last_turn, registry, transcript

HERE = os.path.dirname(os.path.abspath(__file__))


def _kill(pid: int, sig: int) -> None:
    os.kill(pid, sig)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _gone(pid: int, secs: float) -> bool:
    end = time.time() + secs
    while time.time() < end:
        if not _alive(pid):
            return True
        time.sleep(0.2)
    return not _alive(pid)


def placeholder_argv(sid: str) -> list[str]:
    return [sys.executable, os.path.join(HERE, "hibernate.py"), "placeholder", sid]


def sleep(p: dict, ctx: dict, manual: bool = False, extra: dict | None = None) -> tuple[int, dict]:
    sid, sh = p["id"], ctx["sh"]
    no = ctx["why_not"](p, ctx, manual)
    if no:
        return 409, {"error": "휴면하지 않음: " + no}
    pane = p["pane"]
    code, held = sh(["tmux", "display-message", "-p", "-t", pane, "#{@cc_pane_session}"])
    if code != 0 or held != sid:
        return 409, {"error": "pane " + pane + "은 이제 이 세션이 아닙니다"}
    reg = ctx["reg"][sid]
    pid = int(reg["pid"])
    pane_pid = ctx["panes"].get(pane)
    top = launcher(pid, pane_pid, ctx["rows"])
    got = ctx.get("procargs", procargs)(top) if top else None
    if not got:
        return 500, {"error": "실행 인자를 읽지 못해 내리지 않았습니다"}
    exe, argv, env = got
    resume, dropped = resume_argv(exe, argv, sid)
    root = "launcher" if top == pane_pid else "shell"
    cfg = ctx["cfg"]
    tx = transcript(sid)
    c = {
        "sid": sid, "name": reg.get("name") or p.get("name"), "summary": coord.summaries().get(sid) or p.get("title") or p.get("name"),
        "cwd": reg.get("cwd") or p.get("cwd"), "pane": pane, "window": p.get("window"), "wid": p.get("wid"),
        "session": (p.get("window") or ":").split(":")[0], "turn": last_turn(tx), "transcript": tx,
        "launch": {"argv": resume, "dropped": dropped, "root": root, "env": {k: v for k, v in env.items() if ENV_KEEP.match(k) and not ENV_SECRET.search(k)}},
        "mb": subtree_kb(top, ctx["rows"]) // 1024, "pid": pid, "at": time.time(), "mode": cfg["pane"], **(extra or {}),
    }
    with _lock:
        _write(os.path.join(folder(), sid + ".json"), c)
    keep = cfg["pane"] == "keep"
    if keep:
        # A pane whose root is the launcher would close as soon as claude exits.
        sh(["tmux", "set-option", "-p", "-t", pane, "remain-on-exit", "on"])
    try:
        ctx.get("kill", _kill)(pid, signal.SIGTERM)
    except OSError as e:
        drop_card(sid)
        return 500, {"error": "SIGTERM 실패: " + str(e)}
    gone = ctx.get("gone", _gone)
    if not gone(pid, 30):
        # The card stays: claude may still be on its way out (12.6 s in the
        # live run under load), and a dead session with no card has no wake
        # row. The view drops it if the session turns out to stay alive.
        return 504, {"error": "claude가 30초 안에 끝나지 않았습니다 (pid " + str(pid) + "); 카드는 남겨 둠, pane은 그대로"}
    if top != pid and not gone(top, 5):
        try:
            ctx.get("kill", _kill)(top, signal.SIGTERM)  # the wrapper outlived its child
        except OSError:
            pass
        gone(top, 5)
    if keep:
        code, out = sh(["tmux", "respawn-pane", "-k", "-t", pane, "-c", c["cwd"] or os.path.expanduser("~"), *placeholder_argv(sid)])
        sh(["tmux", "set-option", "-p", "-t", pane, "@cc_dormant", sid])
        note = "pane " + pane + "에 💤 표시" if code == 0 else "pane을 다시 띄우지 못함 (" + out[:80] + ")"
    else:
        # A pane whose root was the launcher closed itself when it exited;
        # one with a shell under claude is closed here, and only while its
        # root is still that shell (a pane id is reused once freed). tmux
        # closes a window when its last pane goes.
        code, now = sh(["tmux", "display-message", "-p", "-t", pane, "#{pane_pid}"])
        if code == 0 and now == str(pane_pid) and root == "shell":
            sh(["tmux", "kill-pane", "-t", pane])
        note = "pane " + pane + " 닫음"
    return 200, {"ok": True, "sent": "💤 " + str(c["name"]) + " 휴면 · ~" + str(c["mb"]) + "MB · " + note, "mb": c["mb"]}


WINDOW_SESSIONS = 3
SPLIT_MIN = {"cols": 60, "rows": 15}
PANES_FMT = "#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}\t#{@cc_pane_session}\t#{session_name}\t#{window_active}#{pane_active}"


def split_plan(width: int, height: int) -> list[str] | None:
    """coordplace.ts splitPlan: a third of the longer side, both sides big enough."""
    across = ("-h", width // 3, width - width // 3 - 1, SPLIT_MIN["cols"])
    down = ("-v", height // 3, height - height // 3 - 1, SPLIT_MIN["rows"])
    for d, size, keep, low in ([across, down] if width >= 2 * height else [down, across]):
        if size >= low and keep >= low:
            return [d, "-l", str(size)]
    return None


def common_dir(path: str | None, sh=run) -> str | None:
    if not path or not os.path.isdir(path):
        return None
    code, out = sh(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    return out if code == 0 and out else None


def place(c: dict, sh=run) -> tuple[str, list[str], str]:
    """Where a woken session's pane goes: ("split", flags, pane to split) or
    ("new", [], tmux session or "")."""
    code, out = sh(["tmux", "list-panes", "-a", "-F", PANES_FMT])
    panes = [ln.split("\t") for ln in out.splitlines()] if code == 0 else []
    panes = [p for p in panes if len(p) >= 8]
    by_win: dict[str, list[list[str]]] = {}
    for p in panes:
        by_win.setdefault(p[0], []).append(p)

    def spot(wid: str) -> tuple[list[str], str] | None:
        ps_ = by_win.get(wid) or []
        if sum(1 for p in ps_ if p[5]) >= WINDOW_SESSIONS:
            return None
        # The window's largest pane is split, as the coordinator's own is.
        for p in sorted(ps_, key=lambda p: -int(p[2] or 0) * int(p[3] or 0)):
            plan = split_plan(int(p[2] or 0), int(p[3] or 0))
            if plan:
                return plan, p[1]
        return None

    first = spot(c.get("wid") or "") if c.get("wid") else None
    if first:
        return "split", *first
    want = common_dir(c.get("cwd"), sh)
    if want:
        for wid, ps_ in by_win.items():
            if wid != c.get("wid") and any(p[5] and common_dir(p[4], sh) == want for p in ps_):
                got = spot(wid)
                if got:
                    return "split", *got
    sess = c.get("session") if any(p[6] == c.get("session") for p in panes) else ""
    return "new", [], sess or ""


def wake_argv(c: dict) -> list[str]:
    cmd = list(c["launch"]["argv"])
    if c["launch"].get("root") == "shell":
        # The pane had a shell under claude: it gets one back when claude exits.
        shell = os.environ.get("SHELL") or "/bin/sh"
        return ["/bin/sh", "-c", shlex.join(cmd) + "; exec " + shlex.quote(shell) + " -l"]
    return cmd


def wake(sid: str, sh=run) -> tuple[int, dict]:
    if not SID.match(sid or "") or not allowed(sid):
        return 400, {"error": "bad session id"}
    c = card(sid)
    if not c:
        return 404, {"error": "휴면 카드가 없습니다"}
    if sid in registry():
        drop_card(sid)
        return 200, {"ok": True, "sent": "이미 깨어 있음: 카드만 지웠습니다"}
    cwd = c.get("cwd") if c.get("cwd") and os.path.isdir(c["cwd"]) else os.path.expanduser("~")
    env = [a for k, v in (c["launch"].get("env") or {}).items() for a in ("-e", k + "=" + v)]
    argv = wake_argv(c)
    pane = c.get("pane") or ""
    code, held = sh(["tmux", "display-message", "-p", "-t", pane, "#{@cc_dormant}"]) if pane else (1, "")
    if code == 0 and held == sid:
        code, out = sh(["tmux", "respawn-pane", "-k", "-t", pane, "-c", cwd, *env, *argv])
        sh(["tmux", "set-option", "-p", "-t", pane, "-u", "@cc_dormant"])
        sh(["tmux", "set-option", "-p", "-t", pane, "-u", "remain-on-exit"])
        where = "pane " + pane
    else:
        how, target, where = place(c, sh)
        if how == "split":
            code, out = sh(["tmux", "split-window", "-d", *target, "-t", where, "-c", cwd, *env, *argv])
            where = "pane " + where + " 옆"
        else:
            code, out = sh(["tmux", "new-window", "-d", *(["-t", where + ":"] if where else []), "-c", cwd, "-n", str(c.get("name") or sid[:8])[:20], *env, *argv])
            where = "새 창"
    if code != 0:
        return 502, {"error": "깨우지 못했습니다: " + out[:200]}
    with _lock:
        c["wokeAt"] = time.time()
        _write(os.path.join(folder(), sid + ".json"), c)
    return 200, {"ok": True, "sent": "깨움: " + str(c.get("name")) + " → " + where}


def placeholder(sid: str) -> None:
    """What a kept pane shows while its session sleeps; Enter wakes it here."""
    c = card(sid)
    if not c:
        print("💤 이 세션의 휴면 카드가 없습니다: " + sid)
        os.execvp(os.environ.get("SHELL") or "/bin/sh", [os.environ.get("SHELL") or "/bin/sh", "-l"])
    t = c.get("turn") or {}
    print("\n  💤 휴면: " + str(c.get("summary") or c.get("name")) + " — office 지휘에서 깨우기, 또는 여기서 Enter")
    if t.get("ask"):
        print("     마지막 요청: " + t["ask"].splitlines()[0][:160])
    if t.get("said"):
        print("     마지막 답: " + t["said"][:160])
    print("     " + time.strftime("%m-%d %H:%M", time.localtime(c.get("at") or 0)) + "에 내림 · ~" + str(c.get("mb")) + "MB 회수 · " + str(c.get("cwd")))
    try:
        input()
    except (EOFError, KeyboardInterrupt):
        return
    c = card(sid) or c
    c["wokeAt"] = time.time()
    _write(os.path.join(folder(), sid + ".json"), c)
    try:
        os.chdir(c.get("cwd") or os.path.expanduser("~"))
    except OSError:
        pass
    subprocess.run(["tmux", "set-option", "-p", "-u", "@cc_dormant"], capture_output=True)
    subprocess.run(["tmux", "set-option", "-p", "-u", "remain-on-exit"], capture_output=True)
    env = {**os.environ, **(c["launch"].get("env") or {})}
    argv = wake_argv(c)
    os.execve(argv[0], argv, env)
