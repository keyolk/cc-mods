import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import textwrap
import urllib.request
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
import command  # noqa: E402
import coord  # noqa: E402
import office  # noqa: E402

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
        for target, attr, value in ((command, "BRIEFS", str(self.link)), (coord, "COORD_DIR", str(self.coords))):
            p = mock.patch.object(target, attr, value)
            p.start()
            self.addCleanup(p.stop)
        self.cli = mock.patch.object(command, "brief_bin", return_value=None)
        self.cli.start()
        self.addCleanup(self.cli.stop)
        coord._cache.update(at=0.0, ledgers=[])
        command._side.clear()
        command._title.clear()
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

    def ledger(self, workers: list[dict], on: bool = True) -> None:
        (self.coords / f"{COORD}.json").write_text(json.dumps({"sid": COORD, "on": on, "name": "cc-mods-d9", "workers": workers}))
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
        self.assertEqual(calls, [{"sid": WORKER, "name": "w", "window": "cc:3", "pane": "%9", "cwd": "/src/x", "attention": "ask", "doing": "asking", "boss": "cc-mods-d9", "slug": "w"}])

    def test_asking_reads_the_answer_tail_and_the_screen(self):
        me = {"pane": "%9", "wid": "@3", "window": "cc:3", "name": "w", "cwd": "/src/x"}
        with mock.patch.object(office, "pane_of", return_value=me), mock.patch.object(office, "last_text", return_value="설명\n\n진행할까요?"), mock.patch.object(office, "capture", return_value=[]), mock.patch.object(office, "inbox_waiting", return_value=None):
            a = office.asking(WORKER)
        self.assertEqual((a["sid"], a["pane"], a["cwd"], a["text"], a["cut"], a["dialog"]), (WORKER, "%9", "/src/x", "설명\n\n진행할까요?", False, None))
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
        with mock.patch.object(office, "snapshot", return_value=[]):
            with urllib.request.urlopen(base + "/command.js") as r:
                self.assertIn("javascript", r.headers["Content-Type"])
                self.assertIn(b"function commandKey", r.read())
            with urllib.request.urlopen(base + "/command") as r:
                self.assertEqual(set(json.loads(r.read())), {"at", "pending", "coordinators", "calls", "recent"})


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
    vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx)
    vm.runInContext(`
      var card = { style: { display: 'none' } }, viewer = { path: '' }, renders = 0, toasts = [], answers = []
      cmdRender = () => { renders++ }; cmdRenderDoc = () => {}; cmdLoad = () => {}
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
        floor = ["j", "k", "i", "n", "p", "v", "f", "0", "Tab", "ArrowUp", "?", ","]
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

    def test_j_and_k_walk_the_briefs_then_the_waiting_sessions(self):
        got = self.run_js("""
            calls(); cmd.sel = null
            const seen = []
            for (let n = 0; n < 4; n++) { press('j'); seen.push(cmd.sel.file || cmd.sel.sid) }
            press('k'); seen.push(cmd.sel.file || cmd.sel.sid)
            return seen
        """)
        self.assertEqual(got, ["a.html", "s1", "s2", "a.html", "s2"])

    def test_a_picked_session_arms_a_choice_with_a_digit_and_sends_it_with_enter(self):
        got = self.run_js("""
            calls()
            const nine = press('9'), early = press('Enter')
            press('2'); const armed = cmd.armed
            press('Enter')
            // A choice drawn on its screen is a key, not a reply.
            calls({ dialog: { question: 'Proceed?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] }, suggestions: [] })
            press('1'); press('Enter')
            return [nine, early, armed, replies]
        """)
        self.assertEqual(got, [False, False, {"call": "s1", "i": 1}, [["s1", {"kind": "reply", "value": "아니요"}, "아니요"], ["s1", {"kind": "key", "value": "1"}, "Yes"]]])

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


if __name__ == "__main__":
    unittest.main()
