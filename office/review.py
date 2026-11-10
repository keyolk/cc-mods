"""The coordinators' review queues, as the command view (지휘) shows them.

Each coordinator keeps finished work the person should judge in
~/.claude/state/office/coord/review/<coordinator sid>.json (written by its
coord_review tool, hooks/lib/coordreview.ts):

  {"sid", "name", "items": [{"id", "title", "changed", "verified", "check", "risk",
    "links": [], "state": "open"|"confirmed", "at", "updatedAt" (ms),
    "confirmedAt"?, "issues"?: [{"text", "at"}]}]}

The view lists the open items under 🔎 검토. The person's 확인함 marks one
confirmed here (it leaves the list and stays in the file as history for a
week) and tells its coordinator `[review] confirmed <id>`; 문제 있음 keeps it
open, notes the words on it and tells the coordinator `[review] issue <id>:
<words>`, a task for it.

Run as a script, `review.py seed <coordinator sid> <items.json|->` adds the
items of a JSON list (the item fields above, state open) to that
coordinator's queue, an item already there by id updated: a one-off brief's
items moved into the queue once.
"""

import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import coord  # noqa: E402 - office/coord.py, the coordinators' ledgers

KINDS = ("review_confirm", "review_issue")
SID = re.compile(r"^[0-9a-f-]{8,64}$")
ID = re.compile(r"^[\w.#-]{1,60}$")
KEEP_MS = 7 * 24 * 3600 * 1000
FIELDS = ("title", "changed", "verified", "check", "risk")


def folder() -> str:
    # Not coord/*.json: that glob is the ledgers (coord.ledgers).
    return os.path.join(coord.COORD_DIR, "review")


def _path(sid: str) -> str:
    return os.path.join(folder(), sid + ".json")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _read(sid: str) -> dict | None:
    """The queue file, None when it is missing or half written (the
    coordinator writes it in place; the next poll reads it whole)."""
    try:
        with open(_path(sid)) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and isinstance(d.get("items"), list) else None


def _write(sid: str, d: dict) -> None:
    now = _now_ms()
    d["items"] = [i for i in d["items"] if not isinstance(i, dict) or i.get("state") != "confirmed" or now - int(i.get("confirmedAt") or i.get("updatedAt") or 0) < KEEP_MS]
    os.makedirs(folder(), exist_ok=True)
    tmp = _path(sid) + ".tmp"
    with open(tmp, "w") as f:
        f.write(json.dumps(d, ensure_ascii=False, indent=1) + "\n")
    os.replace(tmp, _path(sid))


def _text(x, n: int = 2000) -> str:
    return x.strip()[:n] if isinstance(x, str) else ""


def _links(x) -> list[str]:
    seen: list[str] = []
    for l in x if isinstance(x, list) else []:
        t = _text(l, 500)
        if t and t not in seen:
            seen.append(t)
    return seen[:12]


def items() -> list[dict]:
    """Every coordinator's open items, the longest waiting first, each with
    the coordinator it goes back to."""
    names = {d["sid"]: d.get("name") or d["sid"][:8] for d in coord.ledgers()}
    out = []
    try:
        files = sorted(os.listdir(folder()))
    except OSError:
        return []
    for fn in files:
        sid = fn[: -len(".json")]
        if not fn.endswith(".json") or not SID.match(sid):
            continue
        d = _read(sid)
        if not d:
            continue
        for i in d["items"]:
            if not isinstance(i, dict) or i.get("state") == "confirmed" or not ID.match(str(i.get("id") or "")):
                continue
            issues = [x for x in i.get("issues") or [] if isinstance(x, dict) and isinstance(x.get("text"), str)]
            out.append(
                {
                    "coord": sid,
                    "coordName": names.get(sid) or d.get("name") or sid[:8],
                    "id": i["id"],
                    "title": _text(i.get("title"), 200) or i["id"],
                    **{k: _text(i.get(k)) for k in FIELDS[1:]},
                    "links": _links(i.get("links")),
                    "at": i.get("at"),
                    "updatedAt": i.get("updatedAt"),
                    "issues": issues[-5:],
                }
            )
    out.sort(key=lambda x: (int(x.get("at") or 0), x["id"]))
    return out


def _item(sid: str, rid: str) -> tuple[dict | None, dict | None, tuple[int, dict] | None]:
    if not SID.match(sid or "") or not ID.match(rid or ""):
        return None, None, (400, {"error": "bad coordinator or item id"})
    d = _read(sid)
    if d is None:
        return None, None, (404, {"error": "no review queue for that coordinator"})
    it = next((i for i in d["items"] if isinstance(i, dict) and i.get("id") == rid), None)
    if not it:
        return None, None, (404, {"error": "no such item"})
    return d, it, None


def confirm(sid: str, rid: str, inbox_put) -> tuple[int, dict]:
    """The person looked at it: confirmed (off the list, kept as history),
    and its coordinator hears so."""
    d, it, err = _item(sid, rid)
    if err:
        return err
    if it.get("state") == "confirmed":
        return 409, {"error": "already confirmed"}
    now = _now_ms()
    it.update(state="confirmed", confirmedAt=now, updatedAt=now)
    _write(sid, d)
    inbox_put(sid, f"[review] confirmed {rid}")
    return 200, {"ok": True, "sent": f"확인함 {rid} → {d.get('name') or sid[:8]}", "left": sum(1 for i in d["items"] if isinstance(i, dict) and i.get("state") != "confirmed")}


def issue(sid: str, rid: str, text: str, inbox_put) -> tuple[int, dict]:
    """A problem the person found, in their words: noted on the item, which
    stays open, and sent to its coordinator as a task."""
    text = (text or "").strip()
    if not text or len(text) > 4000:
        return 400, {"error": "empty or too long"}
    d, it, err = _item(sid, rid)
    if err:
        return err
    it["issues"] = [*(it.get("issues") or []), {"text": text, "at": _now_ms()}][-20:]
    # A confirmed item the person finds wrong after all is open again.
    it.update(state="open", updatedAt=_now_ms())
    it.pop("confirmedAt", None)
    _write(sid, d)
    inbox_put(sid, f"[review] issue {rid}: {text}")
    return 200, {"ok": True, "sent": f"문제 {rid} → {d.get('name') or sid[:8]}"}


def act(body: dict, inbox_put) -> tuple[int, dict]:
    kind, sid, rid = body.get("kind"), str(body.get("coord") or ""), str(body.get("id") or "")
    if kind == "review_confirm":
        return confirm(sid, rid, inbox_put)
    if kind == "review_issue":
        return issue(sid, rid, str(body.get("value") or ""), inbox_put)
    return 400, {"error": "unknown action"}


def seed(sid: str, rows: list) -> int:
    """Add (or, by id, update) these items in a coordinator's queue, open."""
    if not SID.match(sid):
        raise ValueError("not a session id: " + sid)
    d = _read(sid) or {"sid": sid, "name": next((x.get("name") for x in coord.ledgers() if x["sid"] == sid), None) or sid[:8], "items": []}
    now, n = _now_ms(), 0
    for r in rows:
        rid = str(r.get("id") or "") if isinstance(r, dict) else ""
        if not ID.match(rid) or not _text(r.get("title")):
            raise ValueError(f"item needs an id ({ID.pattern}) and a title: {r!r}"[:300])
        old = next((i for i in d["items"] if isinstance(i, dict) and i.get("id") == rid), None)
        # A ms apart: the list shows them in the order given.
        it = old if old is not None else {"id": rid, "at": now + n, "links": []}
        it.update({k: _text(r.get(k), 200 if k == "title" else 2000) for k in FIELDS if _text(r.get(k))})
        it.update(links=_links([*(it.get("links") or []), *(r.get("links") or [])]), state="open", updatedAt=now)
        it.pop("confirmedAt", None)
        if old is None:
            d["items"].append(it)
        n += 1
    _write(sid, d)
    return n


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "seed":
        src = sys.stdin if sys.argv[3] == "-" else open(sys.argv[3])
        rows = json.load(src)
        if not isinstance(rows, list):
            sys.exit("seed: a JSON list of items")
        n = seed(sys.argv[2], rows)
        print(f"{n} items → {_path(sys.argv[2])} (open: {sum(1 for i in items() if i['coord'] == sys.argv[2])})")
    else:
        sys.exit("usage: review.py seed <coordinator sid> <items.json|->")
