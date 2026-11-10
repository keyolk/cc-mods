"""The person's turn (office/turn.py) and ending or releasing a session from
the command view (office/crew.py)."""

import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))

import coord  # noqa: E402
import crew  # noqa: E402
import turn  # noqa: E402

COORD = "c0000000-0000-0000-0000-00000000c0de"
OWNED = "11111111-1111-1111-1111-111111111111"
ADOPTED = "22222222-2222-2222-2222-222222222222"
STRAY = "33333333-3333-3333-3333-333333333333"


class TurnTest(unittest.TestCase):
    def test_times_as_the_sources_write_them(self):
        self.assertEqual(turn.epoch(1794299622), 1794299622.0)
        self.assertEqual(turn.epoch(1794299622173), 1794299622.173)
        self.assertEqual(turn.epoch("2026-11-08T01:00Z"), turn.epoch("2026-11-08T01:00:00+00:00"))
        self.assertEqual([turn.epoch(x) for x in (None, "", "soon", True)], [0.0] * 4)

    def test_one_list_oldest_first_and_a_workers_rows_together(self):
        waiting = [{"file": "a.html", "decision": {"asked": "2026-11-10T08:00Z", "worker": "fix"}, "sessions": []},
                   {"file": "b.html", "decision": {"asked": "2026-11-10T09:30Z"}, "sessions": [OWNED]}]
        calls = [{"sid": OWNED, "since": turn.epoch("2026-11-10T07:00Z"), "slug": None}, {"sid": STRAY, "since": None, "name": "s"}]
        reviews = [{"coord": COORD, "id": "fix", "updatedAt": turn.epoch("2026-11-10T09:00Z") * 1000}, {"coord": COORD, "id": "cc-mods#85", "at": turn.epoch("2026-11-10T07:30Z") * 1000}]
        now = turn.epoch("2026-11-10T10:00Z")
        rows = turn.rows(waiting, calls, reviews, {OWNED: "fix"}, now=now)
        got = [(r["kind"], r.get("file") or r.get("sid") or r.get("id"), r["worker"]) for r in rows]
        # fix's question (07:00) pulls its decisions and its review up beside it,
        # each in its own time; a time not known sorts as now, last.
        self.assertEqual(got, [("session", OWNED, "fix"), ("decision", "a.html", "fix"), ("review", "fix", "fix"), ("decision", "b.html", "fix"),
                               ("review", "cc-mods#85", None), ("session", STRAY, None)])
        self.assertEqual(rows[-1]["at"], now)
        self.assertEqual(turn.rows([], [], [], {}), [])


class CrewCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = pathlib.Path(tmp.name)
        (self.tmp / "coord").mkdir()
        self.wt = self.tmp / "wt"
        self.wt.mkdir()
        for target, attr, value in ((coord, "COORD_DIR", str(self.tmp / "coord")), (coord, "SUMMARY_FILE", str(self.tmp / "summary.json"))):
            p = mock.patch.object(target, attr, value)
            p.start()
            self.addCleanup(p.stop)
        coord._cache.update(at=0.0, ledgers=[])
        coord._sums.update(at=0.0, sums={})
        (self.tmp / "coord" / f"{COORD}.json").write_text(json.dumps({"sid": COORD, "on": True, "name": "d9", "workers": [
            {"slug": "fix", "sid": OWNED, "relation": "owned", "worktree": str(self.wt), "repoDir": "/src/repo"},
            {"slug": "tw", "sid": ADOPTED, "relation": "adopted", "auto": True}]}))
        (self.tmp / "summary.json").write_text(json.dumps({ADOPTED: {"text": "Twingate 조사"}}))
        self.people = [{"id": OWNED, "name": "fix", "pane": "%7", "cwd": str(self.wt)}, {"id": ADOPTED, "name": "tw", "pane": "%4", "cwd": "/src/tw"},
                       {"id": STRAY, "name": "s", "pane": "%9", "cwd": "/src/s"}, {"id": COORD, "name": "d9", "pane": "%1"}]
        self.sent: list = []
        self.calls: list = []
        self.dirty: dict[str, str] = {}
        self.held: dict[str, str] = {"%7": OWNED, "%4": ADOPTED, "%9": STRAY, "%1": COORD}

    def put(self, sid, text, keep=False):
        self.sent.append((sid, text, keep))

    def sh(self, argv, timeout=5):
        self.calls.append(argv)
        if argv[:2] == ["tmux", "display-message"]:
            return 0, self.held.get(argv[4], "")
        if argv[:2] == ["git", "-C"] and argv[3] == "status":
            return 0, self.dirty.get(argv[2], "")
        return 0, ""

    def end(self, sid, confirm=False):
        with mock.patch.object(os.path, "isdir", return_value=True):
            return crew.end(sid, confirm, self.people, self.put, sh=self.sh)

    def kills(self):
        return [a for a in self.calls if a[:2] == ["tmux", "kill-pane"]]


class EndTest(CrewCase):
    def test_an_owned_worker_is_closed_as_coord_close_does(self):
        code, j = self.end(OWNED)
        self.assertEqual((code, j["ok"]), (200, True))
        self.assertEqual(self.kills(), [["tmux", "kill-pane", "-t", "%7"]])
        self.assertIn(["git", "-C", "/src/repo", "worktree", "remove", str(self.wt)], self.calls)
        self.assertEqual(self.sent, [(COORD, "[office→coord] 세션 fix 끝냄 (pane %7 닫음, worktree 정리)", True)])

    def test_an_owned_worker_with_uncommitted_changes_is_refused(self):
        self.dirty[str(self.wt)] = " M office/command.js"
        code, j = self.end(OWNED, confirm=True)
        self.assertEqual((code, j["dirty"]), (409, [" M office/command.js"]))
        self.assertEqual((self.kills(), self.sent), ([], []))

    def test_an_adopted_session_ends_only_when_confirmed(self):
        self.dirty["/src/tw"] = "?? notes.md"
        code, j = self.end(ADOPTED)
        self.assertEqual((code, j["confirm"], j["dirty"]), (200, "이 세션을 끝냅니다: Twingate 조사, pane %4", ["?? notes.md"]))
        self.assertEqual(self.kills(), [])
        code, j = self.end(ADOPTED, confirm=True)
        self.assertEqual(code, 200)
        self.assertEqual(self.kills(), [["tmux", "kill-pane", "-t", "%4"]])
        # The person's own session: no worktree touched.
        self.assertFalse(any("worktree" in a for a in self.calls))
        self.assertEqual(self.sent, [(COORD, "[office→coord] 세션 tw 끝냄 (pane %4 닫음)", True)])

    def test_a_session_no_coordinator_has_is_confirmed_too_and_nobody_is_told(self):
        self.assertIn("confirm", self.end(STRAY)[1])
        self.assertEqual(self.end(STRAY, confirm=True)[0], 200)
        self.assertEqual((self.kills(), self.sent), ([["tmux", "kill-pane", "-t", "%9"]], []))

    def test_never_a_coordinator_nor_a_pane_that_holds_another_session(self):
        self.assertEqual(self.end(COORD, confirm=True)[0], 403)
        self.held["%4"] = STRAY
        self.assertEqual(self.end(ADOPTED, confirm=True)[0], 409)
        # The office's own TWeb pane has no session at all.
        self.held["%4"] = ""
        self.assertEqual(self.end(ADOPTED, confirm=True)[0], 409)
        self.assertEqual((self.end("../x")[0], self.end("44444444-4444-4444-4444-444444444444")[0]), (400, 404))
        self.assertEqual(self.kills(), [])


class ReleaseTest(CrewCase):
    def test_release_leaves_a_request_for_the_coordinator_and_tells_it(self):
        code, _ = crew.release(ADOPTED, self.put)
        self.assertEqual(code, 200)
        crew.release(OWNED, self.put)
        ops = json.loads((self.tmp / "coord" / "ops" / f"{COORD}.json").read_text())["ops"]
        self.assertEqual([(o["op"], o["sid"], o["slug"]) for o in ops], [("release", ADOPTED, "tw"), ("release", OWNED, "fix")])
        self.assertEqual(self.sent[0], (COORD, "[office→coord] 세션 tw 지휘 목록에서 뺌 (release; 세션은 계속 돎)", True))

    def test_release_refuses_a_coordinator_and_a_session_on_no_list(self):
        self.assertEqual(crew.release(COORD, self.put)[0], 403)
        self.assertEqual(crew.release(STRAY, self.put)[0], 404)
        self.assertFalse((self.tmp / "coord" / "ops").exists())

    def test_office_act_routes_both_kinds(self):
        with mock.patch.object(crew, "release", return_value=(200, {"r": 1})) as rel, mock.patch.object(crew, "end", return_value=(200, {"e": 1})) as end:
            self.assertEqual(crew.act({"kind": "session_release", "sid": ADOPTED}, self.people, self.put), (200, {"r": 1}))
            self.assertEqual(crew.act({"kind": "session_end", "sid": ADOPTED, "confirm": True}, self.people, self.put), (200, {"e": 1}))
        rel.assert_called_once_with(ADOPTED, self.put)
        self.assertEqual(end.call_args.args[:2], (ADOPTED, True))


if __name__ == "__main__":
    unittest.main()
