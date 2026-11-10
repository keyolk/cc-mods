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
        with mock.patch.object(command, "_cli_pending", return_value=["2026-11-08-b.html"]):
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
        code, out = command.answer(f, "B", " 이걸로 ", self.put)
        self.assertEqual(code, 200, out)
        self.assertEqual(out["via"], "sidecar")
        ans = self.side(f)["decision"]["answer"]
        self.assertEqual((ans["choice"], ans["note"], ans["by"]), ("B", "이걸로", "office"))
        self.assertEqual(self.sent, [(COORD, f"[brief answer] {f}: B — 이걸로")])
        self.assertEqual(command.answer(f, "A", "", self.put)[0], 409)

    def test_without_a_coordinator_the_worker_then_the_maker(self):
        self.ledger([{"slug": "w", "sid": WORKER}])
        f = self.brief("2026-11-08-a", {"worker": "w"})
        self.assertEqual(command.answer(f, "A", "", self.put)[0], 200)
        g = self.brief("2026-11-08-b", {})
        self.assertEqual(command.answer(g, "A", "", self.put)[0], 200)
        self.assertEqual(self.sent, [(WORKER, f"[brief answer] {f}: A"), (MAKER, f"[brief answer] {g}: A")])

    def test_refusals(self):
        f = self.brief("2026-11-08-a", {"coordinator": "../../etc"})
        self.assertEqual(command.answer(f, "C", "", self.put)[0], 400)
        self.assertEqual(command.answer("../x.html", "A", "", self.put)[0], 404)
        self.assertEqual(command.answer(self.brief("2026-11-08-plain"), "A", "", self.put)[0], 409)
        # A coordinator id that is not one is never a path to write to.
        self.assertEqual(command.answer(f, "A", "", self.put)[0], 200)
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
            "brief, label = sys.argv[2], sys.argv[3]\n"
            "side = brief[:-5] + '.brief.json'\n"
            "d = json.load(open(side))\n"
            "d['decision']['answer'] = {'choice': label, 'note': None, 'by': sys.argv[5], 'at': 'cli'}\n"
            "json.dump(d, open(side, 'w'))\n"
        )
        f = self.brief("2026-11-08-a", {"coordinator": COORD})
        code, out = command.answer(f, "A", "", self.put)
        self.assertEqual((code, out["via"]), (200, "cli"))
        self.assertEqual(self.side(f)["decision"]["answer"]["at"], "cli")

    def test_an_older_cli_falls_back_to_the_sidecar(self):
        self.fake_cli("import sys\nsys.stderr.write(\"invalid choice: 'answer'\\n\")\nsys.exit(2)\n")
        f = self.brief("2026-11-08-a", {"coordinator": COORD})
        code, out = command.answer(f, "A", "", self.put)
        self.assertEqual((code, out["via"]), (200, "sidecar"))
        self.assertEqual(self.side(f)["decision"]["answer"]["choice"], "A")


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
      var card = { style: { display: 'none' } }, viewer = { path: '' }, renders = 0
      cmdRender = () => { renders++ }; cmdRenderDoc = () => {}; cmdLoad = () => {}
      function press(k, typing = false, alt = false) { let stopped = false; const took = commandKey({ altKey: alt, preventDefault: () => { stopped = true } }, k, typing); return took && stopped }
    `, ctx)
    const out = vm.runInContext(process.argv[3], ctx)
    process.stdout.write(JSON.stringify(out))
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


if __name__ == "__main__":
    unittest.main()
