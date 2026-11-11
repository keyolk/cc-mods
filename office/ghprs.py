"""The person's open pull requests on GitHub, for the agenda (office/agenda.py):
a meeting's attendee who wrote, reviews or is asked to review one of them
gets that PR beside their name.

Two reads with `gh`, each in the background and never on a request's thread:
- PRS: one GraphQL search, every PR_CACHE_S: the open PRs the person wrote
  and those that ask the person's review, with author, requested reviewers
  and latest reviews.
- PEOPLE (with an org set): the org's SAML identities (GitHub login -> the
  work email), every PEOPLE_CACHE_S, kept on disk; 150 members take ~3 s.
  Without it, a login is matched by its letters (Kairo-Kim ~ kairo.kim).

Which gh account and org: ~/.config/cc-mods/office.json "agenda":
{"ghUser": "<gh login to run as>", "ghOrg": "<org whose SAML maps logins>"};
with no ghUser, gh's active account. The office only reads GitHub.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time

CONFIG = os.path.expanduser("~/.config/cc-mods/office.json")
PR_CACHE_S = 600
PEOPLE_CACHE_S = 24 * 3600
RUN_TIMEOUT = 30
FIRST = 30
PER_PERSON = 4
LOGIN = re.compile(r"^[A-Za-z0-9-]{1,39}$")
ORG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$")
# Bots review and are asked for review, but no one meets them.
BOTS = re.compile(r"(\[bot\]$|^(github-actions|dependabot|copilot-pull-request-reviewer|chatgpt-codex-connector|claude)$)", re.I)

_lock = threading.Lock()
_prs: dict = {"at": 0.0, "items": None, "error": None, "running": False}
_people: dict = {"at": 0.0, "map": None, "running": False}

QUERY = """query($a:String!,$r:String!){
 a: search(query:$a, type:ISSUE, first:%d){nodes{...P}}
 r: search(query:$r, type:ISSUE, first:%d){nodes{...P}}
}
fragment P on PullRequest{number title url isDraft repository{nameWithOwner} author{login}
 reviewRequests(first:15){nodes{requestedReviewer{... on User{login}}}}
 latestReviews(first:15){nodes{author{login} state}}}""" % (FIRST, FIRST)

SAML = """query($org:String!,$endCursor:String){organization(login:$org){samlIdentityProvider{
 externalIdentities(first:100, after:$endCursor){pageInfo{hasNextPage endCursor}
 nodes{samlIdentity{nameId} user{login}}}}}}"""


def config() -> dict:
    try:
        with open(CONFIG) as f:
            got = (json.load(f) or {}).get("agenda") or {}
    except (OSError, ValueError, AttributeError):
        got = {}
    got = got if isinstance(got, dict) else {}
    user, org = str(got.get("ghUser") or ""), str(got.get("ghOrg") or "")
    return {"ghUser": user if LOGIN.match(user) else "", "ghOrg": org if ORG.match(org) else ""}


def cache_file() -> str:
    # Read on each call: a test sets HOME in-process.
    return os.path.expanduser("~/.cache/cc-mods/office-gh-people.json")


def gh_bin() -> str | None:
    p = shutil.which("gh")
    return p if p and os.access(p, os.X_OK) else None


def _gh(args: list[str], timeout: float = RUN_TIMEOUT) -> tuple[str | None, str | None]:
    """Run gh as the configured account. Its token is read by gh itself
    (`gh auth token --user`) and handed only to the child's environment."""
    b = gh_bin()
    if not b:
        return None, "gh가 없습니다"
    env = dict(os.environ)
    user = config()["ghUser"]
    try:
        if user:
            t = subprocess.run([b, "auth", "token", "--user", user], capture_output=True, text=True, timeout=10)
            if t.returncode != 0 or not t.stdout.strip():
                return None, f"gh auth token --user {user}: 로그인되어 있지 않습니다"
            env["GH_TOKEN"] = t.stdout.strip()
        r = subprocess.run([b, *args], capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return None, f"gh: {timeout:.0f}초 안에 끝나지 않았습니다"
    except OSError as e:
        return None, f"gh: {e}"
    if r.returncode != 0:
        return None, "gh: " + ((r.stderr or r.stdout).strip().splitlines() or [f"exit {r.returncode}"])[-1][:300]
    return r.stdout, None


def _login(x) -> str:
    v = str((x or {}).get("login") or "") if isinstance(x, dict) else ""
    return v if LOGIN.match(v) and not BOTS.search(v) else ""


def parse_prs(stdout: str) -> list[dict]:
    """The search result as PRs: {repo, number, title, url, draft, mine, author,
    reviewers: {login: state}}, mine first; ValueError when it is not that."""
    d = json.loads(stdout).get("data")
    if not isinstance(d, dict):
        raise ValueError("no data")
    out: dict[str, dict] = {}
    for key, mine in (("a", True), ("r", False)):
        for n in (d.get(key) or {}).get("nodes") or []:
            if not isinstance(n, dict) or not n.get("url"):
                continue
            revs: dict[str, str] = {}
            for r in (n.get("reviewRequests") or {}).get("nodes") or []:
                lg = _login((r or {}).get("requestedReviewer"))
                if lg:
                    revs[lg] = "REQUESTED"
            for r in (n.get("latestReviews") or {}).get("nodes") or []:
                lg = _login((r or {}).get("author"))
                if lg:
                    revs[lg] = str(r.get("state") or "")
            url = str(n["url"])
            out.setdefault(url, {"repo": str((n.get("repository") or {}).get("nameWithOwner") or ""), "number": int(n.get("number") or 0), "title": str(n.get("title") or "")[:200], "url": url, "draft": bool(n.get("isDraft")), "mine": mine, "author": _login(n.get("author")), "reviewers": revs})
    return sorted(out.values(), key=lambda p: (not p["mine"], p["repo"], -p["number"]))


def parse_people(stdout: str) -> dict[str, str]:
    """gh --paginate's pages of SAML identities as {login (lower): email (lower)}."""
    out: dict[str, str] = {}
    dec, i, s = json.JSONDecoder(), 0, stdout.strip()
    while i < len(s):
        page, i = dec.raw_decode(s, i)
        while i < len(s) and s[i].isspace():
            i += 1
        nodes = ((((page.get("data") or {}).get("organization") or {}).get("samlIdentityProvider") or {}).get("externalIdentities") or {}).get("nodes") or []
        for n in nodes:
            lg = _login((n or {}).get("user"))
            email = str(((n or {}).get("samlIdentity") or {}).get("nameId") or "").lower()
            if lg and "@" in email:
                out[lg.lower()] = email
    return out


def _refresh_prs() -> None:
    try:
        out, err = _gh(["api", "graphql", "-f", "query=" + QUERY, "-f", "a=is:pr is:open archived:false author:@me", "-f", "r=is:pr is:open archived:false review-requested:@me"])
        items = None
        if out is not None:
            try:
                items = parse_prs(out)
            except (ValueError, AttributeError) as e:
                err = f"gh: 읽을 수 없는 출력 ({e})"
        with _lock:
            _prs.update(at=time.time(), error=err)
            if items is not None:
                _prs["items"] = items
    finally:
        _prs["running"] = False


def _load_people_file() -> tuple[float, dict] | None:
    try:
        with open(cache_file()) as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("map"), dict):
            return float(d.get("at") or 0), {str(k): str(v) for k, v in d["map"].items()}
    except (OSError, ValueError, TypeError):
        pass
    return None


def _refresh_people(org: str) -> None:
    try:
        out, err = _gh(["api", "graphql", "--paginate", "-f", "query=" + SAML, "-f", "org=" + org], timeout=60)
        m = None
        if out is not None:
            try:
                m = parse_people(out)
            except (ValueError, AttributeError):
                m = None
        now = time.time()
        with _lock:
            _people["at"] = now
            if m:
                _people["map"] = m
        if m:
            path = cache_file()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"at": now, "org": org, "map": m}, f)
            os.replace(tmp, path)
    finally:
        _people["running"] = False


def _kick(state: dict, max_age: float, target, *args, wait: bool = False) -> None:
    with _lock:
        start = time.time() - state["at"] >= max_age and not state["running"]
        if start:
            state["running"] = True
    if not start:
        return
    if wait:
        target(*args)
    else:
        threading.Thread(target=target, args=args, name="office-gh", daemon=True).start()


def prs(wait: bool = False) -> tuple[list[dict] | None, str | None]:
    _kick(_prs, PR_CACHE_S, _refresh_prs, wait=wait)
    with _lock:
        return _prs["items"], _prs["error"]


def last_error() -> str | None:
    """Why the last PR read failed, without starting one."""
    with _lock:
        return _prs["error"]


def people(wait: bool = False) -> dict[str, str]:
    """GitHub login (lower) -> work email, from the org's SAML; {} without an org."""
    org = config()["ghOrg"]
    if not org:
        return {}
    if _people["map"] is None:
        disk = _load_people_file()
        if disk:
            with _lock:
                _people["at"], _people["map"] = disk
    _kick(_people, PEOPLE_CACHE_S, _refresh_people, org, wait=wait)
    with _lock:
        return dict(_people["map"] or {})


def squash(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def login_email(login: str, emails: set[str], saml: dict[str, str], extra: dict) -> str | None:
    """The attendee email a GitHub login belongs to: the people file's github,
    the org's SAML, else the login's letters equal to an email's local part's."""
    lo = login.lower()
    for email, x in extra.items():
        if str((x or {}).get("github") or "").lower() == lo and email in emails:
            return email
    if saml.get(lo) in emails:
        return saml[lo]
    sq = squash(login)
    for e in emails:
        if len(sq) >= 4 and squash(e.split("@", 1)[0]) == sq:
            return e
    return None


def link(emails: set[str], items: list[dict], saml: dict[str, str], extra: dict) -> dict[str, list[dict]]:
    """attendee email -> the PRs they wrote or review: {kind "pr", label, ref, role}."""
    out: dict[str, list[dict]] = {}
    for p in items:
        roles = [(p["author"], "작성")] + [(lg, "승인" if st == "APPROVED" else "변경 요청" if st == "CHANGES_REQUESTED" else "리뷰 요청됨" if st == "REQUESTED" else "리뷰") for lg, st in p["reviewers"].items()]
        for lg, role in roles:
            e = lg and login_email(lg, emails, saml, extra)
            if e:
                out.setdefault(e, []).append({"kind": "pr", "label": f"{p['repo'].split('/')[-1]}#{p['number']} {p['title']}"[:120], "ref": {"url": p["url"]}, "role": role, "mine": p["mine"]})
    # What the person can bring up in the meeting first: a PR of theirs that
    # waits on my review, then one of mine that waits on theirs.
    rank = {"작성": 0, "리뷰 요청됨": 1, "변경 요청": 2}
    return {e: sorted(hs, key=lambda h: rank.get(h["role"], 3))[:PER_PERSON] for e, hs in out.items()}
