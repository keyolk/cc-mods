"""Shared resources: what every session in the office draws on (model accounts,
their quotas, proxies), gathered from whatever harness is in use today.

The harness changes: ccproxy now, cco or plain Claude Code later. So the office
never reads a tool's output directly. A *source* is a command and a function
that turns its output into the one shape below; the page draws only that shape.
Adding a harness is adding a source, nothing else.

    {"source": "ccproxy", "label": "ccproxy", "ok": true, "at": 1792815832,
     "accounts": [{"id": "claude-sendbird", "provider": "anthropic",
                   "state": "ok|soon|cooldown|expired|off|unknown",
                   "gauges": [{"name": "5h", "left_pct": 71, "reset_at": ...}],
                   "note": "...", "stale": true, "until": ...}]}

Sources only read local or offline state: one office server serves every
browser, and a degraded network must not turn this into a fan-out of upstream
calls (NET_DEGRADED_LOAD_INVESTIGATION). Results are cached for TTL seconds,
and a failed read keeps the last good one, marked stale.

Which sources run comes from ~/.config/cc-mods/office.json:

    {"resources": ["ccproxy", "cco"]}

Without that file every known source is tried and the ones whose command is
missing are left out.
"""

import json
import os
import shutil
import subprocess
import threading
import time

TTL = 60
TIMEOUT = 8
CONFIG = os.path.expanduser("~/.config/cc-mods/office.json")


def _pct(w) -> dict | None:
    if not isinstance(w, dict) or not isinstance(w.get("left_pct"), (int, float)):
        return None
    g = {"left_pct": round(w["left_pct"])}
    if isinstance(w.get("reset_at"), (int, float)):
        g["reset_at"] = w["reset_at"]
    return g


def ccproxy_accounts(text: str) -> list[dict]:
    """`ccproxy status --offline --json`: one account per upstream login."""
    raw = json.loads(text)
    out = []
    for a in raw.get("accounts") or []:
        b = a.get("budget") or {}
        gauges = []
        if b.get("kind") == "windows":
            for name, key in (("5h", "five_hour"), ("7d", "seven_day")):
                g = _pct(b.get(key))
                if g:
                    gauges.append({"name": name, **g})
        elif b.get("kind") == "pool":
            g = _pct(b.get("pool"))
            if g:
                gauges.append({"name": b.get("pool_name") or "pool", **g})
        elif b.get("kind") == "requests" and b.get("requests_limit"):
            gauges.append({"name": "req", "left_pct": round(100 * (b.get("requests_remaining") or 0) / b["requests_limit"])})
        st = a.get("state")
        # Same buckets as the Auth tab (hooks/lib/auth.ts ccproxyItems), plus
        # cooldown kept apart from "soon": it has an end the page counts down.
        state = {"ready": "ok", "cooldown": "cooldown", "expired": "expired", "auth-failed": "expired", "disabled": "off"}.get(st, "unknown")
        if state == "ok" and any(g["left_pct"] <= 10 for g in gauges):
            state = "soon"
        note = {"spend_cap": "spend cap hit" if b.get("capped") else "spend cap", "none": b.get("reason") or ""}.get(b.get("kind"), "")
        acc = {
            "id": a.get("name") or "?",
            "provider": a.get("provider") or "",
            "state": state,
            "gauges": gauges,
            "note": a.get("cooldown") or note,
            "stale": bool(a.get("stale_quota")),
        }
        if a.get("cooldown_until"):
            acc["until"] = a["cooldown_until"]
        if a.get("expires_at"):
            acc["expires_at"] = a["expires_at"]
        out.append(acc)
    return out


def cco_accounts(text: str) -> list[dict]:
    """`cco status --once --json`: no per-account quota yet, only whether each
    provider is reachable. Shown as plain lamps until cco reports more."""
    raw = json.loads(text)
    hz = raw.get("healthz") or {}
    out = []
    for name in ("anthropic", "codex"):
        h = hz.get(name)
        if not isinstance(h, dict):
            continue
        if name == "anthropic" and not h.get("configured", True):
            continue
        cd = h.get("cooldown_remaining_seconds")
        state = "cooldown" if cd else "ok" if h.get("available", True) else "unknown"
        acc = {"id": name, "provider": name, "state": state, "gauges": [], "note": "", "stale": False}
        if cd:
            acc["until"] = time.time() + cd
        out.append(acc)
    return out


# name -> (label, argv, parser). Order is the order they are drawn in.
SOURCES = {
    "ccproxy": ("ccproxy", ["ccproxy", "status", "--offline", "--json"], ccproxy_accounts),
    "cco": ("cco", ["cco", "status", "--once", "--json"], cco_accounts),
}

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "items": [], "busy": False}


def enabled() -> list[str]:
    try:
        with open(CONFIG) as f:
            names = json.load(f).get("resources")
        if isinstance(names, list):
            return [n for n in names if n in SOURCES]
    except (OSError, ValueError):
        pass
    return [n for n, (_, argv, _) in SOURCES.items() if shutil.which(argv[0])]


def read(name: str, prev: dict | None, run=subprocess.run) -> dict:
    label, argv, parse = SOURCES[name]
    try:
        r = run(argv, capture_output=True, text=True, timeout=TIMEOUT)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or "exit " + str(r.returncode)).strip().splitlines()[-1][:120])
        return {"source": name, "label": label, "ok": True, "at": time.time(), "accounts": parse(r.stdout)}
    except Exception as e:  # noqa: BLE001 - any failure is shown, never raised
        # Keep what was last seen, marked stale, rather than an empty wall.
        if prev and prev.get("accounts"):
            return {**prev, "ok": False, "error": str(e)[:120], "accounts": [{**a, "stale": True} for a in prev["accounts"]]}
        return {"source": name, "label": label, "ok": False, "error": str(e)[:120], "at": time.time(), "accounts": []}


def refresh(run=subprocess.run) -> list[dict]:
    prev = {i["source"]: i for i in _cache["items"]}
    items = [read(n, prev.get(n), run) for n in enabled()]
    with _lock:
        _cache.update(items=items, at=time.time(), busy=False)
    return items


def snapshot(now: float | None = None, run=subprocess.run) -> list[dict]:
    """The last reading, at once; a stale one starts a refresh in the
    background. /state is polled every second or two, so it never waits on a
    source, and however many browsers ask, a source runs at most once a TTL."""
    now = time.time() if now is None else now
    with _lock:
        due = now - _cache["at"] >= TTL and not _cache["busy"]
        if due:
            _cache["busy"] = True
    if due:
        threading.Thread(target=refresh, args=(run,), daemon=True).start()
    return _cache["items"]
