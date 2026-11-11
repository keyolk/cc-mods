"""office/relay.py: a worker's login wait answered from the office, against a
fake tweb that records its calls. The code must reach tweb on stdin only, and
never its argv, the worker's inbox or a reply."""
import json
import os
import pathlib
import stat
import sys
import tempfile
import textwrap
import time
import unittest

OFFICE = pathlib.Path(__file__).parents[1] / "office"
sys.path.insert(0, str(OFFICE))
import relay  # noqa: E402

SID = "0f1e2d3c-aaaa-bbbb-cccc-000000000001"
CODE = "482913"

# A fake tweb: panes lists %7 on PAGE (a file the test changes), query finds
# the selectors listed in VISIBLE, and every call is logged with its stdin.
FAKE = textwrap.dedent(r"""
    #!/usr/bin/env python3
    import json, os, sys
    d = os.environ["FAKE_DIR"]
    a = sys.argv[1:]
    data = sys.stdin.read() if a[0] == "fill" else ""
    with open(d + "/calls", "a") as f:
        f.write(json.dumps({"argv": a, "stdin": data}) + "\n")
    page = open(d + "/page").read().strip()
    vis = open(d + "/visible").read().split()
    if a[0] == "panes":
        print(json.dumps([{"pane": "%7", "status": {"tabs": {"tabs": [{"active": True, "url": page, "title": "t"}]}}}]))
    elif a[0] == "query":
        if a[1] in vis:
            print(json.dumps({"node": {"ref": "q" + str(vis.index(a[1]))}}))
        else:
            print('Error: no element matches "' + a[1] + '"', file=sys.stderr); sys.exit(1)
    elif a[0] == "screenshot":
        print(json.dumps({"png": "iVBORw0KGgo="}))
    else:
        print(json.dumps({"ok": True}))
""").lstrip()


class Relay(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        tw = os.path.join(self.d, "tweb")
        with open(tw, "w") as f:
            f.write(FAKE)
        os.chmod(tw, stat.S_IRWXU)
        os.environ["FAKE_DIR"] = self.d
        os.environ["OFFICE_TWEB"] = tw
        self.page("https://github.com/sessions/sudo")
        self.visible("#otp #verify #create")
        relay.CONFIG = os.path.join(self.d, "office.json")
        relay.STATUS_DIR = os.path.join(self.d, "status")
        os.makedirs(relay.STATUS_DIR)
        relay._looks.clear()
        self.told = []

    def tearDown(self):
        os.environ.pop("OFFICE_TWEB", None)

    def page(self, url):
        open(os.path.join(self.d, "page"), "w").write(url)

    def visible(self, s):
        open(os.path.join(self.d, "visible"), "w").write(s)

    def status(self, **k):
        st = {"state": "blocked", "kind": "auth", "pane": "%7", "at": int(time.time() * 1000), **k}
        json.dump(st, open(os.path.join(relay.STATUS_DIR, SID + ".json"), "w"))

    def act(self, **body):
        return relay.act({"sid": SID, **body}, lambda s, t: self.told.append((s, t)), office_port=8796)

    def calls(self):
        p = os.path.join(self.d, "calls")
        return [json.loads(l) for l in open(p)] if os.path.exists(p) else []

    def test_a_code_goes_to_the_input_on_stdin_and_is_sent_and_nowhere_else(self):
        self.status(ask="otp", target="#otp", submit="#verify")
        code, out = self.act(kind="relay_otp", value=" " + CODE + " ")
        self.assertEqual((code, out), (200, {"ok": True, "sent": "code sent"}))
        fills = [c for c in self.calls() if c["argv"][0] == "fill"]
        self.assertEqual(fills, [{"argv": ["fill", "q0", "--stdin", "--pane", "%7", "--json"], "stdin": CODE}])
        self.assertIn(["click", "q1", "--pane", "%7", "--json"], [c["argv"] for c in self.calls()])
        self.assertFalse(any(CODE in " ".join(c["argv"]) for c in self.calls()))
        self.assertEqual(len(self.told), 1)
        self.assertNotIn(CODE, self.told[0][1])
        self.assertNotIn(CODE, json.dumps(out))

    def test_a_code_or_a_press_goes_only_to_an_approved_host(self):
        self.status(ask="otp", target="#otp")
        for url in ("https://evil.example/github.com", "https://github.com.evil.example/x", "http://github.com/x", "file:///tmp/form.html"):
            self.page(url)
            code, out = self.act(kind="relay_otp", value=CODE)
            self.assertEqual(code, 409, url)
            self.assertIn("not a site approved", out["error"])
        self.assertFalse([c for c in self.calls() if c["argv"][0] in ("fill", "query")])
        # A look still shows the page, says it is not approved, and why.
        code, seen = self.act(kind="relay_look")
        self.assertEqual((code, seen["approved"]), (200, False))
        self.assertIn("file:", seen["refused"])
        self.status(ask="click", target="#create")
        self.assertEqual(self.act(kind="relay_click", look=self.act(kind="relay_look")[1]["look"])[0], 409)
        # A subdomain of an approved host is approved; office.json replaces the default.
        self.page("https://gist.github.com/x")
        self.status(ask="otp", target="#otp")
        self.assertEqual(self.act(kind="relay_otp", value=CODE)[0], 200)
        json.dump({"relay": {"hosts": ["Login.Example.com"]}}, open(relay.CONFIG, "w"))
        self.assertEqual(self.act(kind="relay_otp", value=CODE)[0], 409)
        self.page("https://login.example.com/2fa")
        self.assertEqual(self.act(kind="relay_otp", value=CODE)[0], 200)
        json.dump({"relay": {"hosts": ["file:"]}}, open(relay.CONFIG, "w"))
        self.page("file:///tmp/form.html")
        self.assertEqual(self.act(kind="relay_otp", value=CODE)[0], 200)

    def test_without_a_submit_button_the_code_is_sent_with_enter(self):
        self.status(ask="otp", target="#otp")
        self.assertEqual(self.act(kind="relay_otp", value=CODE)[0], 200)
        self.assertIn(["press", "Enter", "--pane", "%7", "--json"], [c["argv"] for c in self.calls()])

    def test_no_code_goes_in_when_the_input_is_not_on_the_screen(self):
        self.status(ask="otp", target="#otp")
        self.visible("#verify")
        code, out = self.act(kind="relay_otp", value=CODE)
        self.assertEqual(code, 409)
        self.assertIn("not on its screen", out["error"])
        self.assertFalse([c for c in self.calls() if c["argv"][0] == "fill"])
        self.assertEqual(self.told, [])

    def test_a_code_that_is_not_one_is_refused_before_tweb(self):
        self.status(ask="otp", target="#otp")
        for bad in ("", "12", "12 34", "x" * 17, "$(id)"):
            self.assertEqual(self.act(kind="relay_otp", value=bad)[0], 400)
        self.assertEqual(self.calls(), [])

    def test_a_press_needs_a_look_at_the_same_page_and_spends_it(self):
        self.status(ask="click", target="#create")
        code, out = self.act(kind="relay_click", look="made-up")
        self.assertEqual(code, 409)
        self.assertTrue(out["relook"])
        code, seen = self.act(kind="relay_look")
        self.assertEqual(code, 200)
        self.assertTrue(seen["visible"])
        self.assertEqual(seen["png"], "iVBORw0KGgo=")
        self.assertEqual(self.act(kind="relay_click", look=seen["look"]), (200, {"ok": True, "sent": "pressed"}))
        # Spent: a second press needs another look.
        self.assertEqual(self.act(kind="relay_click", look=seen["look"])[0], 409)
        _, seen = self.act(kind="relay_look")
        self.page("https://github.com/somewhere-else")
        code, out = self.act(kind="relay_click", look=seen["look"])
        self.assertEqual(code, 409)
        self.assertIn("moved", out["error"])

    def test_a_look_says_when_the_target_is_not_on_the_screen(self):
        self.status(ask="otp", target="#otp")
        self.visible("")
        code, out = self.act(kind="relay_look")
        self.assertEqual(code, 200)
        self.assertFalse(out["visible"])
        self.assertIn("no element", out["why"])

    def test_a_device_wait_only_tells_the_worker(self):
        self.status(ask="device")
        self.assertEqual(self.act(kind="relay_device")[0], 200)
        self.assertEqual(self.act(kind="relay_look")[0], 409)
        self.assertEqual([c["argv"][0] for c in self.calls()], [])
        self.assertIn("device", self.told[0][1])

    def test_the_pane_is_the_status_files_never_the_requests(self):
        self.status(ask="otp", target="#otp")
        self.act(kind="relay_otp", value=CODE, pane="%999", target="#evil")
        self.assertTrue(all("%999" not in c["argv"] and "#evil" not in c["argv"] for c in self.calls()))

    def test_no_wait_no_relay(self):
        self.assertEqual(self.act(kind="relay_otp", value=CODE)[0], 409)  # no status file
        self.status(ask="otp", target="#otp", kind="question")
        self.assertEqual(self.act(kind="relay_otp", value=CODE)[0], 409)
        self.status(ask="otp", target="#otp", at=int((time.time() - relay.STALE - 60) * 1000))
        self.assertEqual(self.act(kind="relay_otp", value=CODE)[0], 409)
        self.status(ask="otp", target="#otp", pane="7")
        self.assertEqual(self.act(kind="relay_otp", value=CODE)[0], 409)
        self.assertEqual(relay.act({"sid": "../x", "kind": "relay_otp"}, lambda s, t: None)[0], 409)
        self.assertEqual(self.calls(), [])

    def test_a_pane_showing_the_office_is_never_driven(self):
        self.status(ask="otp", target="#otp")
        self.page("http://127.0.0.1:8796/")
        self.assertEqual(self.act(kind="relay_otp", value=CODE)[0], 409)
        self.assertFalse([c for c in self.calls() if c["argv"][0] == "fill"])


if __name__ == "__main__":
    unittest.main()
