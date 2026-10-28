#!/usr/bin/env python3
"""cc-office: every Claude Code session in tmux as a little worker in an office.

Serves office.html and /state on 127.0.0.1 only. A session is a tmux pane with
@cc_pane_session (published by cc-mods); where its worker stands comes from the
last tool call in its transcript:

  Read/Grep/Glob/WebFetch/WebSearch -> library     (reading)
  Bash/Monitor/BashOutput           -> workshop    (running a command)
  mcp__*                            -> phone booth (calling a service)
  Edit/Write/NotebookEdit           -> desk        (writing)
  Agent/Task/Workflow               -> desk, subagents come out of the corner
  working with no tool for a while  -> desk, chin in hand (thinking)
  waiting/ask, action               -> desk, a "?" or "!" over the head
  done / idle                       -> lounge

Usage: office.py [--port 8787]
"""

import glob
from datetime import datetime
import html
import json
import os
import re
import secrets
import shutil
import threading
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resources  # noqa: E402 - office/resources.py, beside this file

HERE = os.path.dirname(os.path.abspath(__file__))
# The server code it was started from, by file and whole-second mtime. /office
# compares this with the files on disk and restarts a server left over from
# older code: the page is read fresh on every request, so a new page against
# an old server asks for routes the server does not have.
SERVER_FILES = ("office.py", "resources.py")


def code_stamp() -> str:
    return ",".join(f"{n}:{int(os.stat(os.path.join(HERE, n)).st_mtime)}" for n in SERVER_FILES)


STAMP = code_stamp()
FMT = "|".join(
    [
        "#{pane_id}",
        "#{session_name}",
        "#{window_index}",
        "#{window_name}",
        "#{@cc_pane_session}",
        "#{@cc_pane_state}",
        "#{@cc_pane_since}",
        "#{@cc_attention}",
        "#{@title}",
        "#{@cc_agents}",
        "#{@cc_ctx}",
        "#{window_id}",
    ]
)

READ = {"Read", "Grep", "Glob", "WebFetch", "WebSearch", "LS", "ToolSearch"}
RUN = {"Bash", "Monitor", "BashOutput", "KillShell", "TaskStop"}
WRITE = {"Edit", "Write", "NotebookEdit", "MultiEdit"}
DELEGATE = {"Agent", "Task", "Workflow", "SendMessage"}

_paths: dict[str, str] = {}
_live_panes: set[str] = set()


def transcript(sid: str) -> str | None:
    if sid not in _paths:
        hits = glob.glob(os.path.expanduser("~/.claude/projects/*/" + sid + ".jsonl"))
        if not hits:
            return None
        _paths[sid] = max(hits, key=os.path.getmtime)
    return _paths[sid]


def last_tool(sid: str) -> dict:
    """The newest tool call in the transcript's tail, and whether it returned."""
    path = transcript(sid)
    return last_tool_in(path) if path else {}


def last_tool_in(path: str) -> dict:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 96_000))
            lines = f.read().decode("utf-8", "replace").splitlines()[1:]
    except OSError:
        return {}
    tool, detail, at, done = None, "", None, False
    for line in lines:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        content = (d.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if b.get("type") == "tool_use":
                tool, at, done = b.get("name"), d.get("timestamp"), False
                inp = b.get("input") or {}
                detail = str(inp.get("description") or inp.get("file_path") or inp.get("pattern") or inp.get("command") or inp.get("url") or "")[:80]
            elif b.get("type") == "tool_result" and tool:
                done = True
    return {"tool": tool, "detail": detail, "at": at, "done": done}


# ---- personality: what kind of work, how much of it ----------------------
#
# Every tool call in the transcript is counted once, read incrementally (the
# file only grows; the offset read so far is kept), and the mix gives the
# character its job; the total, its seniority.

_counts: dict[str, dict] = {}


_born: dict[str, float] = {}


def born(sid: str) -> float | None:
    """When the session began: the first timestamp in its transcript."""
    path = transcript(sid)
    if not path:
        return None
    if path in _born:
        return _born[path]
    try:
        with open(path, "rb") as f:
            for _ in range(40):
                line = f.readline()
                if not line:
                    break
                try:
                    ts = json.loads(line).get("timestamp")
                except ValueError:
                    continue
                if ts:
                    from datetime import datetime

                    _born[path] = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
                    return _born[path]
    except OSError:
        pass
    return None


def tool_counts(sid: str) -> dict:
    path = transcript(sid)
    if not path:
        return {"total": 0, "by": {}, "compacts": 0, "compactAt": None, "preTokens": None}
    st = _counts.setdefault(path, {"off": 0, "by": {}, "total": 0, "compacts": 0, "compactAt": None, "preTokens": None})
    try:
        size = os.path.getsize(path)
        if size < st["off"]:
            st.update(off=0, by={}, total=0, compacts=0, compactAt=None, preTokens=None)
        with open(path, "rb") as f:
            f.seek(st["off"])
            chunk = f.read()
    except OSError:
        return {k: st[k] for k in ("total", "by", "compacts", "compactAt", "preTokens")}
    end = chunk.rfind(b"\n") + 1  # a half-written last line waits for next time
    for line in chunk[:end].splitlines():
        # A compaction leaves a compact_boundary entry: how many, the last
        # one's time and how full it was before.
        if b'"compact_boundary"' in line:
            try:
                d = json.loads(line)
                st["compacts"] += 1
                st["compactAt"] = datetime.fromisoformat(str(d.get("timestamp", "")).replace("Z", "+00:00")).timestamp()
                st["preTokens"] = (d.get("compactMetadata") or {}).get("preTokens")
            except (ValueError, TypeError):
                pass
            continue
        if b'"tool_use"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        # Only the assistant's own turns: a proxy can log each API request
        # into the transcript too (type api-request-blob), which repeats every
        # earlier tool call without a time.
        if d.get("type") != "assistant":
            continue
        for b in (d.get("message") or {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                st["by"][kind_of(b.get("name") or "")] = st["by"].get(kind_of(b.get("name") or ""), 0) + 1
                st["total"] += 1
                if b.get("name") == "SendMessage":
                    note_talk(sid, b, d.get("timestamp"))
    st["off"] += end
    return {"total": st["total"], "by": st["by"], "compacts": st["compacts"], "compactAt": st["compactAt"], "preTokens": st["preTokens"]}


# Sessions talking to each other: every SendMessage a session sends, read
# from the sender's transcript as its tool calls are counted. The recipient is
# named as the peer listing names it ("tweb-5a", "gavin-jeong-7d [ref]"), so it
# is resolved through Claude Code's session registry (~/.claude/sessions/
# <pid>.json: name, sessionId, messagingSocketPath). Kept for TALK_KEEP.
TALK_KEEP = 15 * 60
_talks: dict[str, dict] = {}
_registry: dict = {"at": 0.0, "by": {}, "alive": set(), "read": False}


def pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
    except PermissionError:
        return True  # someone else's process, but a process
    except (OSError, TypeError, ValueError):
        return False
    return True


def registry() -> dict:
    _read_registry()
    return _registry["by"]


# Sessions whose Claude Code process still runs. The registry outlives its
# process (half the files there name a dead pid), and a pane keeps its
# @cc_pane_session after the session in it ends: a `claude -p` run from a
# shell pane, /clear, or an exit that skipped the hook. Only a running pid
# says the session is there. None when the registry could not be read, so a
# missing directory never sends everyone home.
def alive_sessions() -> set[str] | None:
    _read_registry()
    return _registry["alive"] if _registry["read"] else None


def _read_registry() -> None:
    if time.time() - _registry["at"] < 5:
        return
    by: dict[str, dict] = {}
    alive: set[str] = set()
    files = glob.glob(os.path.expanduser("~/.claude/sessions/*.json"))
    for f in files:
        try:
            with open(f) as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        sid = d.get("sessionId")
        if not sid:
            continue
        if pid_alive(d.get("pid") or os.path.basename(f)[:-5]):
            alive.add(sid)
        for key in (d.get("name"), d.get("messagingSocketPath"), "uds:" + str(d.get("messagingSocketPath") or ""), sid):
            if key:
                by[str(key)] = {"sid": sid, "name": d.get("name") or sid[:8]}
    _registry.update(at=time.time(), by=by, alive=alive, read=bool(files))


def note_talk(sid: str, block: dict, ts) -> None:
    inp = block.get("input") or {}
    to = re.sub(r"\s*\[[^\]]*\]$", "", str(inp.get("to") or "")).strip()
    try:
        at = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return
    if time.time() - at > TALK_KEEP or not to:
        return
    text = str(inp.get("summary") or inp.get("message") or "")
    _talks[str(block.get("id") or (sid + str(at)))] = {"id": str(block.get("id") or ""), "from": sid, "toName": to, "text": text[:160], "at": at}


def talks() -> list[dict]:
    now, reg = time.time(), registry()
    out = []
    for k, t in list(_talks.items()):
        if now - t["at"] > TALK_KEEP:
            _talks.pop(k, None)
            continue
        hit = reg.get(t["toName"]) or next((v for n, v in reg.items() if v["sid"].startswith(t["toName"])), None)
        out.append({**t, "to": hit["sid"] if hit else None, "fromName": next((v["name"] for v in reg.values() if v["sid"] == t["from"]), t["from"][:8])})
    return sorted(out, key=lambda t: t["at"])


def kind_of(tool: str) -> str:
    t = tool.lower()
    if "slack" in t or "gmail" in t or tool == "SendMessage":
        return "talk"
    if "docs" in t or "confluence" in t or "notion" in t or tool in ("Artifact", "NotebookEdit"):
        return "write"
    if tool in ("Edit", "Write", "MultiEdit"):
        return "code"
    if tool in ("Read", "Grep", "Glob", "WebFetch", "WebSearch") or "search" in t:
        return "read"
    if tool in ("Monitor", "TaskStop", "BashOutput", "ScheduleWakeup"):
        return "watch"
    if tool in ("Agent", "Task", "Workflow"):
        return "lead"
    if tool.startswith("mcp__"):
        return "ops"
    return "shell"


# The job a mix reads as. Bash is most of every session's calls, so it only
# decides when it is nearly all of them; otherwise the biggest share of the
# rest does.
JOBS = ("talk", "write", "code", "read", "watch", "lead", "ops", "shell")


def job_of(by: dict) -> str:
    total = sum(by.values())
    rest = {k: v for k, v in by.items() if k != "shell"}
    if total < 5 or sum(rest.values()) < total * 0.05:
        return "shell"
    return max(rest, key=lambda k: rest[k])


RANKS = [(10_000, 5), (5_000, 4), (2_000, 3), (500, 2), (100, 1), (0, 0)]


def rank_of(total: int) -> int:
    return next(r for n, r in RANKS if total >= n)


# A subagent counts as out while its transcript was written this recently.
SUB_LIVE_S = 45
SUB_CAP = 8


def subagents(sid: str) -> list[dict]:
    """The session's subagents still working: <project>/<sid>/subagents/agent-*.jsonl,
    each with its .meta.json (description, agentType), and what each is doing."""
    path = transcript(sid)
    if not path:
        return []
    now = time.time()
    out = []
    for f in glob.glob(os.path.join(os.path.dirname(path), sid, "subagents", "agent-*.jsonl")):
        try:
            mt = os.path.getmtime(f)
        except OSError:
            continue
        if now - mt > SUB_LIVE_S:
            continue
        aid = os.path.basename(f)[len("agent-") : -len(".jsonl")]
        meta = {}
        try:
            with open(f[: -len(".jsonl")] + ".meta.json") as m:
                meta = json.load(m)
        except (OSError, ValueError):
            pass
        t = last_tool_in(f)
        where, doing = room("working", "none", t)
        out.append({"id": aid, "desc": str(meta.get("description") or "")[:80], "type": meta.get("agentType") or "agent", "job": sub_job(meta, t), "room": where, "doing": doing, "tool": t.get("tool"), "detail": t.get("detail"), "at": mt})
    out.sort(key=lambda a: -a["at"])
    return out[:SUB_CAP]


def sub_job(meta: dict, t: dict) -> str:
    kind = str(meta.get("agentType") or "") + " " + str(meta.get("description") or "")
    k = kind.lower()
    if "review" in k:
        return "read"
    if "explore" in k or "search" in k or "research" in k:
        return "read"
    if "plan" in k or "architect" in k:
        return "lead"
    if "doc" in k or "writer" in k:
        return "write"
    return kind_of(t.get("tool") or "") if t.get("tool") else "shell"


DONE_LINGER = 90


def room(state: str, attention: str, t: dict, since: float | None = None) -> tuple[str, str]:
    tool = t.get("tool") or ""
    if state == "working":
        if not t.get("done"):
            if tool in READ:
                return "library", "reading"
            if tool in RUN:
                return "workshop", "running"
            if tool in WRITE:
                return "desk", "typing"
            if tool in DELEGATE:
                return "desk", "delegating"
            if tool.startswith("mcp__"):
                return "phone", "calling"
        return "desk", "thinking"
    if attention == "action":
        return "desk", "alert"
    if attention == "ask":
        return "desk", "asking"
    # Just done: it stays at its desk a while with its answer (DONE_LINGER),
    # so a short job you gave it shows as it coming back and answering, not
    # as a walk from the lounge and straight back.
    if since and time.time() - since < DONE_LINGER:
        return "desk", "done"
    return "lounge", "idle"


# Whose office it is: OFFICE_OWNER, else the first name of the account's full
# name (macOS keeps it in the passwd gecos field), else the login name.
def owner() -> str:
    name = os.environ.get("OFFICE_OWNER", "").strip()
    if not name:
        try:
            import pwd

            name = (pwd.getpwuid(os.getuid()).pw_gecos or "").split(",")[0].split()[0]
        except (KeyError, IndexError, ImportError):
            name = ""
    return name or (os.environ.get("USER", "") or "my").split(".")[0].capitalize()


# Compacting right now: Claude Code says so at the bottom of its pane. Only
# asked of working panes, a few short captures per refresh.
def compacting(pane: str) -> bool:
    try:
        out = subprocess.run(["tmux", "capture-pane", "-p", "-t", pane, "-S", "-12"], capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.TimeoutExpired):
        return False
    return bool(re.search(r"Compacting conversation", out, re.I))


def snapshot() -> list[dict]:
    global _live_panes
    try:
        out = subprocess.run(["tmux", "list-panes", "-a", "-F", FMT], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    rows = [line.split("|") for line in out.splitlines()]
    _live_panes = {p[0] for p in rows if len(p) >= 12}
    alive = alive_sessions()
    seen, people = set(), []
    for p in rows:
        if len(p) < 12 or not p[4] or p[4] in seen:
            continue
        if alive is not None and p[4] not in alive:
            continue  # the pane still names a session that has ended
        seen.add(p[4])
        pane, sess, idx, wname, sid, state, since, attn, title, agents, ctx, wid = p[:12]
        t = last_tool(sid)
        where, doing = room(state, attn, t, int(since) if since.isdigit() else None)
        tc = tool_counts(sid)
        people.append(
            {
                "id": sid,
                "pane": pane,
                "window": sess + ":" + idx,
                "wid": wid,
                "name": wname,
                "title": title,
                "state": state,
                "attention": attn,
                "since": int(since) if since.isdigit() else None,
                "agents": int(agents) if agents.isdigit() else 0,
                "ctx": int(ctx) if ctx.isdigit() else None,
                "room": where,
                "doing": doing,
                "tool": t.get("tool"),
                "detail": t.get("detail"),
                "subs": subagents(sid) if state == "working" else [],
                "tools": tc["total"],
                "made": desk_items(sid),
                "compacts": tc["compacts"],
                "compactAt": tc["compactAt"],
                "compacting": state == "working" and compacting(pane),
                "mix": tc["by"],
                "job": job_of(tc["by"]),
                "rank": rank_of(tc["total"]),
                "born": born(sid),
            }
        )
    return people


# ---- quick actions -------------------------------------------------------
#
# A click answers a session from the office. Two ways, by what it waits on:
# - a choice dialog on its screen (a permission prompt, AskUserQuestion):
#   the option's digit is sent to its pane, and only while the dialog is up;
# - anything else: the text goes to ~/.claude/state/office/inbox/<sid>.json,
#   and that session's cc-mods submits it as the person's own prompt, so vim
#   mode or a half-typed draft cannot garble it.
# Every POST needs the token this server printed into its page, and a local
# Host: another site in the browser cannot drive a session through it.

def _token() -> str:
    """The page's token for POSTs, kept across restarts in a 0600 file: a new
    one per process left every open page sending the old one, so its links
    and replies were refused (403) until someone reloaded it."""
    path = os.path.expanduser("~/.claude/state/office/token")
    try:
        with open(path) as f:
            t = f.read().strip()
        if len(t) >= 24:
            return t
    except OSError:
        pass
    t = secrets.token_urlsafe(24)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(t)
    except OSError:
        pass  # still this process's token, only not kept
    return t


TOKEN = _token()
INBOX = os.path.expanduser("~/.claude/state/office/inbox")
OPTION = re.compile(r"^\s*([❯›>]\s*)?(\d)[.)]\s+(.+?)\s*$")


def capture(pane: str) -> list[str]:
    try:
        out = subprocess.run(["tmux", "capture-pane", "-p", "-J", "-t", pane, "-S", "-40"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [l.rstrip() for l in out.splitlines()]


def dialog(lines: list[str]) -> dict | None:
    """A numbered choice with a cursor (❯) near the bottom of the screen."""
    tail = [l for l in lines if l.strip()][-18:]
    opts, cursor, first = [], False, None
    for i, l in enumerate(tail):
        m = OPTION.match(l)
        if not m:
            continue
        n = int(m.group(2))
        if n == 1:
            opts, cursor, first = [], False, i
        if opts and n != opts[-1]["n"] + 1:
            continue
        opts.append({"n": n, "label": m.group(3)[:90]})
        cursor = cursor or bool(m.group(1))
    if len(opts) < 2 or not cursor or first is None:
        return None
    question = next((tail[j].strip() for j in range(first - 1, -1, -1) if tail[j].strip() and not OPTION.match(tail[j])), "")
    return {"question": question[:160], "options": opts}


def last_text(sid: str) -> str:
    """The session's last answer, from the transcript's tail."""
    path = transcript(sid)
    if not path:
        return ""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 400_000))
            lines = f.read().decode("utf-8", "replace").splitlines()[1:]
    except OSError:
        return ""
    for line in reversed(lines):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        m = d.get("message") or {}
        if m.get("role") != "assistant" or not isinstance(m.get("content"), list):
            continue
        txt = "\n".join(b.get("text", "") for b in m["content"] if b.get("type") == "text").strip()
        if txt:
            return txt[-12000:]
    return ""


ASKS = re.compile(r"[?？]\s*$|까요[?？.]?\s*$|할지|주세요[.]?\s*$")


def suggestions(text: str) -> list[str]:
    """Replies one press can send: numbered picks the answer offers, and a
    yes/no when it ends on a question."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    tail = lines[-14:]
    out: list[str] = []
    nums = [m.group(1) for l in tail if (m := re.match(r"^(\d)[.)]\s", l))]
    if 1 < len(nums) <= 5 and lines and ASKS.search(lines[-1]):
        out += [n + "번으로 해 주세요" for n in nums]
    if lines and ASKS.search(lines[-1]):
        out += ["네, 진행해 주세요", "아니요, 잠깐 기다려 주세요"]
    out.append("계속 진행해 주세요")
    return list(dict.fromkeys(out))[:6]


# ---- policy grant proposals (bin/cc-bridge.py policy, judged by Jev) -------

HOOKS = os.path.expanduser("~/.claude/hooks/")
BRIDGE = os.path.join(os.path.dirname(HERE), "bin", "cc-bridge.py")
_proposals: dict[str, tuple[int, dict | None]] = {}  # sid -> (transcript size, proposal)


def recent_blocks(sid: str) -> list[str]:
    """The policy guards' refusals in the transcript's tail, newest last."""
    path = transcript(sid)
    if not path:
        return []
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            # A turn that hit a guard often goes on for a while (reading,
            # trying other ways) before it asks: look back further than one tool
            # result. Only asked for while the session waits on you.
            f.seek(max(0, f.tell() - 1_500_000))
            raw = f.read().decode("utf-8", "replace")
    except OSError:
        return []
    # Every guard's refusal: the session policy's ("BLOCKED by session
    # policy: …") and the others', like the tmux pane guard's ("BLOCKED: tmux
    # target … Agents may only use panes inside their own window …").
    out = []
    for m in re.finditer(r"BLOCKED(?: by session policy)?:[^\"]{0,600}", raw):
        out.append(m.group(0).replace("\\n", "\n").replace("\\`", "`"))
    return out[-4:]


def policy_caps(sid: str) -> dict:
    try:
        with open(os.path.expanduser(f"~/.claude/state/session_policy/{sid}.json")) as f:
            return (json.load(f) or {}).get("capabilities") or {}
    except (OSError, ValueError):
        return {}


def proposal(sid: str, answer: str) -> dict | None:
    path = transcript(sid)
    size = os.path.getsize(path) if path else 0
    hit = _proposals.get(sid)
    if hit and hit[0] == size:
        return hit[1]
    req = {"session": sid, "answer": answer, "blocks": recent_blocks(sid), "caps": policy_caps(sid)}
    try:
        r = subprocess.run(["python3", BRIDGE, "policy"], input=json.dumps(req), capture_output=True, text=True, timeout=8)
        g = json.loads(r.stdout or "{}").get("grant")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        g = None
    _proposals[sid] = (size, g)
    return g


# Grants the office made and when each goes back (a timer per grant; kept
# only in this process, and said so in the card).
_reverts: dict[str, threading.Timer] = {}


def grant(sid: str) -> tuple[int, dict]:
    g = (_proposals.get(sid) or (0, None))[1]
    if not g:
        return 409, {"error": "no proposal to approve now"}
    env = {**os.environ, "CLAUDE_CODE_SESSION_ID": sid}
    r = subprocess.run(["python3", HOOKS + "session_policy.py", *g["argv"]], capture_output=True, text=True, timeout=10, env=env)
    if r.returncode != 0:
        return 500, {"error": (r.stderr or r.stdout).strip()[:200]}
    back = ["inherit", *g["argv"][1:]]
    key = sid + " " + " ".join(g["argv"])
    if key in _reverts:
        _reverts[key].cancel()
    t = threading.Timer(g["minutes"] * 60, lambda: subprocess.run(["python3", HOOKS + "session_policy.py", *back], capture_output=True, timeout=10, env=env))
    t.daemon = True
    t.start()
    _reverts[key] = t
    _proposals.pop(sid, None)
    # "Approve and go on": the session is told, the way a reply reaches it
    # (its inbox, submitted as the person's prompt), or it would sit waiting
    # with the grant it asked for.
    inbox_put(sid, f"{g['label']} 권한을 {g['minutes']}분 동안 허용했습니다. 막혔던 작업을 계속 진행해 주세요.")
    return 200, {"ok": True, "sent": "granted " + g["label"] + " for " + str(g["minutes"]) + "m and told it to go on"}


# ---- what the session made and was handed (cc-mods' export) ---------------

# What a session's desk holds, from its cc-mods outputs export: what it was
# handed (the in-tray) and what it made, by kind. Cached by the file's mtime.
_desk: dict = {}
IN_DETAIL = {"from your prompt", "read", "mentioned", "in a branch or PR", None}


def bucket(o: dict) -> str | None:
    k, d = o.get("kind"), o.get("detail")
    if k == "pr":
        return "pr" if d in ("created", "edited", "commented", "merged", "pushed", "opened") else "in"
    if k == "slack":
        return "slack" if d in ("replied", "posted") else "in"
    if k == "ticket":
        return "ticket" if d in ("created", "updated") else "in"
    if k == "link":
        return "in"
    if k in ("artifact", "scratch", "exp", "bg", "commit"):
        return k
    if k == "file":
        return "file"
    return None


def desk_items(sid: str) -> dict:
    files = sorted(glob.glob(os.path.expanduser("~/.claude/outputs/*/" + sid + ".json")))
    if not files:
        return {}
    try:
        m = os.path.getmtime(files[-1])
        if _desk.get(sid, (None,))[0] == m:
            return _desk[sid][1]
        with open(files[-1]) as f:
            outs = (json.load(f) or {}).get("outputs") or []
    except (OSError, ValueError):
        return {}
    n: dict = {}
    seen = set()
    for o in outs:
        b, key = bucket(o), o.get("id") or o.get("url") or o.get("path")
        if not b or key in seen:
            continue
        seen.add(key)
        n[b] = n.get(b, 0) + 1
    _desk[sid] = (m, n)
    return n


def related(sid: str, kind: str | None = None, limit: int = 10) -> list[dict]:
    files = sorted(glob.glob(os.path.expanduser("~/.claude/outputs/*/" + sid + ".json")))
    if not files:
        return []
    try:
        with open(files[-1]) as f:
            outs = (json.load(f) or {}).get("outputs") or []
    except (OSError, ValueError):
        return []
    made = {"created", "merged", "replied", "posted", "archived", "edited", "opened", "pushed", "Write", "Edit", "in the answer"}
    keep = [o for o in outs if o.get("kind") in ("pr", "slack", "ticket", "link", "artifact", "scratch", "file", "exp") and (o.get("url") or o.get("path"))]
    if kind and kind != "all":
        keep = [o for o in keep if bucket(o) == kind]
    keep.sort(key=lambda o: (0 if (o.get("detail") in made or o.get("kind") in ("pr", "artifact", "exp")) else 1, -(o.get("at") or 0)))
    seen, out = set(), []
    for o in keep:
        k = o.get("url") or o.get("path")
        if k in seen:
            continue
        seen.add(k)
        out.append({"kind": o.get("kind"), "bucket": bucket(o), "title": str(o.get("title") or "")[:70], "url": o.get("url"), "path": o.get("path"), "detail": o.get("detail")})
    return out[:limit]


# A file a session made or was handed, shown inside the office. Only paths in
# that session's outputs (or under one of its exp folders) are served, never a
# path the page makes up. Served in a sandbox (an opaque origin, no access to
# the office page or its token), so an HTML report can run its scripts without
# reaching the office's actions.
VIEW_TYPES = {".html": "text/html", ".htm": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".log": "text/plain",
              ".json": "application/json", ".csv": "text/plain", ".yaml": "text/plain", ".yml": "text/plain"}
VIEW_MAX = 20 * 1024 * 1024


def viewable(sid: str, path: str) -> tuple[int, bytes, str, dict]:
    path = os.path.realpath(os.path.expanduser(path))
    known = [os.path.realpath(os.path.expanduser(o.get("path") or "")) for o in related(sid, "all", 1000) if o.get("path")]
    known.append(os.path.realpath(MEET_DIR))  # meeting minutes are anyone's to read
    if not any(path == k or (os.path.isdir(k) and path.startswith(k + os.sep)) for k in known):
        return 403, b"not one of this session's files", "text/plain", {}
    if os.path.isdir(path):
        readme = os.path.join(path, "README.md")
        if not os.path.isfile(readme):
            return 404, b"a folder without README.md", "text/plain", {}
        path = readme
    kind = VIEW_TYPES.get(os.path.splitext(path)[1].lower())
    if not kind:
        return 415, b"not a type the office shows", "text/plain", {}
    try:
        if os.path.getsize(path) > VIEW_MAX:
            return 413, b"too big to show here", "text/plain", {}
        with open(path, "rb") as f:
            body = f.read()
    except OSError as e:
        return 404, str(e).encode(), "text/plain", {}
    if kind.startswith("text/") or kind == "application/json":
        kind += "; charset=utf-8"
    return 200, body, kind, {"Content-Security-Policy": "sandbox allow-scripts allow-popups", "X-Content-Type-Options": "nosniff"}


# Where a pane's links go now (tmux-chrome's answer for it), for the card's
# "open outside" menu to say what its default is.
def route_of(pane: str) -> str:
    try:
        out = subprocess.run(["tmux-chrome", "browser"], capture_output=True, text=True, timeout=3, env={**os.environ, "TMUX_PANE": pane}).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        out = ""
    return out if out in ("tweb", "tweb-chrome", "tweb-webkit", "chrome") else "default"


# A reply sent from the office that the session has not picked up yet: what
# it says and how long it has waited (cc-mods takes it within ~2 s once idle).
def inbox_waiting(sid: str) -> dict | None:
    try:
        with open(os.path.join(INBOX, sid + ".json")) as f:
            d = json.load(f)
        return {"text": str(d.get("text", ""))[:200], "at": d.get("at")}
    except (OSError, ValueError):
        return None


def detail(sid: str, kind: str | None = None) -> dict:
    me = next((p for p in snapshot() if p["id"] == sid), None)
    if not me:
        return {"error": "no such session"}
    text = last_text(sid)
    return {"id": sid, "name": me["name"], "window": me["window"], "state": me["state"], "doing": me["doing"], "text": text, "dialog": dialog(capture(me["pane"])), "suggestions": suggestions(text),
            "grant": proposal(sid, text) if me["doing"] in ("asking", "alert") else None, "related": related(sid, "all", 60), "route": route_of(me["pane"]), "inbox": inbox_waiting(sid), "shelf": related(sid, "all", 120) if kind else None, "shelfKind": kind}


# ---- the card's other tabs: cc-mods' Chat, Work, Policy and Web -----------
#
# Fetched with the card (/panels), apart from /detail so a slow tweb or a long
# transcript never holds up the answer and its buttons.

HISTORY_TAIL = 4_000_000
HISTORY_MAX = 64_000_000
HISTORY_TURNS = 40
# User records that are not the person talking: slash-command echoes, hook
# and harness notices, background-task notifications.
NOT_ASKED = re.compile(r"^\s*<(command-|local-command|system-reminder|task-notification|bash-)")
# A plugin's message submitted as a prompt (a monitor event, a finished
# task): a turn of its own, so its answer does not replace the person's, but
# marked as not the person's.
NOTICE = re.compile(r"^The [\w.-]+ plugin sent a message:")


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _turns(lines: list[str]) -> list[dict]:
    turns: list[dict] = []
    for line in lines:
        # Most of a transcript is tool calls and results; skip those lines
        # unparsed, or a long session's tail takes seconds to read.
        if '"type":"text"' not in line and '"content":"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("isMeta") or d.get("isSidechain") or d.get("isCompactSummary"):
            continue
        m = d.get("message") or {}
        role, c = m.get("role"), m.get("content")
        if d.get("type") == "user" and role == "user":
            if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                continue
            t = _text_of(c).strip()
            if t and not NOT_ASKED.match(t):
                turns.append({"ask": t[:4000], "at": d.get("timestamp"), "said": "", "notice": bool(NOTICE.match(t))})
        elif role == "assistant" and turns:
            t = _text_of(c).strip()
            if t:
                turns[-1]["said"] = t[-8000:]
    return turns


def history(sid: str, limit: int = HISTORY_TURNS) -> list[dict]:
    """Past turns, oldest first: what the person asked and the session's last
    words on it (the Chat tab's requests and conclusions, no tool calls).
    Reads back from the end, further each time, until it has `limit` turns:
    a session that ran big tool outputs can hold only a few in its last MBs."""
    path = transcript(sid)
    if not path:
        return []
    tail, turns = HISTORY_TAIL, []
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            while True:
                start = max(0, size - tail)
                f.seek(start)
                lines = f.read(size - start).decode("utf-8", "replace").splitlines()
                turns = _turns(lines[1:] if start else lines)  # a seek cuts the first line
                if len(turns) > limit or not start or tail >= HISTORY_MAX:
                    break
                tail *= 4
    except OSError:
        return []
    # Answers before the first prompt in the window are skipped (turns is
    # still empty then), so even the oldest turn here is whole.
    return turns[-limit:]


def _outputs(sid: str) -> list[dict]:
    files = sorted(glob.glob(os.path.expanduser("~/.claude/outputs/*/" + sid + ".json")))
    if not files:
        return []
    try:
        with open(files[-1]) as f:
            return (json.load(f) or {}).get("outputs") or []
    except (OSError, ValueError):
        return []


def work(sid: str) -> dict:
    """Every subagent the session started (newest first, live ones marked)
    and the background tasks it left running: the Work tab's tree, flat."""
    path, now, subs = transcript(sid), time.time(), []
    for f in glob.glob(os.path.join(os.path.dirname(path), sid, "subagents", "agent-*.jsonl")) if path else []:
        try:
            mt = os.path.getmtime(f)
        except OSError:
            continue
        meta = {}
        try:
            with open(f[: -len(".jsonl")] + ".meta.json") as m:
                meta = json.load(m)
        except (OSError, ValueError):
            pass
        subs.append({"desc": str(meta.get("description") or "")[:100], "type": meta.get("agentType") or "agent", "live": now - mt <= SUB_LIVE_S, "at": mt, "f": f})
    subs.sort(key=lambda a: -a["at"])
    subs = subs[:20]
    for s in subs:
        t = last_tool_in(s.pop("f"))  # only for the ones shown: each reads a file's tail
        s.update(tool=t.get("tool"), detail=t.get("detail"))
    # Output records carry `at` in ms; the page's clocks are seconds.
    bg = [{"title": str(o.get("title") or "")[:80], "detail": o.get("detail"), "at": (o.get("at") or 0) / 1000 or None, "path": o.get("path")} for o in _outputs(sid) if o.get("kind") == "bg"]
    bg.sort(key=lambda o: -(o.get("at") or 0))
    return {"subagents": subs, "bg": bg[:20]}


POLICY_SCOPES = {"gh_merge": "gh_merge_repos", "prod_eks_access": "prod_eks_access_ctxs", "prod_eks_write": "prod_eks_write_scopes", "slack_send": "slack_send_targets"}


def policy(sid: str) -> dict | None:
    """The session policy file (session_policy.py's) as the Policy tab draws
    it, and the guards' latest refusals."""
    try:
        with open(os.path.expanduser(f"~/.claude/state/session_policy/{sid}.json")) as f:
            d = json.load(f) or {}
    except (OSError, ValueError):
        return None
    caps = [{"cap": k, "value": v, "scope": d.get(POLICY_SCOPES.get(k, "")) or []} for k, v in sorted((d.get("capabilities") or {}).items())]
    return {"mode": d.get("mode"), "caps": caps, "updated": d.get("updated_at"), "blocks": recent_blocks(sid)[-3:]}


# cc-mods' credential radar: one result every session shares, kept in the
# mod's store file (plugins/store/cc-mods_<id>.json, key "radar"). The file
# holds every key cc-mods stores (MBs), so it is parsed once per change.
_radar: dict = {}
AUTH_ORDER = {"expired": 0, "soon": 1, "unknown": 2, "ok": 3}


def fix_text(argv) -> str | None:
    if not isinstance(argv, list) or not argv:
        return None
    # ['sh', '-c', script, arg0]: the script with its "$0" filled in is what
    # one would type (the AWS logout-then-login).
    if argv[:2] == ["sh", "-c"] and len(argv) >= 3:
        return str(argv[2]).replace('"$0"', str(argv[3]) if len(argv) > 3 else "")
    return " ".join(str(a) for a in argv)


def auth() -> dict | None:
    files = glob.glob(os.path.expanduser("~/.claude/plugins/store/cc-mods_*.json"))
    if not files:
        return None
    path = max(files, key=os.path.getmtime)
    try:
        m = os.path.getmtime(path)
        if _radar.get("key") != (path, m):
            with open(path) as f:
                r = (json.load(f) or {}).get("radar") or {}
            _radar.update(key=(path, m), value=r)
        r = _radar["value"]
    except (OSError, ValueError):
        return None
    items = [
        {
            "label": str(i.get("label") or i.get("id") or ""),
            "state": i.get("state") or "unknown",
            "detail": str(i.get("detail") or "")[:160],
            "expiresAt": (i.get("expiresAt") or 0) / 1000 or None,
            # The fix as the person would type it (never run from the office).
            "fix": fix_text(i.get("fix")),
            "connector": str(i.get("id") or "").startswith("mcp:claude.ai "),
            "mine": bool(i.get("mine")),
        }
        for i in r.get("items") or []
        if isinstance(i, dict)
    ]
    items.sort(key=lambda i: (AUTH_ORDER.get(i["state"], 2), i["connector"], i["label"]))
    return {"at": (r.get("at") or 0) / 1000 or None, "items": items} if items else None


def tweb_bin() -> str | None:
    for b in (shutil.which("tweb"), os.path.expanduser("~/.local/bin/tweb")):
        if b and os.access(b, os.X_OK):
            return b
    return None


def web(me: dict) -> list[dict]:
    """The TWeb panes this session works with: in its tmux window, or linked
    to its pane (cc-mods' Web tab drives one of those)."""
    b = tweb_bin()
    if not b:
        return []
    try:
        mine = set(subprocess.run(["tmux", "list-panes", "-t", me["wid"], "-F", "#{pane_id}"], capture_output=True, text=True, timeout=3).stdout.split())
        listed = json.loads(subprocess.run([b, "panes", "--json"], capture_output=True, text=True, timeout=4).stdout or "[]")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return []
    out = []
    for p in listed if isinstance(listed, list) else []:
        st = p.get("status") or {}
        pres = st.get("presence") or {}
        link = pres.get("link") or {}
        linked = str(link.get("owner") or "").endswith(" " + me["pane"])
        if p.get("pane") not in mine and not linked:
            continue
        tabs = [{"title": str(t.get("title") or "")[:80], "url": t.get("url"), "active": bool(t.get("active"))} for t in (st.get("tabs") or {}).get("tabs") or []]
        last = pres.get("lastAgent") or {}
        out.append({"pane": p.get("pane"), "engine": st.get("browser"), "tabs": tabs, "linked": linked, "driving": pres.get("driving"), "lastAgent": last.get("method"), "lastAt": (last.get("at") or 0) / 1000 or None})
    return out


def pane_of(sid: str) -> dict | None:
    """The session's pane and window, from tmux alone (snapshot() also reads
    every session's transcript and takes seconds)."""
    try:
        out = subprocess.run(["tmux", "list-panes", "-a", "-F", "#{pane_id}|#{window_id}|#{@cc_pane_session}"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    for line in out.splitlines():
        pane, wid, s = (line.split("|") + ["", ""])[:3]
        if s == sid:
            return {"pane": pane, "wid": wid}
    return None


def panels(sid: str) -> dict:
    me = pane_of(sid)
    if not me:
        return {"error": "no such session"}
    return {"history": history(sid), "work": work(sid), "policy": policy(sid), "web": web(me)}


# Something for a session to read as the person's prompt: its inbox file,
# which cc-mods submits within ~2 s. A message already waiting there is kept
# and this one is added after it, so two sends never lose the first.
def inbox_put(sid: str, text: str) -> None:
    os.makedirs(INBOX, exist_ok=True)
    path = os.path.join(INBOX, sid + ".json")
    try:
        with open(path) as f:
            old = str((json.load(f) or {}).get("text") or "")
    except (OSError, ValueError):
        old = ""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"text": (old + "\n\n" + text) if old else text, "at": time.time()}, f)
    os.replace(tmp, path)


# Meetings: sessions the person put together around one topic. Each is told
# (through its inbox) who the others are, by the names SendMessage takes,
# who leads and where the minutes go; they talk with SendMessage. A meeting
# ends when the lead writes "회의 끝" in the minutes, when the person ends it,
# or after MEET_TTL. Kept in a file so a reload sees the same.
MEET_FILE = os.path.expanduser("~/.claude/state/office/meetings.json")
MEET_DIR = os.path.expanduser("~/.claude/state/office/meetings")
MEET_MAX = 8
MEET_TTL = 2 * 3600


def _meetings() -> dict:
    try:
        with open(MEET_FILE) as f:
            return json.load(f) or {}
    except (OSError, ValueError):
        return {}


def _save_meetings(d: dict) -> None:
    os.makedirs(os.path.dirname(MEET_FILE), exist_ok=True)
    tmp = MEET_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.replace(tmp, MEET_FILE)


def meetings() -> list[dict]:
    """The meetings going on, each with the last lines of its minutes."""
    d, now, changed, out = _meetings(), time.time(), False, []
    for mid, m in d.items():
        if m.get("ended"):
            continue
        try:
            with open(m["minutes"]) as f:
                text = f.read()
        except OSError:
            text = ""
        if "회의 끝" in text or now - m.get("at", now) > MEET_TTL:
            m["ended"] = now
            changed = True
            continue
        tail = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#") and not ln.startswith("- 시작") and not ln.startswith("- 참석")][-3:]
        out.append({"id": mid, "topic": m["topic"], "sids": m["sids"], "lead": m["lead"], "at": m["at"], "minutes": m["minutes"], "tail": tail})
    if changed:
        _save_meetings({k: v for k, v in d.items() if not v.get("ended") or now - v["ended"] < 86400})
    return out


def peer_names() -> dict:
    """sid -> the name another session's SendMessage takes for it."""
    out: dict[str, str] = {}
    for key, v in registry().items():
        if key == v["name"]:
            out[v["sid"]] = key
    return out


def group_act(body: dict) -> tuple[int, dict]:
    kind = body.get("kind")
    people = {p["id"]: p for p in snapshot()}
    if kind == "meeting_end":
        mid = str(body.get("value") or "")
        d = _meetings()
        m = d.get(mid)
        if not m or m.get("ended"):
            return 404, {"error": "no such meeting going on"}
        m["ended"] = time.time()
        _save_meetings(d)
        for sid in m["sids"]:
            if sid in people:
                inbox_put(sid, f"[사무실] '{m['topic']}' 회의를 마쳤습니다. 회의 메시지는 더 보내지 말고 원래 하던 일로 돌아가세요.")
        return 200, {"ok": True, "sent": "meeting ended"}
    sids = [s for s in dict.fromkeys(str(x) for x in (body.get("sids") or [])) if s in people]
    text = str(body.get("value") or "").strip()
    if not sids:
        return 400, {"error": "none of those sessions is here"}
    if not text or len(text) > 2000:
        return 400, {"error": "empty or too long"}
    for s in sids:  # being spoken to lifts a "until you speak" set-aside
        set_mute(s, False)
    if kind == "broadcast":
        for s in sids:
            inbox_put(s, "[사무실 공지] " + text)
        return 200, {"ok": True, "sent": f"announced to {len(sids)}"}
    if len(sids) < 2:
        return 400, {"error": "a meeting needs two or more"}
    if len(sids) > MEET_MAX:
        return 400, {"error": f"at most {MEET_MAX} in a meeting"}
    taken = {s for m in meetings() for s in m["sids"]}
    if taken & set(sids):
        return 409, {"error": "already in a meeting: " + ", ".join(people[s]["name"] for s in sids if s in taken)}
    names = peer_names()
    mid = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
    os.makedirs(MEET_DIR, exist_ok=True)
    minutes = os.path.join(MEET_DIR, mid + ".md")
    roster = [(s, names.get(s), people[s]["name"]) for s in sids]
    lead = sids[0]
    with open(minutes, "w") as f:
        f.write(f"# 회의: {text}\n- 시작: {time.strftime('%Y-%m-%d %H:%M')}\n- 참석: "
                + ", ".join(f"{n or w} ({w})" for _, n, w in roster) + "\n\n## 논의\n\n## 결론\n\n")
    lead_name = names.get(lead) or people[lead]["name"]
    for s, n, w in roster:
        lines = [f"[사무실 회의 요청] 주제: {text}", "참석자 (SendMessage의 to에 쓰는 이름):"]
        for s2, n2, w2 in roster:
            tags = (" (진행)" if s2 == lead else "") + (" (나)" if s2 == s else "")
            lines.append(f"- {n2 or '(이름 없음: 메시지를 받을 수 없음)'} — {w2}{tags}")
        lines += [
            f"진행자: {lead_name}",
            f"회의록: {minutes}",
            "",
            "진행 방법:",
            "1. 하던 일이 있으면 그대로 두고 이 회의에 짧게 참여한 뒤 원래 일로 돌아가세요.",
            "2. 다른 참석자에게만 SendMessage로 짧게(한 번에 5줄 이내) 보내세요.",
            "3. 먼저 자기 맥락에서 이 주제에 보탤 사실이나 제안을 한 번 보내세요.",
            "4. 진행자는 의견을 모아 회의록의 '## 결론'에 결론과 담당자를 적고, 마지막 줄에 '회의 끝'이라고 쓴 뒤 참석자에게 알리세요.",
            "5. 세션 정책과 권한은 회의 중에도 그대로입니다. 회의에서 정했다고 막힌 작업을 우회하지 마세요.",
        ]
        inbox_put(s, "\n".join(lines))
    d = _meetings()
    d[mid] = {"topic": text, "sids": sids, "lead": lead, "at": time.time(), "minutes": minutes, "ended": None}
    _save_meetings(d)
    return 200, {"ok": True, "sent": f"meeting with {len(sids)}", "id": mid}


def act(body: dict) -> tuple[int, dict]:
    sid, kind, value = str(body.get("sid") or ""), body.get("kind"), body.get("value")
    if kind in ("meeting", "meeting_end", "broadcast"):
        return group_act(body)
    me = next((p for p in snapshot() if p["id"] == sid), None)
    if not me:
        return 404, {"error": "no such session"}
    pane = me["pane"]  # from tmux, never from the request
    if kind == "key":
        d = dialog(capture(pane))
        if not d or not any(str(o["n"]) == str(value) for o in d["options"]):
            return 409, {"error": "no dialog with that choice on its screen now"}
        subprocess.run(["tmux", "send-keys", "-t", pane, str(value)], timeout=3)
        return 200, {"ok": True, "sent": "key " + str(value)}
    if kind == "mute":
        # value: minutes to set it aside for, "speak" for until the person
        # speaks to it first, 0 to let it call again.
        if value == "speak":
            set_mute(sid, True, None)
            return 200, {"ok": True, "sent": "quiet until you speak"}
        try:
            mins = int(value or 0)
        except (TypeError, ValueError):
            return 400, {"error": "minutes or speak"}
        if mins <= 0:
            set_mute(sid, False)
            return 200, {"ok": True, "sent": "may call you again"}
        until = time.time() + mins * 60
        set_mute(sid, True, until)
        return 200, {"ok": True, "sent": "set aside", "until": until}
    # Speaking to it (a pick, a reply, a grant) lifts its silence.
    if kind in ("key", "reply", "grant"):
        set_mute(sid, False)
    if kind == "grant":
        return grant(sid)
    if kind == "open":
        # A link from the card: http(s) where that session's own links go, a
        # local path revealed in Finder. Nothing else. The session's links go
        # through tmux-chrome-open with its pane: its @browser (pane, window,
        # global) picks TWeb on Electron, TWeb on your Chrome (where claude.ai
        # artifacts open signed in) or the window's Chrome tab group, the same
        # place a link it opens itself lands. Without tmux-chrome, the default
        # browser.
        # `via` picks the place instead: one of tmux-chrome's (tweb,
        # tweb-chrome, tweb-webkit, chrome: TMUX_CHROME_BROWSER, which wins
        # over the pane options), the default browser or app, or Finder.
        v, via = str(value or ""), str(body.get("via") or "")
        if via not in ("", "session", "tweb", "tweb-chrome", "tweb-webkit", "chrome", "default", "finder"):
            return 400, {"error": "unknown place to open"}
        url = v if re.match(r"^https?://", v) else None
        p = os.path.realpath(os.path.expanduser(v)) if not url else ""
        if not url and not (p.startswith("/") and os.path.exists(p)):
            return 400, {"error": "not a link or an existing path"}
        if not url and via in ("", "session"):
            via = "finder"
        if via == "finder":
            subprocess.Popen(["open", "-R", p or v])
            return 200, {"ok": True, "sent": "revealed"}
        target = url or ("file://" + p)
        if via == "default":
            subprocess.Popen(["open", url or p])
            return 200, {"ok": True, "sent": "opened in the default app"}
        opener = os.path.expanduser("~/.local/bin/tmux-chrome-open")
        if not os.access(opener, os.X_OK):
            subprocess.Popen(["open", target])
            return 200, {"ok": True, "sent": "opened"}
        env = {**os.environ, "TMUX_PANE": pane}
        if via not in ("", "session"):
            env["TMUX_CHROME_BROWSER"] = via
        subprocess.Popen([opener, target], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 200, {"ok": True, "sent": "opened in " + (via if via not in ("", "session") else route_of(pane))}
    if kind == "stop":
        if me["state"] != "working":
            return 409, {"error": "it is not working"}
        subprocess.run(["tmux", "send-keys", "-t", pane, "Escape"], timeout=3)
        return 200, {"ok": True, "sent": "Escape"}
    if kind == "reply":
        text = str(value or "").strip()
        if not text or len(text) > 4000:
            return 400, {"error": "empty or too long"}
        # A session at work takes a prompt as a queued follow-up, and one
        # still in the inbox has not even reached it: a second one is usually
        # the same answer twice. The page asks again before forcing it.
        if not body.get("force"):
            if me["state"] == "working":
                return 409, {"error": "busy", "busy": "working", "tool": me.get("tool")}
            if os.path.exists(os.path.join(INBOX, sid + ".json")):
                return 409, {"error": "busy", "busy": "inbox"}
        inbox_put(sid, text)
        return 200, {"ok": True, "sent": "reply"}
    if kind in ("send", "merge"):
        return rearrange(kind, me, value)
    return 400, {"error": "unknown action"}


# Dragging a pod moves its tmux window: onto another tmux session's block it is
# sent there, onto another pod it is merged into that window. The moves are
# tmc's (`tmc window send|merge`), the same as its TUI's `x s` and `x m`. The
# windows come from tmux by the sessions they hold, never from the request.
def tmc_bin() -> str | None:
    import shutil

    return os.environ.get("OFFICE_TMC") or shutil.which("tmc") or (os.path.expanduser("~/.local/bin/tmc") if os.access(os.path.expanduser("~/.local/bin/tmc"), os.X_OK) else None)


def rearrange(kind: str, me: dict, value) -> tuple[int, dict]:
    tmc = tmc_bin()
    if not tmc:
        return 409, {"error": "tmc is not installed"}
    src = me["wid"]
    if kind == "send":
        dest = str(value or "")
        try:
            live = subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}"], capture_output=True, text=True, timeout=3).stdout.split()
        except (OSError, subprocess.TimeoutExpired):
            live = []
        if dest not in live:
            return 400, {"error": "no such tmux session"}
        argv = [tmc, "window", "send", src, "--to", dest]
    else:
        other = next((p for p in snapshot() if p["id"] == str(value or "")), None)
        if not other:
            return 404, {"error": "no such session to merge into"}
        if other["wid"] == src:
            return 400, {"error": "that is the same window"}
        argv = [tmc, "window", "merge", src, "--into", other["wid"]]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 500, {"error": str(e)}
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).strip()
        if "unrecognized subcommand" in msg:
            msg = "this tmc has no `window` command yet (keyolk/tmc#18)"
        return 500, {"error": msg[:300]}
    return 200, {"ok": True, "sent": r.stdout.strip()}


# Agents set aside ("미루기"): out of the waiting queue, no call for attention,
# whatever they wait on, for a while (until) or until the person speaks to
# them first (until None). Kept in a file (sid -> {since, until}) so a reload
# or `prefix O` sees the same. Either kind is lifted by the person speaking
# first, and a timed one by its time: a reply, a pick or a grant from the office, or anything they
# type to the session themselves (a human prompt in its transcript after
# `since`; a plugin's asUser prompt counts, as the office's replies go that
# way, a plugin's own notification does not).
MUTE_FILE = os.path.expanduser("~/.claude/state/office/mute.json")
_spoke: dict[str, tuple[int, float | None]] = {}


def _mute_file() -> dict:
    try:
        with open(MUTE_FILE) as f:
            d = json.load(f) or {}
    except (OSError, ValueError):
        return {}
    out = {}
    for k, v in d.items():
        if isinstance(v, (int, float)):
            v = {"since": v, "until": None}
        if isinstance(v, dict) and isinstance(v.get("since"), (int, float)):
            out[k] = {"since": v["since"], "until": v.get("until")}
    return out


def set_mute(sid: str, on: bool, until: float | None = None) -> dict:
    """on: set aside until `until` (epoch s), or until spoken to when None."""
    d = _mute_file()
    if on:
        d[sid] = {"since": time.time(), "until": until}
    else:
        d.pop(sid, None)
    os.makedirs(os.path.dirname(MUTE_FILE), exist_ok=True)
    tmp = MUTE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.replace(tmp, MUTE_FILE)
    return d


def last_spoke(sid: str) -> float | None:
    """When the person last prompted this session (newest human prompt)."""
    path = transcript(sid)
    if not path:
        return None
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    hit = _spoke.get(sid)
    if hit and hit[0] == size:
        return hit[1]
    at = None
    try:
        with open(path, "rb") as f:
            f.seek(max(0, size - 2_000_000))
            lines = f.read().splitlines()
    except OSError:
        lines = []
    for line in reversed(lines):
        if b'"type":"user"' not in line and b'"type": "user"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        o = d.get("origin") or {}
        content = (d.get("message") or {}).get("content")
        if isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
            continue
        if d.get("isMeta") or not (o.get("kind") == "human" or (o.get("kind") == "plugin" and o.get("asUser"))):
            continue
        try:
            at = datetime.fromisoformat(str(d.get("timestamp")).replace("Z", "+00:00")).timestamp()
        except (ValueError, TypeError):
            continue
        break
    _spoke[sid] = (size, at)
    return at


def muted() -> dict:
    """sid -> {since, until}; the expired and the spoken-to are lifted."""
    d = _mute_file()
    now = time.time()
    lifted = [sid for sid, m in d.items() if (m["until"] and m["until"] <= now) or (last_spoke(sid) or 0) > m["since"]]
    for sid in lifted:
        d = set_mute(sid, False)
    return d


# `prefix O` (tmux) bumps this; the page sees the bump and opens the next one.
NEXT = {"n": 1}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code: int, body: bytes, kind: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def local(self) -> bool:
        host = self.headers.get("Host", "")
        return host in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")

    def do_POST(self):
        # Opening the next card changes nothing in a session, so the tmux key
        # needs no token; it still has to come from this machine.
        if self.local() and self.path == "/next":
            NEXT["n"] += 1
            return self.send(204, b"", "text/plain")
        if not self.local() or self.headers.get("X-Office-Token") != TOKEN or self.path != "/act":
            return self.send(403, b"forbidden", "text/plain")
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 20_000)) or b"{}")
        except ValueError:
            return self.send(400, b"bad json", "text/plain")
        code, out = act(body)
        self.send(code, json.dumps(out).encode(), "application/json")

    def do_GET(self):
        if not self.local():
            return self.send(403, b"forbidden", "text/plain")
        if self.path == "/version":
            return self.send(200, json.dumps({"stamp": STAMP, "pid": os.getpid()}).encode(), "application/json")
        if self.path.startswith("/next"):
            return self.send(200, json.dumps({"n": NEXT["n"]}).encode(), "application/json")
        if self.path.startswith("/file"):
            from urllib.parse import parse_qs, urlparse

            q = parse_qs(urlparse(self.path).query)
            code, body, kind, extra = viewable((q.get("sid") or [""])[0], (q.get("path") or [""])[0])
            return self.send(code, body, kind, extra)
        if self.path.startswith("/detail"):
            from urllib.parse import parse_qs, urlparse

            q = parse_qs(urlparse(self.path).query)
            sid, kind = (q.get("sid") or [""])[0], (q.get("kind") or [""])[0]
            kind = kind if kind in ("desk", "in", "pr", "slack", "ticket", "artifact", "scratch", "file", "exp") else None
            return self.send(200, json.dumps(detail(sid, kind)).encode(), "application/json")
        if self.path.startswith("/panels"):
            from urllib.parse import parse_qs, urlparse

            sid = (parse_qs(urlparse(self.path).query).get("sid") or [""])[0]
            return self.send(200, json.dumps(panels(sid)).encode(), "application/json")
        if self.path.startswith("/state"):
            people, alive = snapshot(), alive_sessions()
            return self.send(200, json.dumps({"at": time.time(), "people": people, "panes": sorted(_live_panes), "alive": None if alive is None else sorted(alive), "muted": muted(), "talks": talks(), "meetings": meetings(), "resources": resources.snapshot(), "auth": auth()}).encode(), "application/json")
        if self.path.startswith("/focus"):
            # A click on a worker: bring its pane in front (cc-focus switches
            # the clients and selects the window), the notification's action.
            from urllib.parse import parse_qs, urlparse

            pane = (parse_qs(urlparse(self.path).query).get("pane") or [""])[0]
            focus = os.path.expanduser("~/.local/bin/cc-focus")
            if pane.startswith("%") and pane[1:].isdigit() and os.access(focus, os.X_OK):
                subprocess.Popen([focus, pane], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return self.send(204, b"", "text/plain")
            return self.send(400, b"bad pane", "text/plain")
        if self.path in ("/brands.js", "/skins.js", "/resources.js"):
            with open(os.path.join(HERE, self.path.lstrip("/")), "rb") as f:
                skin = f.read().replace(b"__OFFICE_OWNER__", json.dumps(owner())[1:-1].encode())
                return self.send(200, skin, "text/javascript; charset=utf-8")
        if self.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "office.html"), "rb") as f:
                page = f.read().replace(b"__OFFICE_TOKEN__", TOKEN.encode()).replace(b"__OFFICE_OWNER__", html.escape(owner()).encode())
                return self.send(200, page, "text/html; charset=utf-8")
        self.send(404, b"not found", "text/plain")


def main():
    port = 8787
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"cc-office on http://127.0.0.1:{port}/", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
