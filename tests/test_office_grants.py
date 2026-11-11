"""One-shot grants (office/grants.py): a press on a brief option that declares
a Slack send allows that one send of that worker, and nothing else does."""

import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import command  # noqa: E402
import grants  # noqa: E402
import office  # noqa: E402
from test_office_command import COORD, WORKER, BriefsCase  # noqa: E402

BIN = pathlib.Path(__file__).parents[1] / "bin"
CH = "C03GA4WGBCK"
TS = "1731300000.123456"
TEXT = "*1. What did you work on yesterday?*\n• grants\n"
OTHER = "f0000000-0000-0000-0000-000000000009"


class GrantsCase(BriefsCase):
    def setUp(self):
        super().setUp()
        grants._grants.clear()
        for t in grants._open.values():
            t.cancel()
        grants._open.clear()
        # session_policy.py, faked: every call it gets, in order.
        self.hooks = self.tmp / "hooks"
        self.hooks.mkdir()
        self.calls = self.tmp / "calls.jsonl"
        fake = self.hooks / "session_policy.py"
        fake.write_text(
            "import json, os, sys\n"
            f"open({str(self.calls)!r}, 'a').write(json.dumps([os.environ.get('CLAUDE_CODE_SESSION_ID'), *sys.argv[1:]]) + '\\n')\n"
        )
        for attr, val in (("HOOKS", str(self.hooks) + "/"), ("OPEN_FILE", str(self.tmp / "grants-open.json"))):
            p = mock.patch.object(grants, attr, val)
            p.start()
            self.addCleanup(p.stop)
        self.ledger([{"slug": "daily", "sid": WORKER, "relation": "owned"}])

    def policy_calls(self) -> list:
        return [json.loads(x) for x in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def ask(self, text: str = TEXT, worker: str = "daily") -> str:
        f = self.brief("2026-11-11-send", {"question": "보낼까요?", "options": [{"label": "보내기", "detail": ""}, {"label": "고치기", "detail": ""}], "coordinator": COORD, "worker": worker})
        side = self.side(f)
        side["decisions"] = [{**side["decision"], "id": "q1"}]
        (self.repo / f.replace(".html", ".brief.json")).write_text(json.dumps(side, ensure_ascii=False))
        tf = self.tmp / "msg.txt"
        tf.write_text(text)
        r = subprocess.run([sys.executable, str(BIN / "brief-grant"), f, "보내기", "--slack", CH.lower(), "--thread", TS, "--text-file", str(tf)], capture_output=True, text=True, env={**os.environ, "BRIEFS_DIR": str(self.link)})
        self.assertEqual(r.returncode, 0, r.stderr)
        command._side.clear()
        return f

    def drawn(self, f: str) -> dict:
        return command._decisions(command._read_side(f, fresh=True))[0]["grants"]["보내기"]


class DeclareTest(GrantsCase):
    def test_brief_grant_declares_the_action_on_the_option_and_the_page_gets_it_with_a_digest(self):
        f = self.ask()
        g = self.drawn(f)
        self.assertEqual((g["kind"], g["channel"], g["thread"], g["text"]), ("slack_send", CH, TS, TEXT))
        self.assertEqual(g["digest"], grants.digest(g))
        # The CLI's mirror for readers from before `decisions`.
        self.assertEqual(self.side(f)["decision"]["grants"]["보내기"]["channel"], CH)
        # Declaring grants nothing.
        self.assertEqual(grants.live(), [])

    def test_brief_grant_refuses_a_bad_target_an_unknown_option_and_an_answered_question(self):
        f = self.ask()
        tf = self.tmp / "m.txt"
        tf.write_text("x")
        run = lambda *a: subprocess.run([sys.executable, str(BIN / "brief-grant"), f, *a, "--text-file", str(tf)], capture_output=True, text=True, env={**os.environ, "BRIEFS_DIR": str(self.link)})
        self.assertEqual(run("보내기", "--slack", "#general").returncode, 2)
        self.assertEqual(run("없는것", "--slack", CH).returncode, 2)
        self.assertEqual(run("보내기", "--slack", CH, "--thread", "yesterday").returncode, 2)
        command.answer(f, "q1", "고치기", "", self.put)
        self.assertIn("already answered", run("보내기", "--slack", CH).stderr)

    def test_a_declaration_on_an_option_the_question_lacks_is_not_drawn(self):
        f = self.ask()
        side = self.side(f)
        side["decisions"][0]["grants"]["몰래"] = side["decisions"][0]["grants"]["보내기"]
        side["decisions"][0]["grants"]["고치기"] = {"kind": "slack_send", "channel": "general", "text": "x"}
        (self.repo / f.replace(".html", ".brief.json")).write_text(json.dumps(side, ensure_ascii=False))
        command._side.clear()
        self.assertEqual(sorted(command._decisions(command._read_side(f, fresh=True))[0]["grants"]), ["보내기"])


class PressTest(GrantsCase):
    def test_the_press_grants_that_send_to_the_ledgers_worker_and_the_answer_says_so(self):
        f = self.ask()
        code, out = command.answer(f, "q1", "보내기", "", self.put, seen=self.drawn(f)["digest"])
        self.assertEqual(code, 200, out)
        self.assertIn("허가: " + CH, out["sent"])
        [g] = grants.live()
        self.assertEqual((g["sid"], g["channel"], g["thread"], g["hash"]), (WORKER, CH, TS, grants.text_hash(TEXT)))
        self.assertIn("[granted: one Slack send to " + CH + " thread " + TS, self.sent[-1][1])
        self.assertEqual(self.sent[-1][0], COORD)

    def test_the_other_option_or_own_words_grant_nothing(self):
        f = self.ask()
        command.answer(f, "q1", "고치기", "", self.put)
        self.assertEqual(grants.live(), [])
        self.assertNotIn("granted", self.sent[-1][1])

    def test_a_declaration_changed_after_the_page_drew_it_is_refused(self):
        f = self.ask()
        seen = self.drawn(f)["digest"]
        side = self.side(f)
        side["decisions"][0]["grants"]["보내기"]["text"] = "something else"
        (self.repo / f.replace(".html", ".brief.json")).write_text(json.dumps(side, ensure_ascii=False))
        command._side.clear()
        code, out = command.answer(f, "q1", "보내기", "", self.put, seen=seen)
        self.assertEqual(code, 409)
        self.assertEqual(grants.live(), [])
        self.assertIsNone(self.side(f)["decisions"][0]["answer"])

    def test_a_press_without_the_drawn_digest_is_refused(self):
        f = self.ask()
        self.assertEqual(command.answer(f, "q1", "보내기", "", self.put)[0], 409)
        self.assertEqual(grants.live(), [])

    def test_a_worker_of_that_slug_under_another_coordinator_is_not_the_grantee(self):
        (self.coords / "other.json").write_text(json.dumps({"sid": "d0000000-0000-0000-0000-000000000004", "on": True, "workers": [{"slug": "dup", "sid": OTHER}]}))
        self.ledger([{"slug": "daily", "sid": WORKER, "relation": "owned"}])
        f = self.ask(worker="dup")
        self.assertEqual(command.answer(f, "q1", "보내기", "", self.put, seen=self.drawn(f)["digest"])[0], 409)
        self.assertEqual(grants.live(), [])

    def test_no_live_worker_of_that_slug_no_grant(self):
        f = self.ask(worker="gone")
        code, out = command.answer(f, "q1", "보내기", "", self.put, seen=self.drawn(f)["digest"])
        self.assertEqual(code, 409)
        self.assertIn("no live worker", out["error"])
        self.assertEqual(grants.live(), [])

    def test_brief_answer_by_the_cli_is_not_a_press(self):
        # `brief answer … --by office` from a session writes the sidecar;
        # only the office's /act handler issues grants.
        f = self.ask()
        side = self.side(f)
        side["decisions"][0]["answer"] = {"choice": "보내기", "note": "", "by": "office", "at": "2026-11-11T00:00Z"}
        (self.repo / f.replace(".html", ".brief.json")).write_text(json.dumps(side, ensure_ascii=False))
        command._side.clear()
        command.pending()
        command.view([])
        self.assertEqual(grants.live(), [])


class RedeemTest(GrantsCase):
    def granted(self, text: str = TEXT) -> str:
        f = self.ask(text)
        self.assertEqual(command.answer(f, "q1", "보내기", "", self.put, seen=self.drawn(f)["digest"])[0], 200)
        return f

    def redeem(self, **kw) -> tuple[int, dict]:
        return grants.redeem({"sid": WORKER, "kind": "slack_send", "channel": CH, "thread": TS, "text": TEXT, **kw})

    def test_the_matching_send_opens_its_channel_once_and_done_closes_it(self):
        self.granted()
        code, out = self.redeem(text=TEXT.replace("\n", "\r\n") + "  ")  # line ends and trailing spaces do not matter
        self.assertEqual(code, 200, out)
        self.assertEqual(self.policy_calls(), [[WORKER, "allow", "slack_send", "--scope", CH]])
        self.assertEqual(self.redeem()[0], 403)  # spent
        self.assertEqual(grants.redeem({"sid": WORKER, "kind": "slack_send", "channel": CH, "done": True})[0], 200)
        self.assertEqual(self.policy_calls()[-1], [WORKER, "inherit", "slack_send", "--scope", CH])
        self.assertEqual(grants._open, {})

    def test_the_channel_closes_by_itself_when_no_done_comes(self):
        self.granted()
        with mock.patch.object(grants, "OPEN_S", 0.05):
            self.assertEqual(self.redeem()[0], 200)
            threading.Event().wait(0.4)
        self.assertEqual(self.policy_calls()[-1], [WORKER, "inherit", "slack_send", "--scope", CH])

    def test_another_text_thread_channel_or_session_is_refused_and_says_what_differs(self):
        self.granted()
        for kw, why in (({"text": "different"}, "message differs"), ({"thread": None}, "thread"), ({"channel": "C0999ZZZZ9"}, "not C0999ZZZZ9"), ({"sid": OTHER}, "no approved send")):
            code, out = self.redeem(**kw)
            self.assertEqual(code, 403, kw)
            self.assertIn(why, out["error"])
        self.assertEqual(self.policy_calls(), [])
        self.assertEqual(len(grants.live()), 1)  # not spent by a miss

    def test_done_for_a_channel_it_did_not_open_leaves_the_policy_alone(self):
        self.assertEqual(grants.redeem({"sid": WORKER, "kind": "slack_send", "channel": CH, "done": True})[0], 200)
        self.assertEqual(self.policy_calls(), [])

    def test_a_channel_left_open_by_a_stopped_office_is_closed_by_the_next(self):
        self.granted()
        self.assertEqual(self.redeem()[0], 200)
        self.assertEqual(json.loads(pathlib.Path(grants.OPEN_FILE).read_text()), [WORKER + " " + CH])
        # The office stops: its timers and memory are gone.
        for t in grants._open.values():
            t.cancel()
        grants._open.clear()
        self.assertEqual(grants.close_leftovers(), [WORKER + " " + CH])
        self.assertEqual(self.policy_calls()[-1], [WORKER, "inherit", "slack_send", "--scope", CH])
        self.assertEqual(json.loads(pathlib.Path(grants.OPEN_FILE).read_text()), [])

    def test_a_grant_expires(self):
        self.granted()
        later = grants.time.time() + grants.TTL_S + 1
        self.assertEqual(grants.live(now=later), [])

    def test_a_failed_open_keeps_the_grant(self):
        self.granted()
        with mock.patch.object(grants, "policy", return_value=False):
            self.assertEqual(self.redeem()[0], 500)
        self.assertEqual(len(grants.live()), 1)


class HttpTest(GrantsCase):
    def serve(self) -> str:
        srv = office.ThreadingHTTPServer(("127.0.0.1", 0), office.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_port}"

    def post(self, url: str, body: dict, token: str | None) -> tuple[int, dict]:
        h = {"Content-Type": "application/json"}
        if token is not None:
            h["X-Office-Token"] = token
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=h, method="POST")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw or b"{}")
            except ValueError:
                return e.code, {"raw": raw.decode()}

    def test_press_then_redeem_over_http_and_office_redeem_reads_the_token_itself(self):
        f = self.ask()
        base = self.serve()
        with mock.patch.object(office, "inbox_put"):
            code, out = self.post(base + "/act", {"kind": "brief_answer", "file": f, "qid": "q1", "label": "보내기", "seen": self.drawn(f)["digest"]}, office.TOKEN)
        self.assertEqual(code, 200, out)
        # No token: refused before anything is looked at.
        self.assertEqual(self.post(base + "/redeem", {"sid": WORKER, "kind": "slack_send", "channel": CH, "thread": TS, "text": TEXT}, None)[0], 403)
        # bin/office-redeem, as cc-mods runs it: the token from a 0600 file under HOME.
        home = pathlib.Path(tempfile.mkdtemp(dir=self.tmp))
        tok = home / ".claude" / "state" / "office" / "token"
        tok.parent.mkdir(parents=True)
        tok.write_text(office.TOKEN)
        tok.chmod(stat.S_IRUSR | stat.S_IWUSR)
        port = base.rsplit(":", 1)[1]
        r = subprocess.run([sys.executable, str(BIN / "office-redeem")], input=json.dumps({"sid": WORKER, "kind": "slack_send", "channel": CH, "thread": TS, "text": TEXT}), capture_output=True, text=True, env={**os.environ, "HOME": str(home), "CC_OFFICE_PORT": port})
        out = json.loads(r.stdout)
        self.assertEqual((r.returncode, out["status"], out["ok"]), (0, 200, True), out)
        r = subprocess.run([sys.executable, str(BIN / "office-redeem")], input=json.dumps({"sid": WORKER, "kind": "slack_send", "channel": CH, "thread": TS, "text": TEXT}), capture_output=True, text=True, env={**os.environ, "HOME": str(home), "CC_OFFICE_PORT": port})
        self.assertEqual(json.loads(r.stdout)["status"], 403)


class DialogKeyTest(unittest.TestCase):
    """A press on a permission dialog's option approves what the page drew."""

    def setUp(self):
        self.me = {"id": WORKER, "pane": "%9", "state": "waiting", "wid": "@1"}
        self.screen = ["Bash command", "  rm -rf node_modules", "Do you want to proceed?", "❯ 1. Yes", "  2. No"]
        for name, val in (("snapshot", lambda: [self.me]), ("capture", lambda pane: self.screen)):
            p = mock.patch.object(office, name, val)
            p.start()
            self.addCleanup(p.stop)
        self.keys = mock.patch.object(office.subprocess, "run", return_value=mock.Mock(returncode=0))
        self.run = self.keys.start()
        self.addCleanup(self.keys.stop)
        p = mock.patch.object(office, "set_mute")
        p.start()
        self.addCleanup(p.stop)

    def drawn(self) -> dict:
        return office.dialog(self.screen)

    def test_the_drawn_dialog_shows_what_it_asks_and_is_answered(self):
        d = self.drawn()
        self.assertEqual((d["question"], d["about"]), ("Do you want to proceed?", ["Bash command", "rm -rf node_modules"]))
        code, _ = office.act({"sid": WORKER, "kind": "key", "value": "1", "digest": d["digest"], "label": "Yes"})
        self.assertEqual(code, 200)
        self.assertEqual(self.run.call_args[0][0], ["tmux", "send-keys", "-t", "%9", "1"])

    def test_the_next_dialog_with_the_same_question_and_options_but_another_command_gets_no_key(self):
        d = self.drawn()
        self.screen = ["Bash command", "  git push --force origin main", "Do you want to proceed?", "❯ 1. Yes", "  2. No"]
        code, out = office.act({"sid": WORKER, "kind": "key", "value": "1", "digest": d["digest"], "label": "Yes"})
        self.assertEqual(code, 409)
        self.assertIn("changed", out["error"])
        self.run.assert_not_called()

    def test_a_press_that_names_nothing_it_saw_gets_no_key(self):
        self.assertEqual(office.act({"sid": WORKER, "kind": "key", "value": "1", "label": "Yes"})[0], 403)
        self.assertEqual(office.act({"sid": WORKER, "kind": "key", "value": "1", "digest": "0" * 16, "label": "Yes"})[0], 409)
        self.run.assert_not_called()

    def test_a_page_older_than_the_server_is_told_to_reload_not_left_pressing(self):
        # A page loaded before #108 sends no digest: 403 makes every page reload (staleToken).
        code, out = office.act({"sid": WORKER, "kind": "key", "value": "1"})
        self.assertEqual((code, out.get("stale")), (403, True))
        self.run.assert_not_called()

    def test_a_key_tmux_could_not_send_is_not_reported_sent(self):
        d = self.drawn()
        self.run.return_value = mock.Mock(returncode=1)
        self.assertEqual(office.act({"sid": WORKER, "kind": "key", "value": "1", "digest": d["digest"], "label": "Yes"})[0], 502)


def _row(left: str, right: str, w: int = 100) -> str:
    return left + " " * (w - office._cells(left)) + "││ " + right


def warren_screen(reqs: int, retry: int = 899) -> list[str]:
    """An AskUserQuestion with two questions and Submit, in a pane with a side
    panel at its right whose numbers change on their own (the screen of the
    press that did not go through)."""
    return [
        _row("⏺ Ran 1 shell command", "◆ claude-sendbird · opus-5-5 · medium"),
        _row("  why: conversation stays on its account", "accounts claude-personal 73%"),
        _row("◯ Goal not yet met… continuing", f"output ▁▂█ last 2520m · {reqs} requests"),
        "─" * 100 + "┼" + "─" * 30,
        _row("←  ☐ Slack 설치  ☐ 기본 쿼타  ✔ Submit  →", "Quota"),
        _row("", f"○ anthropic/legacy-1 cooling · retry_in={retry}s"),
        _row("warren Slack app 설치 요청(관리자에게 감)을 지금 제출할까요?", "5h 47% · 7d 0%"),
        _row("", ""),
        _row("❯ 1. 지금 제출 (Recommended)", "models opus 98%"),
        _row("  2. 제출하지 않음", ""),
        _row("  3. Type something.", ""),
        _row("  4. Chat about this", f"{reqs} reqs"),
    ]


class ChoiceBesidePanelTest(unittest.TestCase):
    """A choice window (AskUserQuestion) in a pane with a side panel."""

    def test_the_panel_is_not_the_question_nor_what_it_asks(self):
        d = office.dialog(warren_screen(1412))
        self.assertEqual(d["question"], "warren Slack app 설치 요청(관리자에게 감)을 지금 제출할까요?")
        self.assertEqual(d["about"], ["←  ☐ Slack 설치  ☐ 기본 쿼타  ✔ Submit  →"])
        self.assertEqual([o["label"] for o in d["options"]], ["지금 제출 (Recommended)", "제출하지 않음", "Type something.", "Chat about this"])

    def test_the_panel_moving_on_its_own_keeps_the_digest_so_the_press_goes_through(self):
        drawn = office.dialog(warren_screen(1412))
        now = warren_screen(1413, retry=870)
        self.assertEqual(office.dialog(now)["digest"], drawn["digest"])
        me = {"id": WORKER, "pane": "%9", "state": "waiting"}
        with mock.patch.object(office, "snapshot", return_value=[me]), mock.patch.object(office, "capture", return_value=now), \
                mock.patch.object(office.subprocess, "run", return_value=mock.Mock(returncode=0)) as run, mock.patch.object(office, "set_mute"):
            code, _ = office.act({"sid": WORKER, "kind": "key", "value": "1", "digest": drawn["digest"], "label": "지금 제출 (Recommended)"})
        self.assertEqual(code, 200)
        self.assertEqual(run.call_args[0][0], ["tmux", "send-keys", "-t", "%9", "1"])

    def test_the_next_question_of_the_same_window_is_another_digest(self):
        a = office.dialog(warren_screen(1412))
        nxt = warren_screen(1412)
        nxt[6] = _row("기본 쿼타를 정할까요?", "5h 47% · 7d 0%")
        self.assertNotEqual(office.dialog(nxt)["digest"], a["digest"])

    def test_scrollback_above_the_rule_is_not_what_it_asks(self):
        screen = ["⏺ Bash(ls)", "  ⎿  a b c", "─" * 60, "Bash command", "  rm -rf node_modules", "Do you want to proceed?", "❯ 1. Yes", "  2. No"]
        self.assertEqual(office.dialog(screen)["about"], ["Bash command", "rm -rf node_modules"])

    def test_a_box_in_the_chat_is_not_a_panel(self):
        screen = ["╭" + "─" * 40 + "╮", "│ note" + " " * 35 + "│", "╰" + "─" * 40 + "╯", "Proceed?", "❯ 1. Yes", "  2. No", "  3. Later"]
        d = office.dialog(screen)
        self.assertEqual((d["question"], len(d["options"])), ("Proceed?", 3))


if __name__ == "__main__":
    unittest.main()
