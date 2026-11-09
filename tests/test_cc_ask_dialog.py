import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).parents[1]
SCRIPT = ROOT / "bin" / "cc-ask-dialog"


class CcAskDialogTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.log = os.path.join(self.dir.name, "tmux.log")
        # A tmux that records its argv, one JSON list per call.
        fake = os.path.join(self.dir.name, "tmux")
        with open(fake, "w") as f:
            f.write("#!%s\nimport json, sys\nopen(%r, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n" % (sys.executable, self.log))
        os.chmod(fake, 0o755)

    def run_it(self, payload, pane="%42"):
        env = {**os.environ, "PATH": self.dir.name + os.pathsep + os.environ["PATH"], "HOME": "/home/u"}
        env.pop("TMUX_PANE", None)
        if pane is not None:
            env["TMUX_PANE"] = pane
        stdin = payload if isinstance(payload, str) else json.dumps(payload)
        return subprocess.run([sys.executable, str(SCRIPT)], input=stdin, env=env, capture_output=True, text=True)

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [json.loads(l) for l in f]

    def test_a_drawn_dialog_marks_the_pane_ask_and_names_the_call_in_one_tmux_call(self):
        # The payload Claude Code sent live (2.1.306) for a Read outside the cwd.
        r = self.run_it({"session_id": "s", "hook_event_name": "PermissionRequest", "permission_mode": "default", "tool_name": "Read", "tool_input": {"file_path": "/home/u/research/x/brief.py"}})
        # It never answers the dialog: no output, exit 0.
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        [argv] = self.calls()
        cmds = " ".join(argv).split(" ; ")
        self.assertIn("set-window-option -t %42 @cc_attention ask", cmds)
        self.assertIn("set -p -t %42 @cc_pane_attention ask", cmds)
        self.assertIn("set -p -t %42 @cc_pane_state waiting", cmds)
        self.assertIn("set-window-option -t %42 @cc_state waiting", cmds)
        self.assertEqual(argv[-6:], ["set", "-p", "-t", "%42", "@cc_pane_asks", "Read ~/research/x/brief.py"])

    def test_the_label_is_the_one_asks_ts_makes(self):
        long = "x" * 200
        r = self.run_it({"tool_name": "mcp__portal__secrets_list", "tool_input": {"command": "  a\n\tb  "}})
        self.assertEqual(r.returncode, 0)
        self.run_it({"tool_name": "Bash", "tool_input": {"command": long}})
        self.run_it({"tool_name": "Read", "tool_input": {"file_path": "/home/u"}})
        self.run_it({"tool_name": "WebSearch", "tool_input": {}})
        labels = [c[-1] for c in self.calls()]
        self.assertEqual(labels[0], "portal secrets_list a b")
        self.assertEqual(labels[1], ("Bash " + long)[:139] + "…")
        self.assertEqual(labels[2], "Read ~")
        self.assertEqual(labels[3], "WebSearch")

    def test_a_subagent_dialog_outside_tmux_or_bad_input_writes_nothing(self):
        self.assertEqual(self.run_it({"tool_name": "Read", "tool_input": {}, "agent_id": "a1"}).returncode, 0)
        self.assertEqual(self.run_it({"tool_name": "Read", "tool_input": {}}, pane=None).returncode, 0)
        self.assertEqual(self.run_it({"tool_name": "Read", "tool_input": {}}, pane="main:1").returncode, 0)
        self.assertEqual(self.run_it("not json").returncode, 0)
        self.assertEqual(self.run_it("[]").returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_a_missing_tmux_still_exits_zero(self):
        env = {**os.environ, "PATH": "/nonexistent", "TMUX_PANE": "%1"}
        r = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps({"tool_name": "Read"}), env=env, capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_hooks_json_runs_it_on_permission_request(self):
        # The module's classic hooks never run where cc-plugin-sec-default is
        # seated; this command hook is what marks the pane there.
        with open(ROOT / "hooks" / "hooks.json") as f:
            hooks = json.load(f)
        self.assertEqual(hooks["modules"], ["./register.ts"])
        [entry] = hooks["hooks"]["PermissionRequest"]
        [h] = entry["hooks"]
        self.assertEqual(h["type"], "command")
        self.assertIn("${CLAUDE_PLUGIN_ROOT}/bin/cc-ask-dialog", h["command"])


if __name__ == "__main__":
    unittest.main()
