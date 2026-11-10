"""The command view: briefs that wait on the person's decision, and the
coordinators' workers beside them.

A brief is ~/briefs/YYYY-MM-DD-<slug>.html (a symlink to the keyolk/briefs
repo) with a sidecar <same-name>.brief.json. The sidecar says which sessions
made it and, when a coordinator asked the person something, the question:

  "sessions":  [{"id", "cwd", "transcript", "added", "note"}]
  "decisions": [{"id": "q1", "question", "options": [{"label", "detail"}], "recommended": int|null,
                 "coordinator": sid|null, "worker": slug|null, "asked": iso,
                 "answer": null|{"choice", "note", "by", "at"[, "free"]}}]
  "decision":  the first unanswered of them (the last when all are), as a
               sidecar from before `decisions` has only this one

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

BRIEFS = os.path.expanduser(os.environ.get("BRIEFS_DIR") or "~/briefs")
NAME = re.compile(r"^\d{4}-\d{2}-\d{2}-[\w.-]+\.html$")
SID = re.compile(r"^[0-9a-f-]{8,64}$")
KINDS = ("brief_answer", "coord_say")
RECENT = 8  # briefs listed in the command panel
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


def briefs() -> list[dict]:
    """Every brief with a sidecar, oldest first (by the date in its name)."""
    out = []
    for side in sorted(glob.glob(os.path.join(root(), "*.brief.json"))):
        file = os.path.basename(side)[: -len(".brief.json")] + ".html"
        if not NAME.match(file) or not os.path.isfile(os.path.join(root(), file)):
            continue
        d = _read_side(file)
        sids = [str(s.get("id")) for s in d.get("sessions") or [] if isinstance(s, dict) and s.get("id")]
        out.append({"file": file, "path": os.path.join(root(), file), "sessions": sids, "questions": _decisions(d)})
    return out


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


def pending() -> list[dict]:
    """Briefs with a question nobody has answered, the longest waiting first:
    each with all its questions (the answered ones too, to show what is
    decided) and `decision`, the first open one. Read at most every 3 s: the
    CLI is a process start."""
    if time.time() - _pending["at"] < 3:
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
    _pending.update(at=time.time(), items=items)
    return items


def _worker_sid(slug: str | None) -> str | None:
    for d in coord.ledgers():
        for w in d.get("workers") or []:
            if slug and w.get("slug") == slug and not w.get("endedAt") and w.get("sid"):
                return w["sid"]
    return None


def _coord_name(sid: str | None) -> str | None:
    return next((d.get("name") or d["sid"][:8] for d in coord.ledgers() if d["sid"] == sid), None)


def view(people: list[dict]) -> dict:
    """What the command view draws: the waiting decisions, and each
    coordinator with its live workers, their state from the office's own
    snapshot and the brief each is on."""
    by_sid = {p["id"]: p for p in people}
    latest = latest_by_session()

    def live(sid: str | None) -> dict:
        p = by_sid.get(sid or "") or {}
        return {"state": p.get("state"), "attention": p.get("attention"), "doing": p.get("doing"), "window": p.get("window"), "name": p.get("name"), "live": bool(p)}

    coords = []
    for c in coord.view():
        coords.append(
            {
                "sid": c["sid"],
                "name": c.get("name") or c["sid"][:8],
                **{k: v for k, v in live(c["sid"]).items() if k != "name"},
                "workers": [
                    {"slug": w.get("slug"), "sid": w.get("sid"), "relation": w.get("relation") or "owned", "model": w.get("model"), "effort": w.get("effort"), **live(w.get("sid")), "brief": latest.get(w.get("sid") or "")}
                    for w in c["workers"]
                ],
            }
        )
    waiting = []
    for i in pending():
        d = i["decision"]
        waiting.append({**i, "coordinatorName": _coord_name(d["coordinator"]), "to": _target(d, i["sessions"])})
    # With nothing to decide the panel still says something: who waits on
    # the person across the floor, and the briefs written lately.
    calls = [
        {"sid": p["id"], "name": p.get("name") or p["id"][:8], "window": p.get("window"), "pane": p.get("pane"), "cwd": p.get("cwd"), "attention": p.get("attention"), "doing": p.get("doing"), "boss": (p.get("boss") or {}).get("name"), "slug": (p.get("boss") or {}).get("slug")}
        for p in people
        if p.get("attention") in ("ask", "alert")
    ]
    names = {p["id"]: p.get("name") or p["id"][:8] for p in people}
    recent = []
    for b in sorted(briefs(), key=lambda b: _mtime(b["path"]), reverse=True)[:RECENT]:
        recent.append({"file": b["file"], "path": b["path"], "title": title(b["file"]), "at": _mtime(b["path"]), "by": next((names[s] for s in b["sessions"] if s in names), None), "pending": bool(_open(b["questions"]))})
    return {"at": time.time(), "pending": waiting, "coordinators": coords, "calls": calls, "recent": recent}


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


def message(file: str, qs: list[dict]) -> str:
    """The one prompt for whoever asked, once every question is answered:
    `[brief answer] <file>: <label> — <note>` as before for one question; for
    several, each q-id and choice on that line and each question under it. A
    free answer is `직접 답 — <the words>`, so the words always arrive."""
    if len(qs) == 1:
        return f"[brief answer] {file}: {_said(qs[0]['answer'])}"
    head = " · ".join(f"{q['id']} {q['answer'].get('choice')}" for q in qs)
    return f"[brief answer] {file}: {head}\n" + "\n".join(f"- {q['id']} {q['question']} → {_said(q['answer'])}" for q in qs)


def answer(file: str, qid: str, label: str, note: str, inbox_put, text: str = "") -> tuple[int, dict]:
    """Record the person's answer to one question on the brief: one of its
    options (`label`, with `note`) or their own words (`text`). When it was
    the brief's last open question, tell whoever asked every answer at once."""
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
    qs = _decisions(_read_side(file, fresh=True))
    _pending["at"] = 0.0
    said = f"{FREE}: {text}" if text else label
    left = _open(qs)
    if left:
        return 200, {"ok": True, "sent": f"{qid} {said} 기록 · 남은 질문 {len(left)}", "via": via, "left": len(left)}
    to = _target(qs[0], [str(s.get("id")) for s in side.get("sessions") or [] if isinstance(s, dict) and s.get("id")])
    if not to:
        return 200, {"ok": True, "sent": "기록만 했습니다 (전할 세션 없음)", "via": via, "left": 0}
    inbox_put(to, message(file, qs))
    who = "coordinator" if to == qs[0]["coordinator"] else "worker"
    return 200, {"ok": True, "sent": f"{said} → {_coord_name(to) or who}" if len(qs) == 1 else f"답 {len(qs)}개 → {_coord_name(to) or who}", "via": via, "to": to, "left": 0}


def say(coord_sid: str, slug: str, text: str, inbox_put) -> tuple[int, dict]:
    """An instruction for a worker, given to its coordinator (which relays it
    with coord_send), or with no slug one for the coordinator itself (start a
    worker, report, stop). The office writes to the coordinator only: talking
    to a worker directly is the office floor's card."""
    text = (text or "").strip()
    if not text or len(text) > 4000:
        return 400, {"error": "empty or too long"}
    led = next((d for d in coord.ledgers() if d["sid"] == coord_sid), None)
    if not led or not SID.match(coord_sid):
        return 404, {"error": "no such coordinator"}
    name = led.get("name") or coord_sid[:8]
    if not slug:
        inbox_put(coord_sid, f"[office→coord] {text}")
        return 200, {"ok": True, "sent": f"지시 → {name}"}
    if not any(w.get("slug") == slug and not w.get("endedAt") for w in led.get("workers") or []):
        return 404, {"error": "no such worker under it"}
    inbox_put(coord_sid, f"[office→coord] {slug}: {text}")
    return 200, {"ok": True, "sent": f"{slug} 지시 → {name}"}


def act(body: dict, inbox_put) -> tuple[int, dict]:
    kind = body.get("kind")
    if kind == "brief_answer":
        return answer(str(body.get("file") or ""), str(body.get("qid") or ""), str(body.get("label") or ""), str(body.get("note") or ""), inbox_put, str(body.get("text") or ""))
    if kind == "coord_say":
        return say(str(body.get("coord") or ""), str(body.get("slug") or ""), str(body.get("value") or ""), inbox_put)
    return 400, {"error": "unknown action"}


if __name__ == "__main__":
    if sys.argv[1:] == ["pending"]:
        print(json.dumps([{"file": i["file"], "title": i["title"], "qid": q["id"], "decision": q, "coordinatorName": _coord_name(q["coordinator"])} for i in pending() for q in _open(i["questions"])], ensure_ascii=False))
    else:
        sys.exit("usage: command.py pending")
