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

    def test_a_worker_row_carries_its_declared_status(self):
        st = {"state": "blocked", "kind": "wait", "step": "CI"}
        coords = [{"sid": COORD, "name": "cc-mods-d9", "workers": [{"slug": "fix", "sid": OWNED, "status": st}, {"slug": "g", "sid": ADOPTED}]}]
        rows = {r["sid"]: r for r in turn.table([], [], [], coords, now=1000)}
        self.assertEqual(rows[OWNED]["status"], st)
        self.assertIsNone(rows[ADOPTED].get("status"))
        # A status asks nothing of the person: the row does not need them for it.
        self.assertEqual(rows[OWNED]["needKeys"], [])

    def test_a_worker_blocked_on_the_person_by_its_status_needs_them(self):
        N = 1794410000
        def need(st, **kw):
            coords = [{"sid": COORD, "name": "c", "workers": [{"slug": "w", "sid": OWNED, "live": True, "status": st}]}]
            return {r["sid"]: r for r in turn.table([], kw.get("calls", []), [], coords, now=N)}[OWNED]
        auth = {"state": "blocked", "kind": "auth", "needs": "`! warren login`", "at": (N - 1000) * 1000}
        r = need(auth)
        self.assertTrue(r["needs"])
        self.assertEqual(r["at"], N - 1000)
        # CI or a review wait, working again, or a block two hours old: not the person's turn.
        self.assertFalse(need({**auth, "kind": "wait"})["needs"])
        self.assertFalse(need({**auth, "state": "working"})["needs"])
        self.assertFalse(need({**auth, "at": (N - 9 * 3600) * 1000})["needs"])
        # No kind but a needs text counts; neither does not.
        self.assertTrue(need({"state": "blocked", "needs": "decide", "at": (N - 1000) * 1000})["needs"])
        self.assertFalse(need({"state": "blocked", "at": (N - 1000) * 1000})["needs"])
        # A dialog already holds the row: one need, not two.
        r = need(auth, calls=[{"sid": OWNED, "since": N - 500}])
        self.assertEqual([k[0] for k in r["needKeys"]], ["c"])

    def test_a_status_file_makes_a_row_for_a_session_no_coordinator_holds_and_beats_the_ledger_copy(self):
        N = 1794410000
        blk = {"state": "blocked", "kind": "permission", "needs": "merge it", "at": (N - 1000) * 1000}
        # No coordinator has OWNED: its declared status alone makes the row.
        r = {x["sid"]: x for x in turn.table([], [], [], [], now=N, declared={OWNED: {"name": "w", "summary": "s", "state": "waiting", "status": blk}})}[OWNED]
        self.assertTrue(r["needs"])
        self.assertTrue(r["byStatus"])
        # A session not blocked on the person makes none.
        rows = turn.table([], [], [], [], now=N, declared={OWNED: {"name": "w", "status": {"state": "working", "at": N * 1000}}})
        self.assertEqual(rows, [])
        # The ledger's copy is older than the file's: the file's wins.
        old = {"state": "working", "at": (N - 5000) * 1000}
        coords = [{"sid": COORD, "name": "c", "workers": [{"slug": "w", "sid": OWNED, "live": True, "status": old}]}]
        r = {x["sid"]: x for x in turn.table([], [], [], coords, now=N, declared={OWNED: {"status": blk}})}[OWNED]
        self.assertEqual(r["status"], blk)
        self.assertTrue(r["needs"])

    def test_a_block_a_few_hours_old_still_needs_the_person(self):
        N = 1794410000
        st = {"state": "blocked", "kind": "permission", "needs": "merge it", "at": (N - 4 * 3600) * 1000}
        self.assertTrue(turn.status_blocks_person(st, N))
        self.assertFalse(turn.status_blocks_person({**st, "at": (N - 9 * 3600) * 1000}, N))

    def test_a_dependency_a_feature_lacks_is_a_row_that_needs_the_person(self):
        dep = {"id": "gcl", "title": "📅 일정: gcl 업데이트 필요", "text": "옛 버전", "cmd": "make install", "link": None, "since": 900}
        rows = turn.table([], [], [], [], now=1000, deps=[dep])
        self.assertEqual([(r["key"], r["needs"], r["at"], r["dep"]["cmd"]) for r in rows], [("d:gcl", True, 900, "make install")])
        self.assertEqual(rows[0]["name"], dep["title"])


    def test_one_table_a_row_a_session_holding_its_decisions_call_and_reviews(self):
        coords = [{"sid": COORD, "name": "d9", "summary": "지휘", "state": "working", "live": True, "workers": [
            {"slug": "fix", "sid": OWNED, "summary": "office 지휘 정리", "state": "working", "live": True},
            {"slug": "tw", "sid": ADOPTED, "relation": "adopted", "summary": "Twingate 조사", "state": "done", "live": True},
            {"slug": "gone", "sid": None}]}]
        waiting = [{"file": "a.html", "decision": {"asked": "2026-11-10T08:00Z", "worker": "fix"}, "sessions": []},
                   # Recorded on the worker's session only: still its row.
                   {"file": "b.html", "decision": {"asked": "2026-11-10T09:30Z"}, "sessions": [OWNED]},
                   # The coordinator asked, names no worker, and the session it is
                   # recorded on is none of the table's: the coordinator's row.
                   {"file": "c.html", "decision": {"asked": "2026-11-10T06:00Z", "coordinator": COORD}, "sessions": ["44444444-4444-4444-4444-444444444444"]},
                   # Recorded on a session waiting on the person: that one's row.
                   {"file": "e.html", "decision": {"asked": "2026-11-10T09:50Z", "coordinator": COORD}, "sessions": [STRAY]},
                   # Nobody to hang it on: a row of its own, under its title.
                   {"file": "d.html", "title": "D 브리프", "decision": {"asked": "2026-11-10T05:00Z"}, "sessions": []}]
        calls = [{"sid": OWNED, "since": turn.epoch("2026-11-10T07:00Z"), "slug": "fix"}, {"sid": STRAY, "since": None, "name": "s", "summary": "남의 세션"}]
        reviews = [{"coord": COORD, "id": "fix", "updatedAt": turn.epoch("2026-11-10T09:00Z") * 1000},
                   {"coord": COORD, "coordName": "d9", "id": "cc-mods#85", "at": turn.epoch("2026-11-10T07:30Z") * 1000}]
        now = turn.epoch("2026-11-10T10:00Z")
        rows = turn.table(waiting, calls, reviews, coords, now=now)
        got = [(r["key"], r["decisions"], r["call"], [i for _, i in r["reviews"]], r["needs"]) for r in rows]
        # Longest waiting first (a row waits as long as its oldest thing); a
        # time not known counts as now; the rows waiting on nobody last.
        self.assertEqual(got, [
            ("b:d.html", ["d.html"], False, [], True),
            ("s:" + COORD, ["c.html"], False, ["cc-mods#85"], True),
            ("s:" + OWNED, ["a.html", "b.html"], True, ["fix"], True),
            ("s:" + STRAY, ["e.html"], True, [], True),
            ("s:" + ADOPTED, [], False, [], False),
        ])
        by = {r["key"]: r for r in rows}
        self.assertEqual([by["s:" + OWNED]["at"], by["s:" + STRAY]["at"]], [turn.epoch("2026-11-10T07:00Z"), turn.epoch("2026-11-10T09:50Z")])
        # A row carries what names it: the summary, the slug (a small tag in the view), whose and how it is.
        o = by["s:" + OWNED]
        self.assertEqual((o["name"], o["summary"], o["coord"], o["relation"], o["state"]), ("fix", "office 지휘 정리", COORD, "owned", "working"))
        self.assertEqual((by["s:" + COORD]["isCoord"], by["s:" + COORD]["summary"]), (True, "지휘"))
        self.assertEqual((by["s:" + STRAY]["summary"], by["b:d.html"]["name"]), ("남의 세션", "D 브리프"))
        self.assertEqual(by["s:" + ADOPTED]["relation"], "adopted")
        self.assertEqual(turn.table([], [], [], []), [])

    def test_trigger_rows_go_most_recent_first_after_the_rows_that_need_the_person(self):
        now = turn.epoch("2026-11-10T10:00Z")
        calls = [{"sid": STRAY, "since": turn.epoch("2026-11-10T01:00Z"), "name": "s"}]
        trig = [{"id": "old", "alive": False, "at": "2026-11-10T02:00Z"}, {"id": "new", "alive": False, "at": "2026-11-10T09:00Z"}, {"id": "mid", "alive": False, "at": "2026-11-10T05:00Z"}]
        rows = turn.table([], calls, [], [], trig, now=now)
        self.assertEqual([r["key"] for r in rows], ["s:" + STRAY, "x:new", "x:mid", "x:old"])

    def test_the_rows_waiting_on_nobody_go_by_name(self):
        coords = [{"sid": COORD, "name": "d9", "workers": [{"slug": "zz", "sid": OWNED}, {"slug": "aa", "sid": ADOPTED, "relation": "adopted"}]}]
        self.assertEqual([r["name"] for r in turn.table([], [], [], coords)], ["aa", "d9", "zz"])

    def test_a_session_that_lost_an_mcp_server_shows_it_and_a_stuck_one_needs_the_person(self):
        now = turn.epoch("2026-11-10T10:00Z")
        retrying = {"dropped": [{"server": "claude.ai Slack", "since": now - 60, "tries": 1}]}
        stuck = {"dropped": [{"server": "claude.ai Slack", "since": now - 600, "tries": 3, "stuck": True}]}
        coords = [{"sid": COORD, "name": "d9", "mcp": stuck, "workers": [{"slug": "zz", "sid": OWNED, "mcp": retrying}, {"slug": "aa", "sid": ADOPTED}]}]
        by = {r["key"]: r for r in turn.table([], [], [], coords, now=now)}
        # Still retrying on its own: shown, not the person's turn.
        self.assertEqual([m["server"] for m in by["s:" + OWNED]["mcp"]], ["claude.ai Slack"])
        self.assertFalse(by["s:" + OWNED]["needs"])
        # Past retrying alone: the person's, waited since it went.
        self.assertTrue(by["s:" + COORD]["needs"])
        self.assertEqual(by["s:" + COORD]["at"], now - 600)
        self.assertEqual(by["s:" + ADOPTED]["mcp"], [])


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
