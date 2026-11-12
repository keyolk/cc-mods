"""What the person already handled, read from the sessions' transcripts.

The person: "내가 이미 수동으로 직접 업무 지시를 한거에대해서 office에서 그냥
`내 차례` 라며 계속 보여주기도 하고", and "내가 시켜서 일하고 있는 애도 지금 내
차례라고 계속 표현되는 문제도 있고". 내 차례 (office/turn.py) took a worker's
blocked status and a trigger with no live session as the person's turn for as
long as they stood, although the person had typed to that session since, or
had another session take the work up.

So the office reads, from every transcript written in the last SCAN_H hours:
- `typed`: when the person last typed to the session. A prompt counts when
  the person wrote it: typed in its pane (origin human), or sent from the
  office (a cc-mods asUser prompt: a reply, a brief answer, a login done).
  Not the prompts a program wrote, in the person's name or not: a
  coordinator's spawn ("You are worker `x` for the coordinator session") and
  its sends, slx's first prompt and follow-ups (keyolk/slx spawn.go and
  meerkat_group.go: "Slack에서 나에게 온 요청을 처리", "이 스레드에 새 멘션이",
  "같은 종류의 알럿이", an RCA prompt), worker reports and auto-continue.
  slx types into the pane with tmux, so its prompts carry origin human: they
  are told by their text. A slx follow-up with "추가 지시:" is the person's
  own instruction (slx's b with a note) and counts.
- `refs`: the work each session touched and when: Slack threads (a ts
  1793600933.468369 or a permalink's p1793600933468369), DM channels
  (D0123ABCD), Meerkat incidents (inc-<24 hex>), from its prompts and its
  tool calls, never from tool results (an `slx list` result names every
  item). A Slack send to a thread is a reply there (`reply`).
- `first`: the work its first prompt named: a session started for that work.
- `prompted`: when it last got the person's or a coordinator's prompt (a
  peer message, a `[coordinator]` one): a session at work since then is
  not waiting on its old status.

handled(item) then says whether a trigger (office/slx.py) was taken up after
it came, and how: `reply` (a session sent to that thread), `typed` (the
person typed to its own session, or to one started for that thread), or
`relay` (another session took it up later: a coordinator's send, a worker's
read of the thread). The first two are known; `relay` is "다른 세션이 처리 중일
수 있음". A newer mention moves the item's time past them, and it is the
person's turn again.

Limits: an answer in a pane dialog (a permission, an AskUserQuestion) leaves
no prompt in the transcript; the dialog's own going away says it. A slx
template that changes its words would count as the person's.

Reading: a transcript is read forward from where the last read stopped, at
most STEP bytes a call and BUDGET bytes over all, so a cold office catches up
over a few polls instead of reading GBs at once (office.py tool_counts reads
the same way). One read at a time; a call that finds one running returns
what is known.
"""

import glob
import json
import os
import re
import threading
import time
from datetime import datetime

SCAN_H = 36  # slx shows triggers up to 24 h old; a status is trusted for 8 h
STEP = 16_000_000
BUDGET = 96_000_000
LINE_MAX = 4_000_000  # a longer line is a tool result or a pasted file
LIST_EVERY = 20  # s between globs of the projects directory
ROOT = os.path.expanduser("~/.claude/projects")

TS = re.compile(r"(?<![\d.])(1[6-9]\d{8})\.(\d{6})(?!\d)")
PERMA = re.compile(r"/p(1[6-9]\d{8})(\d{6})(?!\d)")
DM = re.compile(r"(?<![A-Z0-9])(D[A-Z0-9]{8,11})(?![A-Z0-9])")
INC = re.compile(r"inc-[0-9a-f]{24}")
SEND = re.compile(r"slack_send_message$")
USER = re.compile(rb'"type":\s?"user"')
SLACK = re.compile(r"(?i)slack")
LIST_MAX = 3  # refs one prompt or call names and still means each of them

# What a program wrote, not the person: slx (spawn.go, meerkat.go,
# meerkat_group.go), a coordinator's spawn and sends, worker reports, the
# auto-continue answer, cc-mods' own reminders.
PROGRAM = re.compile(
    r"^(?:Slack에서 나에게 온 요청을 처리|이 스레드에 새 멘션이|같은 종류의 알럿이|https?://\S+\s+slx가 Meerkat incident로 연 RCA"
    r"|\[(?:coordinator|worker|cc-mods|사무실)|\(전달 확인 전에|\(\d+분 전 office inbox|(?:네, )?계속 진행해 주세요|네, 진행해 주세요"
    r"|(?:READY|DONE|NOTE|BLOCKED|QUESTION)\b|The [\w.-]+ plugin sent a message|Another Claude session sent a message|<)"
)
SLX = re.compile(r"^(?:Slack에서 나에게 온 요청을 처리|이 스레드에 새 멘션이|같은 종류의 알럿이|https?://\S+\s+slx가 Meerkat incident로 연 RCA)")
SPAWNED = re.compile(r"You are worker `[^`]+` for the coordinator session")
PASTED = re.compile(r"^\s*<pasted_content[^>]*>\s*")
NOTE = re.compile(r"\n추가 지시: \S")

_lock = threading.Lock()
_files: dict[str, dict] = {}  # path -> {"off", "sid", "first", "typed", "refs"}
_list: dict = {"at": 0.0, "paths": []}


def refs_in(text: str) -> set[str]:
    """The work a text names: thread ts, DM channels, incidents."""
    out = {a + "." + b for a, b in TS.findall(text)} | {a + "." + b for a, b in PERMA.findall(text)}
    out |= set(DM.findall(text)) | set(INC.findall(text))
    return out


def item_refs(item: dict) -> set[str]:
    """What names a trigger: a Slack item `C…/<ts>` or a DM `D…`, a Meerkat
    `meerkat:inc-…`."""
    i = str(item.get("id") or "")
    if i.startswith("meerkat:"):
        return set(INC.findall(i))
    ch, _, ts = i.partition("/")
    return {ts} if ts else ({ch} if DM.fullmatch(ch) else set())


def _epoch(v) -> float:
    try:
        return datetime.fromisoformat(re.sub(r"(\.\d{6})\d+", r"\1", str(v)).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0.0


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text") or "" for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def by_person(d: dict, text: str) -> bool:
    """Whether a user prompt is the person's own words (see the module doc)."""
    o = d.get("origin") or {}
    if d.get("isMeta") or not (o.get("kind") == "human" or (o.get("kind") == "plugin" and o.get("asUser"))):
        return False
    t = PASTED.sub("", text).lstrip()
    if not t or SPAWNED.search(t):
        return False
    return not PROGRAM.match(t) or bool(NOTE.search(t))


def _note(st: dict, ref: str, kind: str, at: float) -> None:
    r = st["refs"].setdefault(ref, {})
    r[kind] = max(r.get(kind, 0.0), at)


def take(st: dict, d: dict) -> None:
    """One transcript entry into a file's state."""
    kind = d.get("type")
    at = _epoch(d.get("timestamp"))
    if not at or d.get("isSidechain"):
        return
    content = (d.get("message") or {}).get("content")
    if kind == "user":
        if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return
        text = _text(content)
        # A peer message (a coordinator's SendMessage) is written isMeta; it
        # still answers what the worker asked.
        peer = (d.get("origin") or {}).get("kind") == "peer"
        if not text.strip() or (d.get("isMeta") and not peer):
            return
        person = by_person(d, text)
        refs = refs_in(text)
        if st["first"] is None:
            # A session resumed after a compaction opens on its summary,
            # which names all it did: the work only when it names little.
            st["first"] = sorted(refs) if len(refs) <= LIST_MAX or not d.get("isCompactSummary") else []
        # A monitor event or a task's end wakes a session too, without
        # answering what it asked: only the person's and a coordinator's.
        if person or peer or text.lstrip().startswith("[coordinator]"):
            st["prompted"] = max(st["prompted"], at)
        if person:
            st["typed"] = max(st["typed"], at)
        if len(refs) > LIST_MAX and not person:
            return
        for ref in refs:
            # slx's own prompts hand the work out; another program's (a
            # coordinator's spawn or send, a worker's report on it) is a
            # session taking it up for the person.
            if person:
                _note(st, ref, "typed", at)
            elif not SLX.match(PASTED.sub("", text).lstrip()) and not text.lstrip().startswith("<"):
                _note(st, ref, "relay", at)
    elif kind == "assistant" and isinstance(content, list):
        for b in content:
            if not (isinstance(b, dict) and b.get("type") == "tool_use"):
                continue
            inp = b.get("input") if isinstance(b.get("input"), dict) else {}
            if SEND.search(str(b.get("name") or "")):
                ch, ts = str(inp.get("channel_id") or ""), str(inp.get("thread_ts") or "")
                for ref in ({ts} if ts else set()) | ({ch} if DM.fullmatch(ch) else set()):
                    _note(st, ref, "reply", at)
            elif SLACK.search(str(b.get("name") or "")):
                # A Slack read of a thread or a DM; a call that names many
                # (a search, a listing) takes none of them up.
                refs = refs_in(json.dumps(inp, ensure_ascii=False))
                for ref in refs if len(refs) <= LIST_MAX else ():
                    _note(st, ref, "relay", at)


def _new(path: str) -> dict:
    return {"off": 0, "sid": os.path.basename(path)[: -len(".jsonl")], "first": None, "typed": 0.0, "prompted": 0.0, "refs": {}}


def read(path: str, st: dict, step: int = STEP) -> int:
    """Read on from where the last read stopped; the bytes read."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return 0
    if size < st["off"]:
        st.clear()
        st.update(_new(path))
    if size == st["off"]:
        return 0
    try:
        with open(path, "rb") as f:
            f.seek(st["off"])
            buf = f.read(min(step, size - st["off"]))
    except OSError:
        return 0
    end = buf.rfind(b"\n")
    if end < 0:
        # One line longer than a step: a tool result, skipped unread.
        st["off"] += len(buf) if len(buf) >= step else 0
        return len(buf)
    st["off"] += end + 1
    for line in buf[: end + 1].splitlines():
        # A user prompt, or a tool call that may be a Slack read or send;
        # a tool's result is neither. Claude Code writes compact JSON, but a
        # spaced one is matched too.
        if len(line) > LINE_MAX or b'"tool_use_id"' in line:
            continue
        if not USER.search(line) and not (b'"tool_use"' in line and (b"Slack" in line or b"slack" in line)):
            continue
        try:
            take(st, json.loads(line))
        except ValueError:
            continue
    return end + 1


def paths(now: float) -> list[str]:
    """The transcripts written in the last SCAN_H hours (subagents' aside)."""
    if now - _list["at"] > LIST_EVERY:
        found = []
        for p in glob.glob(os.path.join(ROOT, "*", "*.jsonl")):
            try:
                if now - os.path.getmtime(p) < SCAN_H * 3600:
                    found.append(p)
            except OSError:
                continue
        _list.update(at=now, paths=found)
    return _list["paths"]


def scan(now: float | None = None, files: list[str] | None = None, budget: int = BUDGET) -> dict[str, dict]:
    """Read what was written since the last call; sid -> its state. A call
    while another reads returns what is known."""
    now = time.time() if now is None else now
    if not _lock.acquire(blocking=False):
        return by_sid()
    try:
        left = budget
        for p in files if files is not None else paths(now):
            if left <= 0:
                break
            st = _files.get(p)
            if st is None:
                st = _files[p] = _new(p)
            left -= read(p, st, min(STEP, left))
        keep = set(files if files is not None else paths(now))
        for p in [p for p in _files if p not in keep]:
            del _files[p]
    finally:
        _lock.release()
    return by_sid()


def by_sid() -> dict[str, dict]:
    return {st["sid"]: st for st in list(_files.values())}


def seen(states: dict[str, dict], triggers: list[dict]) -> dict:
    """What office/turn.py table takes as `seen`: when each session was last
    typed to and prompted, and the triggers with no live session that were
    taken up."""
    return {
        "typed": {sid: st["typed"] for sid, st in states.items() if st["typed"]},
        "prompted": {sid: st["prompted"] for sid, st in states.items() if st["prompted"]},
        "slx": {x["id"]: h for x in triggers if not x.get("alive") and (h := handled(x, states))},
        # A session's own work (the threads its first prompt names) and the
        # newest reply to each: a block asking about a thread someone has
        # since answered is answered too.
        "work": {sid: st["first"] for sid, st in states.items() if st["first"]},
        "replied": replies(states),
    }


def replies(states: dict[str, dict]) -> dict[str, dict]:
    """ref -> the newest send to that thread or DM, from any session."""
    out: dict[str, dict] = {}
    for sid, st in states.items():
        for ref, r in st["refs"].items():
            if r.get("reply", 0) > out.get(ref, {}).get("at", 0):
                out[ref] = {"how": "reply", "at": r["reply"], "sid": sid}
    return out


def handled(item: dict, states: dict[str, dict]) -> dict | None:
    """Whether a trigger was taken up after it came: {how, at, sid}, the
    surest way first (reply, typed, relay); None when not."""
    at = _epoch(item.get("at")) if not isinstance(item.get("at"), (int, float)) else float(item["at"])
    refs = item_refs(item)
    if not at or not refs:
        return None
    best: dict | None = None
    rank = {"reply": 0, "typed": 1, "relay": 2}
    own = item.get("sid")
    for sid, st in states.items():
        # A session started for the work: its own (slx's), or one whose first
        # prompt names the thread or incident. A DM is a whole channel, months
        # of asks: a session started on an older one only maybe took this up.
        mine = sid == own or bool(refs & set(st["first"] or []))
        if mine and st["typed"] > at:
            dm = sid != own and all(DM.fullmatch(r) for r in refs)
            got = {"how": "relay" if dm else "typed", "at": st["typed"], "sid": sid}
        else:
            got = None
            for ref in refs & set(st["refs"]):
                r = st["refs"][ref]
                for how in ("reply", "typed", "relay"):
                    # The item's own session reading its own thread is slx's
                    # work, not anyone taking it up.
                    if how == "relay" and sid == own:
                        continue
                    if r.get(how, 0) > at and (got is None or rank[how] < rank[got["how"]]):
                        got = {"how": how, "at": r[how], "sid": sid}
        if got and (best is None or rank[got["how"]] < rank[best["how"]] or (got["how"] == best["how"] and got["at"] > best["at"])):
            best = got
    return best
