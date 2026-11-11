"""Putting long-idle sessions to sleep, and waking them, from the office.

The person asked: "to save memory, take down sessions idle for a long time,
and bring them back from a brief or their history when needed". One idle
Claude Code session holds 400 MB to 1 GB (claude, and the ccproxy that
wraps it); its conversation stays on disk (~/.claude/projects/*/<sid>.jsonl)
and `claude --resume <sid>` brings it back.

Who may sleep (`candidates`): a live session, waiting or done, that waits on
nobody (its pane's own @cc_pane_attention: no question, no permission
dialog), whose last state change and last message are older than
`idleHours`. Never a coordinator, an owned worker (its coordinator drives
it), one with subagents, background tasks or Monitors running (@cc_agents),
one whose prompt holds a draft, whose pane a client looked at in the last
`typedMinutes`, with an office reply or memo still waiting for it, pinned
(📌), sent to the background (/bg: its registry names a parkedJobId, or its
transcript ends in continued-in), or with no transcript to resume from.
When tmux does not answer (a screen, the clients), the answer is no. The tmux
state is not `idle`: a session that finished stays `waiting` (attention
none) or `done`, so both count.

Going down (`sleep`), with every rule checked again at the press, and the
list for "모두 내리기" built here, never taken from the page:
1. The card ~/.claude/state/office/dormant/<sid>.json is written first:
   name, summary, cwd (the registry's: the transcript lives under the
   launch directory's project), pane and window, the last request and the
   gist of its answer, its newest brief (whether it still waits on a
   decision: `brief.pending`), and how it was launched (`launch`). What is
   left undone is not guessed from the transcript: the last request and
   answer are what the person reads to decide.
2. The claude process gets SIGTERM, not a typed /exit (that could land in a
   dialog and pick an option; office/crew.py). The wrapper (ccproxy) goes
   when its child does; one still there after that is sent SIGTERM too.
3. The pane is closed (`pane: close`, the person's pick on the brief
   2026-11-11-session-hibernate-pane): a window left empty goes with it,
   as tmux closes a window with no panes. `pane: keep` instead respawns it
   with a placeholder that says `💤 휴면: <summary>` and wakes the session
   on Enter, its id, place and window kept; `remain-on-exit` is set first,
   or a pane whose root is the launcher would close the moment claude exits.

Waking (`wake`) runs the launch again with `--resume <sid>` in the same cwd,
in a new pane placed as coord_spawn places a worker (hooks/lib/coordplace.ts,
`place`): a split of the window it was in while that window still exists and
has room, else a split of a window whose sessions work in the same
repository, else a new window in its tmux session. A split takes a third of
the longer side and needs 60 columns or 15 rows on both sides (splitPlan);
a window that already holds WINDOW_SESSIONS Claude sessions takes no more.
The command is the wrapper's own argv (ccproxy's, so its intercept stays)
with the person's flags after `--`, or claude's own; flags the office does
not know are dropped and named in the card (a value-taking flag it cannot
tell from a positional would eat the prompt). A worker's first prompt (a
positional argument) is never sent again. The card goes once the registry
shows the session alive again (`view`), so a wake that fails leaves it to
retry.

Auto (`auto`): "pressure" (the default, the person's pick on the brief
2026-11-11-session-hibernate-auto: the view proposes and a press decides,
and while macOS reports memory pressure or swap is nearly full the
candidates are put to sleep without asking), "off" (proposals only),
"always". From ~/.config/cc-mods/office.json:

  "hibernate": {"idleHours": 12, "typedMinutes": 30, "auto": "pressure",
                "pane": "close", "swapFreeMB": 512, "pressureLevel": 2,
                "maxSessions": 8, "capIdleHours": 2}

Session cap (`maxSessions`, 0 turns it off): while more live Claude sessions
run than that, the next longest-idle sessions are proposed down to
`capIdleHours` of rest, only as many as are over the cap (`why: cap`), by
the same rules otherwise (never one waiting on the person, a coordinator,
an owned worker, or an adopted one a coordinator handed a task). They are
proposals only: the automatic mode takes the long-idle ones alone.

OFFICE_HIBERNATE_ONLY=<sid>,<sid> limits every action to those sessions
(the live test runs a second office against the real roster).
"""

import json
import os
import re
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hibproc import launcher, ps, run, subtree_kb  # noqa: E402 - office/hibproc.py, the processes
from hibstate import SID, allowed, cards, config, continued, draft, drop_card, idle_since, pin, pins, registry, transcript  # noqa: E402 - office/hibstate.py, the files
from hibwake import sleep, wake  # noqa: E402 - office/hibwake.py, going down and waking
import hibwake  # noqa: E402
import hibstate  # noqa: E402

KINDS = ("hibernate", "hibernate_all", "wake", "hibernate_pin")
AUTO_EVERY = 300


def looked_at(sh=run) -> dict[str, float] | None:
    """pane id -> the last activity of a client showing it; None when tmux
    did not answer (under load it times out), and then no session may sleep:
    a person may be looking at it."""
    code, out = sh(["tmux", "list-clients", "-F", "#{pane_id} #{client_activity}"])
    if code != 0:
        return None
    seen: dict[str, float] = {}
    for ln in out.splitlines() if code == 0 else []:
        p = ln.split()
        if len(p) == 2 and p[1].isdigit():
            seen[p[0]] = max(seen.get(p[0], 0.0), float(p[1]))
    return seen


def pane_pids(sh=run) -> tuple[dict[str, int], dict[str, str]]:
    """pane id -> its root pid, and -> @cc_pane_attention. The pane's own
    attention, not the window's @cc_attention that /state carries: several
    sessions share a window, and one waiting on the person made its quiet
    neighbour look as if it waited too (live run)."""
    code, out = sh(["tmux", "list-panes", "-a", "-F", "#{pane_id} #{pane_pid} #{@cc_pane_attention}"])
    got, attn = {}, {}
    for ln in out.splitlines() if code == 0 else []:
        p = ln.split()
        if len(p) >= 2 and p[1].isdigit():
            got[p[0]] = int(p[1])
            attn[p[0]] = p[2] if len(p) > 2 else ""
    return got, attn


def capture(pane: str, sh=run) -> list[str] | None:
    """The pane's screen with its colours; None when tmux did not answer."""
    code, out = sh(["tmux", "capture-pane", "-e", "-p", "-t", pane])
    return out.splitlines() if code == 0 else None


def waiting_for_it(sid: str) -> str | None:
    """An office reply or a memo the session has not taken yet."""
    base = os.path.expanduser("~/.claude/state/office")
    for n in (sid + ".json", sid + ".json.sending"):
        if os.path.exists(os.path.join(base, "inbox", n)):
            return "office 답장이 아직 안 들어감"
    try:
        with open(os.path.join(base, "defer", sid + ".json")) as f:
            if (json.load(f) or {}).get("memos"):
                return "📝 메모가 남아 있음"
    except (OSError, ValueError, AttributeError):
        pass
    return None


def why_not(p: dict, ctx: dict, manual: bool = False) -> str | None:
    """Why this session may not sleep now; None when it may."""
    sid, cfg, now = p["id"], ctx["cfg"], ctx["now"]
    if not allowed(sid):
        return "OFFICE_HIBERNATE_ONLY 밖"
    if p.get("coord"):
        return "coordinator"
    boss = p.get("boss") or {}
    if boss and (boss.get("relation") or "owned") == "owned":
        return "owned worker (coordinator가 돌림)"
    if p.get("state") not in ("waiting", "done"):
        return "일하는 중"
    # The pane's own attention when tmux has it, else what /state says.
    attention = ctx.get("attn", {}).get(p.get("pane") or "") or p.get("attention")
    if attention in ("ask", "action", "alert"):
        return "사람 답을 기다림"
    if p.get("agents"):
        return "백그라운드 작업 " + str(p["agents"]) + "개"
    if sid in ctx["pins"]:
        return "📌 고정"
    tx = transcript(sid)
    if not tx:
        return "대화 파일이 없어 되살릴 수 없음"
    idle = now - idle_since(p, tx)
    # Over the session cap (cap_floor), a shorter idle floor, for sessions
    # the cap may take: not one a coordinator handed a task.
    floor = cfg["idleHours"]
    cap = ctx.get("capFloor")
    if cap is not None and cap_eligible(p):
        floor = min(floor, cap)
    if not manual and idle < floor * 3600:
        return "쉰 지 %.1f시간" % (idle / 3600)
    if ctx["seen"] is None:
        return "tmux client 목록을 읽지 못함"
    if now - ctx["seen"].get(p.get("pane") or "", 0) < cfg["typedMinutes"] * 60:
        return "최근 %d분 안에 사람이 본 pane" % int(cfg["typedMinutes"])
    w = waiting_for_it(sid)
    if w:
        return w
    reg = ctx["reg"].get(sid)
    if not reg:
        return "프로세스를 찾지 못함"
    if reg.get("kind") not in (None, "interactive"):
        return "interactive 세션이 아님"
    # Sent to the background (/bg): the conversation goes on in job
    # parkedJobId and this pane is what is left of it; resuming this sid
    # would bring back the old conversation (live roster: the one 12 h
    # candidate was such a pane, its job working an hour ago).
    if reg.get("parkedJobId"):
        return "백그라운드 job " + str(reg["parkedJobId"])[:8] + "으로 이어짐"
    if reg.get("status") == "busy":
        return "registry가 busy"
    if continued(tx):
        return "다른 세션으로 이어짐 (continued-in)"
    if not ctx["rows"] or not ctx["panes"]:
        return "프로세스 목록을 읽지 못함"
    if launcher(int(reg["pid"]), ctx["panes"].get(p.get("pane") or ""), ctx["rows"]) is None:
        return "pane과 프로세스가 맞지 않음"
    if ctx.get("draft", True):
        screen = capture(p["pane"], ctx["sh"])
        if screen is None:
            return "화면을 읽지 못함 (입력창 확인 불가)"
        if draft(screen):
            return "입력창에 보내지 않은 글이 있음"
    return None


def cap_eligible(p: dict) -> bool:
    """Whether the session cap may propose this session. Not one a
    coordinator handed a task: an adopted worker sits waiting between two of
    its sends, and taken down it reads as gone (owned workers and
    coordinators are out already, why_not)."""
    boss = p.get("boss") or {}
    return not (boss and boss.get("instructed"))


def cap_floor(people: list[dict] | None, cfg: dict) -> float | None:
    """The idle floor (hours) while more Claude sessions run than
    `maxSessions` (sys-load brief F, 2026-11-11: 17 sessions, 10.9 GB, 16 of
    them runnable); None at or under the cap, or with no roster to count."""
    if people is None or cfg["maxSessions"] <= 0 or len(people) <= cfg["maxSessions"]:
        return None
    return cfg["capIdleHours"]


def context(sh=run, cfg: dict | None = None, people: list[dict] | None = None) -> dict:
    # why_not rides along: hibwake.sleep checks the rules again at the press,
    # with the same capFloor, so a cap candidate is not refused there.
    cfg = cfg or config()
    panes, attn = pane_pids(sh)
    return {"cfg": cfg, "now": time.time(), "pins": pins(), "seen": looked_at(sh), "reg": registry(), "panes": panes, "attn": attn, "rows": ps(sh), "sh": sh, "why_not": why_not,
            "capFloor": cap_floor(people, cfg), "live": len(people) if people is not None else None}


def reclaim_mb(p: dict, ctx: dict) -> int:
    reg = ctx["reg"].get(p["id"])
    top = reg and launcher(int(reg["pid"]), ctx["panes"].get(p.get("pane") or ""), ctx["rows"])
    return subtree_kb(top, ctx["rows"]) // 1024 if top else 0


def candidates(people: list[dict], ctx: dict) -> list[dict]:
    """Who may sleep: the long-idle ones (`idleHours`), and over the session
    cap the next longest-idle ones down to `capIdleHours` (`why: cap`), only
    as many as the sessions over it. The draft check captures the pane, so
    it runs on the cheap rules' survivors only, longest idle first, and the
    cap's run stops once the excess is filled (sys-load brief D)."""
    plain = {**ctx, "capFloor": None}
    rows = []
    for p in people:
        tx = transcript(p["id"])
        rows.append((ctx["now"] - idle_since(p, tx) if tx else 0.0, p))
    rows.sort(key=lambda r: -r[0])
    out = []

    def row(p: dict, idle: float, why: str) -> dict:
        return {"sid": p["id"], "name": p.get("name"), "pane": p.get("pane"), "window": p.get("window"), "idleH": round(idle / 3600, 1), "mb": reclaim_mb(p, ctx), "why": why}

    for idle, p in rows:
        if why_not(p, {**plain, "draft": False}) is None and why_not(p, plain) is None:
            out.append(row(p, idle, "idle"))
    excess = (ctx.get("live") or 0) - ctx["cfg"]["maxSessions"] - len(out)
    if ctx.get("capFloor") is not None and excess > 0:
        taken = {c["sid"] for c in out}
        for idle, p in rows:
            if excess <= 0:
                break
            if p["id"] in taken:
                continue
            if why_not(p, {**ctx, "draft": False}) is None and why_not(p, ctx) is None:
                out.append(row(p, idle, "cap"))
                excess -= 1
    return out


def pressure(sh=run, cfg: dict | None = None) -> dict:
    """macOS memory pressure: "free" is always near zero there, so the kernel's
    level (1 normal, 2 warn, 4 critical) and swap left are the signal."""
    cfg = cfg or config()
    code, lvl = sh(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"])
    code2, sw = sh(["sysctl", "-n", "vm.swapusage"])
    m = re.search(r"free = ([\d.]+)M", sw if code2 == 0 else "")
    level = int(lvl) if code == 0 and lvl.strip().isdigit() else 0
    free = float(m.group(1)) if m else None
    on = level >= cfg["pressureLevel"] or (free is not None and free < cfg["swapFreeMB"])
    return {"level": level, "swapFreeMB": free, "on": on}


_view: dict = {"at": 0.0, "out": None, "busy": False}
VIEW_TTL = 15
EMPTY = {"cards": [], "candidates": [], "mb": 0, "auto": None, "idleHours": None, "cap": None, "pressure": None, "pins": []}


def view(people: list[dict], sh=run, fresh: bool = False) -> dict:
    """/command's `hibernate`: cards (asleep), candidates (may sleep), pressure.
    /command polls every 3 s and the candidates cost a ps, a capture per idle
    session and git calls, seconds under the load this exists for: the poll
    gets the last answer at once and a thread works out the next one."""
    if fresh:
        out = _view_now(people, sh)
        _view.update(at=time.time(), out=out)
        return out
    if time.time() - _view["at"] >= VIEW_TTL and not _view["busy"]:
        _view["busy"] = True

        def work():
            try:
                _view.update(at=time.time(), out=_view_now(people, sh))
            except Exception as e:  # noqa: BLE001 - the next poll tries again
                print("hibernate: view failed: " + repr(e), file=sys.stderr, flush=True)
            finally:
                _view["busy"] = False
        threading.Thread(target=work, name="hibernate-view", daemon=True).start()
    return _view["out"] or EMPTY


WAKE_GRACE = 180


def resumed(c: dict) -> bool:
    """It ran again after it went down: a message in its transcript newer
    than the card. The registry alone misses a session woken and ended
    between two passes (live run: /exit right after a wake left the card)."""
    return bool(c.get("transcript")) and idle_since({}, c["transcript"]) > float(c.get("at") or 0) + 1


def _view_now(people: list[dict], sh=run) -> dict:
    alive = registry()
    sleeping = []
    for c in cards():
        if c["sid"] in alive or resumed(c):
            drop_card(c["sid"])  # woken, here or by hand
            continue
        row = {k: c.get(k) for k in ("sid", "name", "summary", "cwd", "window", "pane", "mb", "at", "turn", "wokeAt", "mode", "brief", "auto")} | {"dropped": c["launch"].get("dropped") or []}
        # A wake that never came up (its pane closed at once): 깨우기 again.
        if row["wokeAt"] and time.time() - row["wokeAt"] > WAKE_GRACE:
            row["wokeAt"] = None
        sleeping.append(row)
    ctx = context(sh, people=people)
    cands = candidates(people, ctx)
    return {"cards": sleeping, "candidates": cands, "mb": sum(c["mb"] for c in cands), "auto": ctx["cfg"]["auto"], "idleHours": ctx["cfg"]["idleHours"],
            "cap": {"max": ctx["cfg"]["maxSessions"], "live": ctx["live"], "idleHours": ctx["cfg"]["capIdleHours"], "on": ctx["capFloor"] is not None},
            "pressure": pressure(sh, ctx["cfg"]), "pins": sorted(ctx["pins"])}


def act(body: dict, people: list[dict], inbox_put=None, sh=run, brief=None) -> tuple[int, dict]:
    _view["at"] = 0.0  # the next /command works out what the press changed
    kind, sid = body.get("kind"), str(body.get("sid") or "")
    if kind == "wake":
        return wake(sid, sh)
    if kind == "hibernate_pin":
        if not SID.match(sid):
            return 400, {"error": "bad session id"}
        on = body.get("on") is not False
        pin(sid, on)
        return 200, {"ok": True, "sent": ("📌 고정: 휴면 후보에서 뺌" if on else "📌 해제")}
    ctx = context(sh, people=people)
    if kind == "hibernate":
        p = next((x for x in people if x.get("id") == sid), None)
        if not p:
            return 404, {"error": "no such session"}
        return sleep(p, ctx, manual=True, extra={"brief": brief(sid) if brief else None})
    if kind == "hibernate_all":
        # The list is this server's, never the page's.
        done, failed, mb = [], [], 0
        for cnd in candidates(people, ctx):
            p = next(x for x in people if x["id"] == cnd["sid"])
            code, out = sleep(p, context(sh, people=people), extra={"brief": brief(p["id"]) if brief else None})
            (done if code == 200 else failed).append(str(p.get("name")) + ("" if code == 200 else ": " + out.get("error", "")))
            mb += out.get("mb", 0) if code == 200 else 0
        if not done and not failed:
            return 200, {"ok": True, "sent": "휴면 후보가 없습니다"}
        return 200, {"ok": True, "sent": "💤 " + str(len(done)) + "개 휴면 · ~" + str(round(mb / 1024, 1)) + "GB" + (" · 실패 " + "; ".join(failed) if failed else ""), "done": done, "failed": failed}
    return 400, {"error": "unknown kind"}


def auto_tick(snapshot, sh=run, brief=None) -> list[str]:
    """One pass of the automatic mode; what it put to sleep."""
    cfg = config()
    if cfg["auto"] == "off" or (cfg["auto"] == "pressure" and not pressure(sh, cfg)["on"]):
        return []
    people = snapshot()
    out = []
    # Only the long-idle ones: the cap's are proposals, a press decides
    # (the person's pick on 2026-11-11-session-hibernate-auto was made for
    # sessions idle half a day, not two hours). Their recheck runs without
    # the cap's floor too.
    for cnd in candidates(people, context(sh, cfg)):
        if cnd.get("why") == "cap":
            continue
        p = next(x for x in people if x["id"] == cnd["sid"])
        code, _ = sleep(p, context(sh, cfg), extra={"auto": cfg["auto"], "brief": brief(p["id"]) if brief else None})
        if code == 200:
            out.append(cnd["sid"])
    return out


def start(snapshot, brief=None) -> None:
    """The automatic mode's loop, in the office server (a daemon thread)."""
    def loop():
        while True:
            time.sleep(AUTO_EVERY)
            try:
                auto_tick(snapshot, brief=brief)
            except Exception as e:  # noqa: BLE001 - one bad pass must not stop the next
                print("hibernate: auto pass failed: " + repr(e), file=sys.stderr, flush=True)
    threading.Thread(target=loop, name="hibernate-auto", daemon=True).start()


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "placeholder":
        hibwake.placeholder(sys.argv[2])
    elif len(sys.argv) >= 2 and sys.argv[1] == "cards":
        print(json.dumps(cards(), ensure_ascii=False, indent=1))
    else:
        print("usage: hibernate.py placeholder <sid> | cards", file=sys.stderr)
        sys.exit(2)
