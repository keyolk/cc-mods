import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import textwrap
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
import command  # noqa: E402
import coord  # noqa: E402
import office  # noqa: E402
import review  # noqa: E402
import slx  # noqa: E402

COORD = "c0000000-0000-0000-0000-000000000001"
WORKER = "a0000000-0000-0000-0000-000000000002"
MAKER = "b0000000-0000-0000-0000-000000000003"


class BriefsCase(unittest.TestCase):
    """A briefs folder reached through a symlink, as ~/briefs is, and a
    coordinators' folder, both temporary."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = pathlib.Path(tmp.name)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.link = self.tmp / "briefs"
        self.link.symlink_to(self.repo)
        self.coords = self.tmp / "coord"
        self.coords.mkdir()
        self.sums = self.tmp / "summary.json"
        for target, attr, value in ((command, "BRIEFS", str(self.link)), (coord, "COORD_DIR", str(self.coords)), (coord, "SUMMARY_FILE", str(self.sums))):
            p = mock.patch.object(target, attr, value)
            p.start()
            self.addCleanup(p.stop)
        self.cli = mock.patch.object(command, "brief_bin", return_value=None)
        self.cli.start()
        self.addCleanup(self.cli.stop)
        # The view reads this machine's transcripts for what the person
        # handled (office/handled.py): none here.
        import handled
        p = mock.patch.object(handled, "ROOT", str(self.tmp / "projects"))
        p.start()
        self.addCleanup(p.stop)
        handled._files.clear()
        handled._list.update(at=0.0, paths=[])
        # The view reads the slx inbox; this machine's slx must not answer.
        p = mock.patch.object(slx, "binary", return_value=None)
        p.start()
        self.addCleanup(p.stop)
        slx._cache.update(at=0.0, out=None)
        coord._cache.update(at=0.0, ledgers=[])
        coord._sums.update(at=0.0, sums={})
        command._side.clear()
        command._title.clear()
        # A first prompt and a repository name are cached per session and folder.
        command._first.clear()
        command._repo.clear()
        command._pending.update(at=0.0, items=[])
        command._no_pending["until"] = 0.0
        self.sent: list[tuple[str, str]] = []
        self.kept: list[bool] = []

    def put(self, sid: str, text: str, keep: bool = False) -> None:
        self.sent.append((sid, text))
        self.kept.append(keep)

    def brief(self, name: str, decision: dict | None = None, sessions: tuple = (MAKER,), title: str = "제목") -> str:
        file = name + ".html"
        (self.repo / file).write_text(f"<html><head><title>{title}</title></head><body>x</body></html>")
        side = {"sessions": [{"id": s, "cwd": "/", "transcript": "", "added": "2026-11-08T00:00Z"} for s in sessions], "published": {}}
        if decision is not None:
            side["decision"] = {"question": "어느 쪽?", "options": [{"label": "A", "detail": "a"}, {"label": "B", "detail": "b"}], "recommended": 1, "coordinator": None, "worker": None, "asked": "2026-11-08T01:00Z", "answer": None, **decision}
        (self.repo / (name + ".brief.json")).write_text(json.dumps(side, ensure_ascii=False))
        return file

    def ledger(self, workers: list[dict], on: bool = True, log: list | None = None) -> None:
        (self.coords / f"{COORD}.json").write_text(json.dumps({"sid": COORD, "on": on, "name": "cc-mods-d9", "workers": workers, "log": log or []}))
        coord._cache.update(at=0.0, ledgers=[])

    def side(self, file: str) -> dict:
        return json.loads((self.repo / file.replace(".html", ".brief.json")).read_text())


class BriefPathTest(BriefsCase):
    def test_an_html_in_the_folder_through_the_symlink(self):
        f = self.brief("2026-11-08-a")
        self.assertEqual(command.brief_path(str(self.link / f)), str((self.repo / f).resolve()))

    def test_dotdot_and_links_out_and_other_types_are_refused(self):
        self.brief("2026-11-08-a")
        outside = self.tmp / "secret.html"
        outside.write_text("secret")
        (self.repo / "2026-11-08-escape.html").symlink_to(outside)
        (self.repo / "sub").mkdir()
        (self.repo / "sub" / "x.html").write_text("x")
        (self.repo / "notes.txt").write_text("x")
        for p in (self.link / ".." / "secret.html", self.link / "2026-11-08-escape.html", self.link / "sub" / "x.html", self.link / "notes.txt", self.link / "missing.html", self.link):
            self.assertIsNone(command.brief_path(str(p)), p)

    def test_the_office_viewer_serves_a_brief_to_any_session_but_not_an_escape(self):
        f = self.brief("2026-11-08-a")
        outside = self.tmp / "secret.html"
        outside.write_text("secret")
        (self.repo / "2026-11-08-escape.html").symlink_to(outside)
        with mock.patch.object(office, "related", return_value=[]):
            code, body, kind, extra = office.viewable("any", str(self.link / f))
            self.assertEqual(code, 200)
            self.assertIn(b"<title>", body)
            self.assertIn("sandbox", extra["Content-Security-Policy"])
            self.assertEqual(office.viewable("any", str(self.link / "2026-11-08-escape.html"))[0], 403)
            self.assertEqual(office.viewable("any", str(self.link / ".." / "secret.html"))[0], 403)


class BriefFrameTest(BriefsCase):
    """The links inside a framed brief (← 모든 브리프, another brief) and ↗ 밖으로."""

    def serve(self):
        srv = office.ThreadingHTTPServer(("127.0.0.1", 0), office.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_port}"

    def get(self, url):
        try:
            with urllib.request.urlopen(url) as r:
                return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def test_the_index_and_a_sibling_resolve_beside_the_brief(self):
        f = self.brief("2026-11-08-a")
        (self.repo / "index.html").write_text("<html><body>list</body></html>")
        base = self.serve()
        code, body, h = self.get(base + "/briefs/" + f)
        self.assertEqual(code, 200)
        self.assertIn(b"officeBrief", body)  # tells the page which brief its frame shows
        self.assertIn("sandbox", h["Content-Security-Policy"])
        # What <a href="index.html"> resolves to from /briefs/<f>:
        code, body, _ = self.get(base + "/briefs/index.html")
        self.assertEqual(code, 200)
        self.assertIn(b"list", body)
        self.assertNotIn(b"cc-office", body)

    def test_only_a_file_directly_in_the_folder_is_served(self):
        self.brief("2026-11-08-a")
        outside = self.tmp / "secret.html"
        outside.write_text("secret")
        (self.repo / "2026-11-08-escape.html").symlink_to(outside)
        (self.repo / "sub").mkdir()
        (self.repo / "sub" / "x.html").write_text("x")
        (self.repo / "notes.txt").write_text("x")
        base = self.serve()
        for path in ("2026-11-08-escape.html", "sub/x.html", "..%2Fsecret.html", "%2E%2E/secret.html", "notes.txt", "missing.html", ""):
            self.assertEqual(self.get(base + "/briefs/" + path)[0], 404, path)

    def test_the_brief_route_does_not_swallow_the_scripts(self):
        # /briefline.js shares the prefix: it must stay JavaScript.
        base = self.serve()
        code, body, h = self.get(base + "/briefline.js")
        self.assertEqual(code, 200)
        self.assertIn("javascript", h["Content-Type"])

    def test_nothing_frames_the_office_page(self):
        base = self.serve()
        for path in ("/", "/index.html"):
            _, _, h = self.get(base + path)
            self.assertEqual(h["Content-Security-Policy"], "frame-ancestors 'none'")
            self.assertEqual(h["X-Frame-Options"], "DENY")

    def test_open_outside_opens_the_brief_and_needs_no_session(self):
        f = self.brief("2026-11-08-a")
        with mock.patch.object(command.subprocess, "Popen") as popen:
            code, out = command.act({"kind": "brief_open", "file": f}, self.put)
        self.assertEqual(code, 200)
        popen.assert_called_once()
        self.assertEqual(popen.call_args[0][0], ["open", str((self.repo / f).resolve())])

    def test_a_picked_tweb_place_still_opens_with_open_never_tmux_chrome_open(self):
        # tmux-chrome-open lands in the caller's tmux window: the office's own pane.
        f = self.brief("2026-11-08-a")
        with mock.patch.object(command.subprocess, "Popen") as popen:
            self.assertEqual(command.act({"kind": "brief_open", "file": f, "via": "tweb-chrome"}, self.put)[0], 200)
            self.assertEqual(popen.call_args[0][0][0], "open")
        with mock.patch.object(command.subprocess, "Popen") as popen:
            self.assertEqual(command.act({"kind": "brief_open", "file": f, "via": "finder"}, self.put)[0], 400)
        popen.assert_not_called()

    def test_open_outside_refuses_what_is_not_a_brief(self):
        outside = self.tmp / "secret.html"
        outside.write_text("secret")
        (self.repo / "2026-11-08-escape.html").symlink_to(outside)
        for name in ("2026-11-08-escape.html", "../secret.html", "/etc/passwd", "", "sub/x.html"):
            with mock.patch.object(command.subprocess, "Popen") as popen:
                self.assertEqual(command.act({"kind": "brief_open", "file": name}, self.put)[0], 404, name)
            popen.assert_not_called()

    def test_the_office_routes_the_kind_without_a_session(self):
        f = self.brief("2026-11-08-a")
        with mock.patch.object(command.subprocess, "Popen"):
            self.assertEqual(office.act({"kind": "brief_open", "file": f})[0], 200)


class PendingTest(BriefsCase):
    def test_unanswered_decisions_longest_waiting_first(self):
        self.brief("2026-11-08-late", {"asked": "2026-11-08T03:00Z"})
        self.brief("2026-11-07-early", {"asked": "2026-11-08T02:00Z"}, title="이른 것")
        self.brief("2026-11-08-done", {"answer": {"choice": "A", "note": None, "by": "office", "at": "x"}})
        self.brief("2026-11-08-plain")
        got = command.pending()
        self.assertEqual([i["file"] for i in got], ["2026-11-07-early.html", "2026-11-08-late.html"])
        self.assertEqual(got[0]["title"], "이른 것")
        self.assertEqual(got[0]["decision"]["recommended"], 1)

    def test_the_cli_list_wins_when_it_answers(self):
        self.brief("2026-11-08-a", {})
        self.brief("2026-11-08-b", {})
        with mock.patch.object(command, "_cli_pending", return_value={"2026-11-08-b.html": None}):
            self.assertEqual([i["file"] for i in command.pending()], ["2026-11-08-b.html"])

    def test_an_older_cli_is_not_asked_on_every_poll(self):
        self.brief("2026-11-08-a", {})
        old = mock.Mock(returncode=2, stdout="", stderr="invalid choice: 'pending'")
        with mock.patch.object(command, "_cli", return_value=old) as cli:
            command._no_pending["until"] = 0.0
            self.assertEqual(len(command.pending()), 1)
            command._pending["at"] = 0.0
            self.assertEqual(len(command.pending()), 1)
        self.assertEqual(cli.call_count, 1)

    def test_latest_brief_per_session(self):
        self.brief("2026-11-01-old", sessions=(MAKER,))
        self.brief("2026-11-08-new", {}, sessions=(MAKER, WORKER))
        got = command.latest_by_session()
        self.assertEqual(got[MAKER]["file"], "2026-11-08-new.html")
        self.assertTrue(got[WORKER]["pending"])


class AnswerTest(BriefsCase):
    def test_recorded_in_the_sidecar_and_sent_to_the_coordinator(self):
        f = self.brief("2026-11-08-a", {"coordinator": COORD, "worker": "w"})
        code, out = command.answer(f, "", "B", " 이걸로 ", self.put)
        self.assertEqual(code, 200, out)
        self.assertEqual(out["via"], "sidecar")
        ans = self.side(f)["decision"]["answer"]
        self.assertEqual((ans["choice"], ans["note"], ans["by"]), ("B", "이걸로", "office"))
        self.assertEqual(self.sent, [(COORD, f"[brief answer] {f}: B — 이걸로")])
        self.assertEqual(command.answer(f, "", "A", "", self.put)[0], 409)

    def test_without_a_coordinator_the_worker_then_the_maker(self):
        self.ledger([{"slug": "w", "sid": WORKER}])
        f = self.brief("2026-11-08-a", {"worker": "w"})
        self.assertEqual(command.answer(f, "", "A", "", self.put)[0], 200)
        g = self.brief("2026-11-08-b", {})
        self.assertEqual(command.answer(g, "", "A", "", self.put)[0], 200)
        self.assertEqual(self.sent, [(WORKER, f"[brief answer] {f}: A"), (MAKER, f"[brief answer] {g}: A")])

    def test_refusals(self):
        f = self.brief("2026-11-08-a", {"coordinator": "../../etc"})
        self.assertEqual(command.answer(f, "", "C", "", self.put)[0], 400)
        self.assertEqual(command.answer("../x.html", "", "A", "", self.put)[0], 404)
        self.assertEqual(command.answer(self.brief("2026-11-08-plain"), "", "A", "", self.put)[0], 409)
        # A coordinator id that is not one is never a path to write to.
        self.assertEqual(command.answer(f, "", "A", "", self.put)[0], 200)
        self.assertEqual(self.sent, [(MAKER, f"[brief answer] {f}: A")])

    def fake_cli(self, script: str) -> None:
        self.cli.stop()
        exe = self.tmp / "brief"
        exe.write_text("#!/usr/bin/env python3\n" + script)
        exe.chmod(0o755)
        p = mock.patch.object(command, "brief_bin", return_value=str(exe))
        p.start()
        self.addCleanup(p.stop)

    def test_the_cli_answers_when_it_can(self):
        self.fake_cli(
            "import json, sys\n"
            "brief, qid, label = sys.argv[2], sys.argv[3], sys.argv[4]\n"
            "side = brief[:-5] + '.brief.json'\n"
            "d = json.load(open(side))\n"
            "d['decision']['answer'] = {'choice': label, 'note': None, 'by': sys.argv[6], 'at': 'cli'}\n"
            "json.dump(d, open(side, 'w'))\n"
        )
        f = self.brief("2026-11-08-a", {"coordinator": COORD})
        code, out = command.answer(f, "", "A", "", self.put)
        self.assertEqual((code, out["via"]), (200, "cli"))
        self.assertEqual(self.side(f)["decision"]["answer"]["at"], "cli")

    def test_an_older_cli_falls_back_to_the_sidecar(self):
        self.fake_cli("import sys\nsys.stderr.write(\"invalid choice: 'answer'\\n\")\nsys.exit(2)\n")
        f = self.brief("2026-11-08-a", {"coordinator": COORD})
        code, out = command.answer(f, "", "A", "", self.put)
        self.assertEqual((code, out["via"]), (200, "sidecar"))
        self.assertEqual(self.side(f)["decision"]["answer"]["choice"], "A")


class FreeAndSeveralTest(BriefsCase):
    """Answers in the person's own words, and briefs asking several questions."""

    def multi(self, name: str, coordinator: str | None = COORD) -> str:
        file = name + ".html"
        (self.repo / file).write_text("<html><head><title>식대</title></head><body>x</body></html>")
        decs = [
            {"id": "q1", "question": "15,000원 넘는 식대는?", "options": [{"label": "A", "detail": "a"}, {"label": "B", "detail": "b"}], "recommended": 0, "coordinator": coordinator, "worker": "w", "asked": "2026-11-10T01:00Z", "answer": None},
            {"id": "q2", "question": "야근 식대 포함?", "options": [{"label": "예", "detail": ""}, {"label": "아니오", "detail": ""}], "recommended": None, "coordinator": coordinator, "worker": "w", "asked": "2026-11-10T01:00Z", "answer": None},
        ]
        side = {"sessions": [{"id": MAKER}], "decisions": decs, "decision": {**decs[0], "history": [{"question": "old"}]}}
        (self.repo / (name + ".brief.json")).write_text(json.dumps(side, ensure_ascii=False))
        return file

    WORDS = "15000원 기준으로 맞출수 있는걸 onetable에 넣고 나머진 환급 안함 처리"

    def test_a_free_answer_is_recorded_and_its_words_reach_the_coordinator(self):
        f = self.brief("2026-11-10-meals", {"coordinator": COORD})
        code, out = command.answer(f, "", "", "", self.put, text=f"  {self.WORDS} ")
        self.assertEqual(code, 200, out)
        ans = self.side(f)["decision"]["answer"]
        self.assertEqual((ans["choice"], ans["note"], ans["by"], ans["free"]), ("직접 답", self.WORDS, "office", True))
        self.assertEqual(self.sent, [(COORD, f"[brief answer] {f}: 직접 답 — {self.WORDS}")])
        self.assertEqual(command.pending(), [])

    def test_a_free_answer_refuses_a_label_beside_it(self):
        f = self.brief("2026-11-10-meals", {"coordinator": COORD})
        self.assertEqual(command.answer(f, "", "A", "", self.put, text="x")[0], 400)
        self.assertEqual(command.answer(f, "", "", "", self.put, text="   ")[0], 400)  # no words, no option
        self.assertIsNone(self.side(f)["decision"]["answer"])

    def test_pending_is_one_card_per_brief_with_every_question(self):
        f = self.multi("2026-11-10-meals")
        got = command.pending()
        self.assertEqual([(i["file"], [q["id"] for q in i["questions"]], i["decision"]["id"]) for i in got], [(f, ["q1", "q2"], "q1")])
        command.answer(f, "q1", "B", "", self.put)
        self.assertEqual(command.pending()[0]["decision"]["id"], "q2")

    def test_the_cli_list_is_read_per_question(self):
        f = self.multi("2026-11-10-meals")
        row = {"brief": str(self.link / f), "qid": "q2"}
        with mock.patch.object(command, "_cli", return_value=mock.Mock(returncode=0, stdout=json.dumps([row]), stderr="")):
            self.assertEqual(command._cli_pending(), {f: {"q2"}})
            got = command.pending()
        self.assertEqual(got[0]["decision"]["id"], "q2")
        # A CLI from before decisions[] names briefs only: all their questions.
        with mock.patch.object(command, "_cli", return_value=mock.Mock(returncode=0, stdout=json.dumps([{"brief": f}]), stderr="")):
            self.assertEqual(command._cli_pending(), {f: None})

    def test_the_coordinator_hears_once_when_the_last_question_is_answered(self):
        f = self.multi("2026-11-10-meals")
        code, out = command.answer(f, "q2", "", "", self.put, text="야근은 빼고")
        self.assertEqual((code, out["left"]), (200, 1), out)
        self.assertEqual(self.sent, [])
        side = self.side(f)
        self.assertEqual((side["decisions"][1]["answer"]["choice"], side["decision"]["id"], side["decision"]["history"]), ("직접 답", "q1", [{"question": "old"}]))
        code, out = command.answer(f, "q1", "B", " 영수증 확인 ", self.put)
        self.assertEqual((code, out["left"], out["to"]), (200, 0, COORD), out)
        self.assertEqual(self.sent, [(COORD, f"[brief answer] {f}: q1 B · q2 직접 답\n- q1 15,000원 넘는 식대는? → B — 영수증 확인\n- q2 야근 식대 포함? → 직접 답 — 야근은 빼고")])
        self.assertEqual(self.side(f)["decision"]["id"], "q2")  # all answered: the mirror is the last

    def test_several_questions_need_a_q_id_and_refuse_another_questions_option(self):
        f = self.multi("2026-11-10-meals")
        self.assertEqual(command.answer(f, "", "A", "", self.put)[0], 400)
        self.assertEqual(command.answer(f, "q9", "A", "", self.put)[0], 400)
        self.assertEqual(command.answer(f, "q2", "A", "", self.put)[0], 400)  # A is q1's
        self.assertEqual(command.answer(f, "q1", "A", "", self.put)[0], 200)
        self.assertEqual(command.answer(f, "q1", "B", "", self.put)[0], 409)

    def test_the_cli_is_asked_with_the_q_id_and_text(self):
        seen = []

        def cli(args):
            seen.append(args)
            return mock.Mock(returncode=2, stdout="", stderr="unrecognized arguments: --text")

        f = self.multi("2026-11-10-meals")
        with mock.patch.object(command, "_cli", side_effect=cli):
            code, out = command.answer(f, "q1", "", "", self.put, text="x")
        self.assertEqual((code, out["via"]), (200, "sidecar"))
        self.assertEqual(seen, [["answer", str(self.repo.resolve() / f), "q1", "--text", "x", "--by", "office"]])

    def test_the_cockpit_gets_a_row_per_open_question(self):
        f = self.multi("2026-11-10-meals")
        command.answer(f, "q1", "A", "", self.put)
        env = {**os.environ, "BRIEFS_DIR": str(self.link), "PATH": "/usr/bin:/bin"}
        with mock.patch.dict(os.environ, env):
            r = subprocess.run([sys.executable, str(pathlib.Path(command.__file__)), "pending"], capture_output=True, text=True, env={**env, "HOME": str(self.tmp)})
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = json.loads(r.stdout)
        self.assertEqual([(x["file"], x["qid"], x["decision"]["question"]) for x in rows], [(f, "q2", "야근 식대 포함?")])


class SayAndViewTest(BriefsCase):
    def test_an_instruction_goes_to_the_coordinator_never_the_worker(self):
        self.ledger([{"slug": "w", "sid": WORKER}, {"slug": "gone", "sid": MAKER, "endedAt": 1}])
        self.assertEqual(command.say(COORD, "w", "테스트 먼저", self.put)[0], 200)
        self.assertEqual(self.sent, [(COORD, "[office→coord] w: 테스트 먼저")])
        self.assertEqual(command.say(COORD, "gone", "x", self.put)[0], 404)
        self.assertEqual(command.say(COORD, "nobody", "x", self.put)[0], 404)
        self.assertEqual(command.say(WORKER, "w", "x", self.put)[0], 404)
        self.assertEqual(command.say(COORD, "w", "  ", self.put)[0], 400)

    def test_without_a_worker_the_instruction_is_for_the_coordinator(self):
        self.ledger([])
        self.assertEqual(command.say(COORD, "", "worker 하나 띄워", self.put)[0], 200)
        self.assertEqual(self.sent, [(COORD, "[office→coord] worker 하나 띄워")])
        self.assertEqual(command.say(WORKER, "", "x", self.put)[0], 404)

    def test_view_joins_ledgers_people_and_briefs(self):
        self.ledger([{"slug": "w", "sid": WORKER, "model": "opus", "effort": "high"}])
        f = self.brief("2026-11-08-a", {"coordinator": COORD, "worker": "w"}, sessions=(WORKER,))
        v = command.view([{"id": WORKER, "state": "waiting", "attention": "ask", "doing": "asking", "window": "w:1", "name": "w"}])
        c = v["coordinators"][0]
        self.assertEqual((c["name"], c["live"]), ("cc-mods-d9", False))
        w = c["workers"][0]
        self.assertEqual((w["slug"], w["model"], w["state"], w["attention"], w["brief"]["file"]), ("w", "opus", "waiting", "ask", f))
        self.assertEqual((v["pending"][0]["file"], v["pending"][0]["coordinatorName"], v["pending"][0]["to"]), (f, "cc-mods-d9", COORD))
        # Who waits on the person, and the briefs lately written, newest first.
        self.assertEqual([c["name"] for c in v["calls"]], ["w"])
        self.assertEqual((v["recent"][0]["file"], v["recent"][0]["by"], v["recent"][0]["pending"]), (f, "w", True))

    def test_a_coordinator_waits_in_the_table_only_for_a_call_on_its_pane(self):
        # cc-mods-d9 ended its turns on "결정 N건 대기 · brief에서 보내기를
        # 누르시면…": its pane said ask, and it stood in 내 차례 as a session to
        # answer beside the briefs that already asked it.
        self.ledger([{"slug": "w", "sid": WORKER}])
        coord_ = {"id": COORD, "state": "waiting", "attention": "ask", "doing": "asking", "name": "cc-mods-d9", "coord": True, "asks": ""}
        worker = {"id": WORKER, "state": "waiting", "attention": "ask", "doing": "asking", "name": "w", "asks": ""}
        v = command.view([coord_, worker])
        self.assertEqual([c["sid"] for c in v["calls"]], [WORKER])
        row = next(r for r in v["table"] if r["sid"] == COORD)
        self.assertEqual((row["call"], row["needs"]), (False, False))
        # A dialog or a permission drawn on its pane is the person's to answer.
        for attn, asks in (("ask", "Bash: git push"), ("alert", "Write ~/x")):
            v = command.view([{**coord_, "attention": attn, "asks": asks}, worker])
            self.assertEqual(sorted(c["sid"] for c in v["calls"]), sorted([COORD, WORKER]))
        self.assertTrue(command.waits_on_person({"attention": "ask"}))
        self.assertFalse(command.waits_on_person({"attention": "none", "coord": True, "asks": "x"}))

    def test_a_worker_row_carries_the_status_it_declared(self):
        # hooks/lib/status.ts: the coordinator's tick copies a worker's status
        # file into its ledger row; the view hands its fields to the 지휘 table.
        st = {"state": "blocked", "kind": "question", "step": "설계", "needs": "~/briefs/x.html", "progress": 40, "msg": "", "at": 1}
        self.ledger([{"slug": "w", "sid": WORKER, "status": st}, {"slug": "v", "sid": "v1", "status": {"state": "paused"}}, {"slug": "u", "sid": "u1"}])
        ws = {w["slug"]: w for w in command.view([{"id": WORKER, "name": "w"}])["coordinators"][0]["workers"]}
        self.assertEqual(ws["w"]["status"], {"state": "blocked", "kind": "question", "step": "설계", "needs": "~/briefs/x.html", "progress": 40, "at": 1})
        # A state it does not know, or none declared: no status.
        self.assertIsNone(ws["v"]["status"])
        self.assertIsNone(ws["u"]["status"])

    def test_the_table_says_a_workers_status_under_its_name(self):
        js = pathlib.Path(__file__).parents[1] / "office" / "table.js"
        prog = textwrap.dedent(r"""
            const vm = require('vm'), fs = require('fs')
            const el = () => ({ appendChild() {}, querySelector: () => null })
            const ctx = { console, JSON, Date, cmd: {}, document: { createElement: el, head: el(), addEventListener() {} } }
            vm.createContext(ctx)
            vm.runInContext(fs.readFileSync(process.argv[1], 'utf8') + `
              var a = tblStatus({ state: 'blocked', kind: 'question', step: '설계', needs: '~/briefs/x.html', progress: 40 })
              var b = tblStatus({ state: 'working', step: 'tests', next: 'PR 열기' })
              var c = tblStatus({ state: 'done', link: 'https://github.com/keyolk/cc-mods/pull/121', msg: 'merged' })
            `, ctx)
            console.log(JSON.stringify({ a: ctx.a, b: ctx.b, c: ctx.c }))
        """)
        r = subprocess.run(["node", "-e", prog, str(js)], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        j = json.loads(r.stdout)
        self.assertEqual(j["a"], "⏸ 결정 대기 40% · 설계 · ~/briefs/x.html")
        self.assertEqual(j["b"], "⚙ working · tests · PR 열기")
        self.assertEqual(j["c"], "✅ done · https://github.com/keyolk/cc-mods/pull/121")

    def test_the_table_puts_what_the_person_must_do_above_triggers_with_its_text_and_links(self):
        # office-gcl asked for a merge: it was row 4 of 28, named by its slug, its
        # needs text small and grey, under 24 Slack mentions.
        js = pathlib.Path(__file__).parents[1] / "office" / "table.js"
        prog = textwrap.dedent(r"""
            const vm = require('vm'), fs = require('fs')
            const el = () => ({ appendChild() {}, querySelector: () => null })
            const ctx = { console, JSON, Date, document: { createElement: el, head: el(), addEventListener() {} },
              cmdEsc: (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
              cmdPending: () => null, cmdCall: () => null, cmdRev: () => true, cmdOpen: () => [], revList: () => [{ coord: 'c', id: 'p', title: 'PR' }], slxList() {}, slxMk: () => '', slxLine: (x) => x, slxData: () => ({ items: [{ id: '1', icon: '📨', text: 'a' }, { id: '2', icon: '📨', text: 'b' }] }), cmd: { sent: {} } }
            vm.createContext(ctx)
            vm.runInContext(fs.readFileSync(process.argv[1], 'utf8') + `
              var rows = [{ key: 'x:1', name: 'alice', decisions: [], reviews: [], slx: ['1'], at: 5 }, { key: 'x:2', name: 'bob', decisions: [], reviews: [], slx: ['2'], at: 4 },
                { key: 's:r', sid: 'r', name: 'rev', decisions: [], reviews: [['c', 'p']], at: 3 },
                { key: 's:g', sid: 'g', name: 'office-gcl', live: true, decisions: [], reviews: [], byStatus: true, at: 9,
                  status: { state: 'blocked', kind: 'permission', needs: '사람이 https://github.com/keyolk/gcl/pull/22 → https://github.com/keyolk/gcl/pull/23 merge. 설치: \`brew install gcl\`' } }]
              cmd.data = { table: rows }
              var g = tblSplit(tblAll()), html = tblHtml(), order = tblOrder()
            `, ctx)
            console.log(JSON.stringify({ act: ctx.g.act.map((R) => R.row.key), look: ctx.g.look.map((R) => R.row.key), slx: ctx.g.slx.map((R) => R.row.key), html: ctx.html, order: ctx.order }))
        """)
        r = subprocess.run(["node", "-e", prog, str(js)], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        j = json.loads(r.stdout)
        self.assertEqual((j["act"], j["look"], j["slx"]), (["s:g"], ["s:r"], ["x:1", "x:2"]))
        self.assertEqual(j["order"], ["s:g", "s:r", "x:1", "x:2"])
        h = j["html"]
        self.assertLess(h.index("지금 내가 해야 할 것"), h.index("office-gcl"))
        self.assertLess(h.index("office-gcl"), h.index("data-row=\"s:r\""))
        self.assertLess(h.index("data-row=\"s:r\""), h.index("data-row=\"x:1\""))
        # The needs text is the line: its URLs are links (a PR as owner/repo#N), a backtick span is code.
        self.assertIn('<b class="do"', h)
        self.assertIn('<a href="https://github.com/keyolk/gcl/pull/22" target="_blank" rel="noopener">keyolk/gcl#22</a>', h)
        self.assertIn("keyolk/gcl#23", h)
        self.assertIn("<code>brew install gcl</code>", h)
        self.assertIn("data-copy=", h)

    def test_a_brief_marked_done_is_listed_apart_from_one_only_answered(self):
        # `brief done` writes sidecar.done; the view lists those under `done`
        # (newest first, a day old is folded), and an answered brief is not one.
        now = datetime.now(timezone.utc)
        iso = lambda h: (now - timedelta(hours=h)).strftime("%Y-%m-%dT%H:%MZ")
        fresh = self.brief("2026-11-11-fresh", sessions=(WORKER,))
        old = self.brief("2026-11-09-old")
        answered = self.brief("2026-11-10-answered", {"answer": {"choice": "A", "note": "", "by": "office", "at": iso(1)}})
        empty = self.brief("2026-11-10-empty")
        for f, done in ((fresh, {"at": iso(1), "result": "가드 17개를 데몬으로 옮김", "links": ["https://github.com/keyolk/briefs/pull/7", 3], "revert": "git revert abc"}),
                        (old, {"at": iso(30), "result": "옛 결과", "links": []}),
                        (empty, {"at": iso(1), "result": "  "})):
            side = self.side(f)
            side["done"] = done
            (self.repo / f.replace(".html", ".brief.json")).write_text(json.dumps(side, ensure_ascii=False))
        v = command.view([{"id": WORKER, "name": "w"}])
        self.assertEqual([d["file"] for d in v["done"]], [fresh, old])
        d = v["done"][0]
        self.assertEqual((d["result"], d["links"], d["revert"], d["old"], d["by"]), ("가드 17개를 데몬으로 옮김", ["https://github.com/keyolk/briefs/pull/7"], "git revert abc", False, "w"))
        self.assertEqual((v["done"][1]["old"], v["done"][1]["revert"]), (True, None))
        marks = {r["file"]: r["done"] for r in v["recent"]}
        self.assertEqual((marks[fresh], marks[old], marks[answered], marks[empty]), (True, True, False, False))

    def test_a_result_brief_its_worker_declared_done_is_listed_without_brief_done(self):
        # No decision question, no `brief done`: the worker's own `done`
        # status (its status file) lists the brief; a pending one, a worker
        # still working, and a brief with a question stay out.
        home = self.tmp / "home"
        st = home / ".claude/state/office/status"
        st.mkdir(parents=True)
        now_ms = int(time.time() * 1000)
        (st / f"{WORKER}.json").write_text(json.dumps({"state": "done", "at": now_ms, "step": "원인 분석 완료", "msg": "load 원인은 fork 폭주"}))
        (st / f"{MAKER}.json").write_text(json.dumps({"state": "working", "at": now_ms, "step": "조사 중"}))
        res = self.brief("2026-11-11-result", sessions=(WORKER,))
        busy = self.brief("2026-11-11-busy", sessions=(MAKER,))
        with mock.patch.dict(os.environ, {"HOME": str(home)}):
            v = command.view([{"id": WORKER, "name": "w"}])
        self.assertEqual([d["file"] for d in v["done"]], [res])
        d = v["done"][0]
        self.assertEqual((d["result"], d["by"], d["old"], d.get("auto")), ("load 원인은 fork 폭주", "w", False, True))
        self.assertNotIn(busy, [d["file"] for d in v["done"]])

    def test_recent_done_is_the_newest_three_of_the_day_one_line_each(self):
        # "최근 완료가 너무 길어서 불편하다": 13 rows of three lines. Now the
        # newest three done in the last day, title and result on one line; the
        # rest in 📚 on its 완료 filter. Links and undo live on the brief's banner.
        js = pathlib.Path(__file__).parents[1] / "office" / "briefline.js"
        prog = textwrap.dedent(r"""
            const vm = require('vm'), fs = require('fs')
            const el = () => ({ appendChild() {}, querySelector: () => null })
            const ctx = { console, JSON, Date, document: { createElement: el, head: el() }, cmdEl: el(),
              cmdEsc: (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]), cmdAgo: () => '1시간 전', cmd: {} }
            vm.createContext(ctx)
            vm.runInContext(fs.readFileSync(process.argv[1], 'utf8') + `
              var mk = (i, old) => ({ file: i + '.html', path: '/b/' + i + '.html', title: 'T' + i, at: '2026-11-11T09:39Z', result: i === 0 ? '결과 <b>' : 'R' + i, links: ['https://x/pull/1'], revert: 'git revert 1', old })
              cmd.data = { done: [mk(0, false), mk(1, false), mk(2, false), mk(3, false), mk(4, true)] }
              var h1 = doneFoot()
              var renders = 0; cmdRender = () => { renders++ }
              var took = doneClick({ target: { closest: (q) => (q === '[data-dall]' ? {} : null) } })
              var after = [JSON.stringify(cmd.sel), blib.only, renders]
              cmd.data = { done: [mk(9, true)] }; var h2 = doneFoot()
              cmd.data = { done: [] }; var h3 = doneFoot()
            `, ctx)
            console.log(JSON.stringify({ h1: ctx.h1, h2: ctx.h2, h3: ctx.h3, took: ctx.took, after: ctx.after }))
        """)
        r = subprocess.run(["node", "-e", prog, str(js)], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        j = json.loads(r.stdout)
        self.assertIn("✅ 최근 완료", j["h1"])
        self.assertIn("24시간 4", j["h1"])
        self.assertEqual(re.findall(r'<span class="t">(T\d)</span><span class="r">([^<]*)</span>', j["h1"]), [("T0", "결과 &lt;b&gt;"), ("T1", "R1"), ("T2", "R2")])
        self.assertNotIn("T3", j["h1"])
        self.assertNotIn("T4", j["h1"])  # a day old: not in this list at all
        self.assertNotIn("drevert", j["h1"])
        self.assertIn('data-dall="1"', j["h1"])
        self.assertIn("완료 5개 모두", j["h1"])
        self.assertEqual((j["took"], j["after"]), (True, ['{"library":true}', "done", 1]))
        # Only old ones, or none: no section.
        self.assertEqual((j["h2"], j["h3"]), ("", ""))

    def test_the_box_says_when_it_sent_and_the_view_carries_where_tasks_went(self):
        # The box's task is the coordinator's to place; the view finds where it
        # went from the ledger's send and spawn lines after `at`.
        log = [{"at": 1, "kind": "event", "text": "w: finished its turn"}, {"at": 2, "kind": "send", "text": "w: 테스트 먼저"}, {"at": 3, "kind": "spawn", "text": "fix opus/high in /w"}, {"at": 4, "kind": "order", "text": "on"}]
        self.ledger([{"slug": "w", "sid": WORKER}], log=log)
        code, j = command.say(COORD, "", "X 고쳐줘", self.put)
        self.assertEqual(code, 200)
        self.assertLessEqual(abs(j["at"] - time.time() * 1000), 5000)
        c = command.view([])["coordinators"][0]
        self.assertEqual([(e["kind"], e["text"]) for e in c["log"]], [("send", "w: 테스트 먼저"), ("spawn", "fix opus/high in /w")])

    def test_what_is_open_rides_with_the_task_as_re(self):
        self.ledger([{"slug": "w", "sid": WORKER}])
        self.assertEqual(command.say(COORD, "", "표를 접어 줘", self.put, {"brief": "2026-11-10-x.html", "worker": "w"})[0], 200)
        self.assertEqual(command.say(COORD, "", "링크가 죽었어", self.put, {"review": "cc-mods#85"})[0], 200)
        self.assertEqual(command.say(COORD, "", "다시 봐", self.put, {"brief": "2026-11-10-x.html"})[0], 200)
        self.assertEqual(command.say(COORD, "", "그냥 할 일", self.put, {})[0], 200)
        self.assertEqual([t for _, t in self.sent], ["[office→coord] (re: 2026-11-10-x.html, worker w) 표를 접어 줘", "[office→coord] (re: review cc-mods#85) 링크가 죽었어", "[office→coord] (re: 2026-11-10-x.html) 다시 봐", "[office→coord] 그냥 할 일"])
        # Only a brief's own name and a slug ride along: nothing else reaches the prompt.
        for bad in ({"brief": "../x.html"}, {"brief": "2026-11-10-x.html", "worker": "w; rm"}, {"review": "a b"}):
            self.assertEqual(command.say(COORD, "", "x", self.put, bad)[0], 400)
        with mock.patch.object(office, "inbox_put", side_effect=self.put):
            self.assertEqual(office.act({"kind": "coord_say", "coord": COORD, "value": "go", "re": {"review": "tweb-240"}})[0], 200)
        self.assertEqual(self.sent[-1], (COORD, "[office→coord] (re: review tweb-240) go"))

    def test_each_session_carries_what_it_was_doing_and_whether_a_coordinator_ever_instructed_it(self):
        self.ledger([{"slug": "w", "sid": WORKER, "instructed": 1794296997069}, {"slug": "gavin-jeong-63", "sid": MAKER, "relation": "adopted", "auto": True}])
        self.sums.write_text(json.dumps({WORKER: {"text": "office 지휘 view 정리", "src": "model", "key": "k", "at": 1}, MAKER: {"text": 3}}))
        people = [{"id": WORKER, "name": "w", "pane": "%9", "attention": "ask"}, {"id": MAKER, "name": "gavin-jeong-63", "pane": "%4", "attention": "none"}]
        v = command.view(people)
        w, m = v["coordinators"][0]["workers"]
        self.assertEqual((w["summary"], w["instructed"], w["auto"], w["pane"]), ("office 지휘 view 정리", True, False, "%9"))
        # A row the cache cannot use is no summary, not an error.
        self.assertEqual((m["summary"], m["instructed"], m["auto"]), (None, False, True))
        self.assertEqual(v["calls"][0]["summary"], "office 지휘 view 정리")
        self.sums.write_text("{half")
        coord._sums.update(at=0.0, sums={})
        self.assertEqual(coord.summaries(), {})

    def test_a_session_with_no_summary_is_its_repo_and_the_start_of_its_first_prompt(self):
        # The person could not tell ops-k8s-4a from its slug: with no cached
        # summary the view says the repository and what it was first asked.
        projects = self.tmp / "home" / ".claude" / "projects" / "-x"
        projects.mkdir(parents=True)
        lines = [{"type": "user", "isMeta": True, "message": {"content": "<command-name>/clear</command-name>"}},
                 {"type": "user", "message": {"content": "<local-command-stdout>x</local-command-stdout>"}},
                 {"type": "user", "message": {"content": [{"type": "text", "text": "Weight 0으로   낮춘 PR이 모두 머지됐는지 확인하고 남은 ALB를 정리"}]}}]
        (projects / f"{WORKER}.jsonl").write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines))
        self.ledger([{"slug": "ops-k8s-4a", "sid": WORKER, "repo": "sendbird/ops-k8s", "cwd": "/w/ops-k8s-4a"}, {"slug": "m", "sid": MAKER, "repoDir": "/src/keyolk/cc-mods"}])
        with mock.patch.dict(os.environ, {"HOME": str(self.tmp / "home")}):
            v = command.view([{"id": WORKER, "name": "ops-k8s-4a", "attention": "ask", "cwd": "/w/ops-k8s-4a"}])
        w, m = v["coordinators"][0]["workers"]
        self.assertEqual(w["summary"], "ops-k8s · Weight 0으로 낮춘 PR이 모두 머지됐는지 확인…")
        self.assertEqual(v["calls"][0]["summary"], w["summary"])
        # No transcript: the repository alone (the checkout a worktree came from).
        self.assertEqual(m["summary"], "cc-mods")
        # A cached summary wins; a worktree with nothing known is its git repository's name.
        self.sums.write_text(json.dumps({WORKER: {"text": "ALB 정리", "src": "model", "key": "k", "at": 1}}))
        coord._sums.update(at=0.0, sums={})
        self.assertEqual(command.view([])["coordinators"][0]["workers"][0]["summary"], "ALB 정리")
        repo = self.tmp / "main"
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "--allow-empty", "-m", "x"], check=True, env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", str(self.tmp / "slug-wt")], check=True)
        self.assertEqual(command.repo_name(str(self.tmp / "slug-wt")), "main")
        self.assertIsNone(command.label(None, {}))

    def test_the_library_lists_every_brief_newest_first_with_where_it_stands(self):
        # 📚 전체 브리프: the office could reach only the newest 8 briefs.
        self.brief("2026-11-08-old", {"coordinator": COORD}, title="옛 결정")
        self.brief("2026-11-10-done", {"coordinator": COORD, "answer": {"choice": "A"}}, title="끝난 것")
        side = self.side("2026-11-10-done.html")
        side["done"] = {"at": "2026-11-10T01:00Z", "result": "merge 완료"}
        (self.repo / "2026-11-10-done.brief.json").write_text(json.dumps(side, ensure_ascii=False))
        self.brief("2026-11-11-ans", {"coordinator": COORD, "answer": {"choice": "B"}}, title="답한 것")
        (self.repo / "2026-11-12-plain.html").write_text("<html><head><title>사이드카 없음</title></head></html>")
        (self.repo / "index.html").write_text("<html></html>")
        command._side.clear()
        d = command.library()
        self.assertEqual([(b["date"], b["title"], b["state"]) for b in d["items"]],
                         [("2026-11-12", "사이드카 없음", "read"), ("2026-11-11", "답한 것", "answered"), ("2026-11-10", "끝난 것", "done"), ("2026-11-08", "옛 결정", "pending")])
        self.assertEqual((d["total"], d["counts"]), (4, {"pending": 1, "done": 1, "answered": 1, "read": 1}))
        self.assertEqual(d["items"][2]["result"], "merge 완료")
        self.assertEqual(d["items"][3]["ask"], "어느 쪽?")
    def test_a_first_prompt_handed_on_by_a_coordinator_names_the_work_not_the_hand_off(self):
        # slx-ask-judge showed as `사람의 말(원문): "slx를 좀 개선할수…`.
        self.assertEqual(command.unrelay('사람의 말(원문): "slx를 좀 개선할수 있을거 같아" (office-x): 이어서'), "slx를 좀 개선할수 있을거 같아")
        self.assertEqual(command.unrelay('[coordinator] 사람의 말(원문, 앞선 요청): "warren 다시 로드"'), "warren 다시 로드")
        self.assertEqual(command.unrelay("worker 보고(원문): \"SKILL tsc(worktree)\" 고쳐"), "SKILL tsc(worktree)")
        self.assertEqual(command.unrelay('[coordinator] #130 rebase'), "#130 rebase")
        self.assertEqual(command.unrelay('그냥 "말" 그대로'), '그냥 "말" 그대로')
        with mock.patch.object(command, "first_prompt", return_value='사람의 말(원문): "slx를 좀 개선할수 있을거 같아 무조건 다 올리는게 아니라"'):
            self.assertEqual(command.label(WORKER, {}, None, {"repo": "keyolk/slx"}), "slx · slx를 좀 개선할수 있을거 같아 무조건 다 올리는게…")

    def test_hibernate_candidates_are_named_by_their_summary_without_touching_the_cache(self):
        self.sums.write_text(json.dumps({WORKER: {"text": "Dynamic cell 준비", "src": "model", "key": "k", "at": 1}}))
        coord._sums.update(at=0.0, sums={})
        hib = {"cards": [], "candidates": [{"sid": WORKER, "name": "agent", "idleH": 2.7, "mb": 744}, {"sid": MAKER, "name": "rca", "idleH": 3, "mb": 1}]}
        with mock.patch.object(command, "first_prompt", return_value=""):
            got = command.hib_named(hib, [{"id": WORKER, "cwd": "/w/x"}])
        self.assertEqual([c["summary"] for c in got["candidates"]], ["Dynamic cell 준비", None])
        self.assertNotIn("summary", hib["candidates"][0])

    def test_the_library_is_the_briefs_cli_list_when_it_has_one(self):
        # One record per brief for ~/briefs/index.html and 📚: `brief list --json`.
        self.brief("2026-11-08-a", {"coordinator": COORD}, title="옛 결정")
        out = json.dumps({"total": 2, "items": [
            {"file": "2026-11-08-a.html", "date": "2026-11-08", "title": "옛 결정", "desc": "d", "topic": "결정", "state": "pending", "ask": "어느 쪽?", "result": None, "search": "옛 결정 결정 결정 대기"},
            {"file": "../escape.html", "date": "x", "title": "x", "topic": "x", "state": "read", "search": ""}]}, ensure_ascii=False)
        command._no_list["until"] = 0.0
        with mock.patch.object(command, "_cli", return_value=subprocess.CompletedProcess([], 0, out, "")):
            d = command.library()
        self.assertEqual([(b["file"], b["topic"], b["state"], b["ask"]) for b in d["items"]], [("2026-11-08-a.html", "결정", "pending", "어느 쪽?")])
        self.assertEqual((d["total"], d["topics"], d["counts"]["pending"]), (1, [("결정", 1)], 1))
        self.assertEqual(d["items"][0]["path"], os.path.join(command.root(), "2026-11-08-a.html"))
        # A CLI from before `list`: read here, the same fields, and not asked again for a while.
        with mock.patch.object(command, "_cli", return_value=subprocess.CompletedProcess([], 2, "", "invalid choice: 'list'")) as cli:
            d = command.library()
            command.library()
        self.assertEqual(cli.call_count, 1)
        self.assertEqual((d["items"][0]["topic"], d["items"][0]["state"]), ("기타", "pending"))
        self.assertIn("옛 결정", d["items"][0]["search"])

    def test_office_act_routes_the_new_kinds(self):
        self.ledger([{"slug": "w", "sid": WORKER}])
        with mock.patch.object(office, "inbox_put", side_effect=self.put):
            code, _ = office.act({"kind": "coord_say", "coord": COORD, "slug": "w", "value": "go"})
        self.assertEqual(code, 200)
        self.assertEqual(self.sent, [(COORD, "[office→coord] w: go")])
        # Kept however late the coordinator reads its inbox.
        self.assertEqual(self.kept, [True])

    def test_inbox_put_keeps_the_keep_mark_when_a_plain_message_follows(self):
        with mock.patch.object(office, "INBOX", str(self.tmp / "inbox")):
            office.inbox_put(COORD, "[brief answer] a.html: A", keep=True)
            office.inbox_put(COORD, "ok")
            with open(os.path.join(self.tmp, "inbox", COORD + ".json")) as f:
                d = json.load(f)
            self.assertEqual((d["text"], d.get("keep")), ("[brief answer] a.html: A\n\nok", True))
            office.inbox_put(WORKER, "quick reply")
            with open(os.path.join(self.tmp, "inbox", WORKER + ".json")) as f:
                self.assertNotIn("keep", json.load(f))

    def test_a_message_cc_mods_took_but_has_not_seen_go_in_still_waits(self):
        inbox = self.tmp / "inbox"
        with mock.patch.object(office, "INBOX", str(inbox)):
            self.assertIsNone(office.inbox_waiting(WORKER))
            os.makedirs(inbox, exist_ok=True)
            with open(inbox / (WORKER + ".json.sending"), "w") as f:
                json.dump({"text": "[coordinator] go", "at": 5}, f)
            self.assertEqual(office.inbox_waiting(WORKER), {"text": "[coordinator] go", "at": 5})
            office.inbox_put(WORKER, "newer")
            self.assertEqual(office.inbox_waiting(WORKER)["text"], "newer")



class AskingTest(BriefsCase):
    """A session waiting on the person, opened in the view's left pane."""

    def test_a_short_answer_is_shown_whole(self):
        self.assertEqual(command.ask_block("첫 줄\n\n어느 쪽으로 할까요?\n"), {"text": "첫 줄\n\n어느 쪽으로 할까요?", "cut": False})
        self.assertEqual(command.ask_block(""), {"text": "", "cut": False})

    def test_a_long_answer_keeps_whole_paragraphs_from_the_end(self):
        paras = ["\n".join(f"p{i} line{j}" for j in range(8)) for i in range(6)]
        b = command.ask_block("\n\n".join(paras) + "\n\n어느 쪽으로 할까요?")
        lines = b["text"].splitlines()
        self.assertTrue(b["cut"])
        self.assertLessEqual(len(lines), command.ASK_LINES)
        # Opens on a paragraph's first line, never in the middle of one.
        self.assertEqual(lines[0].split()[1], "line0")
        self.assertEqual(lines[-1], "어느 쪽으로 할까요?")

    def test_one_long_paragraph_is_its_last_lines_and_the_chars_are_capped(self):
        b = command.ask_block("\n".join(f"line {i}" for i in range(100)))
        self.assertEqual(b["text"].splitlines(), [f"line {i}" for i in range(70, 100)])
        self.assertTrue(b["cut"])
        wide = command.ask_block("\n".join("가" * 400 + str(i) for i in range(20)))
        self.assertLessEqual(len(wide["text"]), command.ASK_CHARS)
        self.assertTrue(wide["text"].startswith("가"), "cut at a line start")
        self.assertTrue(wide["cut"])

    def test_the_view_says_where_each_waiting_session_is_and_whose_worker(self):
        self.ledger([{"slug": "w", "sid": WORKER}])
        people = [{"id": WORKER, "name": "w", "window": "cc:3", "pane": "%9", "cwd": "/src/x", "attention": "ask", "doing": "asking", "boss": {"name": "cc-mods-d9", "slug": "w"}}, {"id": MAKER, "name": "m", "attention": "none"}]
        calls = command.view(people)["calls"]
        self.assertEqual(calls, [{"sid": WORKER, "name": "w", "window": "cc:3", "pane": "%9", "cwd": "/src/x", "attention": "ask", "doing": "asking", "boss": "cc-mods-d9", "slug": "w", "summary": "x", "since": None, "slx": None}])

    def test_asking_reads_the_answer_tail_and_the_screen(self):
        me = {"pane": "%9", "wid": "@3", "window": "cc:3", "name": "w", "cwd": "/src/x"}
        with mock.patch.object(office, "pane_of", return_value=me), mock.patch.object(office, "last_text", return_value="설명\n\n진행할까요?"), mock.patch.object(office, "capture", return_value=[]), mock.patch.object(office, "inbox_waiting", return_value=None):
            a = office.asking(WORKER)
        self.assertEqual((a["sid"], a["pane"], a["cwd"], a["text"], a["cut"], a["dialog"], a["brief"]), (WORKER, "%9", "/src/x", "설명\n\n진행할까요?", False, None, None))
        self.assertIn("네, 진행해 주세요", a["suggestions"])
        screen = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"]
        with mock.patch.object(office, "pane_of", return_value=me), mock.patch.object(office, "last_text", return_value="진행할까요?"), mock.patch.object(office, "capture", return_value=screen), mock.patch.object(office, "inbox_waiting", return_value=None):
            a = office.asking(WORKER)
        # A choice on its screen is answered with a key: no quick replies beside it.
        self.assertEqual(([o["n"] for o in a["dialog"]["options"]], a["suggestions"]), ([1, 2], []))
        # Beside a preview box every line runs out to its border.
        boxed = ["어떻게 정리할까요?" + " " * 30 + "│", "│" + " " * 40 + "│", "❯ 1. 전부 진행 (Recommended)" + " " * 40, "  2. 정리는 내가 직접" + " " * 30 + "│", "  3. 보류  "]
        d = office.dialog(boxed)
        self.assertEqual((d["question"], [o["label"] for o in d["options"]]), ("어떻게 정리할까요?", ["전부 진행 (Recommended)", "정리는 내가 직접", "보류"]))
        with mock.patch.object(office, "pane_of", side_effect=AssertionError("not asked")):
            self.assertEqual(office.asking("../x"), {"error": "no such session"})
        with mock.patch.object(office, "pane_of", return_value=None):
            self.assertEqual(office.asking(WORKER), {"error": "no such session"})

    def test_the_card_carries_what_the_session_was_doing(self):
        # The card's head (the floor's and the command view's) says it in one line.
        self.sums.write_text(json.dumps({WORKER: {"text": "office 카드 왼쪽에", "src": "model", "key": "k", "at": 1}}))
        me = {"id": WORKER, "name": "w", "window": "cc:3", "state": "idle", "doing": "idle", "pane": "%9"}
        with mock.patch.object(office, "snapshot", return_value=[me]), mock.patch.object(office, "last_text", return_value="끝"), mock.patch.object(office, "capture", return_value=[]), \
                mock.patch.object(office, "related", return_value=[]), mock.patch.object(office, "route_of", return_value="default"), mock.patch.object(office, "inbox_waiting", return_value=None):
            d = office.detail(WORKER)
            coord._sums.update(at=0.0, sums={})
            self.sums.write_text("{}")
            bare = office.detail(WORKER)
        self.assertEqual((d["summary"], d["text"], bare["summary"]), ("office 카드 왼쪽에", "끝", None))

    def test_an_answer_from_the_office_goes_to_the_session_not_its_coordinator(self):
        # Not coord_say: coord_send's hold on a worker the person typed in never stops it.
        self.ledger([{"slug": "w", "sid": WORKER}])
        me = {"id": WORKER, "pane": "%9", "state": "waiting"}
        with mock.patch.object(office, "snapshot", return_value=[me]), mock.patch.object(office, "inbox_put", side_effect=self.put), mock.patch.object(office, "INBOX", str(self.tmp / "inbox")), mock.patch.object(office, "set_mute"):
            self.assertEqual(office.act({"sid": WORKER, "kind": "reply", "value": "B로 해"})[0], 200)
        self.assertEqual(self.sent, [(WORKER, "B로 해")])

    def test_the_view_route_answers_one_session_when_asked(self):
        srv = office.ThreadingHTTPServer(("127.0.0.1", 0), office.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        with mock.patch.object(office, "asking", return_value={"sid": WORKER, "text": "?"}) as ask, mock.patch.object(office, "snapshot", side_effect=AssertionError("the whole floor is not read")):
            with urllib.request.urlopen(f"http://127.0.0.1:{srv.server_port}/command?sid={WORKER}") as r:
                self.assertEqual(json.loads(r.read()), {"sid": WORKER, "text": "?"})
        ask.assert_called_once_with(WORKER)


class RoutesTest(BriefsCase):
    def test_the_view_and_its_script_are_two_routes(self):
        # /command once answered /command.js too (a prefix match), so the
        # page got JSON for its script and the switch never appeared.
        srv = office.ThreadingHTTPServer(("127.0.0.1", 0), office.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        base = f"http://127.0.0.1:{srv.server_port}"
        with mock.patch.object(office, "snapshot", return_value=[]), mock.patch.object(office.agenda, "view", return_value={"events": []}), mock.patch.object(office.agenda, "people", return_value={"links": {}, "prs": None}):
            with urllib.request.urlopen(base + "/command.js") as r:
                self.assertIn("javascript", r.headers["Content-Type"])
                self.assertIn(b"function commandKey", r.read())
            with urllib.request.urlopen(base + "/command") as r:
                self.assertEqual(set(json.loads(r.read())), {"at", "pending", "coordinators", "calls", "reviews", "recent", "done", "table", "slx", "hibernate", "agenda"})
            with urllib.request.urlopen(base + "/hibernate.js") as r:
                self.assertIn(b"function hibFoot", r.read())
            with urllib.request.urlopen(base + "/review.js") as r:
                self.assertIn("javascript", r.headers["Content-Type"])
                self.assertIn(b"function revKey", r.read())
            with urllib.request.urlopen(base + "/slx.js") as r:
                self.assertIn("javascript", r.headers["Content-Type"])
                self.assertIn(b"function slxKey", r.read())

    def test_the_server_stamp_and_the_page_know_review(self):
        # /office restarts a server whose stamp differs from the files on
        # disk: register.ts must list the same files office.py stamps.
        self.assertIn("review.py", office.SERVER_FILES)
        self.assertIn("slx.py", office.SERVER_FILES)
        reg = (pathlib.Path(__file__).parents[1] / "hooks" / "register.ts").read_text()
        self.assertIn("'office.py', 'resources.py', 'coord.py', 'command.py', 'review.py', 'slx.py'", reg)
        page = (pathlib.Path(__file__).parents[1] / "office" / "office.html").read_text()
        self.assertLess(page.index('src="review.js"'), page.index('src="command.js"'))
        self.assertLess(page.index('src="slx.js"'), page.index('src="command.js"'))


class ReviewTest(BriefsCase):
    def queue(self, items: list[dict], sid: str = COORD) -> pathlib.Path:
        d = self.coords / "review"
        d.mkdir(exist_ok=True)
        f = d / f"{sid}.json"
        f.write_text(json.dumps({"sid": sid, "name": "cc-mods-d9", "items": items}, ensure_ascii=False))
        return f

    def item(self, id: str, **kw) -> dict:
        return {"id": id, "title": "T " + id, "changed": "c", "verified": "v", "check": "k", "risk": "r", "links": ["https://github.com/keyolk/cc-mods/pull/85"], "state": "open", "at": 1000, "updatedAt": 1000, **kw}

    def test_the_view_lists_open_items_oldest_first_with_their_coordinator(self):
        self.ledger([])
        self.queue([self.item("b", at=2000), self.item("a", at=1000), self.item("done", state="confirmed", confirmedAt=review._now_ms())])
        # A ledger in coord/ is not a queue, and a queue is not a ledger.
        self.assertEqual([d["sid"] for d in coord.ledgers()], [COORD])
        got = command.view([])["reviews"]
        self.assertEqual([(r["id"], r["coord"], r["coordName"]) for r in got], [("a", COORD, "cc-mods-d9"), ("b", COORD, "cc-mods-d9")])
        self.assertEqual(got[0]["links"], ["https://github.com/keyolk/cc-mods/pull/85"])

    def test_confirm_takes_it_off_the_list_keeps_it_in_the_file_and_tells_the_coordinator(self):
        f = self.queue([self.item("cc-mods#85"), self.item("other")])
        code, j = office.command.act({"kind": "review_confirm", "coord": COORD, "id": "cc-mods#85"}, self.put)
        self.assertEqual((code, j["left"]), (200, 1))
        self.assertEqual(self.sent, [(COORD, "[review] confirmed cc-mods#85")])
        kept = json.loads(f.read_text())["items"]
        self.assertEqual([(i["id"], i["state"]) for i in kept], [("cc-mods#85", "confirmed"), ("other", "open")])
        self.assertEqual([r["id"] for r in review.items()], ["other"])
        self.assertEqual(review.confirm(COORD, "cc-mods#85", self.put)[0], 409)

    def test_an_issue_keeps_it_open_notes_the_words_and_sends_them(self):
        f = self.queue([self.item("tweb-240", state="confirmed", confirmedAt=5)])
        code, _ = review.act({"kind": "review_issue", "coord": COORD, "id": "tweb-240", "value": " reload 경우 다시 봐 줘 "}, self.put)
        self.assertEqual(code, 200)
        self.assertEqual(self.sent, [(COORD, "[review] issue tweb-240: reload 경우 다시 봐 줘")])
        it = json.loads(f.read_text())["items"][0]
        self.assertEqual((it["state"], "confirmedAt" in it, [i["text"] for i in it["issues"]]), ("open", False, ["reload 경우 다시 봐 줘"]))
        self.assertEqual(review.items()[0]["issues"][0]["text"], "reload 경우 다시 봐 줘")

    def test_refusals(self):
        self.queue([self.item("a")])
        self.assertEqual(review.issue(COORD, "a", "  ", self.put)[0], 400)
        self.assertEqual(review.confirm(COORD, "nope", self.put)[0], 404)
        self.assertEqual(review.confirm("../../x", "a", self.put)[0], 400)
        self.assertEqual(review.confirm(WORKER, "a", self.put)[0], 404)
        self.assertEqual(self.sent, [])

    def test_confirmed_items_older_than_a_week_go_at_the_next_write(self):
        old = review._now_ms() - review.KEEP_MS - 1
        f = self.queue([self.item("old", state="confirmed", confirmedAt=old), self.item("recent", state="confirmed", confirmedAt=review._now_ms()), self.item("a")])
        review.confirm(COORD, "a", self.put)
        self.assertEqual([i["id"] for i in json.loads(f.read_text())["items"]], ["recent", "a"])

    def test_a_half_written_queue_is_skipped_not_fatal(self):
        d = self.coords / "review"
        d.mkdir()
        (d / f"{COORD}.json").write_text('{"items": [')
        self.assertEqual(review.items(), [])

    def test_seed_adds_and_updates_by_id_and_the_script_reads_stdin(self):
        self.ledger([])
        self.queue([self.item("a", state="confirmed", confirmedAt=5)])
        n = review.seed(COORD, [{"id": "a", "title": "A again", "check": "새로 볼 것", "links": ["x"]}, {"id": "b", "title": "B", "changed": "c"}])
        self.assertEqual(n, 2)
        got = {r["id"]: r for r in review.items()}
        self.assertEqual((got["a"]["title"], got["a"]["check"], got["a"]["changed"], got["a"]["links"]), ("A again", "새로 볼 것", "c", ["https://github.com/keyolk/cc-mods/pull/85", "x"]))
        self.assertEqual(sorted(got), ["a", "b"])
        with self.assertRaises(ValueError):
            review.seed(COORD, [{"id": "bad id", "title": "x"}])
        script = pathlib.Path(__file__).parents[1] / "office" / "review.py"
        r = subprocess.run([sys.executable, str(script), "seed", MAKER, "-"], input=json.dumps([{"id": "c", "title": "C"}]), capture_output=True, text=True, env={**os.environ, "HOME": str(self.tmp)}, timeout=20)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.tmp / ".claude/state/office/coord/review" / f"{MAKER}.json").exists())


# command.js run under node with just enough of a page for its keys: the
# view's toggle, what it leaves to the floor and the card, and what a close
# remembers. Rendering is stubbed out; only the key logic runs.
KEYS_HARNESS = textwrap.dedent(r"""
    const vm = require('vm'), fs = require('fs')
    const el = () => ({ style: {}, dataset: {}, classList: { toggle() {} }, appendChild() {}, after() {}, querySelector: () => null, querySelectorAll: () => [], set innerHTML(v) {}, get innerHTML() { return '' } })
    const ctx = { console, JSON, Math, setTimeout: () => 0, clearTimeout() {}, fetch: () => Promise.reject(new Error('no server')),
      localStorage: { getItem: () => null, setItem() {} },
      document: { createElement: el, getElementById: el, head: el(), body: el() } }
    vm.createContext(ctx)
    // review.js, crew.js, look.js, briefline.js, slx.js, table.js and defer.js come first, as office.html loads them.
    for (const f of ['review.js', 'crew.js', 'look.js', 'briefline.js', 'slx.js', 'table.js', 'defer.js']) vm.runInContext(fs.readFileSync(process.argv[2].replace(/command\.js$/, f), 'utf8'), ctx)
    vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx)
    vm.runInContext(`
      var card = { style: { display: 'none' } }, viewer = { path: '' }, renders = 0, toasts = [], answers = []
      var cmdRenderDocReal = cmdRenderDoc
      cmdRender = () => { renders++ }; cmdRenderDoc = () => {}; cmdLoad = () => {}
      var cmdAnswerReal = cmdAnswer
      toast = (m) => { toasts.push(m) }; cmdAnswer = (p, q, a) => { answers.push([p.file, q.id, a]) }
      // A brief asking two questions, picked.
      function two() {
        const qs = [{ id: 'q1', question: 'Q1?', options: [{ label: 'A' }, { label: 'B' }], answer: null }, { id: 'q2', question: 'Q2?', options: [{ label: '예' }, { label: '아니오' }], answer: null }]
        cmd.data = { pending: [{ file: 'a.html', path: '/b/a.html', title: 'A', questions: qs, decision: qs[0] }, { file: 'b.html', path: '/b/b.html', title: 'B', decision: { question: 'Z?', options: [{ label: 'Y' }] } }], coordinators: [] }
        press('c'); cmd.sel = { file: 'a.html' }
        return cmd.data.pending[0]
      }
      // A key in a question's box: what cmdNoteKey took and what it did.
      function inBox(p, qid, key, value = '', more = {}) {
        let stopped = false, blurred = false
        const e = { key, shiftKey: false, isComposing: false, keyCode: 0, ...more, target: { value, blur: () => { blurred = true } }, preventDefault: () => { stopped = true } }
        const took = cmdNoteKey(e, p, p.questions.find((q) => q.id === qid))
        return [took, stopped, blurred]
      }
      function press(k, typing = false, alt = false) { let stopped = false; const took = commandKey({ altKey: alt, preventDefault: () => { stopped = true } }, k, typing); return took && stopped }
      // One brief and two sessions waiting on the person, the first picked
      // with what it asks; replies are recorded, not sent.
      var replies = [], cmdReplyReal = cmdReply, focused = []
      focusPane = (pane) => { focused.push(pane) }
      cmdReply = (s, body, label) => { replies.push([s.sid, body, label]) }
      function calls(ask = { suggestions: ['네', '아니요'] }) {
        cmd.data = { pending: [{ file: 'a.html', path: '/b/a.html', title: 'A', decision: { question: 'Z?', options: [{ label: 'Y' }] } }], coordinators: [],
          calls: [{ sid: 's1', name: 'one', window: 'w:1', pane: '%1' }, { sid: 's2', name: 'two', window: 'w:2', pane: '%2' }] }
        if (!cmd.on) press('c')
        cmd.sel = { sid: 's1', name: 'one', window: 'w:1' }; cmd.ask = { sid: 's1', ...ask }
      }
      // Two review items and one waiting session; confirms and issues recorded.
      var reviewed = [], revConfirmReal = revConfirm, revIssueReal = revIssue
      revConfirm = (s) => { reviewed.push(['confirm', s.review]) }
      revIssue = (s, text) => { reviewed.push(['issue', s.review, text]) }
      function reviews() {
        cmd.data = { pending: [{ file: 'a.html', path: '/b/a.html', title: 'A', decision: { question: 'Z?', options: [{ label: 'Y' }] } }], coordinators: [],
          calls: [{ sid: 's1', name: 'one', window: 'w:1', pane: '%1' }],
          reviews: [{ coord: 'c1', coordName: 'd9', id: 'cc-mods#85', title: 'R1', links: [] }, { coord: 'c1', coordName: 'd9', id: 'tweb-240', title: 'R2', links: [] }] }
        if (!cmd.on) press('c')
        cmd.sel = { review: 'cc-mods#85', coord: 'c1', title: 'R1' }
      }
      function inRevBox(key, value = '', more = {}) {
        let stopped = false, blurred = false
        const e = { key, shiftKey: false, isComposing: false, keyCode: 0, ...more, target: { value, blur: () => { blurred = true } }, preventDefault: () => { stopped = true } }
        return [revBoxKey(e, cmd.sel), stopped, blurred]
      }
      // A coordinator with four sessions at work: one it started, one handed
      // over, one auto-adopted it gave a task, one auto-adopted and quiet.
      function crew() {
        calls()
        cmd.data.coordinators = [{ sid: 'c1', name: 'd9', live: true, state: 'working', log: [], workers: [
          { slug: 'fix', sid: 'w1', relation: 'owned', live: true, state: 'working', window: 'w:3', summary: 'office 지휘 정리' },
          { slug: 'held', sid: 'w2', relation: 'adopted', live: true, state: 'done' },
          { slug: 'told', sid: 'w3', relation: 'adopted', auto: true, instructed: 1, live: true, state: 'done' },
          { slug: 'gavin-jeong-63', sid: 'w4', relation: 'adopted', auto: true, live: true, state: 'done', summary: 'Twingate 조사' }] }]
      }
      // A click on a row of the table, by its key ('s:<sid>', 'b:<file>').
      const row = (key) => ({ target: { closest: (q) => (q === 'tr[data-row]' ? { dataset: { row: key.includes(':') ? key : 's:' + key } } : null) } })
      // /command's table (office/turn.py): fix holds a decision, its call and
      // a review; one waits on the person alone; d9 put a review up for
      // itself; the rest wait on nobody.
      function table() {
        crew()
        cmd.data.pending[0].decision.worker = 'fix'
        cmd.data.pending[0].questions = [{ id: 'q1', ...cmd.data.pending[0].decision, answer: null }]
        cmd.data.calls = [{ sid: 'w1', name: 'w1n', slug: 'fix', window: 'w:3', pane: '%3', summary: 'office 지휘 정리' }, { sid: 's1', name: 'one', window: 'w:1', pane: '%1' }]
        cmd.data.reviews = [{ coord: 'c1', coordName: 'd9', id: 'fix', title: 'R fix', links: [] }, { coord: 'c1', coordName: 'd9', id: 'cc-mods#85', title: 'R c', links: [] }]
        cmd.data.table = [
          { key: 's:w1', sid: 'w1', name: 'fix', summary: 'office 지휘 정리', coord: 'c1', relation: 'owned', state: 'working', live: true, decisions: ['a.html'], call: true, reviews: [['c1', 'fix']], at: 100 },
          { key: 's:s1', sid: 's1', name: 'one', summary: null, live: true, state: 'waiting', decisions: [], call: true, reviews: [], at: 200 },
          { key: 's:c1', sid: 'c1', name: 'd9', summary: '지휘', isCoord: true, live: true, state: 'working', decisions: [], call: false, reviews: [['c1', 'cc-mods#85']], at: 300 },
          { key: 's:w4', sid: 'w4', name: 'gavin-jeong-63', summary: 'Twingate 조사', coord: 'c1', relation: 'adopted', live: true, state: 'done', decisions: [], call: false, reviews: [] },
          { key: 's:w2', sid: 'w2', name: 'held', coord: 'c1', relation: 'adopted', live: true, state: 'working', decisions: [], call: false, reviews: [] },
        ]
        cmd.sel = null; cmd.row = null; cmd.ask = null
      }
      const tabs = () => tblTabs(tblFind(cmd.row)).map((t) => t.k)
      function inCallBox(key, value = '', more = {}) {
        let stopped = false, blurred = false
        const e = { key, shiftKey: false, isComposing: false, keyCode: 0, ...more, target: { value, blur: () => { blurred = true } }, preventDefault: () => { stopped = true } }
        return [cmdCallKey(e, cmd.sel), stopped, blurred]
      }
    `, ctx)
    Promise.resolve(vm.runInContext(process.argv[3], ctx)).then((out) => process.stdout.write(JSON.stringify(out)))
""")


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class CommandKeysTest(unittest.TestCase):
    def run_js(self, body: str):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(KEYS_HARNESS)
        self.addCleanup(os.unlink, f.name)
        js = pathlib.Path(__file__).parents[1] / "office" / "command.js"
        r = subprocess.run(["node", f.name, str(js), "(() => {" + body + "})()"], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_c_opens_the_view_without_a_decision_and_closes_it_again(self):
        got = self.run_js("const a = press('c'), on1 = cmd.on, b = press('c'); return [a, on1, b, cmd.on]")
        self.assertEqual(got, [True, True, True, False])

    def test_d_still_toggles_and_esc_still_closes(self):
        got = self.run_js("press('d'); const on1 = cmd.on; press('Escape'); const on2 = cmd.on; press('c'); press('d'); return [on1, on2, cmd.on]")
        self.assertEqual(got, [True, False, False])

    def test_c_is_typed_in_a_box_but_alt_c_toggles_anywhere(self):
        # TWeb's normal mode keeps bare c (its command palette); ⌥C reaches the page.
        got = self.run_js("const a = press('c', true), on1 = cmd.on; const b = press('c', true, true), on2 = cmd.on; const c = press('Escape', true), on3 = cmd.on; const d = press('c', false, true); return [a, on1, b, on2, c, on3, d, cmd.on]")
        self.assertEqual(got, [False, False, True, True, False, True, True, False])

    def test_an_open_card_keeps_c_for_itself(self):
        got = self.run_js("card.style.display = 'block'; const a = press('c'), a2 = press('c', false, true), on1 = cmd.on; card.style.display = 'none'; press('c'); card.style.display = 'block'; const b = press('c'); return [a, a2, on1, b, cmd.on]")
        self.assertEqual(got, [False, False, False, False, True])

    def test_the_floor_keys_pass_through_while_the_view_is_shut_and_open(self):
        floor = ["j", "k", "i", "n", "p", "v", "f", "0", "Tab", "ArrowUp", "?", ",", "t", "[", "]", "b"]
        got = self.run_js("const keys = " + json.dumps(floor) + "; const shut = keys.filter((k) => press(k)); press('c'); const open = keys.filter((k) => press(k)); return [shut, open]")
        # Open, the view takes i (its box) and j/k only when a decision waits; none does here.
        self.assertEqual(got, [[], ["i"]])

    def test_closing_by_hand_does_not_reopen_the_same_decision(self):
        got = self.run_js("""
            cmd.data = { pending: [{ file: 'a.html', path: '/b/a.html', title: 'A', decision: { options: [] } }, { file: 'b.html', path: '/b/b.html', title: 'B', decision: { options: [] } }], coordinators: [] }
            press('c'); cmd.sel = { file: 'a.html' }
            press('c')
            const shut = cmd.shut, sel = cmd.sel
            press('c')
            press('j'); const first = cmd.sel.file
            return [shut, sel, first]
        """)
        self.assertEqual(got, ["a.html|b.html", None, "a.html"])

    def test_enter_in_a_box_sends_the_armed_option_or_the_words_or_says_what_to_do(self):
        got = self.run_js("""
            const p = two()
            const empty = inBox(p, 'q1', 'Enter', '  ')
            const words = inBox(p, 'q1', 'Enter', ' 15000원 기준으로 onetable ')
            cmd.armed = { q: 'q1', i: 1 }
            const armed = inBox(p, 'q1', 'Enter', '메모')
            // Armed on q1, Enter in q2's box is q2's own answer.
            const other = inBox(p, 'q2', 'Enter', '야근 제외')
            return [empty, words, armed, other, answers, toasts.length]
        """)
        self.assertEqual(got[:4], [[True, True, False]] * 4)
        self.assertEqual(got[4], [["a.html", "q1", {"text": "15000원 기준으로 onetable"}], ["a.html", "q1", {"label": "B"}], ["a.html", "q2", {"text": "야근 제외"}]])
        self.assertEqual(got[5], 1)

    def test_the_box_leaves_composition_newlines_and_other_keys_alone(self):
        got = self.run_js("""
            const p = two()
            const keys = [['Enter', { isComposing: true }], ['Enter', { keyCode: 229 }], ['Enter', { shiftKey: true }], ['j', {}], ['1', {}], ['a', {}]]
            const took = keys.map(([k, m]) => inBox(p, 'q1', k, 'x', m)[0])
            return [took, inBox(p, 'q1', 'Escape', 'x'), answers.length]
        """)
        self.assertEqual(got, [[False] * 6, [True, True, True], 0])

    def test_keys_typed_in_a_box_never_reach_the_view_and_the_view_keeps_its_own(self):
        # Ownership: j/k/digits/Enter/m/i typed in a box are the box's; outside
        # it they still walk the briefs, arm and send.
        got = self.run_js("""
            const p = two()
            const typed = ['j', 'k', '1', '2', 'Enter', 'm', 'i', 'd', 'Escape'].filter((k) => press(k, true))
            const stillSel = cmd.sel.file, stillArmed = cmd.armed
            press('2'); const armed = cmd.armed
            press('Enter'); const sent = answers.slice()
            cmd.q = 'q2'; press('1'); const armed2 = cmd.armed
            press('j'); const next = [cmd.sel.file, cmd.armed, cmd.q]
            return [typed, stillSel, stillArmed, armed, sent, armed2, next]
        """)
        self.assertEqual(got, [[], "a.html", None, {"q": "q1", "i": 1}, [["a.html", "q1", {"label": "B"}]], {"q": "q2", "i": 0}, ["b.html", None, None]])

    def test_digits_arm_the_first_open_question_and_an_answered_one_is_skipped(self):
        got = self.run_js("""
            const p = two(); p.questions[0].answer = { choice: 'A' }
            press('2'); const a = cmd.armed
            // A server from before questions[]: its one decision is q1.
            cmd.data.pending[1].decision.answer = null; cmd.sel = { file: 'b.html' }; cmd.armed = null
            press('1'); const b = cmd.armed; press('Enter')
            return [a, b, answers]
        """)
        self.assertEqual(got, [{"q": "q2", "i": 1}, {"q": "q1", "i": 0}, [["b.html", "q1", {"label": "Y"}]]])

    def test_a_picked_session_arms_a_choice_with_a_digit_and_sends_it_with_enter(self):
        got = self.run_js("""
            calls()
            const nine = press('9'), early = press('Enter')
            press('2'); const armed = cmd.armed
            press('Enter')
            // A choice drawn on its screen is a key, not a reply.
            calls({ dialog: { question: 'Proceed?', digest: 'd1', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] }, suggestions: [] })
            press('1'); press('Enter')
            return [nine, early, armed, replies]
        """)
        self.assertEqual(got, [False, False, {"call": "s1", "i": 1}, [["s1", {"kind": "reply", "value": "아니요"}, "아니요"], ["s1", {"kind": "key", "value": "1", "digest": "d1", "label": "Yes"}, "Yes"]]])

    def test_a_refused_press_on_a_screens_choice_says_why_and_draws_the_choice_again(self):
        got = self.run_js("""
            return (async () => {
              calls({ dialog: { question: 'Q?', digest: 'd1', options: [{ n: 1, label: 'Yes' }] }, suggestions: [] })
              const now = { question: 'Q2?', digest: 'd2', options: [{ n: 1, label: 'Yes' }] }, sent = []
              TOKEN = 't'; cmdAsk = () => {}
              fetch = (url, o) => { sent.push(JSON.parse(o.body)); return Promise.resolve({ status: 409, ok: false, json: () => Promise.resolve({ error: 'the dialog on its screen changed since the page drew it: look again', dialog: now }) }) }
              const ok = await cmdReplyReal(cmd.sel, { kind: 'key', value: '1', digest: 'd1', label: 'Yes' }, 'Yes')
              return [ok, sent[0].digest, cmd.ask.dialog.digest, cmd.refused, toasts, cmdRefusedText(cmd.refused.text)]
            })()
        """)
        self.assertEqual(got[:5], [False, "d1", "d2", {"sid": "s1", "text": "the dialog on its screen changed since the page drew it: look again", "digest": "d2"}, []])
        self.assertIn("바뀌었습니다", got[5])

    def test_enter_in_a_sessions_box_sends_the_words_or_the_armed_reply_or_says_what_to_do(self):
        got = self.run_js("""
            calls()
            const empty = inCallBox('Enter', '  ')
            cmd.armed = { call: 's1', i: 0 }
            const words = inCallBox('Enter', ' B로 해 주세요 ')
            const armed = inCallBox('Enter', '')
            const other = [['Enter', { isComposing: true }], ['Enter', { keyCode: 229 }], ['Enter', { shiftKey: true }], ['j', {}], ['1', {}]].map(([k, m]) => inCallBox(k, 'x', m)[0])
            return [empty, words, armed, inCallBox('Escape', 'x'), other, replies, toasts.length]
        """)
        self.assertEqual(got[:4], [[True, True, False]] * 3 + [[True, True, True]])
        self.assertEqual(got[4], [False] * 5)
        self.assertEqual(got[5], [["s1", {"kind": "reply", "value": "B로 해 주세요"}, "답장"], ["s1", {"kind": "reply", "value": "네"}, "네"]])
        self.assertEqual(got[6], 1)

    def test_keys_typed_in_a_sessions_box_never_reach_the_view_and_the_floor_keeps_its_own(self):
        got = self.run_js("""
            calls()
            const typed = ['j', 'k', '1', '2', 'Enter', 'm', 'i', 'd', 'g', 'Escape'].filter((k) => press(k, true))
            const still = [cmd.sel.sid, cmd.armed, replies.length, focused.length]
            const floor = ['n', 'p', 'v', 'f', '0', 'Tab', 'ArrowUp', '?', ','].filter((k) => press(k))
            press('Escape'); const shut = [cmd.sel, cmd.ask, cmd.on]
            return [typed, still, floor, shut]
        """)
        self.assertEqual(got, [[], ["s1", None, 0, 0], [], [None, None, True]])

    def test_g_goes_to_the_picked_sessions_pane_and_alt_g_from_its_box(self):
        got = self.run_js("""
            calls()
            const g = press('g'), altInBox = press('g', true, true)
            // The pane /command?sid= saw wins over the list's.
            cmd.ask = { sid: 's1', pane: '%7', suggestions: [] }; press('g')
            // A brief picked, an open card or the floor: G is not the view's.
            cmd.sel = { file: 'a.html' }; const onBrief = press('g'), altOnBrief = press('g', true, true)
            cmd.sel = { sid: 's2', name: 'two' }; card.style.display = 'block'; const cardG = press('g'), cardAltG = press('g', false, true); card.style.display = 'none'
            press('Escape'); press('Escape'); const shut = press('g')
            return [g, altInBox, onBrief, altOnBrief, cardG, cardAltG, shut, focused]
        """)
        self.assertEqual(got, [True, True, False, False, False, False, False, ["%1", "%1", "%7"]])

    def test_a_link_inside_the_frame_moves_the_bar_and_the_answers_with_it(self):
        # ← 모든 브리프 inside the frame: the bar and the decision strip must
        # not stay under the brief that was picked. Only the frame itself may say so.
        got = self.run_js("""
            cmdEl.querySelector = (q) => (q === '.doc iframe' ? { contentWindow: 'F' } : null)
            cmdBriefBar = (bar, s) => { bars.push(s.file) }
            var bars = []
            two()
            const ev = (src, page) => ({ source: src, data: { officeBrief: page } })
            cmdFrameMsg(ev('X', '/briefs/index.html'))      // not the frame
            cmdFrameMsg(ev('F', '/index.html'))             // not a brief path
            cmdFrameMsg(ev('F', '/briefs/../etc.html'))
            const same = [cmd.sel.file, bars.length]
            cmdFrameMsg(ev('F', '/briefs/b.html'))          // a pending sibling
            const sib = [cmd.sel.file, cmd.sel.path, cmd.frame]
            cmdFrameMsg(ev('F', '/briefs/index.html'))      // the list
            return [same, sib, cmd.sel.file, cmd.sel.path, bars]
        """)
        self.assertEqual(got[0], ["a.html", 0])
        self.assertEqual(got[1], ["b.html", "/b/b.html", "/b/b.html"])
        self.assertEqual(got[2:], ["index.html", "~/briefs/index.html", ["b.html", "index.html"]])

    def test_a_redraw_keeps_the_reply_box_itself_so_the_caret_and_the_composition_survive(self):
        # The 3 s poll redraws the decision strip; the box under the person's hands is put back, not remade.
        got = self.run_js("""
            const mk = (tag) => { const e = { tagName: tag, dataset: {}, style: {}, removed: 0, replaced: 0, value: '', classList: { toggle() {} } }; e.remove = () => { e.removed++ }; e.focus = () => { e.focused = true }; return e }
            const old = mk('INPUT'); old.dataset.call = 'sid1'; old.value = 'hel'
            const fresh = mk('INPUT'); fresh.dataset.call = 'sid1'; fresh.replaceWith = (n) => { fresh.replacedWith = n }
            const dec = { dataset: { key: 'x' }, style: {}, contains: () => true, appendChild() {}, querySelector: (q) => (q.startsWith('.note[data-call]') ? (dec.rebuilt ? fresh : old) : q === '.opts' ? { appendChild() {} } : null) }
            Object.defineProperty(dec, 'innerHTML', { set() { dec.rebuilt = true }, get: () => '' })
            document.activeElement = old
            cmd.ask = { sid: 'sid1', text: 't', suggestions: ['a'], dialog: null, inbox: null }
            cmdAsk = () => {}
            cmdRenderCall({ innerHTML: '', querySelector: () => ({ onclick: null, textContent: '' }) }, { querySelector: () => ({ dataset: { key: 'k' }, innerHTML: '' }), className: '', style: {}, innerHTML: '' }, dec, { sid: 'sid1', name: 'n' })
            return [old.removed, fresh.replacedWith === old, !!old.focused, typeof old.onkeydown]
        """)
        self.assertEqual(got, [1, True, True, "function"])

    def test_letters_and_hangul_typed_by_hand_in_the_reply_box_are_never_cancelled(self):
        # The browser cancels a key whose handler property returns false. The
        # box's key function returns false for each key it leaves alone, so
        # handed straight to onkeydown it ate every letter typed by hand
        # (`tweb type` inserts without a keydown, and so typed). Here the
        # handler the box really carries gets the keys, under that rule.
        got = self.run_js("""
            const note = { tagName: 'INPUT', dataset: { call: 'sid1' }, style: {}, value: '', focus() {}, remove() {}, blur() {} }
            const dec = { dataset: {}, style: {}, contains: () => false, appendChild() {}, querySelector: (q) => (q.startsWith('.note') ? (dec.rebuilt ? note : null) : q === '.opts' ? { appendChild() {} } : null) }
            Object.defineProperty(dec, 'innerHTML', { set() { dec.rebuilt = true }, get: () => '' })
            cmd.ask = { sid: 'sid1', text: 't', suggestions: ['a'], dialog: null, inbox: null }
            cmdAsk = () => {}
            cmdRenderCall({ innerHTML: '', querySelector: () => ({ onclick: null, textContent: '' }) }, { querySelector: () => ({ dataset: { key: 'k' }, innerHTML: '' }), className: '', style: {}, innerHTML: '' }, dec, { sid: 'sid1', name: 'n' })
            // A letter, the view's own keys, a digit, and Hangul from the IME
            // (TWeb's keydown under the Korean layout has no key; a composing one is 229).
            const keys = [['a', {}], ['j', {}], ['k', {}], ['x', {}], ['t', {}], ['g', {}], ['b', {}], ['m', {}], ['1', {}], ['[', {}], ['', {}], ['ㅎ', { isComposing: true, keyCode: 229 }], ['Process', { keyCode: 229 }]]
            const cancelled = keys.filter(([k, m]) => {
              let stopped = false
              const e = { key: k, shiftKey: false, altKey: false, isComposing: false, keyCode: 0, ...m, target: note, preventDefault: () => { stopped = true } }
              return note.onkeydown(e) === false || stopped
            }).map(([k]) => k)
            // Enter and Escape are still the box's.
            let sent = false, left = false
            note.value = '네'
            note.onkeydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, target: note, preventDefault: () => { sent = true } })
            note.onkeydown({ key: 'Escape', target: { blur: () => { left = true } }, preventDefault() {} })
            return [cancelled, sent, left, replies]
        """)
        self.assertEqual(got, [[], True, True, [["sid1", {"kind": "reply", "value": "네"}, "답장"]]])

    def test_a_pick_answered_before_the_view_is_built_draws_its_box_once_it_is(self):
        # /command?sid= can answer before the view's first /command builds the
        # panes. Drawing then threw after cmd.frame was set, and every redraw
        # after found no .sbrief: the box never came.
        got = self.run_js("""
            const mk = () => { const e = { dataset: {}, style: {}, className: '', kids: {}, appendChild() {}, focus() {}, remove() {}, replaceWith() {} }
              e.querySelector = (q) => e.kids[q] || null
              Object.defineProperty(e, 'innerHTML', { set(v) { e.html = v; e.kids = {}; for (const c of ['endarm', 'sbrief', 'said', 'cardv']) if (v.includes('class="' + c + '"')) e.kids['.' + c] = mk()
                if (v.includes('class="note"')) { e.kids['.note[data-call]'] = e.kids['.note'] = mk(); e.kids['.note'].dataset.call = 'sid1' }
                if (v.includes('class="opts"')) e.kids['.opts'] = mk()
                for (const c of ['go', 'shut', 'seg', 'm']) if (v.includes('class="act ' + c) || v.includes('class="' + c)) e.kids['.' + c] = mk() }, get: () => e.html || '' })
              e.contains = () => false; return e }
            const parts = {}
            cmdEl.querySelector = (q) => parts[q] || null
            cmdEl.classList = { toggle() {} }
            cmd.sel = { sid: 'sid1', name: 'n' }; cmd.frame = null
            cmd.ask = { sid: 'sid1', text: 't', suggestions: ['a'], dialog: null, inbox: null }
            cmdAsk = () => {}; cmdRenderView = () => {}
            let early = 'ok'
            try { cmdRenderDocReal() } catch (e) { early = e.message }
            parts['.bar'] = mk(); parts['.doc'] = mk(); parts['.decide'] = mk(); parts['.rtabs'] = mk()
            let late = 'ok'
            try { cmdRenderDocReal() } catch (e) { late = e.message }
            // A look lost under a frame already set is made again.
            parts['.doc'].innerHTML = ''; parts['.decide'].dataset.key = ''
            let again = 'ok'
            try { cmdRenderDocReal() } catch (e) { again = e.message }
            return [early, late, again, !!parts['.doc'].kids['.sbrief'], !!parts['.decide'].kids['.note[data-call]']]
        """)
        self.assertEqual(got, ["ok", "ok", "ok", True, True])

    def test_no_box_hands_its_key_function_straight_to_onkeydown(self):
        # Every box's keys go in through cmdBoxKeys: an arrow with no braces
        # returns what the key function returns, and false cancels the key.
        office = pathlib.Path(__file__).parents[1] / "office"
        bare = re.compile(r"\.onkeydown\s*=\s*(?:async\s*)?\(?\w*\)?\s*=>(?!\s*\{)")
        found = [f"{f.name}:{i}" for f in sorted([*office.glob("*.js"), office / "office.html"]) for i, line in enumerate(f.read_text().splitlines(), 1) if bare.search(line) and not line.lstrip().startswith('//')]
        self.assertEqual(found, [])

    def test_the_brief_bar_posts_a_brief_open_and_never_the_session_path(self):
        got = self.run_js("""
            const btn = {}, bar = { innerHTML: '', querySelector: (q) => (q === '.out' ? btn : {}) }
            const posts = []
            globalThis.lastPlace = () => 'session'  // office.html's, the person's remembered place
            cmdPost = async (b) => { posts.push(b); return { sent: 'x' } }
            cmdBriefBar(bar, { file: 'a.html', path: '/b/a.html', title: 'A' })
            return btn.onclick().then(() => posts)
        """)
        self.assertEqual(got, [{"kind": "brief_open", "file": "a.html", "via": "session"}])

    def test_a_refused_press_on_a_brief_says_why_under_it_and_leaves_the_row(self):
        # pt2677: the 보내기 came back 409 (its worker ended) as a toast in the
        # corner; the buttons came back and the row stayed, the press dead.
        got = self.run_js("""
            return (async () => {
              const p = two(), q = p.questions[0]
              q.grants = { A: { kind: 'slack_send', channel: 'C1', text: 'x', digest: 'd' } }
              const posts = []
              cmdPost = async (b) => { posts.push(b); return { refused: 'no live worker ops-k8s-4a to allow this for', why: 'worker', worker: 'ops-k8s-4a' } }
              await cmdAnswerReal(p, q, { label: 'A' })
              const after = [cmd.refusedQ, q.answer, cmd.data.pending.length, toasts.length]
              cmdPost = async (b) => ({ ok: true, sent: 'x' })
              await cmdAnswerReal(p, q, { text: '다시 요청해 줘' })
              return [posts[0].seen, after, cmd.refusedQ, q.answer.choice]
            })()
        """)
        seen, (rq, ans, left, toasts), rq2, choice = got
        self.assertEqual(seen, "d")
        self.assertEqual((rq["file"], rq["q"], ans, left, toasts), ("a.html", "q1", None, 2, 0))
        self.assertIn("ops-k8s-4a", rq["text"])
        self.assertIn("직접 쓴 답", rq["text"])
        self.assertEqual((rq2, choice), (None, "직접 답"))

    def test_a_brief_answer_409_comes_back_as_a_refusal_not_a_toast(self):
        got = self.run_js("""
            return (async () => {
              globalThis.TOKEN = 't'
              fetch = async () => ({ status: 409, ok: false, json: async () => ({ error: 'no live worker w to allow this for', refused: 'worker', worker: 'w' }) })
              const a = await cmdPost({ kind: 'brief_answer', file: 'a.html' })
              fetch = async () => ({ status: 409, ok: false, json: async () => ({ error: 'busy' }) })
              const b = await cmdPost({ kind: 'coord_say' })
              return [a, b, toasts]
            })()
        """)
        self.assertEqual(got, [{"refused": "no live worker w to allow this for", "why": "worker", "worker": "w"}, None, ["✕ busy"]])

    def test_the_brief_line_has_no_fold_toggle_and_its_library_button_opens_every_brief(self):
        # The person: the line's 전체/접기 meant nothing (three more chips on a
        # line that scrolls sideways); every brief needed a way in, laid out and
        # filtered as ~/briefs/index.html is.
        got = self.run_js("""
            const recent = Array.from({ length: 8 }, (_, i) => ({ file: 'f' + i + '.html', path: '/b/f' + i + '.html', title: 'T' + i, pending: i === 0, done: i === 1 }))
            cmd.data = { pending: [], coordinators: [], recent }
            press('c')
            let html = ''
            const line = { scrollLeft: 0, clientWidth: 300, dataset: {}, querySelector: () => null, set innerHTML(v) { html = v }, get innerHTML() { return html } }
            const q0 = cmdEl.querySelector
            cmdEl.querySelector = (q) => (q === '.briefs' ? line : q0.call(cmdEl, q))
            const today = new Date(), iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
            const t0 = iso(today), t1 = iso(new Date(today.getTime() - 86400000))
            blib.data = { total: 3, counts: { pending: 1, done: 1, answered: 0, read: 1 }, topics: [['결정', 2], ['인프라', 1]], items: [
              { file: 'a.html', path: '/b/a.html', title: '결정 하나', date: t0, state: 'pending', topic: '결정', ask: '어느 쪽?', search: '결정 하나 결정 결정 대기' },
              { file: 'b.html', path: '/b/b.html', title: '끝난 일', date: t0, state: 'done', topic: '결정', result: 'merge 완료', search: '끝난 일 결정 완료 merge 완료' },
              { file: 'c.html', path: '/b/c.html', title: '조사 메모', date: t1, state: 'read', topic: '인프라', desc: '노드 메모리', search: '조사 메모 노드 메모리 인프라' }] }
            cmdRenderBriefs()
            const chips = (html.match(/data-brief=/g) || []).length
            cmdBriefClick({ target: { closest: () => ({ dataset: { lib: '1' } }) } })
            const opened = JSON.stringify(cmd.sel), about = cmdAbout()
            const n = (h) => (h.match(/data-lbrief=/g) || []).length
            const all = blibHtml(), facets = blibFacets()
            blib.topic = '결정'; const decided = n(blibHtml()), facetsOn = blibFacets(); blib.topic = ''
            blib.only = 'done'; const done = n(blibHtml()); blib.only = ''
            blib.q = '메모리'; const found = n(blibHtml()); blib.q = ''
            blib.q = 'zzz'; const none = blibHtml(); blib.q = ''
            blibClick({ target: { closest: (q) => (q === '[data-lbrief]' ? { dataset: { lbrief: '/b/b.html', title: '끝난 일' } } : null) } })
            return [/전체 8|접기|data-all/.test(html), /📚 전체 브리프 3/.test(html), chips, opened, about, n(all),
              /<span>오늘<\/span><small>2<\/small>/.test(all), /<span>어제<\/span><small>1<\/small>/.test(all), all.includes('❓ 어느 쪽?'), all.includes('✅ merge 완료'), all.includes('노드 메모리'), /class="topic">인프라/.test(all),
              /data-ltopic="결정" aria-pressed="false">결정<small>2/.test(facets) && /data-lonly="pending" aria-pressed="false">⏳ 결정 대기<small>1/.test(facets), /3개/.test(facets), decided, /data-ltopic="결정" aria-pressed="true"/.test(facetsOn), /2 \/ 3/.test(facetsOn), /필터 지우기/.test(facetsOn),
              done, found, /조건에 맞는 브리프가 없습니다/.test(none), cmd.sel]
        """)
        self.assertEqual(got, [False, True, 5, '{"library":true}', None, 3, True, True, True, True, True, True,
                               True, True, 2, True, True, True, 1, 1, True, {"file": "b.html", "path": "/b/b.html", "title": "끝난 일", "fromLib": True}])

    def test_the_library_grass_picks_a_range_and_a_type_and_esc_clears_the_range_first(self):
        # The person: pick a range on the grass (as ~/briefs/index.html), and a
        # type filter; search, state, topic, type and range all AND; Esc takes
        # the range off before 📚 closes (the layers.js step, command.js cmdEscStep).
        got = self.run_js("""
            press('c')
            const today = new Date(), iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
            const day = (n) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n))
            const mk = (file, date, type, topic, state) => ({ file, path: '/b/' + file, title: file, date, type, topic, state, search: (file + ' ' + topic).toLowerCase() })
            blib.data = { total: 5, counts: {}, types: { decision: 2, result: 1, review: 1, research: 1 }, topics: [['결정', 3], ['인프라', 2]], items: [
              mk('a', day(0), 'decision', '결정', 'pending'), mk('b', day(0), 'review', '결정', 'read'), mk('c', day(1), 'decision', '인프라', 'read'),
              mk('d', day(5), 'result', '결정', 'done'), mk('e', day(40), 'research', '인프라', 'read')] }
            cmd.sel = { library: true }
            const n = () => blibItems().length
            const g = blibGrass()
            const cells = (g.match(/class="c[ "]/g) || []).length, days = (g.match(/data-d=/g) || []).length
            const lv = (d) => (new RegExp('class="c( l[1-4])?" data-d="' + d + '"').exec(g) || [])[1] || ''
            const lvls = [lv(day(0)), lv(day(2)), lv(day(1))]
            const out = [n()]
            blibSetRange(day(1), day(0)); out.push(n())           // two days: a, b, c
            blib.ty = 'decision'; out.push(n())                   // AND type: a, c
            blib.topic = '결정'; out.push(n())                    // AND topic: a
            blib.topic = ''; blib.ty = ''; blibSetRange(day(0), day(1)); out.push(blib.from === day(1) && blib.to === day(0))  // reversed pair is ordered
            blibClearRange(); blib.ty = 'review'; out.push(n()); blib.ty = ''
            // shift+click extends from the anchor, a click on the lone day clears it
            blibRangeChanged = () => {}
            const cell = (d) => ({ dataset: { d } })
            blibGridClick(cell(day(5)), { detail: 0 }); out.push([blib.from, blib.to, blib.anc].join() === [day(5), day(5), day(5)].join())
            blibGridClick(cell(day(0)), { detail: 0, shiftKey: true }); out.push(blib.from === day(5) && blib.to === day(0))
            blibClearRange(); blibGridClick(cell(day(2)), { detail: 0 }); blibGridClick(cell(day(2)), { detail: 0 }); out.push(blib.from === '')
            // touch: tap the start, tap the end
            blibGridClick(cell(day(3)), { pointerType: 'touch' }); const waiting = blib.wait; blibGridClick(cell(day(1)), { pointerType: 'touch' })
            out.push(waiting, blib.wait, blib.from === day(3) && blib.to === day(1))
            // Esc: the range first, then 📚 itself closes
            const a = cmdEscStep(), left = [!!blib.from, !!cmd.sel?.library]
            const b = cmdEscStep(), after = cmd.sel
            return [cells, days, lvls, out, [a, left], [b, after]]
        """)
        cells, days, lvls, out, first, second = got
        # 53 weeks x 7 cells (the future ones of this week are blank), plus the legend's 5.
        self.assertEqual(cells, 53 * 7 + 5)
        self.assertTrue(53 * 7 - 6 <= days <= 53 * 7)
        # the index's scale, 1 + (n-1)*4//peak: two briefs on the busiest day is l3, one is l1, none stays plain
        self.assertEqual(lvls, [" l3", "", " l1"])
        self.assertEqual(out[:4], [5, 3, 2, 1])
        self.assertEqual(out[4:6], [True, 1])
        self.assertEqual(out[6:], [True, True, True, True, False, True])
        self.assertEqual(first, [True, [False, True]])
        self.assertEqual(second[0], True)

    def test_a_busy_session_is_sent_on_a_second_enter_and_then_the_next_one_opens(self):
        got = self.run_js("""
            return (async () => {
              calls()
              const posts = [], answers = [{ busy: 'inbox' }, { ok: true }]
              cmdPost = async (body) => { posts.push(body); return answers.shift() }
              cmdAsk = () => {}
              await cmdReplyReal(cmd.sel, { kind: 'reply', value: '네' }, '네')
              const after1 = [cmd.sel.sid, !!cmd.force]
              await cmdReplyReal(cmd.sel, { kind: 'reply', value: '네' }, '네')
              return [posts.map((b) => [b.sid, b.value, !!b.force]), after1, cmd.sel.sid, Object.keys(cmd.sent)]
            })()
        """)
        self.assertEqual(got, [[["s1", "네", False], ["s1", "네", True]], ["s1", True], "s2", ["s1"]])


    def test_a_review_item_is_confirmed_by_1_then_enter_and_nothing_else(self):
        got = self.run_js("""
            reviews()
            const early = press('Enter'), two = press('2'), nine = press('9')
            press('1'); const armed = cmd.armed
            press('Enter')
            return [early, two, nine, armed, reviewed]
        """)
        self.assertEqual(got, [False, False, False, {"review": "cc-mods#85"}, [["confirm", "cc-mods#85"]]])

    def test_enter_in_a_review_box_sends_the_issue_or_the_armed_confirm_or_says_what_to_do(self):
        got = self.run_js("""
            reviews()
            const empty = inRevBox('Enter', '  ')
            cmd.armed = { review: 'cc-mods#85' }
            const words = inRevBox('Enter', ' reload 경우 미재현 ')
            const armed = inRevBox('Enter', '')
            const other = [['Enter', { isComposing: true }], ['Enter', { keyCode: 229 }], ['Enter', { shiftKey: true }], ['j', {}], ['1', {}], ['m', {}]].map(([k, m]) => inRevBox(k, 'x', m)[0])
            return [empty, words, armed, inRevBox('Escape', 'x'), other, reviewed, toasts.length]
        """)
        self.assertEqual(got[:4], [[True, True, False]] * 3 + [[True, True, True]])
        self.assertEqual(got[4], [False] * 6)
        self.assertEqual(got[5], [["issue", "cc-mods#85", "reload 경우 미재현"], ["confirm", "cc-mods#85"]])
        self.assertEqual(got[6], 1)

    def test_keys_typed_in_a_review_box_never_reach_the_view_and_a_review_keeps_the_floor_keys(self):
        # Ownership: the item takes 1, Enter (armed) and m; the box takes
        # everything typed; the floor keys still pass through.
        got = self.run_js("""
            reviews()
            const typed = ['j', 'k', '1', '2', 'Enter', 'm', 'i', 'd', 'g', 'Escape'].filter((k) => press(k, true))
            const still = [cmd.sel.review, cmd.armed, reviewed.length]
            const floor = ['n', 'p', 'v', 'f', '0', 'Tab', 'ArrowUp', '?', ',', 'g'].filter((k) => press(k))
            press('Escape'); const shut = [cmd.sel, cmd.on]
            return [typed, still, floor, shut, focused.length]
        """)
        self.assertEqual(got, [[], ["cc-mods#85", None, 0], [], [None, True], 0])

    def test_alt_m_goes_to_a_review_box_only_with_a_review_picked(self):
        # TWeb's normal mode keeps bare m, so ⌥M does it too; typed in a box it is the box's.
        got = self.run_js("""
            let boxed = 0
            revFocus = () => { boxed++ }
            reviews()
            const a = press('m', false, true), inBox = press('m', true, true)
            cmd.sel = { file: 'a.html' }; const onBrief = press('m', false, true)
            cmd.sel = { sid: 's1', name: 'one' }; const onCall = press('m', false, true)
            cmd.sel = { review: 'tweb-240', coord: 'c1' }; card.style.display = 'block'; const cardUp = press('m', false, true)
            return [a, inBox, onBrief, onCall, cardUp, boxed]
        """)
        self.assertEqual(got, [True, False, False, False, False, 1])

    def test_alt_i_j_k_do_what_i_j_k_do_for_tweb_and_leave_a_box_and_the_card_alone(self):
        # TWeb's normal mode keeps bare i, j and k; ⌥ reaches the page.
        got = self.run_js("""
            crew(); cmd.sel = { sid: 'w1', name: 'fix' }
            const seen = []
            for (const k of ['j', 'j', 'k']) { press(k, false, true); seen.push(cmd.sel.file || cmd.sel.sid) }
            const typedJ = press('j', true, true), boxI = press('i', true, true), floorI = press('i', false, true)
            card.style.display = 'block'; const cardJ = press('j', false, true), cardI = press('i', false, true); card.style.display = 'none'
            // Nothing waits: ⌥J is the floor's.
            cmd.data.pending = []; cmd.data.calls = []; cmd.data.reviews = []
            const none = press('j', false, true)
            return [seen, typedJ, boxI, floorI, cardJ, cardI, none]
        """)
        self.assertEqual(got, [["a.html", "s1", "a.html"], False, True, True, False, False, False])

    def test_t_turns_a_picked_session_between_its_last_answer_and_its_card(self):
        got = self.run_js("""
            crew(); cmd.sel = null
            const none = press('t')
            cmdClick(row('w1'))
            const t1 = press('t'), v1 = cmd.view, t2 = press('t'), v2 = cmd.view
            // In a box bare t is typing; ⌥T works there, as ⌥G does.
            const typed = press('t', true), v3 = cmd.view, alt = press('t', true, true), v4 = cmd.view
            // On the card the box still speaks straight to that session.
            const about = cmdAbout().label
            cmdSay('카드 보고 하는 말')
            // An open floor card or file viewer keeps t; a brief or a review item is no session.
            card.style.display = 'block'; const cardT = press('t'); card.style.display = 'none'
            viewer.path = '/x.md'; const viewT = press('t'); viewer.path = ''
            const keep = cmd.sel; cmd.sel = { file: 'a.html' }; const briefT = press('t'); cmd.sel = { review: 'cc-mods#85', coord: 'c1' }; const revT = press('t'); cmd.sel = keep
            // Another session opens in the same look; a close goes back to the answer.
            cmdClick(row('w4')); const v5 = cmd.view
            press('Escape')
            return [none, t1, v1, t2, v2, typed, v3, alt, v4, about, replies, cardT, viewT, briefT, revT, v5, cmd.sel, cmd.view]
        """)
        self.assertEqual(got, [False, True, "card", True, "said", False, "said", True, "card", "👷 office 지휘 정리 에게",
                               [["w1", {"kind": "reply", "value": "카드 보고 하는 말"}, "지시"]], False, False, False, False, "card", None, "said"])

    def test_b_walks_the_brief_line_under_the_box(self):
        got = self.run_js("""
            calls()
            cmd.data.recent = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ path: '/b/' + n + '.html', file: n + '.html', title: 'B' + n }))
            const chips = cmdBriefs().map((b) => b.title)
            cmd.sel = null
            const seen = []
            for (let n = 0; n < 6; n++) { press('b'); seen.push(cmd.sel.path) }
            // ⇧B goes back; from a session (not a chip) b starts at the newest.
            let stopped = false; commandKey({ altKey: false, shiftKey: true, preventDefault: () => { stopped = true } }, 'b', false); const back = cmd.sel.path
            cmd.sel = { sid: 's1', name: 'one' }; press('b'); const fromCall = cmd.sel.path
            // Typed in a box bare b is typing; ⌥B works there. The floor card keeps ⌥B (its btw), the viewer keeps b.
            const typed = press('b', true), sel1 = cmd.sel.path, alt = press('b', true, true), sel2 = cmd.sel.path
            card.style.display = 'block'; const cardB = press('b', false, true); card.style.display = 'none'
            viewer.path = '/x.md'; const viewB = press('b'); viewer.path = ''
            cmd.data.recent = []; const none = press('b')
            return [chips, seen, back, fromCall, typed, sel1, alt, sel2, cardB, viewB, none]
        """)
        self.assertEqual(got, [["B1", "B2", "B3", "B4", "B5"], ["/b/1.html", "/b/2.html", "/b/3.html", "/b/4.html", "/b/5.html", "/b/1.html"],
                               "/b/5.html", "/b/1.html", False, "/b/1.html", True, "/b/2.html", False, False, False])

    def test_x_ends_the_picked_session_and_an_adopted_one_only_on_a_second_press(self):
        got = self.run_js("""
            crew(); cmdClick(row('w4'))
            const posts = []
            cmdPost = async (b) => { posts.push(b); return b.confirm ? { ok: true, sent: 'gavin-jeong-63 끝냄' } : { confirm: '이 세션을 끝냅니다: Twingate 조사, pane %4', dirty: [] } }
            // The harness's setTimeout never fires: wait on a few microtasks for the post.
            const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve() }
            return (async () => {
              const t = press('x'); await flush()
              const armed = !!crewState.arm
              press('x'); await flush()
              // Typed in a box bare x is typing, ⌥X works there; over the floor card or the viewer, never.
              const typed = press('x', true)
              card.style.display = 'block'; const cardX = press('x', false, true); card.style.display = 'none'
              viewer.path = '/x.md'; const viewX = press('x'); viewer.path = ''
              // A coordinator is never a target; nothing picked, x is the floor's.
              cmd.sel = { sid: 'c1', name: 'd9' }; const coordX = press('x'); await flush()
              cmd.sel = null; const none = press('x')
              return [t, armed, posts, cmd.sel, typed, cardX, viewX, coordX, none]
            })()
        """)
        self.assertEqual(got[:2], [True, True])
        self.assertEqual(got[2], [{"kind": "session_end", "sid": "w4"}, {"kind": "session_end", "sid": "w4", "confirm": True}, {"kind": "session_end", "sid": "c1"}][:2] + got[2][2:])
        self.assertEqual(len(got[2]), 2, "a coordinator is never posted")
        self.assertEqual(got[3:], [None, False, False, False, True, False])

    def test_release_and_end_buttons_follow_the_relation(self):
        got = self.run_js("""
            crew()
            return [crewButtons('w1').includes('rel'), crewButtons('w1').includes('end'), crewButtons('s2').includes('rel'), crewButtons('s2').includes('end'), crewButtons('c1')]
        """)
        # A worker can be released; a session no coordinator has can only end; a coordinator, neither.
        self.assertEqual(got, [True, True, False, True, ""])

    def test_a_picked_session_links_its_brief_from_what_it_asks_or_its_row(self):
        got = self.run_js("""
            crew()
            cmd.data.coordinators[0].workers[0].brief = { path: '/b/row.html', title: 'Row', pending: false }
            const fromRow = cmdSessionBrief('w1').path
            cmd.ask = { sid: 'w1', brief: { path: '/b/ask.html', title: 'Ask', pending: true } }
            const fromAsk = cmdSessionBrief('w1').path
            return [fromRow, fromAsk, cmdSessionBrief('w4'), cmdSessionBrief('s2')]
        """)
        self.assertEqual(got, ["/b/row.html", "/b/ask.html", None, None])

    def test_the_cards_tabs_take_alt_digits_and_its_shelf_brackets_only_with_no_row_open(self):
        got = self.run_js("""
            crew(); cmdPickCall({ sid: 'w1', name: 'fix', window: 'w:3' })
            const tabs = []
            cmd.card = { dataset: { sid: 'w1' }, selectTab: (i) => tabs.push(i), shelfTab: (d) => tabs.push('s' + d) }
            // The last answer showing: [ ] and ⌥2 are not the view's.
            const onSaid = [press(']'), press('2', false, true)]
            press('t')
            const onCard = [press(']'), press('['), press('2', false, true), press('9', true, true)]
            // A bare digit still arms the session's choice (none here), never a tab.
            const bare = press('2')
            // A card still on screen from another session is not this one's.
            cmd.card.dataset.sid = 'w4'; const stale = [press(']'), press('3', false, true)]
            // Opened from the table, [ ] are the row's tabs (마지막 답 · 카드), not the shelf.
            cmd.card.dataset.sid = 'w1'; cmdClick(row('w1')); const look = cmd.view
            const step = [press(']'), cmd.view, press('['), cmd.view]
            return [onSaid, onCard, bare, stale, tabs, look, step]
        """)
        self.assertEqual(got, [[False, False], [True, True, True, True], False, [False, False], ["s1", "s-1", 1, 8], "card", [True, "said", True, "card"]])

    def test_where_the_task_went_is_the_first_send_or_spawn_after_it_was_sent(self):
        got = self.run_js("""
            const c = { log: [{ at: 100, kind: 'send', text: 'old: x' }, { at: 5000, kind: 'event', text: 'fix: finished' }, { at: 6000, kind: 'send', text: 'fix: 테스트 먼저' }, { at: 7000, kind: 'spawn', text: 'new opus/high in /w' }] }
            return [cmdWhere(c, 5000), cmdWhere({ log: [{ at: 9000, kind: 'spawn', text: 'new-one opus/high in /w' }] }, 8000), cmdWhere(c, 8000), cmdWhere(undefined, 1)]
        """)
        self.assertEqual(got[1:], ["🆕 새 worker <b>new-one</b>", "", ""])
        self.assertEqual(got[0], "👷 <b>fix</b>에 맡김")

    def test_an_answer_to_a_session_at_work_stays_on_it_and_one_waiting_goes_on(self):
        got = self.run_js("""
            return (async () => {
              crew()
              cmdPost = async () => ({ ok: true })
              cmd.sel = { sid: 'w1', name: 'fix' }
              await cmdReplyReal(cmd.sel, { kind: 'reply', value: 'x' }, '답장')
              const stay = cmd.sel.sid
              cmd.sel = { sid: 's1', name: 'one' }
              await cmdReplyReal(cmd.sel, { kind: 'reply', value: 'y' }, '답장')
              return [stay, cmd.sel.sid]
            })()
        """)
        self.assertEqual(got, ["w1", "s2"])

    def test_the_box_speaks_about_what_is_open_and_x_makes_it_a_plain_task(self):
        got = self.run_js("""
            return (async () => {
              crew()
              cmdReply = cmdReplyReal
              const posts = []
              cmdPost = async (body) => { posts.push(body); return body.kind === 'coord_say' ? { ok: true, sent: 'x', at: 5 } : { ok: true } }
              cmd.data.pending[0].decision.worker = 'fix'
              cmd.data.pending[0].decision.coordinator = 'c1'
              cmd.data.reviews = [{ coord: 'c1', id: 'cc-mods#85', title: 'R1', links: [] }]
              const out = []
              cmd.sel = null; out.push(cmdAbout()); await cmdSay('할 일')
              cmd.sel = { file: 'a.html', title: 'A' }; out.push(cmdAbout().label); await cmdSay('표를 접어 줘')
              revPick(cmd.data.reviews[0]); out.push(cmdAbout().label); await cmdSay('링크가 죽었어')
              cmdPickCall({ sid: 'w1', name: 'fix', window: 'w:3' }); out.push(cmdAbout().label); await cmdSay('테스트부터'); out.push(cmd.said.direct)
              // ✕ on the chip: the same thing open, the box is a plain task again.
              cmd.aboutOff = cmdAbout().key; out.push(cmdAbout()); await cmdSay('아무 데나')
              cmd.sel = { file: 'a.html', title: 'A' }; out.push(!!cmdAbout())
              return [out, posts]
            })()
        """)
        out, posts = got
        # A session is named by what it was doing, not its slug.
        self.assertEqual(out, [None, "📄 A 에 대해", "🔎 cc-mods#85 에 대해", "👷 office 지휘 정리 에게", "office 지휘 정리", None, True])
        self.assertEqual(posts, [
            {"kind": "coord_say", "coord": "c1", "slug": "", "value": "할 일"},
            {"kind": "coord_say", "coord": "c1", "slug": "", "value": "표를 접어 줘", "re": {"brief": "a.html", "worker": "fix"}},
            {"kind": "coord_say", "coord": "c1", "slug": "", "value": "링크가 죽었어", "re": {"review": "cc-mods#85"}},
            # A session is told straight, as its own view's box does: not through a coordinator.
            {"sid": "w1", "kind": "reply", "value": "테스트부터"},
            {"kind": "coord_say", "coord": "c1", "slug": "", "value": "아무 데나"},
        ])


    def test_the_table_is_a_row_a_session_with_the_ones_that_need_the_person_first_and_the_rest_folded(self):
        got = self.run_js("""
            table()
            const html = tblHtml()
            cmdFold('others'); const open = tblHtml(); cmdFold('others')
            // A row picked from under 그 밖 still shows folded.
            cmd.row = 's:w4'; const picked = tblHtml(); cmd.row = null
            const needs = tblAll().filter((R) => R.needs).length
            cmd.data.table = cmd.data.table.slice(3); const none = tblHtml()
            return [html, open, picked, none, needs]
        """)
        html, opened, picked, none, needs = got
        self.assertIn("✋ 내 차례 3", html)
        # A row overlays what it holds: ❓ its decision, 🙋 its call, 🔎 its review.
        self.assertRegex(html, r'data-row="s:w1".*❓1 🙋 🔎1')
        # Named by its summary; the slug a small tag.
        self.assertIn('<b title="office 지휘 정리">office 지휘 정리</b>', html)
        self.assertIn('<span class="slug">fix</span>', html)
        self.assertIn("Z?", html)
        # No summary: the name alone, no tag.
        self.assertIn('<b title="one">one</b>', html)
        self.assertLess(html.index('data-row="s:w1"'), html.index('data-row="s:s1"'))
        self.assertLess(html.index('data-row="s:s1"'), html.index('data-row="s:c1"'))
        # The rest fold to one line, and how many of them are at work.
        self.assertIn("👷 그 밖 2", html)
        self.assertIn("일하는 중 1", html)
        self.assertNotIn('data-row="s:w4"', html)
        self.assertIn('data-row="s:w4"', opened)
        self.assertIn('data-end="w4"', opened)
        self.assertIn('data-row="s:w4"', picked)
        self.assertNotIn('data-row="s:w2"', picked)
        # Nothing needs the person: no heading, no notice, only the fold.
        self.assertNotIn("내 차례", none)
        self.assertIn("👷 그 밖 2", none)
        self.assertIn("<colgroup>", none)
        self.assertEqual(needs, 3)

    def test_j_and_k_walk_the_rows_that_need_the_person_and_never_the_folded_ones(self):
        got = self.run_js("""
            table()
            const seen = []
            for (let n = 0; n < 4; n++) { press('j'); seen.push([cmd.row, tblTabNow()]) }
            press('k'); seen.push([cmd.row, tblTabNow()])
            // From a row under 그 밖, j starts at the first again.
            cmdClick(row('w4')); const folded = [cmd.row, cmd.sel.sid]
            press('j'); seen.push([cmd.row, tblTabNow()])
            // A brief opened from its chip: j goes on from its row.
            cmdPick({ file: 'a.html', path: '/b/a.html', title: 'A' }); press('j'); seen.push([cmd.row, tblTabNow()])
            // Nothing needs the person: j/k are the floor's.
            cmd.data.table = cmd.data.table.slice(3); cmd.row = null
            return [seen, folded, press('j'), press('k')]
        """)
        self.assertEqual(got, [[["s:w1", "dec"], ["s:s1", "wait"], ["s:c1", "rev"], ["s:w1", "dec"], ["s:c1", "rev"], ["s:w1", "dec"], ["s:s1", "wait"]], ["s:w4", "w4"], False, False])

    def test_a_rows_tabs_are_what_it_holds_most_urgent_first_and_tab_moves_between_them(self):
        got = self.run_js("""
            table()
            cmdClick(row('w1'))
            const first = [tabs(), tblTabNow(), cmd.sel.file]
            const walk = []
            for (let n = 0; n < 4; n++) { press('Tab'); walk.push(tblTabNow()) }
            let stopped = false; commandKey({ altKey: false, shiftKey: true, preventDefault: () => { stopped = true } }, 'Tab', false); walk.push(tblTabNow())
            press(']'); walk.push(tblTabNow()); press('['); walk.push(tblTabNow())
            // ⌥[ ⌥] for TWeb's normal mode, which keeps the bare keys.
            press(']', false, true); walk.push(tblTabNow())
            const revSel = cmd.sel
            // A session waiting on nobody: its last answer and its card.
            cmdClick(row('w4')); const quiet = tabs()
            // Walking onto the coordinator's row never changes where the box's tasks go.
            cmd.coord = null; cmd.row = 's:s1'; press('j', false, true); const walked = [cmd.row, cmd.coord]
            // Clicking it does: its review and its look.
            cmdClick(row('c1')); const boss = [tabs(), cmd.sel.revs, cmd.coord]
            return [first, walk, revSel, quiet, boss, walked]
        """)
        first, walk, rev_sel, quiet, boss, walked = got
        self.assertEqual(walked, ["s:c1", None])
        self.assertEqual(first, [["dec", "wait", "rev", "card"], "dec", "a.html"])
        self.assertEqual(walk, ["wait", "rev", "card", "dec", "card", "dec", "card", "dec"])
        self.assertEqual(quiet, ["said", "card"])
        # Opening the coordinator's row makes it the one the box speaks to.
        self.assertEqual(boss, [["rev", "said", "card"], "s:c1", "c1"])

    def test_tab_and_brackets_are_the_floors_unless_a_row_with_two_tabs_is_open_and_never_in_a_box(self):
        got = self.run_js("""
            table()
            const shut = ['Tab', '[', ']'].map((k) => press(k))
            // A brief from a chip has no row: the floor's.
            cmdPick({ file: 'a.html', path: '/b/a.html', title: 'A' }); cmd.row = null
            const chip = ['Tab', '[', ']'].map((k) => press(k))
            // A row with one tab (a brief nobody else holds) leaves them too.
            cmd.data.table.push({ key: 'b:z.html', name: 'Z', decisions: ['z.html'], reviews: [] })
            cmd.data.pending.push({ file: 'z.html', path: '/b/z.html', title: 'Z', decision: { question: '?', options: [{ label: 'Y' }] } })
            cmdClick(row('b:z.html')); const one = [tabs(), ...['Tab', ']'].map((k) => press(k))]
            cmdClick(row('w1'))
            const typed = ['Tab', '[', ']'].map((k) => press(k, true)).concat([press(']', true, true)])
            const still = tblTabNow()
            return [shut, chip, one, typed, still]
        """)
        self.assertEqual(got, [[False, False, False], [False, False, False], [["dec"], False, False], [False, False, False, False], "dec"])

    def test_an_answer_goes_on_to_the_rows_next_need_then_the_next_row(self):
        got = self.run_js("""
            return (async () => {
              table()
              cmdPost = async (b) => ({ ok: true, sent: 'x' })
              cmdAsk = () => {}
              cmdClick(row('w1'))
              const p = cmd.data.pending[0], q = cmdOpen(p)[0]
              const at = []
              // The decision answered: the same row, its call next (the server has not caught up).
              await cmdAnswerReal(p, q, { label: 'Y' }); at.push([cmd.row, tblTabNow()])
              // Its call answered: its review.
              cmdReply = cmdReplyReal
              await cmdReply(cmd.sel, { kind: 'reply', value: '네' }, '네'); at.push([cmd.row, tblTabNow()])
              // Its review confirmed: the row needs nothing; on to the next row.
              if (!revCur(cmd.sel)) return at
              await revConfirmReal({ review: revCur(cmd.sel).id, coord: 'c1' }); at.push([cmd.row, tblTabNow()])
              // The last row's need done: back to the first that still needs the person.
              cmdClick(row('c1')); await revConfirmReal({ review: 'cc-mods#85', coord: 'c1' }); at.push([cmd.row, tblTabNow()])
              // Nothing left: closed.
              cmdClick(row('s1')); await cmdReply(cmd.sel, { kind: 'reply', value: 'x' }, 'x'); at.push([cmd.row, cmd.sel])
              return at
            })()
        """)
        self.assertEqual(got, [["s:w1", "wait"], ["s:w1", "rev"], ["s:s1", "wait"], ["s:s1", "wait"], [None, None]])

    def test_a_rows_review_tab_lists_its_items_confirms_one_or_all_and_an_issue_stays(self):
        got = self.run_js("""
            return (async () => {
              table()
              cmd.data.table[0].reviews.push(['c1', 'tweb-240'])
              cmd.data.reviews.push({ coord: 'c1', coordName: 'd9', id: 'tweb-240', title: 'R t', links: [] })
              const posts = []
              cmdPost = async (body) => { posts.push(body); return { ok: true, sent: 'x' } }
              cmdClick(row('w1')); tblShow(tblFind('s:w1'), 'rev')
              const list = [cmd.sel.revs, revRow(cmd.sel).map((r) => r.id), revCur(cmd.sel).id, cmdAbout().label]
              // Another item unfolded: the keys and the box work on it.
              cmd.sel.open = 'c1|tweb-240'
              const cur = revCur(cmd.sel).id
              press('1'); const armed = cmd.armed
              await revIssueReal({ review: 'tweb-240', coord: 'c1' }, '다시 봐 줘')
              const issue = [cmd.sel.revs, cmd.data.reviews.find((r) => r.id === 'tweb-240').issues.map((i) => i.text)]
              await revConfirmAll(cmd.sel)
              return [list, cur, armed, issue, posts, cmd.data.reviews.map((r) => r.id), cmd.row, tblTabNow()]
            })()
        """)
        list_, cur, armed, issue, posts, left, row_, tab = got
        self.assertEqual(list_, ["s:w1", ["fix", "tweb-240"], "fix", "🔎 R fix 에 대해"])
        self.assertEqual((cur, armed), ("tweb-240", {"review": "tweb-240"}))
        self.assertEqual(issue, ["s:w1", ["다시 봐 줘"]])
        self.assertEqual(posts, [{"kind": "review_issue", "coord": "c1", "id": "tweb-240", "value": "다시 봐 줘"}, {"kind": "review_confirm", "coord": "c1", "id": "fix"}, {"kind": "review_confirm", "coord": "c1", "id": "tweb-240"}])
        # Both confirmed: the row's other needs come next (its decision).
        self.assertEqual((left, row_, tab), (["cc-mods#85"], "s:w1", "dec"))

    def test_end_on_a_folded_row_opens_it_and_asks_there(self):
        got = self.run_js("""
            table()
            const asked = []
            crewEnd = (s) => { asked.push(s.sid) }
            cmdClick({ target: { closest: (q) => (q === 'button[data-end]' ? { dataset: { end: 'w4' } } : null) } })
            return [asked, cmd.sel.sid, cmd.sel.summary, cmd.row]
        """)
        self.assertEqual(got, [["w4"], "w4", "Twingate 조사", "s:w4"])

    def test_what_the_person_handled_leaves_my_turn_for_a_fold_of_its_own(self):
        got = self.run_js("""
            table()
            cmd.data.table.push(
              { key: 's:w5', sid: 'w5', name: 'luther', coord: 'c1', relation: 'owned', live: true, state: 'working', decisions: [], call: false, reviews: [], status: { state: 'blocked', kind: 'question', needs: '보낼지' }, handled: { how: 'working', at: Date.now() / 1000 } },
              { key: 'x:C1/1.2', name: 'Luther Lee', decisions: [], reviews: [], slx: [], handled: { how: 'reply', at: Date.now() / 1000 } })
            const need = (k) => tblAll().find((R) => R.row.key === k).needs
            const html = tblHtml()
            cmdFold('done'); const open = tblHtml(); cmdFold('done')
            return [need('s:w5'), need('x:C1/1.2'), /✔ 처리 중 2/.test(html), html.includes('data-row="s:w5"'), open.includes('data-row="s:w5"'), open.includes('지시 받고 일하는 중'), open.includes('스레드에 답함')]
        """)
        self.assertEqual(got, [False, False, True, False, True, True, True])

    def test_an_older_server_without_a_table_still_gets_a_row_each(self):
        got = self.run_js("""
            crew(); cmd.data.calls = [{ sid: 's1', name: 'one' }, { sid: 's2', name: 'two' }]
            cmd.data.reviews = [{ coord: 'c1', coordName: 'd9', id: 'cc-mods#85', title: 'R1', links: [] }]
            delete cmd.data.table
            return tblAll().map((R) => [R.row.key, R.needs])
        """)
        self.assertEqual(got[:4], [["b:a.html", True], ["s:s1", True], ["s:s2", True], ["r:c1|cc-mods#85", True]])
        self.assertIn(["s:w4", False], got)

if __name__ == "__main__":
    unittest.main()


class HeadsUpOfTest(unittest.TestCase):
    def test_the_ledger_band_is_kept_small_and_a_bad_one_is_none(self):
        self.assertEqual(command.heads_up_of({"headsUp": {"text": "x" * 300, "at": 5}}), {"text": "x" * 240, "at": 5})
        for bad in ({}, {"headsUp": None}, {"headsUp": {"text": "  "}}, {"headsUp": "text"}, {"headsUp": {"text": 3}}):
            self.assertIsNone(command.heads_up_of(bad))
