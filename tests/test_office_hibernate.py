"""Long-idle sessions put to sleep and woken from the office:
office/hibernate.py (who and when), office/hibwake.py (going down, waking),
office/hibproc.py (processes and the launch), office/hibstate.py (files)."""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))

import hibernate  # noqa: E402
import hibproc  # noqa: E402
import hibstate  # noqa: E402
import hibwake  # noqa: E402

def _epoch(iso: str) -> float:
    return hibstate._epoch(iso)


S1 = "11111111-1111-1111-1111-111111111111"
S2 = "22222222-2222-2222-2222-222222222222"
OFFICE = pathlib.Path(__file__).parents[1] / "office"


class Sh:
    """A fake `run`: answers by the argv's first words, records every call."""

    def __init__(self, answers: dict | None = None):
        self.calls: list[list[str]] = []
        self.answers = answers or {}

    def __call__(self, argv, timeout=5):
        self.calls.append(list(argv))
        for k, v in self.answers.items():
            if tuple(argv[: len(k)]) == k:
                return v(argv) if callable(v) else v
        return 0, ""

    def ran(self, *head) -> list[list[str]]:
        return [c for c in self.calls if tuple(c[: len(head)]) == head]


class Home(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = pathlib.Path(tmp.name)
        p = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        p.start()
        self.addCleanup(p.stop)
        os.environ.pop("OFFICE_HIBERNATE_ONLY", None)
        hibernate._view.update(at=0.0, out=None, busy=False)
        hibstate._turn_cache.clear()
        cfg = mock.patch.object(hibstate, "CONFIG", str(self.home / "office.json"))
        cfg.start()
        self.addCleanup(cfg.stop)

    def transcript(self, sid: str, ask="이거 해 줘", said="## 끝났습니다\n자세히", at="2026-11-10T00:00:00Z") -> pathlib.Path:
        d = self.home / ".claude/projects/-tmp-x"
        d.mkdir(parents=True, exist_ok=True)
        f = d / (sid + ".jsonl")
        rows = [
            {"type": "user", "timestamp": at, "message": {"role": "user", "content": ask}},
            {"type": "assistant", "timestamp": at, "message": {"role": "assistant", "content": [{"type": "text", "text": said}]}},
            # Bookkeeping Claude Code writes into an idle transcript: not activity.
            {"type": "cost-state", "sessionId": sid},
        ]
        # Compact, as Claude Code writes it.
        f.write_text("\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows) + "\n")
        return f

    def person(self, sid=S1, **kw) -> dict:
        p = {"id": sid, "pane": "%7", "name": "w:" + sid[:4], "state": "waiting", "attention": "none", "agents": 0, "since": time.time() - 20 * 3600, "window": "main:3", "wid": "@9", "cwd": "/tmp/x", "coord": False, "boss": None}
        p.update(kw)
        return p

    def ctx(self, **kw) -> dict:
        c = {"cfg": hibstate.config(), "now": time.time(), "pins": {}, "seen": {}, "reg": {S1: {"pid": 300, "cwd": "/tmp/x", "kind": "interactive"}},
             "panes": {"%7": 100}, "rows": {100: (1, 4, "fish"), 200: (100, 200_000, "ccproxy"), 300: (200, 600_000, "claude"), 301: (300, 10_000, "narwhal")},
             "sh": Sh(), "why_not": hibernate.why_not}
        c.update(kw)
        return c


class LaunchTest(unittest.TestCase):
    def test_ccproxy_wrapper_keeps_its_own_args_and_the_persons_flags(self):
        argv = ["ccproxy", "claude", "--intercept=mitm", "--", "--dangerously-skip-permissions", "--model", "default", "--resume", "old", "--settings", "{}"]
        cmd, dropped = hibproc.resume_argv("/bin/ccproxy", argv, S1)
        self.assertEqual(cmd, ["/bin/ccproxy", "claude", "--intercept=mitm", "--", "--dangerously-skip-permissions", "--model", "default", "--settings", "{}", "--resume", S1])
        self.assertEqual(dropped, [])

    def test_worker_launch_drops_its_first_prompt_and_session_id(self):
        argv = ["ccproxy", "claude", "--intercept=mitm", "--", "--add-dir=/b", "--model", "opus", "--effort", "high", "--permission-mode", "auto",
                "--disallowedTools", "AskUserQuestion", "--session-id", S1, "-n", "w", "You are worker w ..."]
        cmd, dropped = hibproc.resume_argv("/x/ccproxy", argv, S1)
        self.assertNotIn("--session-id", cmd)
        self.assertNotIn("You are worker w ...", cmd)
        self.assertEqual(dropped, ["You are worker w ..."])
        self.assertEqual(cmd[-2:], ["--resume", S1])
        self.assertIn("--add-dir=/b", cmd)
        # --disallowedTools takes values up to the next flag; -n w survives it.
        self.assertEqual(cmd[cmd.index("--disallowedTools") + 1], "AskUserQuestion")
        self.assertEqual(cmd[cmd.index("-n") + 1], "w")

    def test_bare_claude(self):
        cmd, dropped = hibproc.resume_argv("/bin/claude", ["claude", "-c", "--weird-flag"], S1)
        self.assertEqual(cmd, ["/bin/claude", "--resume", S1])
        self.assertEqual(dropped, ["--weird-flag"])

    def test_launcher_is_the_top_process_under_the_pane(self):
        rows = {100: (1, 0, "fish"), 200: (100, 0, "ccproxy"), 300: (200, 0, "claude")}
        self.assertEqual(hibproc.launcher(300, 100, rows), 200)
        # A worker pane's root is the launcher itself (sh -c ... exec ccproxy).
        rows = {200: (1, 0, "ccproxy"), 300: (200, 0, "claude")}
        self.assertEqual(hibproc.launcher(300, 200, rows), 200)
        # A shell in a shell: the launcher is the wrapper, not the inner fish.
        rows = {50: (1, 0, "sh"), 100: (50, 0, "/opt/homebrew/bin/fish"), 200: (100, 0, "ccproxy"), 300: (200, 0, "claude")}
        self.assertEqual(hibproc.launcher(300, 50, rows), 200)
        # Not under this pane: not this pane's session.
        self.assertIsNone(hibproc.launcher(300, 999, rows))

    def test_subtree_counts_the_wrapper_and_children(self):
        rows = {200: (1, 1024, "ccproxy"), 300: (200, 2048, "claude"), 301: (300, 1024, "mcp"), 400: (1, 99999, "other")}
        self.assertEqual(hibproc.subtree_kb(200, rows), 4096)

    def test_procargs_reads_this_process(self):
        got = hibproc.procargs(os.getpid())
        if got is None:
            self.skipTest("KERN_PROCARGS2 not available here")
        exe, argv, env = got
        self.assertTrue(argv and os.path.basename(argv[0]).startswith("python"))
        self.assertEqual(env.get("HOME"), os.environ["HOME"])


class RulesTest(Home):
    def test_idle_waiting_session_is_a_candidate(self):
        self.transcript(S1)
        self.assertIsNone(hibernate.why_not(self.person(), self.ctx()))

    def test_exclusions(self):
        self.transcript(S1)
        cases = [
            ({"coord": True}, {}, "coordinator"),
            ({"boss": {"relation": "owned"}}, {}, "owned"),
            ({"boss": {}}, {}, None),  # no relation recorded: not under a coordinator
            ({"state": "working"}, {}, "일하는 중"),
            ({"attention": "action"}, {}, "사람 답"),
            ({"attention": "ask"}, {}, "사람 답"),
            ({"agents": 2}, {}, "백그라운드"),
            ({}, {"pins": {S1: 1}}, "📌"),
            ({"since": time.time() - 60}, {}, "쉰 지"),
            ({}, {"seen": {"%7": time.time() - 60}}, "사람이 본"),
            ({}, {"reg": {}}, "프로세스"),
            ({}, {"panes": {"%7": 555}}, "pane과 프로세스"),
            ({}, {"rows": {}}, "프로세스 목록"),
        ]
        for pk, ck, want in cases:
            with self.subTest(pk=pk, ck=ck):
                got = hibernate.why_not(self.person(**pk), self.ctx(**ck))
                if want is None:
                    self.assertIsNone(got)
                else:
                    self.assertIn(want, got or "")

    def test_a_session_sent_to_the_background_is_not_a_candidate(self):
        f = self.transcript(S1)
        reg = {"pid": 300, "cwd": "/tmp/x", "kind": "interactive"}
        self.assertIn("백그라운드 job", hibernate.why_not(self.person(), self.ctx(reg={S1: {**reg, "parkedJobId": "248e9ea4"}})))
        self.assertIn("busy", hibernate.why_not(self.person(), self.ctx(reg={S1: {**reg, "status": "busy"}})))
        with open(f, "a") as fh:
            fh.write(json.dumps({"type": "continued-in", "continuedInSessionId": S2}, separators=(",", ":")) + "\n")
        self.assertIn("continued-in", hibernate.why_not(self.person(), self.ctx()))

    def test_tmux_not_answering_means_no(self):
        self.transcript(S1)
        self.assertIn("client", hibernate.why_not(self.person(), self.ctx(seen=None)))
        sh = Sh({("tmux", "capture-pane"): (1, "timed out")})
        self.assertIn("화면을 읽지 못함", hibernate.why_not(self.person(), self.ctx(sh=sh)))
        sh = Sh({("tmux", "list-clients"): (1, "timed out")})
        self.assertIsNone(hibernate.looked_at(sh))

    def test_the_panes_own_attention_wins_over_the_windows(self):
        self.transcript(S1)
        # The window says action (a neighbour's dialog); this pane waits on nobody.
        self.assertIsNone(hibernate.why_not(self.person(attention="action"), self.ctx(attn={"%7": "none"})))
        self.assertIn("사람 답", hibernate.why_not(self.person(attention="none"), self.ctx(attn={"%7": "ask"})))

    def test_adopted_worker_may_sleep(self):
        self.transcript(S1)
        self.assertIsNone(hibernate.why_not(self.person(boss={"relation": "adopted"}), self.ctx()))

    def test_recent_message_counts_not_the_file_mtime(self):
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.transcript(S1, at=now)
        self.assertIn("쉰 지", hibernate.why_not(self.person(), self.ctx()))
        # A press on one session skips the idle time and nothing else.
        self.assertIsNone(hibernate.why_not(self.person(), self.ctx(), manual=True))
        self.assertIn("coordinator", hibernate.why_not(self.person(coord=True), self.ctx(), manual=True))

    def test_a_request_far_back_is_found(self):
        f = self.transcript(S1)
        with open(f, "a") as fh:
            for _ in range(30):  # api-request-blob lines, ~1.2 MB
                fh.write(json.dumps({"type": "api-request-blob", "blob": "x" * 40_000}) + "\n")
        self.assertEqual(hibstate.last_turn(str(f))["ask"], "이거 해 줘")

    def test_no_transcript_no_sleep(self):
        self.assertIn("대화 파일", hibernate.why_not(self.person(), self.ctx()))

    def test_draft_in_the_prompt_box(self):
        self.transcript(S1)
        sh = Sh({("tmux", "capture-pane"): (0, "chat\n────\n❯ 반쯤 쓴 글\n────")})
        self.assertIn("보내지 않은 글", hibernate.why_not(self.person(), self.ctx(sh=sh)))
        sh = Sh({("tmux", "capture-pane"): (0, "chat\n────\n❯ \n────")})
        self.assertIsNone(hibernate.why_not(self.person(), self.ctx(sh=sh)))

    def test_the_empty_boxs_hint_is_not_a_draft(self):
        self.assertEqual(hibstate.draft(['\x1b[39m❯ Try "how does <filepath> work?"']), "")
        self.assertEqual(hibstate.draft(["\x1b[39m❯ \x1b[38;5;246mfix the tests\x1b[39m"]), "")
        self.assertEqual(hibstate.draft(["\x1b[39m❯ abc"]), "abc")
        # The sent request above the box keeps its marker: the box is the last one.
        self.assertEqual(hibstate.draft(["\x1b[38;5;246m\x1b[48;5;237m❯ \x1b[38;5;231mRemember\x1b[39m", "⏺ OK", "────", "\x1b[39m❯ ", "────"]), "")

    def test_office_reply_or_memo_waiting(self):
        self.transcript(S1)
        inbox = self.home / ".claude/state/office/inbox"
        inbox.mkdir(parents=True)
        (inbox / (S1 + ".json")).write_text("{}")
        self.assertIn("office 답장", hibernate.why_not(self.person(), self.ctx()))
        (inbox / (S1 + ".json")).unlink()
        d = self.home / ".claude/state/office/defer"
        d.mkdir(parents=True)
        (d / (S1 + ".json")).write_text(json.dumps({"memos": [{"id": "m1", "text": "x"}]}))
        self.assertIn("메모", hibernate.why_not(self.person(), self.ctx()))

    def test_only_env_limits_every_action(self):
        self.transcript(S1)
        with mock.patch.dict(os.environ, {"OFFICE_HIBERNATE_ONLY": S2}):
            self.assertIn("OFFICE_HIBERNATE_ONLY", hibernate.why_not(self.person(), self.ctx()))
            self.assertEqual(hibwake.wake(S1, Sh())[0], 400)

    def test_candidates_carry_what_comes_back(self):
        self.transcript(S1)
        got = hibernate.candidates([self.person(), self.person(S2, pane="%8")], self.ctx())
        self.assertEqual([c["sid"] for c in got], [S1])
        self.assertEqual(got[0]["mb"], (200_000 + 600_000 + 10_000 + 4) // 1024)

    def test_session_cap_proposes_the_excess_down_to_its_floor(self):
        # sys-load brief F: over `maxSessions`, sessions rested `capIdleHours`
        # are proposed too, longest idle first, only as many as are over.
        (self.home / "office.json").write_text(json.dumps({"hibernate": {"maxSessions": 2, "capIdleHours": 2}}))
        three_h = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 3 * 3600))
        one_h = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 3600))
        S3, S4 = "33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"
        self.transcript(S1, at=three_h)
        self.transcript(S2, at=three_h)
        self.transcript(S3, at=one_h)
        self.transcript(S4, at=three_h)
        recent = time.time() - 3 * 3600
        reg = {s: {"pid": 300, "cwd": "/tmp/x", "kind": "interactive"} for s in (S1, S2, S3, S4)}
        people = [self.person(S1, since=recent), self.person(S2, since=recent), self.person(S3, since=time.time() - 3600), self.person(S4, since=recent, attention="ask")]
        cfg = hibstate.config()
        ctx = self.ctx(cfg=cfg, reg=reg, capFloor=hibernate.cap_floor(people, cfg), live=len(people))
        got = hibernate.candidates(people, ctx)
        # 4 live, cap 2: two over. S4 waits on the person and S3 rested 1 h
        # (under the 2 h floor): never. S1 and S2 (3 h) fill the excess.
        self.assertEqual(sorted(c["sid"] for c in got), sorted([S1, S2]))
        self.assertEqual({c["why"] for c in got}, {"cap"})
        # At or under the cap there is no floor: 3 h is not 12.
        self.assertIsNone(hibernate.cap_floor(people[:2], cfg))
        self.assertEqual(hibernate.candidates(people, self.ctx(cfg=cfg, reg=reg)), [])
        # The press checks again with the same floor: a cap candidate sleeps.
        self.assertIsNone(hibernate.why_not(people[0], ctx))
        self.assertIn("쉰 지", hibernate.why_not(people[0], self.ctx(cfg=cfg, reg=reg)))

    def test_session_cap_never_takes_a_worker_its_coordinator_instructed(self):
        (self.home / "office.json").write_text(json.dumps({"hibernate": {"maxSessions": 1, "capIdleHours": 2}}))
        three_h = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 3 * 3600))
        self.transcript(S1, at=three_h)
        recent = time.time() - 3 * 3600
        told = self.person(boss={"relation": "adopted", "instructed": True}, since=recent)
        mine = self.person(boss={"relation": "adopted"}, since=recent)
        cfg = hibstate.config()
        ctx = self.ctx(cfg=cfg, capFloor=2.0, live=5)
        self.assertIn("쉰 지", hibernate.why_not(told, ctx))
        self.assertIsNone(hibernate.why_not(mine, ctx))

    def test_the_automatic_mode_leaves_the_caps_candidates_to_a_press(self):
        cands = [{"sid": S1, "why": "cap"}, {"sid": S2, "why": "idle"}]
        slept = []
        with mock.patch.object(hibernate, "config", return_value={**hibstate.config(), "auto": "always"}), \
                mock.patch.object(hibernate, "candidates", return_value=cands), \
                mock.patch.object(hibernate, "context", return_value={}), \
                mock.patch.object(hibernate, "sleep", side_effect=lambda p, ctx, extra=None: (slept.append(p["id"]), (200, {}))[1]):
            out = hibernate.auto_tick(lambda: [self.person(), self.person(S2)])
        self.assertEqual((out, slept), ([S2], [S2]))

    def test_config_defaults_are_the_persons_picks(self):
        cfg = hibstate.config()
        self.assertEqual((cfg["auto"], cfg["pane"], cfg["idleHours"]), ("pressure", "close", 12.0))
        (self.home / "office.json").write_text(json.dumps({"hibernate": {"idleHours": 3, "auto": "bogus", "pane": "keep"}}))
        cfg = hibstate.config()
        self.assertEqual((cfg["auto"], cfg["pane"], cfg["idleHours"]), ("pressure", "keep", 3.0))

    def test_pressure(self):
        sh = Sh({("sysctl", "-n", "kern.memorystatus_vm_pressure_level"): (0, "1"), ("sysctl", "-n", "vm.swapusage"): (0, "total = 7168.00M  used = 6192.38M  free = 975.62M  (encrypted)")})
        self.assertFalse(hibernate.pressure(sh)["on"])
        sh.answers[("sysctl", "-n", "vm.swapusage")] = (0, "total = 7168.00M  used = 6900.00M  free = 268.00M")
        self.assertTrue(hibernate.pressure(sh)["on"])
        sh.answers[("sysctl", "-n", "vm.swapusage")] = (0, "free = 4000.00M")
        sh.answers[("sysctl", "-n", "kern.memorystatus_vm_pressure_level")] = (0, "4")
        self.assertTrue(hibernate.pressure(sh)["on"])


class SleepTest(Home):
    ARGV = ["ccproxy", "claude", "--intercept=mitm", "--", "--model", "default"]

    def run_sleep(self, pane_mode="close", root_pid=100, **kw):
        self.transcript(S1)
        (self.home / "office.json").write_text(json.dumps({"hibernate": {"pane": pane_mode}}))
        killed = []
        sh = Sh({("tmux", "display-message", "-p", "-t", "%7", "#{@cc_pane_session}"): (0, S1), ("tmux", "display-message", "-p", "-t", "%7", "#{pane_pid}"): (0, str(root_pid))})
        ctx = self.ctx(cfg=hibstate.config(), sh=sh, kill=lambda pid, sig: killed.append(pid), gone=lambda pid, secs: True,
                       procargs=lambda pid: ("/bin/ccproxy", self.ARGV, {"HOME": "/h", "ANTHROPIC_API_KEY": "sk-x", "CLAUDE_CONFIG_DIR": "/c", "PATH": "/bin"}), **kw)
        code, out = hibwake.sleep(self.person(), ctx)
        return code, out, sh, killed

    def test_close_writes_the_card_first_then_kills_claude_and_closes_the_pane(self):
        code, out, sh, killed = self.run_sleep()
        self.assertEqual(code, 200, out)
        self.assertEqual(killed, [300])
        self.assertTrue(sh.ran("tmux", "kill-pane", "-t", "%7"))
        c = hibstate.card(S1)
        self.assertEqual(c["launch"]["argv"], ["/bin/ccproxy", "claude", "--intercept=mitm", "--", "--model", "default", "--resume", S1])
        self.assertEqual(c["launch"]["root"], "shell")
        self.assertEqual(c["cwd"], "/tmp/x")
        self.assertEqual(c["turn"]["ask"], "이거 해 줘")
        self.assertEqual(c["turn"]["said"], "끝났습니다")
        # Never a secret in the card; an account selector is kept.
        self.assertNotIn("ANTHROPIC_API_KEY", c["launch"]["env"])
        self.assertEqual(c["launch"]["env"].get("CLAUDE_CONFIG_DIR"), "/c")
        self.assertNotIn("HOME", c["launch"]["env"])
        self.assertEqual(oct(os.stat(hibstate.folder() + "/" + S1 + ".json").st_mode & 0o777), "0o600")

    def test_a_pane_now_held_by_another_shell_is_not_closed(self):
        code, _, sh, _ = self.run_sleep(root_pid=555)
        self.assertEqual(code, 200)
        self.assertFalse(sh.ran("tmux", "kill-pane"))

    def test_keep_respawns_a_placeholder(self):
        code, out, sh, _ = self.run_sleep("keep")
        self.assertEqual(code, 200, out)
        self.assertTrue(sh.ran("tmux", "set-option", "-p", "-t", "%7", "remain-on-exit", "on"))
        r = sh.ran("tmux", "respawn-pane", "-k", "-t", "%7")
        self.assertTrue(r and r[0][-2:] == ["placeholder", S1])
        self.assertFalse(sh.ran("tmux", "kill-pane"))

    def test_rules_are_checked_again_at_the_press(self):
        self.transcript(S1)
        code, out = hibwake.sleep(self.person(attention="ask"), self.ctx())
        self.assertEqual(code, 409)
        self.assertIsNone(hibstate.card(S1))

    def test_pane_no_longer_this_session(self):
        self.transcript(S1)
        sh = Sh({("tmux", "display-message"): (0, S2)})
        code, _ = hibwake.sleep(self.person(), self.ctx(sh=sh, kill=lambda *a: self.fail("killed")))
        self.assertEqual(code, 409)

    def test_claude_slow_to_exit_keeps_its_card_and_its_pane(self):
        self.transcript(S1)
        sh = Sh({("tmux", "display-message"): (0, S1)})
        ctx = self.ctx(sh=sh, kill=lambda *a: None, gone=lambda pid, secs: False, procargs=lambda pid: ("/c", ["claude"], {}))
        self.assertEqual(hibwake.sleep(self.person(), ctx)[0], 504)
        self.assertIsNotNone(hibstate.card(S1))
        self.assertFalse(sh.ran("tmux", "kill-pane"))


class WakeTest(Home):
    def card(self, **kw):
        c = {"sid": S1, "name": "w", "cwd": str(self.home), "pane": "%7", "wid": "@9", "window": "main:3", "session": "main",
             "launch": {"argv": ["/bin/claude", "--resume", S1], "root": "launcher", "env": {"CLAUDE_CONFIG_DIR": "/c"}}}
        c.update(kw)
        hibstate._write(os.path.join(hibstate.folder(), S1 + ".json"), c)

    def test_split_of_its_old_window(self):
        self.card()
        sh = Sh({("tmux", "list-panes"): (0, "@9\t%3\t200\t50\t/tmp\t\tmain\t11")})
        code, out = hibwake.wake(S1, sh)
        self.assertEqual(code, 200, out)
        s = sh.ran("tmux", "split-window")[0]
        self.assertEqual(s[s.index("-t") + 1], "%3")
        self.assertIn("-h", s)
        self.assertEqual(s[s.index("-c") + 1], str(self.home))
        self.assertEqual(s[-3:], ["/bin/claude", "--resume", S1])
        self.assertIn("CLAUDE_CONFIG_DIR=/c", s)
        self.assertTrue(hibstate.card(S1)["wokeAt"])

    def test_a_shell_rooted_pane_gets_its_shell_back(self):
        self.card(launch={"argv": ["/bin/claude", "--resume", S1], "root": "shell", "env": {}})
        sh = Sh({("tmux", "list-panes"): (0, "@9\t%3\t200\t50\t/tmp\t\tmain\t11")})
        hibwake.wake(S1, sh)
        s = sh.ran("tmux", "split-window")[0]
        self.assertEqual(s[-3:-1], ["/bin/sh", "-c"])
        self.assertIn("--resume " + S1 + "; exec", s[-1])

    def test_full_or_gone_window_falls_to_a_new_window_in_its_session(self):
        self.card()
        # Old window gone; another window is full of Claude sessions.
        sh = Sh({("tmux", "list-panes"): (0, "@5\t%1\t200\t50\t/tmp\ta\tmain\t00\n@5\t%2\t200\t50\t/tmp\tb\tmain\t00\n@5\t%4\t200\t50\t/tmp\tc\tmain\t00")})
        code, out = hibwake.wake(S1, sh)
        self.assertEqual(code, 200, out)
        n = sh.ran("tmux", "new-window")[0]
        self.assertEqual(n[n.index("-t") + 1], "main:")
        self.assertFalse(sh.ran("tmux", "split-window"))

    def test_window_too_small_to_split(self):
        self.card()
        sh = Sh({("tmux", "list-panes"): (0, "@9\t%3\t80\t20\t/tmp\t\tmain\t11")})
        hibwake.wake(S1, sh)
        self.assertTrue(sh.ran("tmux", "new-window"))

    def test_same_repo_window_when_its_own_is_gone(self):
        self.card(wid="@gone")
        repo = str(self.home)
        sh = Sh({("tmux", "list-panes"): (0, "@2\t%5\t200\t50\t/elsewhere\tzz\tmain\t00\n@3\t%6\t200\t50\t" + repo + "\tyy\twork\t00"),
                 ("git", "-C"): lambda a: (0, "/repo/.git") if a[2] == repo else (0, "/other/.git")})
        hibwake.wake(S1, sh)
        s = sh.ran("tmux", "split-window")[0]
        self.assertEqual(s[s.index("-t") + 1], "%6")

    def test_kept_placeholder_pane_is_respawned_in_place(self):
        self.card()
        sh = Sh({("tmux", "display-message", "-p", "-t", "%7", "#{@cc_dormant}"): (0, S1)})
        hibwake.wake(S1, sh)
        self.assertTrue(sh.ran("tmux", "respawn-pane", "-k", "-t", "%7"))
        self.assertFalse(sh.ran("tmux", "split-window"))

    def test_already_awake_only_clears_the_card(self):
        self.card()
        with mock.patch.object(hibwake, "registry", return_value={S1: {"pid": 1}}):
            code, out = hibwake.wake(S1, Sh())
        self.assertEqual(code, 200)
        self.assertIn("이미", out["sent"])
        self.assertIsNone(hibstate.card(S1))

    def test_view_drops_the_card_once_the_session_runs_again(self):
        self.card()
        with mock.patch.object(hibernate, "registry", return_value={}):
            self.assertEqual([c["sid"] for c in hibernate.view([], Sh(), fresh=True)["cards"]], [S1])
        with mock.patch.object(hibernate, "registry", return_value={S1: {"pid": 1}}):
            self.assertEqual(hibernate.view([], Sh(), fresh=True)["cards"], [])
        self.assertIsNone(hibstate.card(S1))

    def test_a_card_whose_session_ran_again_goes_even_if_it_ended(self):
        f = self.transcript(S1, at="2026-11-10T00:00:00Z")
        self.card(transcript=str(f), at=_epoch("2026-11-10T01:00:00Z"))
        with mock.patch.object(hibernate, "registry", return_value={}):
            self.assertEqual(len(hibernate.view([], Sh(), fresh=True)["cards"]), 1)
            # Resumed, a turn, /exit: a newer message, no live process.
            self.transcript(S1, at="2026-11-10T02:00:00Z")
            self.assertEqual(hibernate.view([], Sh(), fresh=True)["cards"], [])

    def test_a_wake_that_never_came_up_offers_wake_again(self):
        self.card(wokeAt=time.time() - 600)
        with mock.patch.object(hibernate, "registry", return_value={}):
            self.assertIsNone(hibernate.view([], Sh(), fresh=True)["cards"][0]["wokeAt"])

    def test_bad_sid_and_no_card(self):
        self.assertEqual(hibwake.wake("../x", Sh())[0], 400)
        self.assertEqual(hibwake.wake(S1, Sh())[0], 404)


class ActTest(Home):
    def test_pin_and_unpin(self):
        hibernate.act({"kind": "hibernate_pin", "sid": S1}, [])
        self.assertIn(S1, hibstate.pins())
        hibernate.act({"kind": "hibernate_pin", "sid": S1, "on": False}, [])
        self.assertNotIn(S1, hibstate.pins())
        self.assertNotIn("pins.json", [c.get("sid") for c in hibstate.cards()])

    def test_all_uses_the_servers_list_not_the_pages(self):
        with mock.patch.object(hibernate, "candidates", return_value=[]) as c, mock.patch.object(hibernate, "sleep") as s:
            code, out = hibernate.act({"kind": "hibernate_all", "sids": [S1, S2]}, [], sh=Sh())
        self.assertEqual(code, 200)
        self.assertTrue(c.called)
        self.assertFalse(s.called)

    def test_auto_off_and_pressure(self):
        (self.home / "office.json").write_text(json.dumps({"hibernate": {"auto": "off"}}))
        self.assertEqual(hibernate.auto_tick(lambda: self.fail("asked")), [])
        (self.home / "office.json").write_text(json.dumps({"hibernate": {"auto": "pressure"}}))
        with mock.patch.object(hibernate, "pressure", return_value={"on": False}):
            self.assertEqual(hibernate.auto_tick(lambda: self.fail("asked")), [])
        with mock.patch.object(hibernate, "pressure", return_value={"on": True}), mock.patch.object(hibernate, "candidates", return_value=[{"sid": S1}]), \
                mock.patch.object(hibernate, "sleep", return_value=(200, {})) as s, mock.patch.object(hibernate, "context", return_value={}):
            self.assertEqual(hibernate.auto_tick(lambda: [{"id": S1}]), [S1])
        self.assertEqual(s.call_args.kwargs["extra"]["auto"], "pressure")

    def test_view_answers_at_once_from_the_last_pass(self):
        hibernate._view.update(at=time.time(), out={"cards": [{"sid": S1}]})
        self.assertEqual(hibernate.view([])["cards"], [{"sid": S1}])
        hibernate._view.update(at=0.0, out=None, busy=True)
        self.assertEqual(hibernate.view([])["candidates"], [])


class PlaceholderTest(Home):
    def test_placeholder_prints_the_card(self):
        hibstate._write(os.path.join(hibstate.folder(), S1 + ".json"), {"sid": S1, "name": "w", "summary": "office 작업", "cwd": "/tmp", "mb": 700, "at": time.time(),
                                                                        "turn": {"ask": "해 줘", "said": "됐습니다"}, "launch": {"argv": ["/usr/bin/true"], "root": "launcher", "env": {}}})
        r = subprocess.run([sys.executable, str(OFFICE / "hibernate.py"), "placeholder", S1], input="", capture_output=True, text=True, timeout=20, env={**os.environ})
        self.assertIn("💤 휴면: office 작업", r.stdout)
        self.assertIn("마지막 요청: 해 줘", r.stdout)


class PageTest(unittest.TestCase):
    """hibernate.js under node: the foot line and its rows."""

    def test_foot_and_rows(self):
        script = r"""
        const vm = require('vm'), fs = require('fs')
        const el = () => ({ style: {}, dataset: {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] })
        const ctx = { console, JSON, Math, Date, setTimeout: () => 0, document: { createElement: el, head: el() } }
        vm.createContext(ctx)
        vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), ctx)
        vm.runInContext(`
          var cmdEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
          var cmd = { data: { coordinators: [{ sid: 'c' }], hibernate: { cards: [{ sid: 'a', name: 'w', summary: '<b>x</b>', mb: 700, at: 1, turn: { ask: 'q' }, dropped: [] }], candidates: [{ sid: 'b', name: 'n', idleH: 13, mb: 2048 }], mb: 2048, pins: ['b'], pressure: { on: true }, auto: 'pressure' } } }
          var out = { foot: hibFoot() }; hib.open = true; out.open = hibFoot(); out.coordBtn = hibButtons('c'); out.pinned = hibButtons('b')
          out.empty = (cmd.data.hibernate = { cards: [], candidates: [], pins: [] }, hibFoot())
        `, ctx)
        console.log(JSON.stringify(ctx.out))
        """
        r = subprocess.run(["node", "-e", script, str(OFFICE / "hibernate.js")], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertIn("💤 휴면 1", out["foot"])
        self.assertIn("휴면 후보 1개</button> · 회수 예상 2.0 GB", out["foot"])
        self.assertIn("자동 휴면 켜짐", out["foot"])
        self.assertNotIn("깨우기", out["foot"])  # folded
        self.assertIn('data-hib="wake" data-sid="a"', out["open"])
        self.assertIn("&lt;b&gt;x", out["open"])
        self.assertEqual(out["coordBtn"], "")
        self.assertIn("pin on", out["pinned"])
        self.assertEqual(out["empty"], "")

    def test_the_candidates_unfold_named_by_their_work_with_one_press_each(self):
        # "휴면 후보가 2개 있다는데 볼방법이 없어서 휴면을 시킬수가 없다": the names
        # were only in 모두 내리기's tooltip, as pane titles.
        script = r"""
        const vm = require('vm'), fs = require('fs')
        const el = () => ({ style: {}, dataset: {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] })
        const ctx = { console, JSON, Math, Date, setTimeout: () => 0, document: { createElement: el, head: el() } }
        vm.createContext(ctx)
        vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), ctx)
        vm.runInContext(`
          var cmdEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
          var posts = [], toasts = [], focused = [], renders = 0
          var cmdPost = async (b) => { posts.push(b); return { sent: 'ok' } }, toast = (m) => toasts.push(m), cmdLoad = () => {}, cmdRender = () => { renders++ }, focusPane = (p) => focused.push(p)
          var cmd = { data: { coordinators: [], hibernate: { cards: [], pins: ['b'], mb: 1433, candidates: [
            { sid: 'a', name: 'agent', summary: 'Dynamic cell 준비 히스토리', pane: '%22', window: '2:1', idleH: 2.7, mb: 744, why: 'cap' },
            { sid: 'b', name: 'rca', pane: '%629', idleH: 13, mb: 689, why: 'idle' }] } } }
          var btn = (hibv, sid, pane) => ({ target: { closest: () => ({ dataset: { hib: hibv, sid, pane } }) } })
          var out = { folded: hibFoot() }
          hibClick(btn('cands'))
          out.open = hibFoot()
          ;(async () => {
            hibClick(btn('one', 'a')); out.armed = hibFoot(); out.postsAfterOne = posts.length
            await hibOne('a'); out.posts = posts.slice()
            await hibPin("b"); out.pin = posts[posts.length - 1]
            hibClick(btn('go', '', '%22')); out.focused = focused
            console.log(JSON.stringify(out))
          })()
        `, ctx)
        """
        r = subprocess.run(["node", "-e", script, str(OFFICE / "hibernate.js")], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertNotIn("hiblist cand", out["folded"])
        self.assertIn("▸ 휴면 후보 2개", out["folded"])
        self.assertIn("▾ 휴면 후보 2개", out["open"])
        # A row each: its work (else its name), idle, what it gives back, why.
        self.assertIn("<b>Dynamic cell 준비 히스토리</b>", out["open"])
        self.assertIn("2.7시간 idle · ~744 MB · 세션 상한 · 2:1", out["open"])
        self.assertIn("<b>rca</b>", out["open"])
        self.assertIn("13시간 idle · ~689 MB · idle", out["open"])
        self.assertIn("📌 고정 해제", out["open"])  # b is pinned
        self.assertIn('data-hib="go" data-pane="%22"', out["open"])
        # 💤 휴면: the first press arms, only the second sends.
        self.assertIn("한 번 더: 💤 휴면", out["armed"])
        self.assertEqual(out["postsAfterOne"], 0)
        self.assertEqual(out["posts"], [{"kind": "hibernate", "sid": "a"}])
        self.assertEqual(out["pin"], {"kind": "hibernate_pin", "sid": "b", "on": False})
        self.assertEqual(out["focused"], ["%22"])

    def test_esc_takes_back_an_armed_sleep_then_folds_the_candidates_before_the_view(self):
        script = r"""
        const vm = require('vm'), fs = require('fs'), path = require('path')
        const el = () => ({ style: {}, dataset: {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] })
        const ctx = { console, JSON, Math, Date, setTimeout: () => 0, document: { createElement: el, head: el() } }
        vm.createContext(ctx)
        vm.runInContext(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'layers.js'), 'utf8'), ctx)
        vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), ctx)
        vm.runInContext(`
          var cmdEsc = (s) => String(s ?? ''), toast = () => {}, cmdLoad = () => {}, cmdRender = () => {}, cmdPost = async () => ({})
          var cmd = { on: true, data: { coordinators: [], hibernate: { cards: [], pins: [], mb: 1, candidates: [{ sid: 'a', name: 'n', idleH: 3, mb: 1, why: 'cap' }] } } }
          var closed = []
          layerUp('command', () => cmd.on, () => { cmd.on = false; closed.push('command') })
          hibCandFold(true)
          hibOne('a')
          var out = { top: layerTop(), armed: !!hib.oneArmed }
          layerEsc(); out.afterFirst = [hib.candOpen, !!hib.oneArmed, layerTop()]
          layerEsc(); out.afterSecond = [hib.candOpen, layerTop()]
          layerEsc(); out.afterThird = closed
          console.log(JSON.stringify(out))
        `, ctx)
        """
        r = subprocess.run(["node", "-e", script, str(OFFICE / "hibernate.js")], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual((out["top"], out["armed"]), ("hibcands", True))
        self.assertEqual(out["afterFirst"], [True, False, "hibcands"])
        self.assertEqual(out["afterSecond"], [False, "command"])
        self.assertEqual(out["afterThird"], ["command"])


if __name__ == "__main__":
    unittest.main()
