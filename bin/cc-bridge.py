#!/usr/bin/env python3
"""JSON bridge from the cc-mods mod to the judgment code in ~/.claude/hooks.

The mod handles events and drawing; deciding things (is this turn waiting on
the user, is a prompt a separate line of work, who are my neighbors) stays in
the Python modules that already have tests and measured thresholds. Each
subcommand reads JSON on stdin and prints one JSON object.

    attention  {"message": str, "proceed"?: bool} -> {"attention": "ask|action|none", "proceed"?: bool}
    fork       {"prompt": str, "recent": [str], "answer": str} -> {"p": float|null}
    neighbors  {"pane": str, "cwd": str}       -> {"neighbors": [{window,state,title}]}
    route      {"prompt": str, "recent": [str]} -> {"effort": str|null, "confidence": float}
    goal       {"transcript": str}               -> {"goal": {condition, active, met, setAt, checks, lastAt, reason, ended, endedAt}|null}
    jev_usage  {"now": float, "session"?: str}  -> {"today", "week", "session"?, "hours": [24], "callers", "kinds", "gateway"}
    policy     {"answer": str, "blocks": [str], "caps": {cap: value}} -> {"grant": {argv, label, minutes, why}|null, "confidence": float}

Failure is always an answer, never a traceback: the mod treats a missing
value as "undecided" and keeps its default behaviour.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

HOOKS = Path.home() / ".claude" / "hooks"
sys.path.insert(0, str(HOOKS))


def attention(req: dict) -> dict:
    try:
        import turn_question
        if req.get("proceed"):
            got = _proceed(turn_question, str(req.get("message") or ""))
            if got is not None:
                return got
        return {"attention": turn_question.classify_attention(req.get("message"))}
    except Exception as exc:  # degrade to "none" rather than mark a window wrongly
        return {"attention": "none", "error": str(exc)}


# auto_continue: the same one Jev call that sorts ask/action/none, with a fourth
# option for "it only asks whether to go on". Judged by Jev rather than by
# matching phrases: "고칠까요?" and "머지할까요?" read the same to a regex.
PROCEED = "proceed"
PROCEED_CRITERIA_TEXT = (
    "the assistant ends by asking only whether to go on with a next step it already "
    "named: a plain yes/no such as 'shall I continue?' or 'if you want, I will do X'. "
    "No options to pick between, no information it needs from the user, and the step "
    "stays on this machine and can be undone (editing files, running tests, building, "
    "reading, a local experiment). NOT this when the step merges or approves, pushes, "
    "sends or posts a message, deploys, deletes data, restarts a shared service, spends "
    "money, or touches production"
)
PROCEED_MIN = 0.6
ASK_NARROW = (
    "the assistant needs the user's own answer before it can continue: a choice between "
    "options, information or a preference only the user has, or approval for a step that "
    "merges, pushes, sends, deploys, deletes, restarts a shared service, spends money or "
    "touches production"
)


def _proceed(tq, message: str) -> dict | None:
    if not message.strip():
        return None
    try:
        import jev
    except Exception:
        return None
    # turn_question's ASK ("asked a question … waiting for a typed answer") also
    # covers a plain "shall I?", so Jev split the two near evenly; here ASK is
    # narrowed to what only the person can answer.
    criteria = {PROCEED: PROCEED_CRITERIA_TEXT, **tq.CRITERIA, tq.ASK: ASK_NARROW}
    got = jev.choose(message[-3000:], "attention", criteria)
    if got is None:
        return None
    pick, conf = got
    if pick == PROCEED:
        # Not sure enough to answer for the person: it is still a question.
        return {"attention": tq.ASK, "proceed": conf >= PROCEED_MIN, "confidence": conf}
    return {"attention": pick, "proceed": False, "confidence": conf}


def fork(req: dict) -> dict:
    try:
        import flow_fork_hint as ffh
        import jev
    except Exception as exc:
        return {"p": None, "error": str(exc)}
    recent = [str(p)[:300] for p in req.get("recent", [])][-ffh.RECENT_PROMPTS:]
    prompt = str(req.get("prompt", ""))
    if len(prompt) < ffh.MIN_CHARS or not recent:
        return {"p": None}
    state = ("RECENT requests:\n" + "\n".join(f"- {p}" for p in recent)
             + f"\n\nEnd of last answer:\n{str(req.get('answer', ''))[-ffh.ANSWER_TAIL:]}"
             + f"\n\nNEW:\n{prompt[:600]}")
    p = jev.ask(state, "isSeparate", ffh.QUESTION, timeout=2.5)
    return {"p": p, "threshold": ffh.THRESHOLD}


# How hard the next turn needs the model to think. Described by the work, not
# by length: a short "why is prod down" is xhigh, a long paste to reformat is low.
ROUTE_CRITERIA = {
    "low": "A lookup, a status check, a yes/no, running one known command, a trivial or "
           "mechanical edit, reformatting, or continuing an obvious next step.",
    "medium": "A routine change in one place, explaining code or output that is in front of "
              "it, writing a short message or doc from known facts.",
    "high": "Multi-step work: debugging with a known symptom, a change across several files, "
            "a design choice between options, reviewing code for bugs.",
    "xhigh": "Hard reasoning with an unclear cause or high stakes: a production incident, a "
             "subtle concurrency or data-loss bug, an architecture decision, or a claim that "
             "must be verified against evidence.",
}


def route(req: dict) -> dict:
    try:
        import jev
    except Exception as exc:
        return {"effort": None, "confidence": 0.0, "error": str(exc)}
    prompt = str(req.get("prompt", ""))[:1500]
    if not prompt.strip():
        return {"effort": None, "confidence": 0.0}
    recent = [str(p)[:200] for p in req.get("recent", [])][-3:]
    state = (("Earlier requests in this session:\n" + "\n".join(f"- {p}" for p in recent) + "\n\n")
             if recent else "") + f"NEW request to a coding agent:\n{prompt}"
    got = jev.choose(state, "effort", ROUTE_CRITERIA, timeout=1.4)
    if got is None:
        return {"effort": None, "confidence": 0.0}
    return {"effort": got[0], "confidence": got[1]}


def neighbors(req: dict) -> dict:
    try:
        import tmux_neighbors as tn
    except Exception as exc:
        return {"neighbors": [], "error": str(exc)}
    pane = req.get("pane") or ""
    root = tn.git_root(req.get("cwd") or "")
    if not pane or not root or root == os.path.normpath(os.path.expanduser("~")):
        return {"neighbors": []}
    out = []
    for line in tn.collect(pane, root, int(time.time())):
        # "- @12 name (pane %3) — working 5m · title"
        body = line[2:]
        head, _, rest = body.partition(" — ")
        state, _, title = rest.partition(" · ")
        window = head.split(" (pane")[0].split(" ", 1)[-1]
        out.append({"window": window, "state": state, "title": title})
    return {"neighbors": out}


JEV_LOG = Path.home() / ".claude" / "state" / "jev-usage.jsonl"
JEV_GATEWAY_CACHE = Path.home() / ".claude" / "state" / "jev-gateway-report.json"
GATEWAY_CACHE_S = 3600


def _jev_gateway(now: float) -> dict | None:
    """The team-wide Jev line of the AI Gateway's 7-day report, cached an hour.

    The report covers everyone on the gateway key and lags by hours, so the
    cockpit shows it beside, never instead of, what these hooks recorded.
    """
    try:
        cached = json.loads(JEV_GATEWAY_CACHE.read_text())
        if now - cached.get("at", 0) < GATEWAY_CACHE_S:
            return cached.get("value")
    except (OSError, ValueError):
        pass
    try:
        import urllib.request
        import jev  # key and the mesh TLS context, as the hooks use them

        jev.ask("warm", "q", "is this the word warm?", timeout=3)
        start = time.strftime("%Y-%m-%d", time.gmtime(now - 7 * 86400))
        end = time.strftime("%Y-%m-%d", time.gmtime(now))
        req = urllib.request.Request(
            f"https://ai-gateway.vercel.sh/v1/report?start_date={start}&end_date={end}&group_by=model",
            headers={"Authorization": f"Bearer {jev._api_key}"},
        )
        with urllib.request.urlopen(req, timeout=10, context=jev._ssl_context) as r:
            rows = json.loads(r.read()).get("results") or []
        row = next((x for x in rows if x.get("model") == jev.MODEL), None)
        value = {"requests": row.get("request_count", 0), "cost": float(row.get("total_cost") or 0), "since": start} if row else None
        JEV_GATEWAY_CACHE.write_text(json.dumps({"at": now, "value": value}))
        return value
    except Exception:
        return None


def _pct(xs: list[int], q: float) -> int:
    if not xs:
        return 0
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def jev_usage(req: dict) -> dict:
    """Sums ~/.claude/state/jev-usage.jsonl (one line per Jev call, jev.py).

    today/week totals, the last 24 hours by hour, each hook (caller) and each
    call kind (ask: one yes/no, choose: one of several) with latency, and this
    session's share when the request names it (lines carry `sid` since jev.py
    started recording it; older lines count only in the totals).
    """
    now = float(req.get("now") or time.time())
    sid = str(req.get("session") or "")
    day0 = now - (now - time.timezone) % 86400  # local midnight
    week0 = now - 7 * 86400
    hour0 = now - now % 3600 - 23 * 3600  # 24 whole-hour buckets, the last holds now

    def tally() -> dict:
        return {"calls": 0, "cost": 0.0, "in": 0}

    today, week, session = tally(), tally(), tally()
    session_ms: list[int] = []
    hours = [{"start": int(hour0 + i * 3600), "calls": 0, "cost": 0.0, "ms": 0} for i in range(24)]
    callers: dict[str, dict] = {}
    kinds: dict[str, dict] = {}
    try:
        with JEV_LOG.open(encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                ts = float(r.get("ts") or 0)
                if ts < week0:
                    continue
                cost = float(r.get("cost") or 0)
                tokens = int(r.get("in") or 0)
                ms = int(r.get("ms") or 0)
                mine = bool(sid) and r.get("sid") == sid
                for bucket, on in ((week, True), (today, ts >= day0), (session, mine)):
                    if on:
                        bucket["calls"] += 1
                        bucket["cost"] += cost
                        bucket["in"] += tokens
                if mine:
                    session_ms.append(ms)
                if ts >= hour0:
                    h = hours[min(23, int((ts - hour0) // 3600))]
                    h["calls"] += 1
                    h["cost"] += cost
                    h["ms"] += ms
                name = str(r.get("caller") or "?")
                kind = str(r.get("kind") or "?")
                c = callers.setdefault(name, {"name": name, "calls": 0, "cost": 0.0, "ms": [], "kinds": {}, "today": 0})
                c["calls"] += 1
                c["cost"] += cost
                c["ms"].append(ms)
                c["kinds"][kind] = c["kinds"].get(kind, 0) + 1
                c["today"] += ts >= day0
                k = kinds.setdefault(kind, {"name": kind, "calls": 0, "cost": 0.0, "ms": []})
                k["calls"] += 1
                k["cost"] += cost
                k["ms"].append(ms)
    except OSError:
        pass

    def latency(g: dict) -> dict:
        xs = g.pop("ms")
        g["p50"], g["p95"] = _pct(xs, 0.5), _pct(xs, 0.95)
        return g

    ranked = [latency(c) for c in sorted(callers.values(), key=lambda c: -c["calls"])[:8]]
    out = {
        "today": today,
        "week": week,
        "callers": ranked,
        "kinds": [latency(k) for k in sorted(kinds.values(), key=lambda k: -k["calls"])],
        "hours": hours,
        "gateway": _jev_gateway(now) if req.get("gateway", True) else None,
    }
    if sid:
        session["p50"], session["p95"] = _pct(session_ms, 0.5), _pct(session_ms, 0.95)
        out["session"] = session
    return out


GOAL_MARKS = ("goal_status", "Goal set:", "Goal cleared", "Goal achieved", "Goal met")


def goal(req: dict) -> dict:
    """The session's /goal from its transcript: the condition, whether it is
    still being pursued, and the Stop-hook evaluator's checks of it.

    The transcript records it three ways: `<local-command-stdout>Goal set: X`
    (and `Goal cleared: X`) as user rows, `goal_status` attachments (sentinel
    rows when it is set or cleared; evaluations with `met` and `reason` after
    each turn), and a system row when an error clears it. Rows are matched by
    their type, never by text alone: other rows quote "Goal set" (the
    daily-activity context, tool output reading transcripts).
    """
    path = str(req.get("transcript") or "")
    out: dict | None = None
    if not path:
        return {"goal": None}
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return {"goal": None}

    def ts(r: dict) -> float:
        try:
            return time.mktime(time.strptime(str(r.get("timestamp", ""))[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
        except ValueError:
            return 0.0

    def start(cond: str, at: float) -> dict:
        return {"condition": cond, "active": True, "met": False, "setAt": at, "checks": 0, "lastAt": 0, "reason": "", "ended": "", "endedAt": 0}

    with f:
        for line in f:
            if not any(m in line for m in GOAL_MARKS):
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("isSidechain"):
                continue
            a = r.get("attachment") if r.get("type") == "attachment" else None
            if isinstance(a, dict) and a.get("type") == "goal_status":
                cond = str(a.get("condition") or "")
                if out is None or out["condition"] != cond:
                    out = start(cond, ts(r))
                if a.get("sentinel"):
                    # Set (met false) or cleared/finished (met true) marker.
                    if a.get("met"):
                        out.update(active=False, ended=out["ended"] or "cleared", endedAt=out["endedAt"] or ts(r))
                    elif not out["active"]:
                        out = start(cond, ts(r))
                    continue
                out["checks"] += 1
                out["lastAt"] = ts(r)
                out["reason"] = str(a.get("reason") or "")[:1200]
                if a.get("met"):
                    out.update(met=True, active=False, ended="met", endedAt=ts(r))
                continue
            content = (r.get("message") or {}).get("content") if r.get("type") == "user" else None
            if isinstance(content, str) and content.startswith("<local-command-stdout>Goal "):
                text = content[len("<local-command-stdout>"):].split("</local-command-stdout>")[0]
                if text.startswith("Goal set: "):
                    out = start(text[len("Goal set: "):].strip(), ts(r))
                elif out is not None and text.startswith("Goal cleared"):
                    out.update(active=False, ended=out["ended"] or "cleared", endedAt=ts(r))
                continue
            if r.get("type") == "system" and out is not None and str(r.get("content") or "").startswith("Goal cleared"):
                out.update(active=False, ended="error", endedAt=ts(r), reason=str(r.get("content"))[:400])
    return {"goal": out}


# ---- policy: a grant the session needs now, for the person to approve -------
#
# Candidates come from what the guards printed when they refused this session
# (`/policy allow merge owner/repo 15m` …) and, failing that, from the
# capabilities its last answer asks for. Jev picks one or none. The office
# shows it with an approve button; nothing here changes the policy.

import re as _re

SHORT = {"merge": ("gh_merge", "--repo"), "prod": ("prod_eks_access", "--scope"), "prod-w": ("prod_eks_write", "--scope"),
         "slack": ("slack_send", "--scope"), "tmux": ("tmux_window_escape", None), "auto": ("auto_continue", None)}
LABEL = {"gh_merge": "PR merge", "prod_eks_access": "prod EKS 읽기", "prod_eks_write": "prod EKS 쓰기",
         "slack_send": "Slack 보내기", "tmux_window_escape": "다른 tmux 창 조작", "auto_continue": "확인 없이 계속"}
# Without a refusal to go on, an answer that plainly asks for one of these.
ASKS = [("gh_merge", r"merge|머지"), ("prod_eks_write", r"prod.{0,20}(write|쓰기|재시작|restart|delete|apply)"),
        ("prod_eks_access", r"prod.{0,20}(read|읽|조회|kubectl)"), ("slack_send", r"slack|슬랙|보낼까|보내도"),
        ("tmux_window_escape", r"다른 (tmux )?(창|window)|tmux window")]


def _grants_from_blocks(blocks: list[str]) -> list[dict]:
    out = []
    for b in blocks:
        for m in _re.finditer(r"/policy allow (merge|prod-w|prod|slack|tmux|auto)(?: ([^\s`]+))?(?: (\d+)m)?", b):
            short, scope, mins = m.group(1), m.group(2), m.group(3)
            if scope in ("owner/repo",) or (scope and scope.startswith("<")):
                scope = None
            cap, flag = SHORT[short]
            argv = ["allow", cap] + ([flag, scope] if flag and scope else [])
            out.append({"argv": argv, "label": LABEL[cap] + (" " + scope if scope else " (모든 대상)"), "minutes": int(mins or 30),
                        "why": "이 세션이 방금 정책에 막혔습니다: " + b.splitlines()[0][:120]})
    return out


def policy(req: dict) -> dict:
    answer = str(req.get("answer", ""))[-1500:]
    blocks = [str(b) for b in req.get("blocks", [])][-4:]
    caps = req.get("caps") or {}
    cands = _grants_from_blocks(blocks)
    if not cands:
        for cap, pat in ASKS:
            if caps.get(cap) != "allow" and _re.search(pat, answer[-600:], _re.I):
                cands.append({"argv": ["allow", cap], "label": LABEL[cap] + " (모든 대상)", "minutes": 15, "why": "마지막 답이 이 권한이 필요한 일을 묻습니다"})
    seen, uniq = set(), []
    for c in cands:
        k = " ".join(c["argv"])
        if k not in seen:
            seen.add(k)
            uniq.append(c)
    cands = uniq[:5]
    if not cands:
        return {"grant": None, "confidence": 1.0}
    try:
        import jev
    except Exception as exc:
        return {"grant": cands[0] if blocks else None, "confidence": 0.0, "error": str(exc)}
    criteria = {f"g{i}": f"Grant {c['label']} ({' '.join(c['argv'])}) — needed now: {c['why']}" for i, c in enumerate(cands)}
    criteria["none"] = ("No policy change is needed for what this session is waiting on now: it asks a question, "
                        "reports, or the refusal is old and already worked around.")
    state = ("Refusals this session got from the policy guards (newest last):\n" + ("\n".join("- " + b[:300] for b in blocks) or "(none)")
             + "\n\nEnd of its last answer:\n" + answer)
    got = jev.choose(state, "policyGrant", criteria, timeout=3.0)
    if not got:
        return {"grant": cands[0] if blocks else None, "confidence": 0.0}
    pick, conf = got
    if pick == "none" or conf < 0.45:
        return {"grant": None, "confidence": conf}
    return {"grant": cands[int(pick[1:])], "confidence": conf}


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        req = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, ValueError):
        req = {}
    # jev.py records which session asked; the mod is not a child of the
    # session's shell, so it names the session in each request instead.
    if isinstance(req, dict) and req.get("session"):
        os.environ["CLAUDE_CODE_SESSION_ID"] = str(req["session"])
    # jev.py names the caller by argv[0]; one name per bridge command keeps the
    # fork hint apart from routing in the cockpit's per-hook rows.
    sys.argv[0] = f"cc-bridge:{cmd}"
    fn = {"attention": attention, "fork": fork, "neighbors": neighbors, "route": route, "jev_usage": jev_usage, "goal": goal, "policy": policy}.get(cmd)
    print(json.dumps(fn(req) if fn else {"error": f"unknown command {cmd!r}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
