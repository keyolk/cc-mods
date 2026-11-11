"""The office's memory: what made one office grow to gigabytes in minutes
(tool_counts re-reading whole transcripts when /state calls overlapped) and
the bounds that keep it flat."""
import json
import os
import pathlib
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
import office  # noqa: E402


def tool_use(name="Read"):
    return {"type": "assistant", "timestamp": "2026-11-11T01:00:00Z", "message": {"role": "assistant", "content": [{"type": "tool_use", "name": name, "input": {}}]}}


class Home(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        env = mock.patch.dict(os.environ, {"HOME": self.home.name})
        env.start()
        self.addCleanup(env.stop)
        for d in (office._paths, office._counts, office._born):
            d.clear()
            self.addCleanup(d.clear)
        self.project = pathlib.Path(self.home.name, ".claude", "projects", "p")
        self.project.mkdir(parents=True)

    def append(self, sid, records):
        with open(self.project / f"{sid}.jsonl", "a") as f:
            for r in records:
                f.write(json.dumps(r, separators=(",", ":")) + "\n")
        return str(self.project / f"{sid}.jsonl")


class ToolCountsTest(Home):
    def test_overlapping_calls_count_each_line_once(self):
        # Two /state polls at once: the first is still parsing when the file
        # grows and the second reads it. The offset each one keeps must stay
        # inside the file, or the next call takes the file for rewritten and
        # reads it whole again (the 2.7 GB office).
        path = self.append("s", [tool_use()] * 3)
        parsing, release = threading.Event(), threading.Event()
        kind_of = office.kind_of

        def slow(name):
            if threading.current_thread().name == "first" and not parsing.is_set():
                parsing.set()
                release.wait(5)
            return kind_of(name)

        with mock.patch.object(office, "kind_of", side_effect=slow):
            first = threading.Thread(target=office.tool_counts, args=("s",), name="first")
            first.start()
            self.assertTrue(parsing.wait(5))
            self.append("s", [tool_use()] * 2)
            second = threading.Thread(target=office.tool_counts, args=("s",), name="second")
            second.start()
            second.join(0.5)
            release.set()
            first.join(5)
            second.join(5)
        self.assertLessEqual(office._counts[path]["off"], os.path.getsize(path))
        self.assertEqual(office.tool_counts("s")["total"], 5)

    def test_a_long_transcript_is_read_in_bounded_steps(self):
        # A cold office meets transcripts of 200 MB: each call reads at most
        # COUNT_STEP, whole lines only, and the total catches up over calls.
        line = tool_use()
        self.append("s", [line] * 50)
        size = len(json.dumps(line, separators=(",", ":"))) + 1
        reads = []
        real_open = open

        class Spy:
            def __init__(self, f):
                self.f = f

            def __enter__(self):
                return self

            def __exit__(self, *a):
                self.f.close()

            def read(self, n=-1):
                b = self.f.read(n)
                reads.append(len(b))
                return b

            def __getattr__(self, k):
                return getattr(self.f, k)

        with mock.patch.object(office, "COUNT_STEP", size * 10 + 5), mock.patch.object(office, "COUNT_CHUNK", size * 3 + 1), \
                mock.patch("builtins.open", side_effect=lambda *a, **k: Spy(real_open(*a, **k))):
            totals = [office.tool_counts("s")["total"] for _ in range(6)]
        self.assertEqual(totals, [10, 20, 30, 40, 50, 50])
        self.assertLessEqual(max(reads), size * 3 + 1)

    def test_a_half_written_last_line_waits(self):
        path = self.append("s", [tool_use()] * 2)
        with open(path, "a") as f:
            f.write('{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_')
        self.assertEqual(office.tool_counts("s")["total"], 2)
        with open(path, "a") as f:
            f.write('use","name":"Bash","input":{}}]}}\n')
        self.assertEqual(office.tool_counts("s")["total"], 3)

    def test_a_rewritten_transcript_is_counted_again(self):
        path = self.append("s", [tool_use()] * 4)
        self.assertEqual(office.tool_counts("s")["total"], 4)
        pathlib.Path(path).write_text(json.dumps(tool_use()) + "\n")
        self.assertEqual(office.tool_counts("s")["total"], 1)


def pane_row(pane, sid):
    return "|".join([pane, "0", "1", "win", sid, "waiting", "", "", "", "0", "", "@1"])


class SnapshotTest(Home):
    def test_overlapping_callers_share_one_snapshot(self):
        runs, gate = [], threading.Event()

        def slow_rows():
            runs.append(1)
            gate.wait(5)
            return [{"id": "s"}]

        with mock.patch.object(office, "_snapshot", side_effect=slow_rows):
            out = []
            ts = [threading.Thread(target=lambda: out.append(office.snapshot())) for _ in range(5)]
            for t in ts:
                t.start()
            threading.Event().wait(0.2)
            gate.set()
            for t in ts:
                t.join(5)
        self.assertLessEqual(len(runs), 2)  # the one running, and at most one that came after it began
        self.assertEqual(out, [[{"id": "s"}]] * 5)

    def test_a_call_after_the_last_one_ended_runs_again(self):
        with mock.patch.object(office, "_snapshot", side_effect=[[{"id": "a"}], [{"id": "b"}]]):
            self.assertEqual(office.snapshot(), [{"id": "a"}])
            self.assertEqual(office.snapshot(), [{"id": "b"}])

    def test_ended_sessions_are_forgotten(self):
        live, gone = self.append("live", [tool_use()]), self.append("gone", [tool_use()])
        office.tool_counts("live"), office.tool_counts("gone"), office.born("gone")
        out = "\n".join([pane_row("%1", "live")])
        with mock.patch.object(office.subprocess, "run", return_value=types.SimpleNamespace(stdout=out)), \
                mock.patch.object(office, "alive_sessions", return_value={"live"}), \
                mock.patch.object(office, "desk_items", return_value={}), \
                mock.patch.object(office, "subagents", return_value=[]), \
                mock.patch.object(office, "mcp_state", return_value=None):
            office.snapshot()
        self.assertIn(live, office._counts)
        self.assertNotIn(gone, office._counts)
        self.assertNotIn("gone", office._paths)

    def test_an_unknown_registry_forgets_nothing(self):
        gone = self.append("gone", [tool_use()])
        office.tool_counts("gone")
        with mock.patch.object(office.subprocess, "run", return_value=types.SimpleNamespace(stdout="")), \
                mock.patch.object(office, "alive_sessions", return_value=None):
            office.snapshot()
        self.assertIn(gone, office._counts)


class SaidTest(Home):
    def test_said_maps_the_transcript_instead_of_copying_it(self):
        sid = "0123abcd-0000-0000-0000-000000000000"
        self.append(sid, [{"type": "user", "message": {"role": "user", "content": "see /tmp/x/report.md"}}])
        said = office._said(sid)
        self.assertNotIsInstance(said, bytes)
        self.assertTrue(office.paths.mentioned(said, "/tmp/x/report.md"))
        self.assertFalse(office.paths.mentioned(said, "/tmp/x/other.md"))

    def test_said_of_an_empty_or_missing_transcript_is_empty(self):
        sid = "0123abcd-0000-0000-0000-000000000001"
        (self.project / f"{sid}.jsonl").write_text("")
        self.assertFalse(office._said(sid))
        self.assertFalse(office._said("0123abcd-0000-0000-0000-00000000ffff"))


class FootprintTest(unittest.TestCase):
    def test_footprint_is_this_process_in_bytes(self):
        n = office.footprint()
        self.assertIsNotNone(n)
        self.assertGreater(n, 1_000_000)
        self.assertLess(n, 1 << 40)

    def test_over_the_cap_warns_once_until_it_drops(self):
        office._mem["over"] = False
        said = []
        with mock.patch.object(office, "MEM_WARN", 100_000_000), mock.patch.object(office, "footprint", side_effect=[200_000_000, 300_000_000, 50_000_000, 200_000_000]), \
                mock.patch.object(office, "_warn", side_effect=said.append):
            for _ in range(4):
                office.mem_check()
        self.assertEqual(len(said), 2)
        self.assertIn("200 MB is over 100 MB", said[0])


if __name__ == "__main__":
    unittest.main()
