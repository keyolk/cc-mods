import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "bin" / "coord-report"
SID = "8aa8ea53-8bfd-4484-b94d-d9f9a7803da6"


class CoordReportTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)

    def run_it(self, *args):
        env = {**os.environ, "HOME": self.home.name}
        return subprocess.run([sys.executable, str(SCRIPT), *args], env=env, capture_output=True, text=True)

    def inbox(self):
        with open(os.path.join(self.home.name, ".claude/state/office/inbox", SID + ".json")) as f:
            return json.load(f)

    def test_a_report_lands_in_the_coordinator_inbox_and_appends(self):
        self.assertEqual(self.run_it(SID, "[worker a] READY abc").returncode, 0)
        self.assertEqual(self.inbox()["text"], "[worker a] READY abc")
        # Marked keep: the coordinator takes it however late it reads.
        self.assertIs(self.inbox()["keep"], True)
        # One not yet taken is kept, as office.py's inbox_put does.
        self.run_it(SID, "[worker b] BLOCKED x")
        self.assertEqual(self.inbox()["text"], "[worker a] READY abc\n\n[worker b] BLOCKED x")

    def test_a_bad_session_id_or_empty_text_writes_nothing(self):
        self.assertEqual(self.run_it("../../etc", "x").returncode, 2)
        self.assertEqual(self.run_it(SID, "  ").returncode, 2)
        self.assertFalse(os.path.exists(os.path.join(self.home.name, ".claude")))


if __name__ == "__main__":
    unittest.main()
