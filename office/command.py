"""The command view: briefs that wait on the person's decision, and the
coordinators' workers beside them, and the slx inbox (office/slx.py).

A brief is ~/briefs/YYYY-MM-DD-<slug>.html (a symlink to the keyolk/briefs
repo) with a sidecar <same-name>.brief.json. The sidecar says which sessions
made it and, when a coordinator asked the person something, the question:

  "sessions":  [{"id", "cwd", "transcript", "added", "note"}]
  "decisions": [{"id": "q1", "question", "options": [{"label", "detail"}], "recommended": int|null,
                 "coordinator": sid|null, "worker": slug|null, "asked": iso,
                 "answer": null|{"choice", "note", "by", "at"[, "free"]}}]
  "decision":  the first unanswered of them (the last when all are), as a
               sidecar from before `decisions` has only this one
  "done":      {"at": UTC iso (minutes), "result", "links": [url], "revert"?}
               (`brief done`): the answer was carried out and checked; the
               view lists it under ✅ 최근 완료 (a brief only answered is not done)

A brief may ask several questions; the person answers each, with one of its
options or in their own words (choice "직접 답", the words in note). The
`brief` CLI owns that file (`brief pending --json`, one row per question;
`brief answer <brief> <q-id> <label>|--text T --by office`). The office asks it
first and, when it is missing or older than those commands, reads and writes
the sidecar itself in the same shape. When the brief's last question is
answered, every answer goes back at once as a prompt to whoever asked: the
coordinator, else the worker, else the session that made the brief.

Run as a script (`command.py pending`) it prints the waiting questions as
JSON, one row each, for the cockpit's Coord tab.
"""

import glob
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import coord  # noqa: E402 - office/coord.py, the coordinators' ledgers
import review  # noqa: E402 - office/review.py, finished work the person should judge
import turn  # noqa: E402 - office/turn.py, the one table of sessions and what each waits on
import slx  # noqa: E402 - office/slx.py, the slx inbox (Slack mentions, Meerkat incidents)
import defer  # noqa: E402 - office/defer.py, sessions set aside and memos left on them
import grants  # noqa: E402 - office/grants.py, one-shot grants a press makes
import handled  # noqa: E402 - office/handled.py, what the person already handled (transcripts)

BRIEFS = os.path.expanduser(os.environ.get("BRIEFS_DIR") or "~/briefs")
NAME = re.compile(r"^\d{4}-\d{2}-\d{2}-[\w.-]+\.html$")
SID = re.compile(r"^[0-9a-f-]{8,64}$")
KINDS = ("brief_answer", "brief_open", "coord_say", *review.KINDS, *slx.KINDS)
RECENT = 8  # briefs listed in the command panel
DONE_FOLD_H = 24  # a brief done longer ago than this is folded in the ✅ group
# file -> (sidecar mtime, sidecar), (html mtime, title): 180 briefs are read
# on every poll of the view, so only a changed file is read again.
_side: dict[str, tuple[float, dict]] = {}
_title: dict[str, tuple[float, str]] = {}
_pending: dict = {"at": 0.0, "items": []}
# A `brief` without `pending` is asked again only after this long: the view
# polls every few seconds and each ask is a process start.
NO_CLI_TTL = 300
_no_pending: dict = {"until": 0.0}


def root() -> str:
    return os.path.realpath(BRIEFS)


def brief_path(path: str) -> str | None:
    """`path` as a brief the office may show: an .html directly in the briefs
    folder once every symlink and `..` is resolved, so a link inside it that
    points elsewhere is not one."""
    if not path:
        return None
    real = os.path.realpath(os.path.expanduser(path))
    return real if os.path.dirname(real) == root() and real.endswith(".html") and os.path.isfile(real) else None


BRIEF_FILE = re.compile(r"^[\w.-]+\.html$")
# Tells the office page which brief its frame shows now: a link inside a brief
# (← 모든 브리프, another brief) moves the frame, and the page's answer buttons
# must not stay under a brief they are not about. A sandboxed frame's URL is
# not readable from outside, so the page says it itself.
FRAME_NOTE = b"<script>try{parent.postMessage({officeBrief:location.pathname},'*')}catch(e){}</script>"


def brief_by_name(name: str) -> str | None:
    """A brief (or the index) in the briefs folder by its file name only."""
    if not BRIEF_FILE.match(name or ""):
        return None
    return brief_path(os.path.join(root(), name))


def serve_brief(name: str) -> tuple[int, bytes, str, dict]:
    """GET /briefs/<name>: the page at a path-shaped URL, so the links inside
    it (index.html, another brief) resolve beside it and not against the
    office's own root, which would put the office page in the frame."""
    path = brief_by_name(name or "index.html")
    if not path:
        return 404, b"not a brief", "text/plain", {}
    try:
        with open(path, "rb") as f:
            body = f.read()
    except OSError as e:
        return 404, str(e).encode(), "text/plain", {}
    i = body.rfind(b"</body>")
    body = body[:i] + FRAME_NOTE + body[i:] if i >= 0 else body + FRAME_NOTE
    return 200, body, "text/html; charset=utf-8", {"Content-Security-Policy": "sandbox allow-scripts allow-popups", "X-Content-Type-Options": "nosniff"}


def open_outside(name: str, via: str = "") -> tuple[int, dict]:
    """↗ 밖으로: the brief alone, in a window or tab of its own, never in the
    office page (the person's screen). Always the default browser's `open`:
    tmux-chrome-open opens in the caller's tmux window, and the server's window
    can be the office's own, where the brief landed in the office's pane (seen
    on a live run with the place set to TWeb). `via` is accepted only so the
    page's remembered place does not make the click fail."""
    path = brief_by_name(name)
    if not path:
        return 404, {"error": "not a brief"}
    if via not in ("", "session", "default", "tweb", "tweb-chrome", "tweb-webkit", "chrome"):
        return 400, {"error": "unknown place to open"}
    subprocess.Popen(["open", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 200, {"ok": True, "sent": "opened in the default browser"}


def _iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def _read_side(file: str, fresh: bool = False) -> dict:
    path = os.path.join(root(), file[: -len(".html")] + ".brief.json")
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return {}
    hit = _side.get(file)
    if hit and hit[0] == mt and not fresh:
        return hit[1]
    try:
        with open(path) as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    d = d if isinstance(d, dict) else {}
    _side[file] = (mt, d)
    return d


def title(file: str) -> str:
    path = os.path.join(root(), file)
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return file
    hit = _title.get(file)
    if hit and hit[0] == mt:
        return hit[1]
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            head = f.read(8192)
    except OSError:
        head = ""
    m = re.search(r"<title>(.*?)</title>", head, re.S | re.I)
    t = html.unescape(m.group(1).strip()) if m else file[11:-5]
    _title[file] = (mt, t)
    return t


# The choice a free answer records, as `brief answer --text` writes it.
FREE = "직접 답"


def _one(d, qid: str) -> dict | None:
    if not isinstance(d, dict) or not d.get("question"):
        return None
    opts = [o for o in d.get("options") or [] if isinstance(o, dict) and o.get("label")]
    rec = d.get("recommended")
    return {
        "id": qid,
        "question": str(d["question"]),
        "options": [{"label": str(o["label"]), "detail": str(o.get("detail") or "")} for o in opts],
        "recommended": rec if isinstance(rec, int) and 0 <= rec < len(opts) else None,
        "coordinator": d.get("coordinator") if isinstance(d.get("coordinator"), str) else None,
        "worker": d.get("worker") if isinstance(d.get("worker"), str) else None,
        "asked": d.get("asked"),
        "answer": d.get("answer") if isinstance(d.get("answer"), dict) else None,
        # The action an option allows when pressed (office/grants.py), as the
        # page draws it: only for an option the question has.
        "grants": {k: a for k, v in (d.get("grants") or {}).items() if k in {str(o["label"]) for o in opts} and (a := grants.shown(v))} if isinstance(d.get("grants"), dict) else {},
    }


def _decisions(side: dict) -> list[dict]:
    """The brief's questions in order; a sidecar from before `decisions` holds
    its one question in `decision`, read as q1 (as the CLI reads it)."""
    raw = side.get("decisions")
    if not isinstance(raw, list):
        raw = [side["decision"]] if isinstance(side.get("decision"), dict) else []
    out = []
    for i, d in enumerate(raw, 1):
        one = _one(d, str(d.get("id") or f"q{i}") if isinstance(d, dict) else "")
        if one:
            out.append(one)
    return out


def _open(qs: list[dict]) -> list[dict]:
    return [q for q in qs if not q["answer"]]


def _done(side: dict) -> dict | None:
    """The sidecar's `done` (`brief done`): a brief whose answer was carried
    out and checked. A `done` with no result is not one (the CLI refuses it,
    a hand-written sidecar may hold it): the brief only answered."""
    raw = side.get("done")
    if not isinstance(raw, dict) or not str(raw.get("result") or "").strip():
        return None
    links = [str(x) for x in raw.get("links") or [] if isinstance(x, str) and x.strip()]
    return {"at": str(raw.get("at") or ""), "result": str(raw["result"]).strip(), "links": links, "revert": str(raw.get("revert") or "").strip() or None}


def _done_ts(at: str) -> float:
    """`done.at` (UTC, minutes: 2026-11-11T09:39Z) as epoch seconds; 0 when unreadable."""
    try:
        return datetime.strptime(at, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return 0.0


def _done_status(sids: list[str]) -> dict | None:
    """The newest `done` status among the sessions that made a brief, read from
    their status files (hooks/lib/status.ts); None when none declared done.
    `result` is the status's msg, else its step."""
    best = None
    d = os.path.expanduser("~/.claude/state/office/status")
    for sid in sids:
        if not SID.match(sid):
            continue
        try:
            with open(os.path.join(d, sid + ".json")) as f:
                st = json.load(f)
        except (OSError, ValueError):
            continue
        at = st.get("at") if isinstance(st, dict) else None
        text = str(st.get("msg") or st.get("step") or "").strip() if isinstance(st, dict) else ""
        if isinstance(st, dict) and st.get("state") == "done" and isinstance(at, (int, float)) and text and (best is None or at > best["at"]):
            best = {"at": at, "result": text}
    return best


def briefs() -> list[dict]:
    """Every brief with a sidecar, oldest first (by the date in its name)."""
    out = []
    for side in sorted(glob.glob(os.path.join(root(), "*.brief.json"))):
        file = os.path.basename(side)[: -len(".brief.json")] + ".html"
        if not NAME.match(file) or not os.path.isfile(os.path.join(root(), file)):
            continue
        d = _read_side(file)
        sids = [str(s.get("id")) for s in d.get("sessions") or [] if isinstance(s, dict) and s.get("id")]
        out.append({"file": file, "path": os.path.join(root(), file), "sessions": sids, "questions": _decisions(d), "done": _done(d)})
    return out


def hib_named(hib: dict, people: list[dict]) -> dict:
    """/command's `hibernate` with each candidate named by what it is doing
    (its summary, as the table names it): the office listed only '휴면 후보
    2개', the names in a tooltip as pane titles (`agent`), and the person
    could not tell which to put down. A copy: the view's cache is not
    changed."""
    cands = hib.get("candidates") or []
    if not cands:
        return hib
    sums, by = coord.summaries(), {p["id"]: p for p in people}
    return {**hib, "candidates": [{**c, "summary": label(c["sid"], sums, (by.get(c["sid"]) or {}).get("cwd"))} for c in cands]}


LIB_MAX = 400  # the 📚 list: every brief there is (~300 today), at most this many


_no_list: dict = {"until": 0.0}
LIB_STATES = ("pending", "done", "answered", "read")
LIB_TYPES = ("decision", "result", "review", "research")  # `brief list --json`'s type, the index's type facets


def library() -> dict:
    """Every brief for the 📚 전체 브리프 panel, newest first: what `brief list
    --json` (keyolk/briefs bin/brief.py) gives, the records ~/briefs/index.html
    is made of, so the panel and the index filter by one rule (title, topic,
    state, the search text). Each: `state` pending (a question open, `ask`),
    done (`brief done`, `result`), answered or read (asks nothing).
    A CLI from before `list` (or none): read here, the same fields."""
    rows = _cli_list()
    if rows is None:
        rows = _own_list()
    for r in rows:
        r["path"] = os.path.join(root(), r["file"])
    topics: dict[str, int] = {}
    for r in rows:
        topics[r["topic"]] = topics.get(r["topic"], 0) + 1
    counts = {k: sum(1 for r in rows if r["state"] == k) for k in LIB_STATES}
    types = {k: sum(1 for r in rows if r.get("type") == k) for k in LIB_TYPES}
    return {"at": time.time(), "total": len(rows), "counts": counts, "types": types, "topics": sorted(topics.items(), key=lambda kv: (-kv[1], kv[0])), "items": rows[:LIB_MAX]}


def _cli_list() -> list[dict] | None:
    if time.time() < _no_list["until"]:
        return None
    r = _cli(["list", "--json"])
    if not r or r.returncode != 0:
        if r and "invalid choice" in r.stderr:
            _no_list["until"] = time.time() + NO_CLI_TTL
        return None
    try:
        items = json.loads(r.stdout).get("items")
    except (ValueError, AttributeError):
        return None
    if not isinstance(items, list):
        return None
    keep = ("file", "date", "title", "desc", "topic", "type", "state", "ask", "result", "search")
    return [{k: it.get(k) for k in keep} for it in items if isinstance(it, dict) and NAME.match(str(it.get("file") or "")) and it.get("state") in LIB_STATES]


def _meta(head: str, name: str) -> str:
    m = re.search(r'<meta\s+name="' + re.escape(name) + r'"\s+content="([^"]*)"', head)
    return html.unescape(m.group(1)) if m else ""


def _own_list() -> list[dict]:
    """`brief list --json`'s records, read here (no CLI, or one from before it)."""
    rows = []
    sides = {b["file"]: b for b in briefs()}
    for path in glob.glob(os.path.join(root(), "*.html")):
        file = os.path.basename(path)
        if not NAME.match(file):
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                head = f.read(8192)
        except OSError:
            head = ""
        b = sides.get(file)
        qs = b["questions"] if b else []
        done = b["done"] if b else None
        state = "pending" if _open(qs) else "done" if done else "answered" if qs else "read"
        t, desc, topic = title(file), _meta(head, "description"), _meta(head, "brief:topic") or "기타"
        rows.append({"file": file, "date": file[:10], "title": t, "desc": desc, "topic": topic, "state": state,
                     "type": "review" if re.search(r"review-requests?", file) else "decision" if qs else "result" if done else "research",
                     "ask": next((q["question"] for q in _open(qs)), None), "result": done["result"] if done else None,
                     "search": " ".join([t, desc, topic, "결정 대기" if state == "pending" else "", "완료" if done else "", done["result"] if done else ""] + (b["sessions"] if b else [])).lower(),
                     "_at": _mtime(path)})
    rows.sort(key=lambda r: (r["date"], r["_at"]), reverse=True)
    for r in rows:
        del r["_at"]
    return rows


def latest_by_session() -> dict[str, dict]:
    """Session id -> the newest brief it is recorded on."""
    out: dict[str, dict] = {}
    for b in briefs():
        for sid in b["sessions"]:
            out[sid] = {"file": b["file"], "path": b["path"], "title": title(b["file"]), "pending": bool(_open(b["questions"]))}
    return out


def brief_bin() -> str | None:
    for p in (shutil.which("brief"), os.path.expanduser("~/.local/bin/brief")):
        if p and os.access(p, os.X_OK):
            return p
    return None


def _cli(args: list[str]) -> subprocess.CompletedProcess | None:
    b = brief_bin()
    if not b:
        return None
    try:
        return subprocess.run([b, *args], capture_output=True, text=True, timeout=10, env={**os.environ, "BRIEFS_DIR": root()})
    except (OSError, subprocess.TimeoutExpired):
        return None


def _cli_pending() -> dict[str, set | None] | None:
    """The questions `brief pending --json` lists: file name -> the q-ids, or
    None for a CLI from before `decisions` (a row per brief, no qid: all of
    them). None when the CLI cannot say (missing, older, or not a list)."""
    if time.time() < _no_pending["until"]:
        return None
    r = _cli(["pending", "--json"])
    if not r or r.returncode != 0:
        if r and "invalid choice" in r.stderr:
            _no_pending["until"] = time.time() + NO_CLI_TTL
        return None
    try:
        items = json.loads(r.stdout)
    except ValueError:
        return None
    if isinstance(items, dict):
        items = items.get("pending") or items.get("briefs")
    if not isinstance(items, list):
        return None
    out: dict[str, set | None] = {}
    for it in items:
        ref = it if isinstance(it, str) else (it.get("brief") or it.get("file") or it.get("path")) if isinstance(it, dict) else None
        if not ref:
            continue
        name, qid = os.path.basename(str(ref)), it.get("qid") if isinstance(it, dict) else None
        if not isinstance(qid, str) or out.get(name, set()) is None:
            out[name] = None
        else:
            out.setdefault(name, set()).add(qid)
    return out


# `brief pending --json` is a process start, and the view polls every 3 s
# (sys-load brief D, 2026-11-11: 3 of them in 13 s). Its answer is asked
# again only when a sidecar changed (a brief asked or answered; an office
# answer also resets the cache) or PENDING_TTL has passed.
PENDING_TTL = 15


def _sides_sig() -> tuple:
    try:
        return tuple(sorted((e.name, e.stat().st_mtime) for e in os.scandir(root()) if e.name.endswith(".brief.json")))
    except OSError:
        return ()


def pending() -> list[dict]:
    """Briefs with a question nobody has answered, the longest waiting first:
    each with all its questions (the answered ones too, to show what is
    decided) and `decision`, the first open one."""
    sig = _sides_sig()
    if time.time() - _pending["at"] < PENDING_TTL and sig == _pending.get("sig"):
        return _pending["items"]
    cli = _cli_pending()
    items = []
    for b in briefs():
        qs = _open(b["questions"])
        if cli is not None:
            if b["file"] not in cli:
                continue
            want = cli[b["file"]]
            qs = [q for q in qs if want is None or q["id"] in want]
        if qs:
            items.append({"file": b["file"], "path": b["path"], "title": title(b["file"]), "questions": b["questions"], "decision": qs[0], "sessions": b["sessions"]})
    items.sort(key=lambda i: str(i["decision"].get("asked") or ""))
    _pending.update(at=time.time(), items=items, sig=sig)
    return items


def _worker_sid(slug: str | None, coordinator: str | None = None, alive: set[str] | None = None) -> str | None:
    """The live worker of that slug: under `coordinator` only, when given
    (two coordinators may each have a worker of one name).

    `alive`: the sessions still running (office.py alive_sessions). A ledger
    marks a worker ended when the coordinator lets it go or loses its pane,
    while the session itself may still run: pt2677's `ops-k8s-4a` was ended
    in the ledger at 00:29 and alive, so the person's 보내기 on its brief was
    refused (no live worker) and the row never left 내 차례. The ledger still
    names the session (the newest entry of that slug); `alive` only says it
    is there to redeem the grant."""
    last = None
    for d in coord.ledgers():
        if coordinator and d.get("sid") != coordinator:
            continue
        for w in d.get("workers") or []:
            if not (slug and w.get("slug") == slug and w.get("sid")):
                continue
            if not w.get("endedAt"):
                return w["sid"]
            if alive and w["sid"] in alive and (last is None or (w.get("at") or 0) >= (last.get("at") or 0)):
                last = w
    return last["sid"] if last else None


def _coord_name(sid: str | None) -> str | None:
    return next((d.get("name") or d["sid"][:8] for d in coord.ledgers() if d["sid"] == sid), None)


# A session's name for the person when no one-line summary is cached yet
# (the coordinator's cc-mods writes those, at most once a minute, and only
# for sessions it sees): its repository and the start of its first prompt.
# The person could not tell `ops-k8s-4a` from its slug alone.
FIRST_CHARS = 30
FIRST_RETRY = 60  # a transcript not found (or with no prompt yet) is looked for again after this
_first: dict[str, tuple[str, float]] = {}
_repo: dict[str, str] = {}


def first_prompt(sid: str) -> str:
    """The first prompt the person (or a coordinator's spawn) gave the
    session, whitespace folded; '' while none is found. Read once per session:
    the head of a transcript never changes."""
    hit = _first.get(sid)
    if hit and (hit[0] or time.time() - hit[1] < FIRST_RETRY):
        return hit[0]
    text = ""
    for f in glob.glob(os.path.expanduser("~/.claude/projects/*/" + sid + ".jsonl")) if SID.match(sid) else []:
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for n, line in enumerate(fh):
                    if n > 400:
                        break
                    if '"user"' not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    if d.get("type") != "user" or d.get("isMeta"):
                        continue
                    c = (d.get("message") or {}).get("content")
                    t = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text") if isinstance(c, list) else ""
                    t = re.sub(r"\s+", " ", t).strip()
                    # Commands, hook output and reminders are not what it was asked.
                    if t and not t.startswith("<"):
                        text = t
                        break
        except OSError:
            continue
        if text:
            break
    _first[sid] = (text, time.time())
    return text


def repo_name(cwd: str | None, w: dict | None = None) -> str:
    """The repository a session works in: the ledger's (owner/name or the
    checkout a worktree came from), else the git common dir of its cwd (a
    worktree's own folder is named after the slug, which is the complaint),
    else the folder's name."""
    w = w or {}
    if w.get("repo"):
        return str(w["repo"]).split("/")[-1]
    if w.get("repoDir"):
        return os.path.basename(str(w["repoDir"]).rstrip("/"))
    if not cwd:
        return ""
    if cwd not in _repo:
        name = ""
        try:
            r = subprocess.run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True, timeout=2)
            d = r.stdout.strip().rstrip("/") if r.returncode == 0 else ""
            if d:
                name = os.path.basename(os.path.dirname(d)) if os.path.basename(d) == ".git" else os.path.basename(d).removesuffix(".git")
        except (OSError, subprocess.TimeoutExpired):
            pass
        _repo[cwd] = name or os.path.basename(cwd.rstrip("/"))
    return _repo[cwd]


# The head a coordinator puts on what it hands a worker (hooks/lib/coordsum.ts
# unrelay): `사람의 말(원문): "…"`, `[coordinator] …`. A name made of it
# names the hand-off, not the work.
RELAY_HEAD = re.compile(r'^\s*(?:\[(?:coordinator|coord|office→coord)\]\s*)?(?:(?:사람의 말|worker 보고)\s*\([^)]*\)\s*:\s*)?"?')


def unrelay(text: str) -> str:
    t = text or ""
    out = RELAY_HEAD.sub("", t, count=1).strip()
    # The quote the head opened closes at the first `"`; what follows is the coordinator's.
    return out.split('"', 1)[0].strip() if out != t.strip() and '"' in out else out


def label(sid: str | None, sums: dict[str, str], cwd: str | None = None, w: dict | None = None) -> str | None:
    """What the view calls a session: its cached summary, else its
    repository and the start of its first prompt; None when neither is known."""
    if not sid:
        return None
    if sums.get(sid):
        return sums[sid]
    first = unrelay(first_prompt(sid))
    first = first if len(first) <= FIRST_CHARS else first[: FIRST_CHARS - 1] + "…"
    out = " · ".join(x for x in (repo_name(cwd, w), first) if x)
    return out or None


STATUS_STATES = ("working", "blocked", "done", "error", "idle")


def status_of(w: dict) -> dict | None:
    """A worker's declared status from its ledger row, the fields the view
    draws; None when it declared none (or the row holds something else)."""
    st = w.get("status")
    if not isinstance(st, dict) or st.get("state") not in STATUS_STATES:
        return None
    keep = ("state", "kind", "step", "next", "needs", "progress", "msg", "link", "pane", "ask", "target", "submit", "at")
    return {k: st[k] for k in keep if st.get(k) not in (None, "")}


def declared(by_sid: dict[str, dict], ledger_w: dict[str, dict]) -> dict[str, dict]:
    """sid -> what each live session declared with its status tool, read from
    its status file (hooks/lib/status.ts). The ledger holds a copy that a
    coordinator tick wrote: late, and absent for a session no coordinator
    holds, which is how a block on the person went unseen."""
    out = {}
    d = os.path.expanduser("~/.claude/state/office/status")
    for sid, p in by_sid.items():
        if not SID.match(sid):
            continue
        try:
            with open(os.path.join(d, sid + ".json")) as f:
                st = status_of({"status": json.load(f)})
        except (OSError, ValueError):
            continue
        if st:
            out[sid] = {"name": (ledger_w.get(sid) or {}).get("slug") or p.get("name"), "summary": None, "state": p.get("state"), "status": st}
    return out


def waits_on_person(p: dict) -> bool:
    """Whether a session is a 🙋 waiting row (`calls`): its pane asks for
    attention. A coordinator is one only while its pane draws a call (a
    dialog, a permission: `asks`, @cc_pane_asks). Its turn that ends on a
    question ("결정 N건 대기", "brief에서 보내기를 누르시면") is asked on its
    briefs, already rows of their own in 내 차례; as a call too, the same
    question stood twice, and the 보내기 pressed on the brief left the
    coordinator's row in place."""
    if p.get("attention") not in ("ask", "alert"):
        return False
    return not p.get("coord") or bool(p.get("asks"))


def view(people: list[dict], ask=None, deps: list[dict] | None = None) -> dict:
    """What the command view draws: the waiting decisions, each coordinator
    with its live workers (their state from the office's own snapshot and the
    brief each is on), and the finished work waiting on the person's look.
    `ask`: sid -> what it asks now (office.py ask_digest), for the rows set
    aside (office/defer.py)."""
    by_sid = {p["id"]: p for p in people}
    latest = latest_by_session()
    sums = coord.summaries()

    def cwd(sid: str | None, w: dict | None = None) -> str | None:
        return (by_sid.get(sid or "") or {}).get("cwd") or (w or {}).get("cwd")

    # A worker's ledger row knows its repository; the same session waiting on
    # the person is named the same way.
    ledger_w = {w["sid"]: w for c in coord.view() for w in c["workers"] if w.get("sid")}

    def live(sid: str | None) -> dict:
        p = by_sid.get(sid or "") or {}
        return {"state": p.get("state"), "attention": p.get("attention"), "doing": p.get("doing"), "window": p.get("window"), "name": p.get("name"), "live": bool(p), "mcp": p.get("mcp")}

    coords = []
    for c in coord.view():
        coords.append(
            {
                "sid": c["sid"],
                "name": c.get("name") or c["sid"][:8],
                "summary": label(c["sid"], sums, cwd(c["sid"])),
                **{k: v for k, v in live(c["sid"]).items() if k != "name"},
                "workers": [
                    {
                        "slug": w.get("slug"),
                        "sid": w.get("sid"),
                        "relation": w.get("relation") or "owned",
                        "auto": bool(w.get("auto")),
                        # An auto-adopted session the coordinator never gave a
                        # task is the person's own: the view folds it away.
                        "instructed": bool(w.get("instructed")),
                        "model": w.get("model"),
                        "effort": w.get("effort"),
                        **live(w.get("sid")),
                        "pane": (by_sid.get(w.get("sid") or "") or {}).get("pane"),
                        "summary": label(w.get("sid"), sums, cwd(w.get("sid"), w), w),
                        "brief": latest.get(w.get("sid") or ""),
                        # What the worker declared with its status tool
                        # (hooks/lib/status.ts), as the coordinator's tick
                        # last copied it into the ledger.
                        "status": status_of(w),
                    }
                    for w in c["workers"]
                ],
                # Where the coordinator handed tasks out lately: the view
                # tells the person where the task they typed went.
                "log": [{"at": e.get("at"), "kind": e.get("kind"), "text": str(e.get("text") or "")[:200]} for e in c.get("log") or [] if e.get("kind") in ("send", "spawn")][-20:],
            }
        )
    waiting = []
    for i in pending():
        d = i["decision"]
        waiting.append({**i, "coordinatorName": _coord_name(d["coordinator"]), "to": _target(d, i["sessions"])})
    # With nothing to decide the panel still says something: who waits on
    # the person across the floor, and the briefs written lately.
    calls = [
        {"sid": p["id"], "name": p.get("name") or p["id"][:8], "window": p.get("window"), "pane": p.get("pane"), "cwd": p.get("cwd"), "attention": p.get("attention"), "doing": p.get("doing"), "boss": (p.get("boss") or {}).get("name"), "slug": (p.get("boss") or {}).get("slug"), "summary": label(p["id"], sums, p.get("cwd"), ledger_w.get(p["id"])), "since": p.get("since")}
        for p in people
        if waits_on_person(p)
    ]
    # The slx inbox: an item whose session has a row above rides on it (📨);
    # the rest get rows of their own.
    inbox = slx.view({c["sid"] for c in calls} | {w["sid"] for c in coords for w in c["workers"] if w.get("sid")})
    on = slx.by_sid(inbox)
    for row in [*calls, *(w for c in coords for w in c["workers"])]:
        row["slx"] = on.get(row.get("sid") or "")
    names = {p["id"]: p.get("name") or p["id"][:8] for p in people}
    recent = []
    for b in sorted(briefs(), key=lambda b: _mtime(b["path"]), reverse=True)[:RECENT]:
        recent.append({"file": b["file"], "path": b["path"], "title": title(b["file"]), "at": _mtime(b["path"]), "by": next((names[s] for s in b["sessions"] if s in names), None), "pending": bool(_open(b["questions"])), "done": bool(b["done"])})
    # ✅ Briefs marked done (`brief done`), newest first. Apart from the ones
    # only answered: those stay in `recent` with no mark. One finished a day
    # ago is `old`; the view folds it.
    finished = []
    for b in briefs():
        if not b["done"]:
            continue
        ts = _done_ts(b["done"]["at"]) or _mtime(b["path"])
        finished.append({"file": b["file"], "path": b["path"], "title": title(b["file"]), "by": next((names[s] for s in b["sessions"] if s in names), None), **b["done"], "ts": ts, "old": time.time() - ts > DONE_FOLD_H * 3600})
    # A result brief with no decision question that a worker finished: the
    # worker declared `done` with its status tool, and nobody ran `brief done`
    # (a coordinator forgot, the worker has no such rule). Listed with the
    # status's own words; a brief marked done by hand wins.
    for b in briefs():
        if b["done"] or b["questions"]:
            continue
        st = _done_status(b["sessions"])
        if st:
            ts = st["at"] / 1000
            finished.append({"file": b["file"], "path": b["path"], "title": title(b["file"]), "by": next((names[s] for s in b["sessions"] if s in names), None), "at": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "result": st["result"], "links": [], "revert": None, "ts": ts, "old": time.time() - ts > DONE_FOLD_H * 3600, "auto": True})
    finished.sort(key=lambda x: x["ts"], reverse=True)
    reviews = review.items()
    # Set aside and memos: only the live sessions' (an ended one keeps its file, out of sight).
    held = defer.held(set(by_sid))
    now = time.time()
    waits = {c["sid"] for c in calls}
    for sid, h in held.items():
        p = by_sid[sid]
        h["info"] = {"name": p.get("name"), "summary": label(sid, sums, p.get("cwd"), ledger_w.get(sid)), "state": p.get("state")}
        # What a session set aside asks now, read only for one that waits on
        # its pane (turn.woken compares it with what it asked when set aside).
        if ask and sid in waits and h.get("until") and h["until"] > now:
            h["askNow"] = ask(sid)
    decl = declared(by_sid, ledger_w)
    for sid, d in decl.items():
        d["summary"] = label(sid, sums, cwd(sid), ledger_w.get(sid))
    seen = handled.seen(handled.scan(now), inbox["items"])
    rows = turn.table(waiting, calls, reviews, coords, inbox["items"], held=held, now=now, declared=decl, deps=deps, seen=seen)
    for r in rows:
        if r.get("wake"):
            defer.wake(r["sid"], r["wake"])
        elif r.get("adopt"):
            defer.adopt(r["sid"], r["adopt"])
    return {"at": time.time(), "pending": waiting, "coordinators": coords, "calls": calls, "reviews": reviews, "recent": recent, "done": finished, "table": rows, "slx": inbox}


# What a session waiting on the person shows in the view's left pane: the
# end of its last answer, where the question is, not the whole answer.
ASK_LINES = 30
ASK_CHARS = 3000


def ask_block(text: str) -> dict:
    """The end of a session's last answer: whole paragraphs from the end up to
    ASK_LINES lines, or the last ASK_LINES lines of one longer paragraph, and
    at most ASK_CHARS characters. `cut` says there is more above it."""
    lines = (text or "").strip("\n").splitlines()
    tail = lines[-ASK_LINES:]
    if len(tail) < len(lines) and tail and lines[len(lines) - len(tail) - 1].strip():
        # The tail starts mid-paragraph: open on the next whole one, if any.
        start = next((i for i in range(1, len(tail)) if not tail[i - 1].strip() and tail[i].strip()), 0)
        tail = tail[start:]
    out = "\n".join(tail).strip("\n")
    if len(out) > ASK_CHARS:
        out = out[-ASK_CHARS:]
        out = out[out.find("\n") + 1 :] if "\n" in out else out
    return {"text": out, "cut": len(out) < len("\n".join(lines).strip("\n"))}


def _mtime(path: str) -> float:
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def _target(d: dict, sessions: list[str]) -> str | None:
    """Whom an answer goes to: the coordinator that asked, else the worker,
    else the newest session that made the brief."""
    for sid in (d.get("coordinator"), _worker_sid(d.get("worker")), *reversed(sessions)):
        if sid and SID.match(sid):
            return sid
    return None


def _write_answer(file: str, qid: str, ans: dict) -> bool:
    """The answer written into the sidecar as `brief answer` writes it: on its
    question in `decisions`, and `decision` mirrors the first one still open
    (the last when none is); a sidecar with only `decision` keeps that shape."""
    path = os.path.join(root(), file[: -len(".html")] + ".brief.json")
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    decs = data.get("decisions")
    if isinstance(decs, list):
        dec = next((d for i, d in enumerate(decs, 1) if isinstance(d, dict) and str(d.get("id") or f"q{i}") == qid), None)
    else:
        dec = data.get("decision") if qid == "q1" else None
    if not isinstance(dec, dict) or dec.get("answer"):
        return False
    dec["answer"] = ans
    if isinstance(decs, list):
        hist = (data.get("decision") or {}).get("history") if isinstance(data.get("decision"), dict) else None
        mirror = next((d for d in decs if isinstance(d, dict) and not d.get("answer")), decs[-1])
        data["decision"] = {**mirror, **({"history": hist} if hist else {})}
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, path)
    return True


def _said(a: dict) -> str:
    return str(a.get("choice")) + (f" — {a['note']}" if a.get("note") else "")


def _granted(q: dict) -> str:
    """What the answer allowed, for the prompt: the worker reads that its
    send is approved and goes on (no second ask)."""
    a = q["grants"].get(str(q["answer"].get("choice"))) if q.get("answer") else None
    if not a:
        return ""
    return f" [granted: one Slack send to {a['channel']}" + (f" thread {a['thread']}" if a["thread"] else "") + ", the text on the brief, exactly]"


def message(file: str, qs: list[dict]) -> str:
    """The one prompt for whoever asked, once every question is answered:
    `[brief answer] <file>: <label> — <note>` as before for one question; for
    several, each q-id and choice on that line and each question under it. A
    free answer is `직접 답 — <the words>`, so the words always arrive."""
    if len(qs) == 1:
        return f"[brief answer] {file}: {_said(qs[0]['answer'])}{_granted(qs[0])}"
    head = " · ".join(f"{q['id']} {q['answer'].get('choice')}" for q in qs)
    return f"[brief answer] {file}: {head}\n" + "\n".join(f"- {q['id']} {q['question']} → {_said(q['answer'])}{_granted(q)}" for q in qs)


def answer(file: str, qid: str, label: str, note: str, inbox_put, text: str = "", seen: str = "", alive: set[str] | None = None) -> tuple[int, dict]:
    """Record the person's answer to one question on the brief: one of its
    options (`label`, with `note`) or their own words (`text`). When it was
    the brief's last open question, tell whoever asked every answer at once.

    An option that declares an action (`grants`) is a press that allows it:
    `seen` is the digest of the action the page drew, and it must still be
    the declared one. The grant goes to the worker the coordinator's ledger
    names for the question (office/grants.py says why only here)."""
    if not NAME.match(file or "") or not brief_path(os.path.join(root(), file)):
        return 404, {"error": "no such brief"}
    side = _read_side(file, fresh=True)
    qs = _decisions(side)
    if not qs:
        return 409, {"error": "this brief asks nothing"}
    if not qid and len(qs) == 1:
        qid = qs[0]["id"]
    q = next((x for x in qs if x["id"] == qid), None)
    if not q:
        return 400, {"error": "which question? " + ", ".join(x["id"] for x in qs)}
    if q["answer"]:
        return 409, {"error": "already answered", "answer": q["answer"]}
    text, note = text.strip()[:2000], note.strip()[:2000]
    if text and label:
        return 400, {"error": "an option or your own words, not both"}
    if not text and label not in [o["label"] for o in q["options"]]:
        return 400, {"error": "not one of its options"}
    act = None if text else q["grants"].get(label)
    grantee = None
    if act:
        if seen != act["digest"]:
            return 409, {"error": "the action this option allows changed since the page drew it: look again"}
        grantee = _worker_sid(q["worker"], q["coordinator"], alive)
        if not grantee:
            # Not recorded: a 보내기 with no one to send it would drop the
            # send the person approved without a word. The page shows why
            # under the option (command.js cmdAnswer) and offers the rest.
            return 409, {"error": "no live worker " + str(q["worker"]) + " to allow this for", "refused": "worker", "worker": q["worker"]}
    path = os.path.join(root(), file)
    if text:
        args = ["answer", path, qid, "--text", text, "--by", "office"]
    else:
        args = ["answer", path, qid, label, "--by", "office"] + (["--note", note] if note else [])
    r = _cli(args)
    via = "cli" if r and r.returncode == 0 and any(x["id"] == qid and x["answer"] for x in _decisions(_read_side(file, fresh=True))) else None
    # A CLI that does not have `answer` yet (or not --text, or not a q-id)
    # leaves the sidecar as it was: the office writes the same record itself.
    if not via:
        ans = {"choice": FREE, "note": text, "by": "office", "at": _iso(), "free": True} if text else {"choice": label, "note": note or None, "by": "office", "at": _iso()}
        if not _write_answer(file, qid, ans):
            return 500, {"error": "could not record the answer", "cli": (r.stderr.strip()[-300:] if r else None)}
        via = "sidecar"
    allowed = ""
    if act and grantee:
        grants.issue(grantee, act, file + " " + qid + " " + label)
        allowed = f" · 허가: {act['channel']}{' 스레드' if act['thread'] else ''}에 1건 ({grants.TTL_S // 60}분)"
    qs = _decisions(_read_side(file, fresh=True))
    _pending["at"] = 0.0
    said = f"{FREE}: {text}" if text else label
    left = _open(qs)
    if left:
        return 200, {"ok": True, "sent": f"{qid} {said} 기록 · 남은 질문 {len(left)}{allowed}", "via": via, "left": len(left)}
    to = _target(qs[0], [str(s.get("id")) for s in side.get("sessions") or [] if isinstance(s, dict) and s.get("id")])
    if not to:
        return 200, {"ok": True, "sent": "기록만 했습니다 (전할 세션 없음)" + allowed, "via": via, "left": 0}
    inbox_put(to, message(file, qs))
    who = "coordinator" if to == qs[0]["coordinator"] else "worker"
    return 200, {"ok": True, "sent": (f"{said} → {_coord_name(to) or who}" if len(qs) == 1 else f"답 {len(qs)}개 → {_coord_name(to) or who}") + allowed, "via": via, "to": to, "left": 0}


SLUG = re.compile(r"^[\w.-]{1,64}$")


def _re(about: dict | None) -> str | None:
    """What the person has open beside the box, as the coordinator reads it:
    `(re: <brief file>, worker <slug>) `, `(re: review <id>) ` or
    `(re: slx <id>: <from> · <where> · <link> · "<text>") `. "" for nothing
    open; None for something that is not a brief, a review or an slx item."""
    if not about:
        return ""
    if about.get("review"):
        rid = str(about["review"])
        return f"(re: review {rid}) " if review.ID.match(rid) else None
    if about.get("slx"):
        return slx.about(str(about["slx"]))
    file, worker = str(about.get("brief") or ""), str(about.get("worker") or "")
    if not NAME.match(file) or (worker and not SLUG.match(worker)):
        return None
    return f"(re: {file}" + (f", worker {worker}" if worker else "") + ") "


def say(coord_sid: str, slug: str, text: str, inbox_put, about: dict | None = None) -> tuple[int, dict]:
    """A task typed in the 지휘 box, for the coordinator to hand out
    (coord_route), or about what the person has open (`about`: a brief and its
    worker, or a review item), for it to pass to that work's worker. With a
    slug, an instruction it relays to that worker with coord_send. The office
    writes to the coordinator only: a session is answered directly from its
    own view (office.py act, kind reply)."""
    text = (text or "").strip()
    if not text or len(text) > 4000:
        return 400, {"error": "empty or too long"}
    led = next((d for d in coord.ledgers() if d["sid"] == coord_sid), None)
    if not led or not SID.match(coord_sid):
        return 404, {"error": "no such coordinator"}
    name = led.get("name") or coord_sid[:8]
    re_ = _re(about if isinstance(about, dict) else None)
    if re_ is None:
        return 400, {"error": "bad re"}
    if not slug:
        inbox_put(coord_sid, f"[office→coord] {re_}{text}")
        # `at` (ms, the ledger log's clock): the view looks for the first
        # send or spawn after it, to say where the task went.
        return 200, {"ok": True, "sent": f"지시 → {name}", "at": int(time.time() * 1000)}
    if not any(w.get("slug") == slug and not w.get("endedAt") for w in led.get("workers") or []):
        return 404, {"error": "no such worker under it"}
    inbox_put(coord_sid, f"[office→coord] {slug}: {text}")
    return 200, {"ok": True, "sent": f"{slug} 지시 → {name}"}


def act(body: dict, inbox_put, alive: set[str] | None = None) -> tuple[int, dict]:
    kind = body.get("kind")
    if kind == "brief_answer":
        return answer(str(body.get("file") or ""), str(body.get("qid") or ""), str(body.get("label") or ""), str(body.get("note") or ""), inbox_put, str(body.get("text") or ""), str(body.get("seen") or ""), alive)
    if kind == "brief_open":
        return open_outside(str(body.get("file") or ""), str(body.get("via") or ""))
    if kind in review.KINDS:
        return review.act(body, inbox_put)
    if kind in slx.KINDS:
        return slx.act(body)
    if kind == "coord_say":
        return say(str(body.get("coord") or ""), str(body.get("slug") or ""), str(body.get("value") or ""), inbox_put, body.get("re"))
    return 400, {"error": "unknown action"}


if __name__ == "__main__":
    if sys.argv[1:] == ["pending"]:
        print(json.dumps([{"file": i["file"], "title": i["title"], "qid": q["id"], "decision": q, "coordinatorName": _coord_name(q["coordinator"])} for i in pending() for q in _open(i["questions"])], ensure_ascii=False))
    else:
        sys.exit("usage: command.py pending")
