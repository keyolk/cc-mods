"""Processes behind a session, for office/hibernate.py: the tree under its
pane, the memory it holds, the exact argv it was launched with (macOS
KERN_PROCARGS2), and the command that resumes it the same way."""

import ctypes
import ctypes.util
import os
import re
import struct
import subprocess
import time

_ps: dict = {"at": 0.0, "rows": {}}


def run(argv: list[str], timeout: int = 5) -> tuple[int, str]:
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)
    return r.returncode, (r.stdout if r.returncode == 0 else r.stderr or r.stdout).strip()


def ps(sh=run) -> dict[int, tuple[int, int, str]]:
    """pid -> (ppid, rss KB, command), once per 30 s: /command polls every 3 s."""
    if time.time() - _ps["at"] < 30 and _ps["rows"]:
        return _ps["rows"]
    # Under load (the reason to sleep sessions at all) ps takes seconds.
    code, out = sh(["ps", "-A", "-o", "pid=,ppid=,rss=,comm="], timeout=30)
    rows = {}
    for line in out.splitlines() if code == 0 else []:
        p = line.split(None, 3)
        if len(p) >= 3 and p[0].isdigit() and p[1].isdigit() and p[2].isdigit():
            rows[int(p[0])] = (int(p[1]), int(p[2]), p[3] if len(p) > 3 else "")
    _ps.update(at=time.time(), rows=rows)
    return rows


def ancestry(pid: int, rows: dict) -> list[int]:
    out, seen = [pid], {pid}
    while pid in rows and rows[pid][0] not in seen and rows[pid][0] > 1:
        pid = rows[pid][0]
        out.append(pid)
        seen.add(pid)
    return out


def subtree_kb(pid: int, rows: dict) -> int:
    kids: dict[int, list[int]] = {}
    for p, (pp, _, _) in rows.items():
        kids.setdefault(pp, []).append(p)
    total, todo = 0, [pid]
    while todo:
        p = todo.pop()
        total += rows.get(p, (0, 0, ""))[1]
        todo += kids.get(p, [])
    return total


LAUNCHERS = ("ccproxy", "claude")


def launcher(pid: int, pane_pid: int | None, rows: dict) -> int | None:
    """The topmost ccproxy or claude above `pid` (claude) and under the pane:
    ccproxy for a wrapped claude, claude itself otherwise. Not the process
    just under the pane's root: a pane can hold a shell in a shell
    (`split-window "fish -l"` runs fish under sh), and the live run took that
    fish for the launcher. None when `pid` does not descend from the pane
    (not this pane's session)."""
    chain = ancestry(pid, rows)
    if pane_pid is None or pane_pid not in chain:
        return None
    top = pid
    for p in chain[1:chain.index(pane_pid) + 1]:
        name = os.path.basename(rows.get(p, (0, 0, ""))[2].split(" ")[0]).lstrip("-")
        if name not in LAUNCHERS:
            break
        top = p
    return top


def procargs(pid: int) -> tuple[str, list[str], dict[str, str]] | None:
    """(exec path, argv, env) of a process of this user (macOS KERN_PROCARGS2)."""
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        mib = (ctypes.c_int * 3)(1, 49, int(pid))
        size = ctypes.c_size_t(0)
        if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
            return None
        buf = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
            return None
    except (OSError, AttributeError, TypeError):
        return None
    raw = buf.raw[: size.value]
    argc = struct.unpack("i", raw[:4])[0]
    exe, _, rest = raw[4:].partition(b"\0")
    parts = rest.lstrip(b"\0").split(b"\0")
    dec = [p.decode("utf-8", "replace") for p in parts]
    env = {}
    for e in dec[argc:]:
        if not e:
            break
        k, eq, v = e.partition("=")
        if eq:
            env[k] = v
    return exe.decode("utf-8", "replace"), dec[:argc], env


# Flags carried to the resume. Others are dropped and named in the card.
VALUE = {"--model", "--effort", "--permission-mode", "--settings", "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file",
         "--system-prompt", "--fallback-model", "-n", "--name", "--autocompact", "--debug-file", "--remote-control-session-name-prefix"}
LIST = {"--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--mcp-config", "--plugin-dir", "--betas"}
BARE = {"--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--chrome", "--no-chrome", "--ide", "--strict-mcp-config", "--brief", "--verbose"}
GONE_VALUE = {"--session-id", "--resume", "-r", "--from-pr"}
GONE_BARE = {"-c", "--continue", "--fork-session"}
# The env the resume gets back: what selects an account or a config, never a secret.
ENV_KEEP = re.compile(r"^(CLAUDE_[A-Z_]+|CCPROXY_[A-Z_]+|ANTHROPIC_(BASE_URL|MODEL|SMALL_FAST_MODEL)|AWS_PROFILE|AWS_REGION|KUBECONFIG|PATH|LANG|LC_[A-Z]+)$")
ENV_SECRET = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", re.I)


def claude_flags(args: list[str]) -> tuple[list[str], list[str]]:
    """(kept, dropped) of claude's own arguments, without the program."""
    kept, dropped, i = [], [], 0
    while i < len(args):
        a = args[i]
        name = a.split("=", 1)[0]
        if a in GONE_BARE:
            i += 1
        elif name in GONE_VALUE:
            i += 1 if "=" in a else 2
        elif name in VALUE:
            kept += [a] if "=" in a else args[i:i + 2]
            i += 1 if "=" in a else 2
        elif name in LIST:
            if "=" in a:
                kept.append(a)
                i += 1
            else:
                # Variadic: its values run to the next flag. A positional
                # after it would be taken as one; the worker launch writes
                # --add-dir=... for that reason.
                j = i + 1
                while j < len(args) and not args[j].startswith("-"):
                    j += 1
                kept += args[i:j]
                i = j
        elif a in BARE:
            kept.append(a)
            i += 1
        else:
            dropped.append(a)  # a positional (a first prompt) or a flag not known
            i += 1
    return kept, dropped


def resume_argv(exe: str, argv: list[str], sid: str) -> tuple[list[str], list[str]]:
    """The command that resumes `sid` the way `argv` launched it, and what it drops."""
    prog = os.path.basename(argv[0]) if argv else ""
    if prog == "ccproxy" and "--" in argv:
        cut = argv.index("--")
        kept, dropped = claude_flags(argv[cut + 1:])
        return [exe, *argv[1:cut + 1], *kept, "--resume", sid], dropped
    kept, dropped = claude_flags(argv[1:])
    return [exe, *kept, "--resume", sid], dropped


