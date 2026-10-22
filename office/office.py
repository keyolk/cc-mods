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
import html
import json
import os
import re
import secrets
import threading
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
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
        return {"total": 0, "by": {}}
    st = _counts.setdefault(path, {"off": 0, "by": {}, "total": 0})
    try:
        size = os.path.getsize(path)
        if size < st["off"]:
            st.update(off=0, by={}, total=0)
        with open(path, "rb") as f:
            f.seek(st["off"])
            chunk = f.read()
    except OSError:
        return {"total": st["total"], "by": st["by"]}
    end = chunk.rfind(b"\n") + 1  # a half-written last line waits for next time
    for line in chunk[:end].splitlines():
        if b'"tool_use"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        for b in (d.get("message") or {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                st["by"][kind_of(b.get("name") or "")] = st["by"].get(kind_of(b.get("name") or ""), 0) + 1
                st["total"] += 1
    st["off"] += end
    return {"total": st["total"], "by": st["by"]}


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


def room(state: str, attention: str, t: dict) -> tuple[str, str]:
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


def snapshot() -> list[dict]:
    try:
        out = subprocess.run(["tmux", "list-panes", "-a", "-F", FMT], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    seen, people = set(), []
    for line in out.splitlines():
        p = line.split("|")
        if len(p) < 12 or not p[4] or p[4] in seen:
            continue
        seen.add(p[4])
        pane, sess, idx, wname, sid, state, since, attn, title, agents, ctx, wid = p[:12]
        t = last_tool(sid)
        where, doing = room(state, attn, t)
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

TOKEN = secrets.token_urlsafe(24)
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
    return 200, {"ok": True, "sent": "granted " + g["label"] + " for " + str(g["minutes"]) + "m"}


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


def detail(sid: str, kind: str | None = None) -> dict:
    me = next((p for p in snapshot() if p["id"] == sid), None)
    if not me:
        return {"error": "no such session"}
    text = last_text(sid)
    return {"id": sid, "name": me["name"], "window": me["window"], "state": me["state"], "doing": me["doing"], "text": text, "dialog": dialog(capture(me["pane"])), "suggestions": suggestions(text),
            "grant": proposal(sid, text) if me["doing"] in ("asking", "alert") else None, "related": related(sid), "shelf": related(sid, "all", 120) if kind else None, "shelfKind": kind}


def act(body: dict) -> tuple[int, dict]:
    sid, kind, value = str(body.get("sid") or ""), body.get("kind"), body.get("value")
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
    if kind == "snooze":
        # value: minutes to add (30 by default, from now or from the current
        # end), or 0 to put it back in the queue.
        mins = int(value if value is not None else 30)
        if mins <= 0:
            set_snooze(sid, None)
            return 200, {"ok": True, "sent": "back in the queue"}
        until = max(time.time(), snoozed().get(sid, 0)) + mins * 60
        set_snooze(sid, until)
        return 200, {"ok": True, "sent": "snoozed", "until": until}
    if kind == "grant":
        return grant(sid)
    if kind == "open":
        # A link from the card: http(s) to the person's browser, a local path
        # revealed in Finder. Nothing else.
        v = str(value or "")
        if re.match(r"^https?://", v):
            subprocess.Popen(["open", v])
            return 200, {"ok": True, "sent": "opened"}
        p = os.path.expanduser(v)
        if p.startswith("/") and os.path.exists(p):
            subprocess.Popen(["open", "-R", p])
            return 200, {"ok": True, "sent": "revealed"}
        return 400, {"error": "not a link or an existing path"}
    if kind == "stop":
        if me["state"] != "working":
            return 409, {"error": "it is not working"}
        subprocess.run(["tmux", "send-keys", "-t", pane, "Escape"], timeout=3)
        return 200, {"ok": True, "sent": "Escape"}
    if kind == "reply":
        text = str(value or "").strip()
        if not text or len(text) > 4000:
            return 400, {"error": "empty or too long"}
        os.makedirs(INBOX, exist_ok=True)
        tmp = os.path.join(INBOX, sid + ".json.tmp")
        with open(tmp, "w") as f:
            json.dump({"text": text, "at": time.time()}, f)
        os.replace(tmp, os.path.join(INBOX, sid + ".json"))
        return 200, {"ok": True, "sent": "reply"}
    return 400, {"error": "unknown action"}


# Agents the person set aside from the waiting queue, until when (epoch s).
# Kept in a file so a reload or `prefix O` sees the same; expired ones drop.
SNOOZE_FILE = os.path.expanduser("~/.claude/state/office/snooze.json")


def snoozed() -> dict:
    try:
        with open(SNOOZE_FILE) as f:
            d = json.load(f) or {}
    except (OSError, ValueError):
        return {}
    now = time.time()
    return {k: v for k, v in d.items() if isinstance(v, (int, float)) and v > now}


def set_snooze(sid: str, until: float | None) -> dict:
    d = snoozed()
    if until:
        d[sid] = until
    else:
        d.pop(sid, None)
    os.makedirs(os.path.dirname(SNOOZE_FILE), exist_ok=True)
    tmp = SNOOZE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.replace(tmp, SNOOZE_FILE)
    return d


# `prefix O` (tmux) bumps this; the page sees the bump and opens the next one.
NEXT = {"n": 1}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code: int, body: bytes, kind: str):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
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
        if self.path.startswith("/next"):
            return self.send(200, json.dumps({"n": NEXT["n"]}).encode(), "application/json")
        if self.path.startswith("/detail"):
            from urllib.parse import parse_qs, urlparse

            q = parse_qs(urlparse(self.path).query)
            sid, kind = (q.get("sid") or [""])[0], (q.get("kind") or [""])[0]
            kind = kind if kind in ("desk", "in", "pr", "slack", "ticket", "artifact", "scratch", "file", "exp") else None
            return self.send(200, json.dumps(detail(sid, kind)).encode(), "application/json")
        if self.path.startswith("/state"):
            return self.send(200, json.dumps({"at": time.time(), "people": snapshot(), "snoozed": snoozed()}).encode(), "application/json")
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
        if self.path == "/brands.js":
            with open(os.path.join(HERE, "brands.js"), "rb") as f:
                return self.send(200, f.read(), "text/javascript; charset=utf-8")
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
