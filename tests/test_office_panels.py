import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
import office  # noqa: E402


def user(text, **kw):
    return {"type": "user", "timestamp": "2026-10-28T01:00:00Z", "message": {"role": "user", "content": text}, **kw}


def said(text):
    return {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def tool_result():
    return {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": [{"type": "text", "text": "out"}]}]}}


class PanelsTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        env = mock.patch.dict(os.environ, {"HOME": self.home.name})
        env.start()
        self.addCleanup(env.stop)
        office._paths.clear()
        self.addCleanup(office._paths.clear)
        self.claude = pathlib.Path(self.home.name, ".claude")
        self.project = self.claude / "projects" / "p"
        self.project.mkdir(parents=True)

    def write(self, sid, records):
        (self.project / f"{sid}.jsonl").write_text("\n".join(json.dumps(r, separators=(",", ":")) for r in records) + "\n")

    def test_history_pairs_each_prompt_with_its_last_words(self):
        self.write("s", [
            user("first ask"), said("thinking"), tool_result(), said("first answer"),
            user("<system-reminder>not the person</system-reminder>"),
            user("meta", isMeta=True),
            user("The cc-mods plugin sent a message: <task-notification>done</task-notification>"), said("noted"),
            user("second ask"), said("second answer"),
        ])
        h = office.history("s")
        self.assertEqual([(t["ask"], t["said"], t["notice"]) for t in h], [
            ("first ask", "first answer", False),
            ("The cc-mods plugin sent a message: <task-notification>done</task-notification>", "noted", True),
            ("second ask", "second answer", False),
        ])

    def test_history_reads_further_back_when_the_tail_is_all_tools(self):
        # The only prompt sits behind more tool output than the first window.
        big = {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "x" * 2000}]}}
        self.write("s", [user("old ask"), said("old answer")] + [big] * 40)
        with mock.patch.object(office, "HISTORY_TAIL", 10_000):
            self.assertEqual([t["ask"] for t in office.history("s")], ["old ask"])

    def test_work_lists_subagents_and_background_tasks(self):
        self.write("s", [user("go")])
        subs = self.project / "s" / "subagents"
        subs.mkdir(parents=True)
        (subs / "agent-a1.jsonl").write_text("")
        (subs / "agent-a1.meta.json").write_text(json.dumps({"description": "Find the bug", "agentType": "Explore"}))
        out = self.claude / "outputs" / "2026-10-28"
        out.mkdir(parents=True)
        (out / "s.json").write_text(json.dumps({"outputs": [{"kind": "bg", "title": "watch PR", "detail": "Monitor", "at": 1_790_000_000_000}, {"kind": "pr", "url": "https://x"}]}))
        w = office.work("s")
        self.assertEqual([(a["desc"], a["type"], a["live"]) for a in w["subagents"]], [("Find the bug", "Explore", True)])
        self.assertEqual(w["bg"], [{"title": "watch PR", "detail": "Monitor", "at": 1_790_000_000, "path": None}])

    def test_policy_carries_scopes_and_none_without_a_file(self):
        self.assertIsNone(office.policy("s"))
        pol = self.claude / "state" / "session_policy"
        pol.mkdir(parents=True)
        (pol / "s.json").write_text(json.dumps({"mode": "custom", "capabilities": {"gh_merge": "allow", "slack_send": "inherit"}, "gh_merge_repos": ["keyolk/cc-mods"]}))
        p = office.policy("s")
        self.assertEqual(p["mode"], "custom")
        self.assertEqual(p["caps"], [{"cap": "gh_merge", "value": "allow", "scope": ["keyolk/cc-mods"]}, {"cap": "slack_send", "value": "inherit", "scope": []}])


if __name__ == "__main__":
    unittest.main()
