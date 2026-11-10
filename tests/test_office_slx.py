import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import command  # noqa: E402
import slx  # noqa: E402
from test_office_command import COORD, KEYS_HARNESS, WORKER, BriefsCase  # noqa: E402

NOW = datetime(2026, 11, 10, 9, 0, tzinfo=timezone.utc)
ALIVE = "d0000000-0000-0000-0000-000000000004"
ENDED = "e0000000-0000-0000-0000-000000000005"


def ago(hours: float) -> str:
    return (NOW - timedelta(hours=hours)).isoformat()


def item(id: str, hours: float, **kw) -> dict:
    return {"id": id, "trigger": "slack", "from": "Alice", "where": "#team", "link": "https://x.slack.com/archives/C1/p1", "text": "봐 주세요", "received_at": ago(hours), "mentions": 1, "pending": 0, "unread": True, "status": "new", **kw}


def session(sid: str, alive: bool) -> dict:
    return {"sid": sid, "pane": "%7" if alive else "%99", "window": "slx:1 x" if alive else "", "alive": alive}


INBOX = {"at": NOW.isoformat(), "tui": True, "muted": 3, "snoozed": 1, "mutes": [
    {"id": "m1a2b", "trigger": "slack", "channel": "C7", "label": "#noise", "hides": 3, "created_at": NOW.isoformat()},
    {"id": "../x", "label": "bad id"},
], "items": [
    item("C1/2.0", 1, text="새 것"),
    item("C1/1.0", 30, **{"from": "Bob"}),
    item("meerkat:inc-1", 5, trigger="meerkat", **{"from": "#3730"}, where="P3 core", link="https://meerkat/i/1", alert_thread="https://x.slack.com/archives/C9/p2", detail="ratio high", status="opened", session=session(ALIVE, True)),
    item("D9", 2, status="opened", session=session(ENDED, False)),
    item("C1/0.5", 200, text="오래된 것"),
    item("C1/0.6", 300, status="opened", session=session(WORKER, True)),
    item("C1/done", 1, status="done"),
    item("C1/muted", 1, status="muted", muted_by="m1a2b"),
    item("C1/snoozed", 1, status="snoozed"),
    item("-rf", 1),
]}


class FakeSlx(BriefsCase):
    """A fake slx on disk: `-h` names list (or not), `list` prints INBOX,
    open/done print what a TUI answered, and every call is logged."""

    def setUp(self):
        super().setUp()
        self.bin = self.tmp / "slx"
        self.log = self.tmp / "calls.log"
        self.inbox = self.tmp / "inbox.json"
        self.inbox.write_text(json.dumps(INBOX, ensure_ascii=False))
        self.make()
        p = mock.patch.object(slx, "binary", return_value=str(self.bin))
        p.start()
        self.addCleanup(p.stop)
        slx._knows.clear()
        slx._cache.update(at=0.0, out=None)

    def make(self, knows: bool = True, answer: str = 'echo "$2: opening a session"', rc: int = 0) -> None:
        self.bin.write_text(textwrap.dedent(f"""\
            #!/bin/sh
            echo "$@" >> {self.log}
            case "$1" in
              -h) echo "usage: slx [flags]{' / slx list [-all]' if knows else ''}" >&2; exit 0 ;;
              list) cat {self.inbox} ;;
              *) {answer}; exit {rc} ;;
            esac
            """))
        self.bin.chmod(self.bin.stat().st_mode | stat.S_IXUSR)
        # A new binary is asked about list again (its mtime moved).
        os.utime(self.bin, (time.time() + len(slx._knows), time.time() + len(slx._knows)))

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def view(self, rows=frozenset()):
        return slx.view(set(rows), now=NOW.timestamp())


class ViewTest(FakeSlx):
    def test_recent_open_items_longest_waiting_first_then_the_ones_at_work(self):
        v = self.view()
        self.assertEqual([r["id"] for r in v["items"]], ["C1/1.0", "D9", "C1/2.0", "C1/0.6", "meerkat:inc-1"])
        # Older than 72 h with no live session: counted, not listed; done and a bad id: gone.
        self.assertEqual(v["old"], 1)
        # Muted and snoozed items are left out (an slx without -all leaves
        # them out anyway); the rules come with valid ids only.
        self.assertEqual((v["muted"], v["snoozed"], v["mutes"]), (3, 1, [{"id": "m1a2b", "label": "#noise", "trigger": "slack", "hides": 3}]))
        self.assertTrue(v["tui"])
        self.assertIsNone(v["error"])
        inc = next(r for r in v["items"] if r["id"] == "meerkat:inc-1")
        self.assertEqual((inc["icon"], inc["from"], inc["alertThread"], inc["detail"], inc["sid"], inc["pane"], inc["alive"]), ("🚨", "#3730", "https://x.slack.com/archives/C9/p2", "ratio high", ALIVE, "%7", True))
        self.assertEqual(next(r for r in v["items"] if r["id"] == "C1/2.0")["icon"], "📨")
        self.assertFalse(next(r for r in v["items"] if r["id"] == "D9")["alive"])

    def test_an_item_whose_session_has_a_row_rides_on_it(self):
        v = self.view({WORKER, ENDED})
        merged = {r["id"]: r["merged"] for r in v["items"]}
        # ENDED's session is not up: its item keeps a row even if the sid is listed.
        self.assertEqual(merged, {"C1/0.6": True, "C1/1.0": False, "meerkat:inc-1": False, "D9": False, "C1/2.0": False})
        self.assertEqual(slx.by_sid(v)[WORKER]["icon"], "📨")

    def test_the_command_view_puts_the_badge_on_the_sessions_row(self):
        self.ledger([{"slug": "w", "sid": WORKER}])
        people = [{"id": WORKER, "name": "w", "attention": "ask"}]
        with mock.patch.object(slx.time, "time", return_value=NOW.timestamp()):
            d = command.view(people)
        self.assertEqual(d["calls"][0]["slx"]["id"], "C1/0.6")
        self.assertEqual(d["coordinators"][0]["workers"][0]["slx"]["id"], "C1/0.6")
        self.assertTrue(next(r for r in d["slx"]["items"] if r["id"] == "C1/0.6")["merged"])

    def test_list_is_read_once_per_cache_window(self):
        self.view()
        self.view()
        self.assertEqual([c for c in self.calls() if c == "list"], ["list"])

    def test_a_slx_without_list_is_never_run_with_it(self):
        # An older slx starts its TUI on `slx list`.
        self.make(knows=False)
        v = self.view()
        self.assertEqual(v["items"], [])
        self.assertIn("make install", v["error"])
        self.assertEqual(self.calls(), ["-h"])

    def test_no_slx_says_so(self):
        with mock.patch.object(slx, "binary", return_value=None):
            v = self.view()
        self.assertEqual((v["items"], v["tui"]), ([], False))
        self.assertIn("slx가 없습니다", v["error"])

    def test_a_failing_list_says_its_last_line(self):
        self.inbox.write_text("not json")
        self.assertIn("slx list", self.view()["error"])


class ActTest(FakeSlx):
    def test_open_and_done_run_slx_with_the_id_and_say_what_it_did(self):
        code, j = command.act({"kind": "slx_open", "id": "C1/2.0"}, self.put)
        self.assertEqual((code, j), (200, {"ok": True, "sent": "세션을 엽니다"}))
        self.make(answer='echo "$2: done"')
        code, j = command.act({"kind": "slx_done", "id": "D9"}, self.put)
        self.assertEqual((code, j["sent"]), (200, "무시했습니다"))
        self.assertEqual([c for c in self.calls() if c.split()[0] in ("open", "done")], ["open C1/2.0", "done D9"])
        # Nothing goes to any session's inbox.
        self.assertEqual(self.sent, [])

    def test_many_ids_go_in_one_slx_command(self):
        self.make(answer='shift; [ "$1" = 3h ] && shift; for k in "$@"; do echo "$k: done"; done')
        code, j = command.act({"kind": "slx_done", "ids": ["C1/2.0", "D9", "C1/2.0"]}, self.put)
        self.assertEqual((code, j["sent"]), (200, "무시했습니다 ×2"))
        self.make(answer='shift; shift; for k in "$@"; do echo "$k: snoozed until 11-10 21:00"; done')
        code, j = command.act({"kind": "slx_snooze", "ids": ["C1/2.0", "D9"], "until": "3h"}, self.put)
        self.assertEqual((code, j["sent"]), (200, "11-10 21:00까지 미뤘습니다 ×2"))
        self.assertEqual(command.act({"kind": "slx_snooze", "id": "D9", "until": "2026-11-11T00:00:00.000Z"}, self.put)[0], 200)
        acts = [c for c in self.calls() if c.split()[0] in ("done", "snooze")]
        self.assertEqual(acts, ["done C1/2.0 D9", "snooze 3h C1/2.0 D9", "snooze 2026-11-11T00:00:00.000Z D9"])
        # One unknown id refuses the lot; a bad until, or open of many, too.
        self.assertEqual(command.act({"kind": "slx_done", "ids": ["C1/2.0", "C1/nope"]}, self.put), (404, {"error": "slx inbox에 없는 항목입니다 (1건)"}))
        for until in ("", "tomorrow", "3d", "-1h", "3h; rm"):
            self.assertEqual(command.act({"kind": "slx_snooze", "id": "D9", "until": until}, self.put)[0], 400, until)
        self.assertEqual(command.act({"kind": "slx_open", "ids": ["C1/2.0", "D9"]}, self.put)[0], 400)
        self.assertEqual(len([c for c in self.calls() if c.split()[0] in ("done", "snooze", "open")]), 3)

    def test_mute_is_made_from_the_item_the_way_its_trigger_allows(self):
        self.make(answer='echo "mute: muted m3f2 (#team): hides 2"')
        code, j = command.act({"kind": "slx_mute", "id": "C1/2.0", "by": "channel"}, self.put)
        self.assertEqual((code, j["sent"]), (200, "「#team」 숨김 규칙을 만들었습니다 (지금 2건)"))
        self.assertEqual(command.act({"kind": "slx_mute", "id": "meerkat:inc-1", "by": "kind"}, self.put)[0], 200)
        self.assertEqual(command.act({"kind": "slx_mute", "id": "C1/2.0", "by": "text", "text": "  -rf  build\n failed "}, self.put)[0], 200)
        mutes = [c for c in self.calls() if c.startswith("mute")]
        self.assertEqual(mutes, ["mute -like C1/2.0 -by channel", "mute -like meerkat:inc-1 -by kind", "mute -like C1/2.0 -by text -text=-rf build failed"])
        for bad in ({"id": "C1/2.0", "by": "service"}, {"id": "meerkat:inc-1", "by": "channel"}, {"id": "C1/2.0", "by": "text", "text": "  "}, {"ids": ["C1/2.0", "D9"], "by": "channel"}):
            self.assertEqual(command.act({"kind": "slx_mute", **bad}, self.put)[0], 400, bad)
        self.make(answer='echo "$2: unmuted"')
        self.assertEqual(command.act({"kind": "slx_unmute", "rule": "m1a2b"}, self.put), (200, {"ok": True, "sent": "숨김을 풀었습니다"}))
        for bad in ("", "../x", "m1a2b;x", "C1/2.0"):
            self.assertEqual(command.act({"kind": "slx_unmute", "rule": bad}, self.put)[0], 400, bad)
        self.assertEqual(len([c for c in self.calls() if c.split()[0] in ("mute", "unmute")]), 4)

    def test_an_id_not_in_the_inbox_or_not_an_id_runs_nothing(self):
        self.assertEqual(command.act({"kind": "slx_open", "id": "C1/nope"}, self.put)[0], 404)
        for bad in ("-rf", "a b", "", "x;rm"):
            self.assertEqual(command.act({"kind": "slx_done", "id": bad}, self.put)[0], 400, bad)
        self.assertFalse([c for c in self.calls() if c.split()[0] in ("open", "done")])

    def test_slx_not_running_is_said_in_words(self):
        self.make(answer='echo "slx: slx is not running: start slx inside tmux to open sessions" >&2', rc=1)
        code, j = command.act({"kind": "slx_open", "id": "C1/2.0"}, self.put)
        self.assertEqual(code, 409)
        self.assertIn("slx가 꺼져 있습니다", j["error"])
        self.make(answer='echo "$2: already opening a session for this item"', rc=1)
        self.assertEqual(command.act({"kind": "slx_open", "id": "C1/2.0"}, self.put), (409, {"error": "이미 세션을 여는 중입니다"}))

    def test_a_link_opens_only_the_url_slx_lists(self):
        inbox = {**INBOX, "items": [*INBOX["items"], item("C2/1.0", 1, link="javascript:alert(1)")]}
        self.inbox.write_text(json.dumps(inbox, ensure_ascii=False))
        with mock.patch.object(slx, "open_url") as opened:
            self.assertEqual(command.act({"kind": "slx_link", "id": "meerkat:inc-1", "which": "alert", "value": "https://evil"}, self.put)[0], 200)
            self.assertEqual(command.act({"kind": "slx_link", "id": "meerkat:inc-1"}, self.put)[0], 200)
            self.assertEqual(command.act({"kind": "slx_link", "id": "C2/1.0"}, self.put)[0], 404)
            self.assertEqual(command.act({"kind": "slx_link", "id": "C1/2.0", "which": "alert"}, self.put)[0], 404)
        self.assertEqual([c.args[0] for c in opened.call_args_list], ["https://x.slack.com/archives/C9/p2", "https://meerkat/i/1"])


    def test_a_task_typed_about_an_item_carries_it_to_the_coordinator(self):
        self.ledger([])
        code, _ = command.act({"kind": "coord_say", "coord": COORD, "value": "이거 처리해 줘", "re": {"slx": "C1/2.0"}}, self.put)
        self.assertEqual(code, 200)
        self.assertEqual(self.sent[-1], (COORD, '[office→coord] (re: slx C1/2.0: Alice · #team · https://x.slack.com/archives/C1/p1 · "새 것") 이거 처리해 줘'))
        for bad in ("C1/nope", "-rf"):
            self.assertEqual(command.act({"kind": "coord_say", "coord": COORD, "value": "x", "re": {"slx": bad}}, self.put)[0], 400, bad)

SLX_JS = textwrap.dedent(r"""
    var did = []
    slxDo = (s, act, extra) => { did.push([s.slx, act, extra || {}]); cmd.armed = null }
    function inbox() {
      cmd.data = { pending: [], coordinators: [], calls: [{ sid: 's1', name: 'one', window: 'w:1', pane: '%1', slx: { id: 'm', icon: '🚨', from: '#1', text: 'x' } }],
        reviews: [{ coord: 'c1', coordName: 'd9', id: 'r1', title: 'R1', links: [] }],
        slx: { tui: true, old: 2, windowH: 72, muted: 3, mutes: [{ id: 'm1', label: '#noise', hides: 3 }], items: [
          { id: 'm', icon: '🚨', from: '#1', text: 'x', merged: true, sid: 's1', alive: true },
          { id: 'a', icon: '📨', from: 'Alice', text: 'hi', where: '#t', at: '2026-11-10T00:00:00Z' },
          { id: 'b', icon: '📨', from: 'Bob', text: 'yo', alive: true, pane: '%5', sid: 's5' }] } }
      if (!cmd.on) press('c')
    }
""")


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class SlxKeysTest(unittest.TestCase):
    def run_js(self, body: str):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(KEYS_HARNESS)
        self.addCleanup(os.unlink, f.name)
        js = pathlib.Path(__file__).parents[1] / "office" / "command.js"
        r = subprocess.run(["node", f.name, str(js), "(() => {" + SLX_JS + body + "})()"], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_j_walks_on_from_the_review_items_to_the_waiting_triggers_only(self):
        # b's session is up (it is under ⚙ 진행 중), m rides on s1's row.
        got = self.run_js("inbox(); const seen = []; for (let i = 0; i < 4; i++) { press('j'); seen.push(cmd.sel.sid || cmd.sel.review || cmd.sel.slx) } return seen")
        self.assertEqual(got, ["s1", "r1", "a", "s1"])

    def test_a_number_then_enter_and_nothing_else(self):
        got = self.run_js("""
            inbox(); cmd.sel = { slx: 'a', title: 'Alice' }
            const stray = press('Enter'), none = did.length
            const one = press('1'), armed1 = cmd.armed, e1 = press('Enter')
            const two = press('2'), e2 = press('Enter')
            return [stray, none, one, armed1, e1, two, e2, did]
        """)
        self.assertEqual(got, [False, 0, True, {"slx": "a", "act": "open"}, True, True, True, [["a", "open", {}], ["a", "done", {}]]])

    def test_3_and_4_open_their_own_choices(self):
        got = self.run_js("""
            inbox(); cmd.sel = { slx: 'a', title: 'Alice' }
            press('3'); const subs = slxSubs(slxOf(cmd.sel), 'mute').map((c) => c[1])
            const lone = press('Enter')            // nothing picked yet: asks for a number
            press('2'); const armed = cmd.armed; press('Enter')
            press('3'); press('9')                 // past the choices: the floor's
            const nine = cmd.armed
            press('Escape'); const back = [cmd.armed, cmd.sel.slx]
            press('4'); press('2'); press('Enter')
            const inc = slxSubs({ trigger: 'meerkat', service: 'core', text: 'DNS' }, 'mute').map((c) => c[1])
            const dm = slxSubs({ trigger: 'slack', dm: true, from: 'Bob', where: 'DM' }, 'mute')[0][0]
            return [subs, lone, armed, nine, back, did, inc, dm]
        """)
        subs, lone, armed, nine, back, did, inc, dm = got
        self.assertEqual(back, [None, "a"])
        self.assertEqual(subs, ["channel", "from", "text"])
        self.assertTrue(lone)
        self.assertEqual(armed, {"slx": "a", "act": "mute", "sub": 1})
        self.assertEqual(nine, {"slx": "a", "act": "mute"})
        self.assertEqual(did, [["a", "mute", {"by": "from"}], ["a", "snooze", {"until": "3h"}]])
        self.assertEqual((inc, dm), (["service", "kind", "text"], "Bob의 DM"))

    def test_x_marks_and_the_slx_line_offers_the_bulk_choices(self):
        got = self.run_js("""
            inbox(); cmd.sel = { slx: 'a', title: 'Alice' }
            const before = slxFoot()
            press('x'); const marked = Object.keys(slxUi.marks), foot = slxFoot()
            cmd.sel = { slx: 'b', title: 'Bob' }; const running = press('x')
            return [before.includes('고른'), marked, foot.includes('고른 1건'), running, foot.includes('⚙ 진행 중 1'), foot.includes('72시간 넘은 2건'), foot.includes('숨김 규칙 1 · 가린 3')]
        """)
        self.assertEqual(got, [False, ["a"], True, False, True, True, True])

    def test_g_goes_to_a_live_pane_and_the_floor_keeps_its_keys(self):
        got = self.run_js("""
            inbox(); cmd.sel = { slx: 'b', title: 'Bob' }
            press('g')
            const floor = ['n', 'p', 'v', 'f', '0', 'Tab', '?', '5', 'y'].filter((k) => press(k))
            cmd.sel = { slx: 'a', title: 'Alice' }; press('g')
            return [focused, floor, toasts.slice(-1)[0]]
        """)
        self.assertEqual(got[0], ["%5"])
        self.assertEqual(got[1], [])
        self.assertIn("pane이 없습니다", got[2])

    def test_the_row_the_badge_and_the_rules(self):
        got = self.run_js("""
            inbox()
            const row = slxTurnRow(slxList()[0]), badge = slxBadge(cmd.data.calls[0]), plain = slxBadge({ sid: 'x' }), two = slxBadge({ slx: { icon: '🚨', from: '#1', text: 'x', n: 2 } })
            cmd.data.slx = { items: [], old: 0, tui: true, mutes: [] }
            const empty = slxFoot()
            cmd.data.slx = { items: [], old: 0, error: 'slx가 없습니다' }
            return [row.includes('data-slx="a"'), row.includes('☐'), badge.includes('🚨'), plain, two.includes('🚨2'), empty, slxFoot().includes('slx가 없습니다'), cmdAbout === undefined || (cmd.sel = { slx: '!rules' }, cmdAbout()) === null]
        """)
        self.assertEqual(got, [True, True, True, "", True, "", True, True])


class TurnTest(unittest.TestCase):
    def test_a_trigger_waits_in_the_turn_unless_its_session_is_up_or_rides_a_row(self):
        import turn
        xs = [
            {"id": "new", "at": "2026-11-10T08:00:00Z"},
            {"id": "ended", "at": "2026-11-10T06:00:00Z", "sid": ENDED},
            {"id": "running", "at": "2026-11-10T01:00:00Z", "alive": True},
            {"id": "merged", "at": "2026-11-10T01:00:00Z", "alive": True, "merged": True},
        ]
        calls = [{"sid": WORKER, "since": NOW.timestamp() - 2 * 3600}]
        rows = turn.rows([], calls, [], {}, xs, now=NOW.timestamp())
        self.assertEqual([(r["kind"], r.get("id") or r.get("sid")) for r in rows], [("slx", "ended"), ("session", WORKER), ("slx", "new")])
        self.assertEqual(turn.rows([], calls, [], {}, now=NOW.timestamp())[0]["kind"], "session")

    def test_several_items_on_one_session_are_counted(self):
        v = {"items": [{"sid": "s", "id": "a", "icon": "🚨", "from": "#1", "text": "x"}, {"sid": "s", "id": "b", "icon": "🚨", "from": "#2", "text": "y"}, {"sid": None, "id": "c"}]}
        self.assertEqual(slx.by_sid(v), {"s": {"id": "b", "icon": "🚨", "from": "#2", "text": "y", "n": 2}})
