"""Relay a worker's login wait from the office: a 2FA code, a button, a device.

A worker that waits on a login in its tweb pane declares it with its status
tool (hooks/lib/status.ts): blocked, kind auth, and pane (%N), ask
(otp|click|device), target (a CSS selector) and, for otp, submit. Before this
the person went to that pane to type the code or press Confirm; now the
office's 내 차례 row does it:

- look: a screenshot of the pane, taken only when the person asks for it,
  sent to the page as base64 and never written to a file;
- otp: the code the person typed goes to the pane's input and is sent;
- click: the button is pressed, only after the person looked at the pane;
- device: nothing to relay (a passkey, a fingerprint): the office only says
  to approve it on the device, and tells the worker when the person says so.

The code. It comes in the POST body (token and local Host, office.py) and
goes to `tweb fill <ref> --stdin`: not argv (`ps`), not a file, not the
command's output (--stdin never prints it back; tweb's MCP fill does, so it
is not used). It is never logged, never put in a reply, and never sent to the
worker: the worker hears only that the person answered, so its transcript
never holds it. Nothing keeps it after the call.

Which sites. A code or a press goes only to a page whose host the person
approved: ~/.config/cc-mods/office.json "relay": {"hosts": [...]}, else
DEFAULT_HOSTS. The worker cannot widen it (its status names the pane, not
the site): a pane that went to another host, by a redirect or a worker's
navigate, gets nothing, and the row says which host it is on.

Where it goes is read from the worker's status file, never from the request,
and only while that pane shows the target: `tweb query` fails on an element
that is missing or hidden, so a page that moved on (a new screen, a redirect)
gets nothing. A press needs the look the person saw: `look` returns a nonce
bound to the pane and its URL, and `click` spends it only while the pane is
on that URL.
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time

STATUS_DIR = os.path.expanduser("~/.claude/state/office/status")
CONFIG = os.path.expanduser("~/.config/cc-mods/office.json")
# The sites a code or a press may go to when office.json names none: the
# login waits workers hit (GitHub sudo, Confirm access, an App's create).
DEFAULT_HOSTS = ("github.com",)
SID = re.compile(r"^[0-9a-f-]{8,64}$")
PANE = re.compile(r"^%\d+$")
ASKS = ("otp", "click", "device")
KINDS = ("relay_look", "relay_otp", "relay_click", "relay_device")
# A status older than this is not acted on (turn.py STATUS_STALE says the
# same for 내 차례): the worker may have moved on without declaring it.
STALE = 2 * 3600
# How long a look stays good for a press: the person looks, then presses.
LOOK_TTL = 180
# A code is digits or letters, a few of them (TOTP, SMS, a recovery code).
CODE = re.compile(r"^[0-9A-Za-z-]{4,16}$")

_looks: dict[str, dict] = {}  # nonce -> {sid, pane, url, at}
_lock = threading.Lock()
# One relay at a time per pane: a double press must not type a code twice.
_busy: dict[str, threading.Lock] = {}


def tweb_bin() -> str | None:
    for b in (os.environ.get("OFFICE_TWEB"), shutil.which("tweb"), os.path.expanduser("~/.local/bin/tweb")):
        if b and os.access(b, os.X_OK):
            return b
    return None


def wait_of(sid: str, now: float | None = None) -> dict | None:
    """The login wait the worker declared in its status file, or None: blocked,
    kind auth, a pane and an ask, declared in the last STALE seconds."""
    if not SID.match(sid or ""):
        return None
    try:
        with open(os.path.join(STATUS_DIR, sid + ".json")) as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(st, dict) or st.get("state") != "blocked" or st.get("kind") != "auth":
        return None
    pane, ask = str(st.get("pane") or ""), st.get("ask")
    if not PANE.match(pane) or ask not in ASKS or (ask != "device" and not st.get("target")):
        return None
    at = (st.get("at") or 0) / 1000
    if at and (now or time.time()) - at > STALE:
        return None
    return {"pane": pane, "ask": ask, "target": str(st.get("target") or ""), "submit": str(st.get("submit") or ""), "needs": str(st.get("needs") or ""), "at": at}


def hosts() -> tuple[str, ...]:
    """The hosts the person approved for a relay (office.json relay.hosts),
    lower case; a host covers its subdomains. Read on each call: an edit
    takes effect without a restart."""
    try:
        with open(CONFIG) as f:
            hs = ((json.load(f) or {}).get("relay") or {}).get("hosts")
    except (OSError, ValueError, AttributeError):
        hs = None
    if not isinstance(hs, list):
        return DEFAULT_HOSTS
    return tuple(h.strip().lower().lstrip(".") for h in hs if isinstance(h, str) and h.strip())


def host_of(url: str) -> str:
    """The page's host, '' for what has none (file:, data:, about:)."""
    m = re.match(r"^https://([^/:?#@]+)(?::\d+)?(?:[/?#]|$)", url or "", re.I)
    return m.group(1).lower() if m else ""


def approved(url: str) -> bool:
    """Whether a page is on a site the person approved: https, and its host
    one of hosts() or under one. http is never approved; a local file only
    when relay.hosts lists "file:" (the local test form, never a default)."""
    h = host_of(url)
    allowed = hosts()
    if not h:
        return "file:" in allowed and (url or "").startswith("file:///")
    return any(h == a or h.endswith("." + a) for a in allowed)


def _run(args: list[str], stdin: str | None = None, timeout: float = 8) -> tuple[int, str, str]:
    b = tweb_bin()
    if not b:
        return 127, "", "tweb is not installed"
    try:
        r = subprocess.run([b, *args], input=stdin, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, "", "tweb did not answer in time"
    except OSError as e:
        return 126, "", str(e)
    return r.returncode, r.stdout, r.stderr.strip()


def _err(text: str) -> str:
    """tweb's error line, without its banner noise, short."""
    lines = [l for l in text.splitlines() if l.strip() and not l.startswith("tweb: this pane's engine")]
    return (lines[-1] if lines else text)[:200]


def page(pane: str, office_port: int | None = None) -> dict | None:
    """The pane's active tab {url, title}, when tweb lists the pane; None
    when it is not a tweb pane. The office's own page is never a target."""
    code, out, _ = _run(["panes", "--json"], timeout=5)
    if code:
        return None
    try:
        panes = json.loads(out or "[]")
    except ValueError:
        return None
    for p in panes:
        if p.get("pane") != pane:
            continue
        tabs = ((p.get("status") or {}).get("tabs") or {})
        t = next((x for x in tabs.get("tabs") or [] if x.get("active")), None) or {}
        url = str(t.get("url") or "")
        if office_port and re.match(rf"^https?://(127\.0\.0\.1|localhost):{office_port}(/|$)", url):
            return None
        return {"url": url, "title": str(t.get("title") or "")}
    return None


def ref_of(pane: str, selector: str) -> tuple[str | None, str]:
    """The ref of the element the selector names, only while it is on the
    page and visible (tweb query refuses a hidden one), else (None, why)."""
    code, out, err = _run(["query", selector, "--pane", pane, "--json"])
    if code:
        return None, _err(err or out) or "not on the page"
    try:
        d = json.loads(out)
    except ValueError:
        return None, "tweb query gave no JSON"
    ref = (d.get("node") or d).get("ref") if isinstance(d, dict) else None
    return (str(ref), "") if ref else (None, "not on the page")


def off_site(url: str) -> str:
    h = host_of(url) or (url or "").split(":", 1)[0] + ":"
    return "the pane is on " + h + ", not a site approved for a relay (" + ", ".join(hosts()) + "; office.json relay.hosts)"


def _lock_for(pane: str) -> threading.Lock:
    with _lock:
        return _busy.setdefault(pane, threading.Lock())


def look(sid: str, w: dict, office_port: int | None) -> tuple[int, dict]:
    pg = page(w["pane"], office_port)
    if not pg:
        return 409, {"error": "pane " + w["pane"] + " is not a browser pane now"}
    code, out, err = _run(["screenshot", "--pane", w["pane"], "--json"], timeout=12)
    if code:
        return 502, {"error": "screenshot failed: " + _err(err or out)}
    try:
        png = json.loads(out).get("png") or ""
        base64.b64decode(png[:64] + "==", validate=False)
    except (ValueError, AttributeError):
        return 502, {"error": "screenshot gave no image"}
    seen = ""
    if w["target"]:
        ref, why = ref_of(w["pane"], w["target"])
        seen = "" if ref else why
    nonce = secrets.token_urlsafe(12)
    with _lock:
        now = time.time()
        for k in [k for k, v in _looks.items() if now - v["at"] > LOOK_TTL]:
            _looks.pop(k, None)
        _looks[nonce] = {"sid": sid, "pane": w["pane"], "url": pg["url"], "at": now}
    ok = approved(pg["url"])
    return 200, {"ok": True, "png": png, "url": pg["url"], "title": pg["title"], "ask": w["ask"], "target": w["target"], "visible": not seen, "why": seen, "look": nonce, "host": host_of(pg["url"]), "approved": ok, **({} if ok else {"refused": off_site(pg["url"])})}


def otp(sid: str, w: dict, value, office_port: int | None, tell) -> tuple[int, dict]:
    if w["ask"] != "otp":
        return 409, {"error": "this wait does not ask for a code"}
    code = str(value or "").strip()
    if not CODE.match(code):
        return 400, {"error": "a code is 4 to 16 letters or digits"}
    pg = page(w["pane"], office_port)
    if not pg:
        return 409, {"error": "pane " + w["pane"] + " is not a browser pane now"}
    if not approved(pg["url"]):
        return 409, {"error": off_site(pg["url"]), "host": host_of(pg["url"])}
    lk = _lock_for(w["pane"])
    if not lk.acquire(blocking=False):
        return 409, {"error": "a relay to this pane is running"}
    try:
        ref, why = ref_of(w["pane"], w["target"])
        if not ref:
            return 409, {"error": "the code input is not on its screen now (" + why + ")"}
        # The page may have moved between the check and the fill: look again.
        pg2 = page(w["pane"], office_port)
        if not pg2 or pg2["url"] != pg["url"]:
            return 409, {"error": "the pane moved to another page: look again"}
        rc, out, err = _run(["fill", ref, "--stdin", "--pane", w["pane"], "--json"], stdin=code)
        if rc:
            return 502, {"error": "fill failed: " + _err(err or out)}
        if w["submit"]:
            sref, why = ref_of(w["pane"], w["submit"])
            if not sref:
                return 409, {"error": "the code is in, but its send button is not on the screen (" + why + "): press it in the pane"}
            rc, out, err = _run(["click", sref, "--pane", w["pane"], "--json"])
        else:
            rc, out, err = _run(["press", "Enter", "--pane", w["pane"], "--json"])
        if rc:
            return 502, {"error": "the code is in, but sending it failed: " + _err(err or out)}
    finally:
        lk.release()
    tell(sid, "[office] The person typed the 2FA code into pane " + w["pane"] + " from the office and sent it (the code is not passed on). Look at the pane and go on; declare your status again.")
    return 200, {"ok": True, "sent": "code sent"}


def click(sid: str, w: dict, nonce, office_port: int | None, tell) -> tuple[int, dict]:
    if w["ask"] != "click":
        return 409, {"error": "this wait does not ask for a press"}
    with _lock:
        seen = _looks.pop(str(nonce or ""), None)
    if not seen or seen["sid"] != sid or seen["pane"] != w["pane"] or time.time() - seen["at"] > LOOK_TTL:
        return 409, {"error": "look at the pane first (🖼), then press", "relook": True}
    pg = page(w["pane"], office_port)
    if not pg or pg["url"] != seen["url"]:
        return 409, {"error": "the pane moved to another page since you looked: look again", "relook": True}
    if not approved(pg["url"]):
        return 409, {"error": off_site(pg["url"]), "host": host_of(pg["url"])}
    lk = _lock_for(w["pane"])
    if not lk.acquire(blocking=False):
        return 409, {"error": "a relay to this pane is running"}
    try:
        ref, why = ref_of(w["pane"], w["target"])
        if not ref:
            return 409, {"error": "the button is not on its screen now (" + why + ")"}
        rc, out, err = _run(["click", ref, "--pane", w["pane"], "--json"])
        if rc:
            return 502, {"error": "click failed: " + _err(err or out)}
    finally:
        lk.release()
    tell(sid, "[office] The person pressed " + w["target"] + " in pane " + w["pane"] + " from the office. Look at the pane and go on; declare your status again.")
    return 200, {"ok": True, "sent": "pressed"}


def act(body: dict, tell, office_port: int | None = None) -> tuple[int, dict]:
    """POST /act for KINDS. `tell(sid, text)`: the worker's inbox (office.py
    inbox_put), which never carries the code."""
    sid, kind = str(body.get("sid") or ""), body.get("kind")
    w = wait_of(sid)
    if not w:
        return 409, {"error": "this session does not wait on a login it declared"}
    if kind == "relay_look":
        if w["ask"] == "device":
            return 409, {"error": "a device wait has nothing to look at"}
        return look(sid, w, office_port)
    if kind == "relay_otp":
        return otp(sid, w, body.get("value"), office_port, tell)
    if kind == "relay_click":
        return click(sid, w, body.get("look"), office_port, tell)
    if kind == "relay_device":
        if w["ask"] != "device":
            return 409, {"error": "this wait is not on a device"}
        tell(sid, "[office] The person says they approved the login on their device (pane " + w["pane"] + "). Look at the pane and go on; declare your status again.")
        return 200, {"ok": True, "sent": "told the worker"}
    return 400, {"error": "unknown relay kind"}
