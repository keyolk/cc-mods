import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
import office  # noqa: E402

# A pid no process holds: macOS and Linux both cap pids well below this.
DEAD_PID = 2**22 + 7


def pane_row(pane: str, sid: str) -> str:
    return "|".join([pane, "0", "1", "win", sid, "waiting", "", "", "", "0", "", "@1"])


class AliveSessionsTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        env = mock.patch.dict(os.environ, {"HOME": self.home.name})
        env.start()
        self.addCleanup(env.stop)
        office._registry.update(at=0.0, by={}, alive=set(), read=False)
        self.sessions = pathlib.Path(self.home.name, ".claude", "sessions")

    def register(self, sid: str, pid: int) -> None:
        self.sessions.mkdir(parents=True, exist_ok=True)
        (self.sessions / f"{pid}.json").write_text(json.dumps({"pid": pid, "sessionId": sid}))

    def test_only_a_running_pid_counts(self):
        self.register("live", os.getpid())
        self.register("ended", DEAD_PID)
        self.assertEqual(office.alive_sessions(), {"live"})

    def test_no_registry_is_unknown_not_empty(self):
        # Unknown keeps everyone in the office; an empty set would send them all home.
        self.assertIsNone(office.alive_sessions())

    def test_snapshot_drops_a_pane_whose_session_ended(self):
        self.register("live", os.getpid())
        self.register("ended", DEAD_PID)
        out = "\n".join([pane_row("%1", "live"), pane_row("%2", "ended")])
        with mock.patch.object(office.subprocess, "run", return_value=types.SimpleNamespace(stdout=out)), \
                mock.patch.object(office, "last_tool", return_value={}), \
                mock.patch.object(office, "tool_counts", return_value={"total": 0, "by": {}, "compacts": 0, "compactAt": None}), \
                mock.patch.object(office, "desk_items", return_value={}), \
                mock.patch.object(office, "born", return_value=None):
            people = office.snapshot()
        self.assertEqual([p["id"] for p in people], ["live"])
        # The pane itself is still live: the page must not take that as the session being there.
        self.assertEqual(office._live_panes, {"%1", "%2"})

    def test_snapshot_rows_carry_the_coordinator_role(self):
        out = "\n".join([pane_row("%1", "c1"), pane_row("%2", "w1"), pane_row("%3", "s1")])
        rel = {"c1": {"name": "lead", "crew": [{"sid": "w1", "slug": "a", "relation": "adopted"}]}, "w1": {"boss": {"sid": "c1", "name": "lead", "relation": "adopted", "slug": "a"}}}
        with mock.patch.object(office.subprocess, "run", return_value=types.SimpleNamespace(stdout=out)), \
                mock.patch.object(office.coord, "relations", return_value=rel), \
                mock.patch.object(office, "alive_sessions", return_value=None), \
                mock.patch.object(office, "last_tool", return_value={}), \
                mock.patch.object(office, "tool_counts", return_value={"total": 0, "by": {}, "compacts": 0, "compactAt": None}), \
                mock.patch.object(office, "desk_items", return_value={}), \
                mock.patch.object(office, "born", return_value=None):
            people = {p["id"]: p for p in office.snapshot()}
        self.assertTrue(people["c1"]["coord"])
        self.assertEqual(people["c1"]["coordName"], "lead")
        self.assertEqual(people["c1"]["crew"][0]["sid"], "w1")
        self.assertFalse(people["w1"]["coord"])
        self.assertEqual(people["w1"]["boss"], {"sid": "c1", "name": "lead", "relation": "adopted", "slug": "a"})
        self.assertEqual((people["s1"]["coord"], people["s1"]["boss"], people["s1"]["crew"]), (False, None, []))


if __name__ == "__main__":
    unittest.main()


class PrefsTest(unittest.TestCase):
    # The skin and settings outlive the browser's storage: TWeb's Electron
    # Local Storage was found rebuilt empty and the skin fell back to default.
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        p = mock.patch.object(office, "PREFS_FILE", os.path.join(self.dir.name, "office", "prefs.json"))
        p.start()
        self.addCleanup(p.stop)

    def test_a_kept_choice_reads_back(self):
        self.assertEqual(office.prefs(), {})
        self.assertTrue(office.set_pref("office.skin", "guildhall"))
        self.assertTrue(office.set_pref("office-card-zoom", "1.2"))
        self.assertEqual(office.prefs(), {"office.skin": "guildhall", "office-card-zoom": "1.2"})
        self.assertTrue(office.set_pref("office.skin", None))
        self.assertEqual(office.prefs(), {"office-card-zoom": "1.2"})

    def test_only_the_pages_own_keys(self):
        self.assertFalse(office.set_pref("token", "x"))
        self.assertFalse(office.set_pref("office.skin", 3))
        self.assertFalse(office.set_pref("office.skin", "x" * 3000))
        self.assertEqual(office.prefs(), {})
