"""Which file paths the office may show (office.py /file and /paths).

A path written in what a session said becomes a 👁 link when its file is one
the office would show; /file serves it with the same answer, so a link never
leads to a refusal. The office listens on 127.0.0.1 only, yet a page that reads
files is still a file-reading endpoint, so two rules hold together:
- resolve(): only a file under the home folder, never a credential, never
  through a symlink that leaves home, never a big one;
- mentioned(): only a file the session itself named (its transcript holds the
  path), so the page cannot ask for a path nobody wrote.
"""

import json
import os
import re

# Folders whose files are keys, tokens or logins: nothing under them is shown,
# whatever its name. Compared case-folded: macOS's file system ignores case,
# so ~/.AWS/credentials is ~/.aws/credentials. ~/.config is whole: gh, gcloud,
# doppler and others keep their tokens there.
DENY_DIRS = (".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".doppler", ".password-store", ".config", ".local/share/keyrings",
             "library/keychains")
# Files that hold a credential by their name alone, wherever they are.
DENY_NAME = re.compile(r"^(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.pgpass|\.credentials(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\..*)?"
                       r"|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk))$|credential|token|secret|passw", re.I)

# What the office shows and how. Source code is served as plain text, never as
# a script type (and with nosniff), so a .js file cannot run as one.
VIEW_TYPES = {".html": "text/html", ".htm": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".log": "text/plain",
              ".json": "application/json", ".csv": "text/plain", ".yaml": "text/plain", ".yml": "text/plain"}
CODE = (".py", ".sh", ".bash", ".zsh", ".fish", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".c", ".h",
        ".cc", ".cpp", ".hpp", ".css", ".scss", ".sql", ".toml", ".ini", ".conf", ".cfg", ".tf", ".hcl", ".xml", ".diff", ".patch", ".jsonl", ".lua",
        ".svelte", ".vue", ".proto", ".graphql", ".rst", ".tsv")
VIEW_TYPES.update({e: "text/plain" for e in CODE})
VIEW_MAX = 20 * 1024 * 1024


def home() -> str:
    # At call time, not import: a test (or a server started under another
    # HOME) must see the home it runs in.
    return os.path.realpath(os.path.expanduser("~"))


def under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def denied(real: str) -> bool:
    """A credential: under one of DENY_DIRS (relative to home, or anywhere
    for a dot-folder) or named like one."""
    low, h = real.casefold(), home().casefold()
    rel = low[len(h) + 1:] if under(low, h) else low
    for d in DENY_DIRS:
        if rel == d or rel.startswith(d + "/") or (d.startswith(".") and "/" not in d and ("/" + d + "/") in ("/" + rel + "/")):
            return True
    return any(DENY_NAME.search(part) for part in real.split(os.sep) if part)


def kind_of(path: str) -> str | None:
    return VIEW_TYPES.get(os.path.splitext(path)[1].lower())


def resolve(raw: str, cwd: str | None = None) -> str | None:
    """The real path of a file `raw` names that the office may show, else
    None. Denied, missing and not-a-viewable-type all answer None alike, so
    the answer says nothing about a file the office will not show.

    `raw` may start with ~, be absolute, or be relative to `cwd` (the
    session's folder); a :line or :line:col suffix is dropped."""
    raw = (raw or "").strip()
    if not raw or "\0" in raw or len(raw) > 1024 or re.match(r"^[a-z][\w+.-]*://", raw, re.I):
        return None
    raw = re.sub(r":\d+(:\d+)?$", "", raw)
    p = os.path.expanduser(raw)
    if not os.path.isabs(p):
        if not cwd:
            return None
        p = os.path.join(os.path.expanduser(cwd), p)
    # Every symlink and .. resolved first, so a link inside home that points
    # at ~/.ssh, or out of home, is judged where it lands.
    real = os.path.realpath(p)
    if not under(real, home()) or denied(real) or denied(os.path.abspath(p)):
        return None
    if os.path.isdir(real):
        real = os.path.join(real, "README.md")  # a folder shows its README
    if not os.path.isfile(real) or not kind_of(real):
        return None
    try:
        if os.path.getsize(real) > VIEW_MAX:
            return None
    except OSError:
        return None
    return real


def forms(real: str, cwd: str | None = None) -> list[str]:
    """The ways a session may have written `real`: as it is, from ~, and
    relative to its folder."""
    out, h = [real], home()
    if under(real, h) and real != h:
        out.append("~/" + os.path.relpath(real, h))
    if cwd:
        c = os.path.realpath(os.path.expanduser(cwd))
        if under(real, c) and real != c:
            out.append(os.path.relpath(real, c))
    if os.path.basename(real) == "README.md":  # a folder that shows its README
        out += [os.path.dirname(f) for f in out if f.endswith("/README.md")]
    return out


# A byte that may sit in a path: a match with one of these on either side is
# part of a longer path (exp/a.md inside exp/a.md.bak or other/exp/a.md).
_PATHCHAR = re.compile(rb"[\w.@+~/:-]")


def mentioned(text: bytes, real: str, cwd: str | None = None) -> bool:
    """Whether a session's transcript names `real` in one of its forms (raw,
    or as JSON writes it with \\u escapes), as a whole path and not inside a
    longer one. Anything in the transcript counts: what it said, what it was
    told, what its tools printed."""
    if not text:
        return False
    for f in forms(real, cwd):
        for b in {f.encode(), json.dumps(f)[1:-1].encode()}:
            if len(b) <= 2:
                continue
            i = text.find(b)
            while i >= 0:
                before, after = text[i - 1:i], text[i + len(b):i + len(b) + 1]
                # A trailing '.' or ':' ends a sentence or starts :line.
                if not (before and _PATHCHAR.match(before)) and not (after and _PATHCHAR.match(after) and after not in b".:"):
                    return True
                i = text.find(b, i + 1)
    return False
