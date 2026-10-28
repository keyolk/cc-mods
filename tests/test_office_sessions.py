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


if __name__ == "__main__":
    unittest.main()
