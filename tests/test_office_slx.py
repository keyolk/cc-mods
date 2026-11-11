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

    def make(self, knows: bool = True, answer: str = 'echo "$2: opening a session"', rc: int = 0, up: str | None = None) -> None:
        """up: the shell `slx up` runs (None: this slx has no up)."""
        self.bin.write_text(textwrap.dedent(f"""\
            #!/bin/sh
            echo "$@" >> {self.log}
            case "$1" in
              -h) echo "usage: slx [flags]{' / slx list [-all]' if knows else ''}{' / slx up [-replace]' if up is not None else ''}" >&2; exit 0 ;;
              list) cat {self.inbox} ;;
              up) {up or 'exit 9'} ;;
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
    def test_recent_open_items_most_recent_first_then_the_ones_at_work(self):
        v = self.view()
        self.assertEqual([r["id"] for r in v["items"]], ["C1/2.0", "D9", "meerkat:inc-1", "C1/0.6"])
        # Older than 24 h with no live session: counted, not listed (a live one stays, whatever its age); done and a bad id: gone.
        self.assertEqual((v["old"], v["windowH"]), (2, 24))
        # Muted and snoozed items are left out (an slx without -all leaves
        # them out anyway); the rules come with valid ids only.
        self.assertEqual((v["muted"], v["snoozed"], v["mutes"]), (3, 1, [{"id": "m1a2b", "label": "#noise", "trigger": "slack", "hides": 3}]))
        self.assertTrue(v["tui"])
        self.assertIsNone(v["error"])
        inc = next(r for r in v["items"] if r["id"] == "meerkat:inc-1")
        self.assertEqual((inc["icon"], inc["from"], inc["alertThread"], inc["detail"], inc["sid"], inc["pane"], inc["alive"]), ("🚨", "#3730", "https://x.slack.com/archives/C9/p2", "ratio high", ALIVE, "%7", True))
        self.assertEqual(next(r for r in v["items"] if r["id"] == "C1/2.0")["icon"], "📨")
        self.assertFalse(next(r for r in v["items"] if r["id"] == "D9")["alive"])

    def test_the_window_edge_is_24_hours_and_a_live_session_is_the_exception(self):
        self.inbox.write_text(json.dumps({**INBOX, "items": [
            item("in", 23.9), item("out", 24.1), item("older-first", 12),
            item("live-old", 100, status="opened", session=session(WORKER, True)),
            item("ended-old", 100, status="opened", session=session(ENDED, False)),
        ]}))
        v = self.view({WORKER})
        # Most recent first among those waiting on the person; the live one is kept, and its badge matches (merged, no row of its own).
        self.assertEqual([r["id"] for r in v["items"]], ["older-first", "in", "live-old"])
        self.assertEqual(v["old"], 2)
        self.assertTrue(next(r for r in v["items"] if r["id"] == "live-old")["merged"])
        self.assertEqual(slx.by_sid(v)[WORKER]["id"], "live-old")

    def test_an_item_whose_session_has_a_row_rides_on_it(self):
        v = self.view({WORKER, ENDED})
        merged = {r["id"]: r["merged"] for r in v["items"]}
        # ENDED's session is not up: its item keeps a row even if the sid is listed.
        self.assertEqual(merged, {"C1/0.6": True, "meerkat:inc-1": False, "D9": False, "C1/2.0": False})
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

class UpTest(FakeSlx):
    """[slx 켜기]: slx up, then the 세션 만들기 pressed."""

    def acts(self) -> list[str]:
        return [c for c in self.calls() if c.split()[0] in ("up", "open")]

    def test_up_then_open_is_one_press(self):
        self.make(up='echo "up: started in %9"')
        code, j = command.act({"kind": "slx_up", "then": "C1/2.0"}, self.put)
        self.assertEqual((code, j), (200, {"ok": True, "sent": "slx를 켰습니다 · 세션을 엽니다"}))
        self.assertEqual(self.acts(), ["up", "open C1/2.0"])
        # Alone, from the slx line: up only.
        self.assertEqual(command.act({"kind": "slx_up"}, self.put), (200, {"ok": True, "sent": "slx를 켰습니다"}))
        self.make(up='echo "up: already running (%9)"')
        self.assertEqual(command.act({"kind": "slx_up"}, self.put)[1]["sent"], "slx가 이미 켜져 있습니다")

    def test_replace_asks_slx_to_quit_the_older_one(self):
        self.make(up='echo "up: quit the older TUI in %52"; echo "up: started in %9"')
        code, j = command.act({"kind": "slx_up", "replace": True, "then": "C1/2.0"}, self.put)
        self.assertEqual((code, j["sent"]), (200, "slx를 다시 시작했습니다 · 세션을 엽니다"))
        self.assertEqual(self.acts(), ["up -replace", "open C1/2.0"])

    def test_an_older_tui_that_stays_is_said_where_and_nothing_opens(self):
        self.make(up='echo "slx: up: the older slx TUI in %52 (0:2 slx) did not quit within 5s; quit it there (q) and run slx up again" >&2; exit 1')
        code, j = command.act({"kind": "slx_up", "replace": True, "then": "C1/2.0"}, self.put)
        self.assertEqual(code, 409)
        self.assertIn("%52 · 0:2 slx", j["error"])
        self.assertIn("강제로 끄지 않았습니다", j["error"])
        self.make(up='echo "slx: an older slx TUI is running in %52 (0:2 slx): slx up -replace quits it and starts this one" >&2; exit 1')
        self.assertIn("다시 시작", command.act({"kind": "slx_up", "then": "C1/2.0"}, self.put)[1]["error"])
        self.make(up='echo "slx: up: slx exited at start: slx: profiles: bad" >&2; exit 1')
        self.assertEqual(command.act({"kind": "slx_up"}, self.put), (409, {"error": "slx가 켜지자마자 꺼졌습니다: slx: profiles: bad"}))
        self.assertEqual([c for c in self.acts() if c.startswith("open")], [])

    def test_open_failing_after_up_says_slx_is_on(self):
        self.make(up='echo "up: started in %9"', answer='echo "$2: slx did not take the request in time (withdrawn)"', rc=1)
        with mock.patch.object(slx.time, "sleep"):
            code, j = command.act({"kind": "slx_up", "then": "C1/2.0"}, self.put)
        self.assertEqual(code, 409)
        self.assertTrue(j["error"].startswith("slx를 켰습니다만 세션은 못 열었습니다"), j)
        self.assertEqual(self.acts(), ["up"] + ["open C1/2.0"] * slx.OPEN_TRIES)

    def test_a_slx_without_up_and_a_bad_then_run_nothing(self):
        self.make()
        self.assertEqual(command.act({"kind": "slx_up", "then": "C1/2.0"}, self.put)[0], 503)
        self.make(up='echo "up: started in %9"')
        self.assertEqual(command.act({"kind": "slx_up", "then": "-rf"}, self.put)[0], 400)
        self.assertEqual(command.act({"kind": "slx_up", "then": "C1/nope"}, self.put)[0], 404)
        self.assertEqual(self.acts(), [])

    def test_the_view_says_whether_slx_can_start_and_names_an_older_tui(self):
        inbox = {**INBOX, "tui": False, "stale_tui": [{"pane": "%52", "window": "0:2 slx", "pid": 64223}, {"pane": "x;rm", "window": "bad"}]}
        self.inbox.write_text(json.dumps(inbox, ensure_ascii=False))
        v = self.view()
        self.assertEqual((v["tui"], v["stale"], v["canUp"]), (False, [{"pane": "%52", "window": "0:2 slx"}], False))
        self.make(up="true")
        slx._cache.update(at=0.0, out=None)
        self.assertTrue(self.view()["canUp"])


class DimTest(FakeSlx):
    def test_a_dim_item_stays_in_the_view_with_why_and_is_counted(self):
        inbox = {**INBOX, "dimmed": 1, "items": [
            item("C1/dim", 1, dim=True, triage={"kind": "fyi", "conf": 0.98, "why": "jev fyi 0.98"}),
            item("C1/ask", 2, triage={"kind": "ask", "conf": 0.9, "why": "jev ask 0.9"}),
            item("C1/old", 3)]}
        self.inbox.write_text(json.dumps(inbox, ensure_ascii=False))
        v = self.view()
        got = {r["id"]: (r["dim"], r["why"]) for r in v["items"]}
        self.assertEqual(got, {"C1/dim": (True, "jev fyi 0.98"), "C1/ask": (False, "jev ask 0.9"), "C1/old": (False, "")})
        self.assertEqual(v["dimmed"], 1)

    def test_an_older_slx_without_dim_gives_no_dim(self):
        v = self.view()
        self.assertTrue(v["items"])
        self.assertTrue(all(r["dim"] is False and r["why"] == "" for r in v["items"]))
        self.assertEqual(v["dimmed"], 0)


SLX_JS = textwrap.dedent(r"""
    var did = [], slxDoReal = slxDo
    slxDo = (s, act, extra) => { did.push([s.slx, act, extra || {}]); cmd.armed = null }
    function inbox() {
      cmd.data = { pending: [], coordinators: [], calls: [{ sid: 's1', name: 'one', window: 'w:1', pane: '%1', slx: { id: 'm', icon: '🚨', from: '#1', text: 'x' } }],
        reviews: [{ coord: 'c1', coordName: 'd9', id: 'r1', title: 'R1', links: [] }],
        slx: { tui: true, old: 2, windowH: 24, muted: 3, mutes: [{ id: 'm1', label: '#noise', hides: 3 }], items: [
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
        # A review item's row opens as that row's list (review.js { revs }).
        got = self.run_js("inbox(); const seen = []; for (let i = 0; i < 4; i++) { press('j'); seen.push(cmd.sel.sid || cmd.sel.revs || cmd.sel.slx) } return [seen, tblFind('s:s1').xs.map((x) => x.id), tblHtml().includes('🙋 🚨')]")
        self.assertEqual(got, [["s1", "r:c1|r1", "a", "s1"], ["m"], True])

    def test_a_triggers_own_row_has_its_mark_and_tab_and_an_answer_goes_on_to_the_next_row(self):
        got = self.run_js("""
            return (async () => {
              inbox()
              slxDo = slxDoReal; cmdPost = async () => ({ sent: 'x' })
              const html = tblHtml()
              cmdClick({ target: { closest: (q) => (q === 'tr[data-row]' ? { dataset: { row: 'x:a' } } : null) } })
              const opened = [cmd.row, tblTabNow(), cmd.sel.slx, tblTabs(tblFind(cmd.row)).map((t) => t.k)]
              await slxDo(cmd.sel, 'done')
              return [html.includes('data-slxmk="a"'), html.includes('📨'), opened, cmd.row, cmd.data.slx.items.map((x) => x.id)]
            })()
        """)
        html_mark, icon, opened, row_, left = got
        self.assertTrue(html_mark and icon)
        self.assertEqual(opened, ["x:a", "slx", "a", ["slx"]])
        # 무시: the trigger's row is gone; on to the first row that still needs the person.
        self.assertEqual((row_, left), ("s:s1", ["m", "b"]))

    def test_many_trigger_rows_fold_to_one_line_and_j_skips_them_until_unfolded(self):
        got = self.run_js("""
            inbox()
            cmd.data.slx.items.push(...[1, 2, 3, 4].map((n) => ({ id: 'z' + n, icon: '📨', from: 'P' + n, text: 't' + n })))
            const folded = tblHtml()
            const seen = []; cmd.row = null
            for (let i = 0; i < 3; i++) { press('j', false, true); seen.push(cmd.row) }
            // One opened from elsewhere stays in sight while folded.
            slxPick({ id: 'z2', from: 'P2' }); cmd.row = 'x:z2'; const one = tblHtml()
            cmdFold('slx'); const open = tblHtml(), walk = tblOrder().length
            return [folded, seen, one, open, walk]
        """)
        folded, seen, one, opened, walk = got
        self.assertIn("▸ 📨 slx 5", folded)
        self.assertIn("내 차례 2 <span class=\"m\">+ 📨 5</span>", folded)
        self.assertNotIn('data-row="x:z1"', folded)
        self.assertEqual(seen, ["s:s1", "r:c1|r1", "s:s1"])
        self.assertIn('data-row="x:z2"', one)
        self.assertNotIn('data-row="x:z1"', one)
        self.assertIn('data-row="x:z1"', opened)
        self.assertEqual(walk, 7)

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
            return [before.includes('고른'), marked, foot.includes('고른 1건'), running, foot.includes('⚙ 진행 중 1'), foot.includes('24시간 넘은 2건'), foot.includes('숨김 규칙 1 · 가린 3')]
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

    def test_off_1_starts_slx_then_opens_and_an_older_one_is_restarted(self):
        got = self.run_js("""
            return (async () => {
              inbox(); slxDo = slxDoReal
              // The harness's timers never fire: let the posts' promises settle.
              const tick = async () => { for (let i = 0; i < 20; i++) await null }
              const posts = []; cmdPost = async (b) => { posts.push(b); return { sent: 'ok' } }
              cmd.data.slx.tui = false; cmd.data.slx.canUp = true
              cmd.sel = { slx: 'a', title: 'Alice' }
              const foot = slxFoot()
              press('1'); press('Enter'); await tick()
              cmd.data.slx.tui = false; cmd.data.slx.stale = [{ pane: '%52', window: '0:2 slx' }]
              const footStale = slxFoot()
              press('1'); press('Enter'); await tick()
              cmd.data.slx.tui = false; cmd.data.slx.stale = []; cmd.data.slx.canUp = false
              press('1'); press('Enter'); await tick()
              const cannot = toasts.slice(-1)[0]
              cmd.data.slx.tui = false; cmd.data.slx.canUp = true
              await slxFootDo('up')
              return [foot.includes('⏻ slx 켜기'), footStale.includes('↻ slx 다시 시작'), footStale.includes('%52'), posts, cannot]
            })()
        """)
        foot, foot_stale, names, posts, cannot = got
        self.assertTrue(foot and foot_stale and names)
        self.assertEqual(posts, [{"kind": "slx_up", "then": "a"}, {"kind": "slx_up", "replace": True, "then": "a"}, {"kind": "slx_up"}])
        self.assertIn("스스로 켜지 못합니다", cannot)

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
    def test_a_trigger_has_a_row_unless_its_session_is_up_or_it_rides_a_row(self):
        import turn
        xs = [
            {"id": "new", "at": "2026-11-10T08:00:00Z"},
            {"id": "ended", "at": "2026-11-10T06:00:00Z", "sid": ENDED},
            {"id": "running", "at": "2026-11-10T01:00:00Z", "alive": True},
            {"id": "merged", "at": "2026-11-10T01:00:00Z", "alive": True, "merged": True},
        ]
        calls = [{"sid": WORKER, "since": NOW.timestamp() - 2 * 3600}]
        xs[3]["sid"] = WORKER
        rows = turn.table([], calls, [], [], xs, now=NOW.timestamp())
        # A session that waited less still comes before the triggers' own
        # rows, and go most recent first; a merged one rides on its session's row; a running one has none.
        self.assertEqual([(r["key"], r["slx"], r["needs"]) for r in rows], [("s:" + WORKER, ["merged"], True), ("x:new", ["new"], True), ("x:ended", ["ended"], True)])
        self.assertEqual(turn.table([], calls, [], [], now=NOW.timestamp())[0]["key"], "s:" + WORKER)

    def test_several_items_on_one_session_are_counted(self):
        v = {"items": [{"sid": "s", "id": "a", "icon": "🚨", "from": "#1", "text": "x"}, {"sid": "s", "id": "b", "icon": "🚨", "from": "#2", "text": "y"}, {"sid": None, "id": "c"}]}
        self.assertEqual(slx.by_sid(v), {"s": {"id": "b", "icon": "🚨", "from": "#2", "text": "y", "n": 2}})


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class DimRenderTest(unittest.TestCase):
    def run_js(self, items):
        office = pathlib.Path(__file__).parents[1] / "office"
        prog = textwrap.dedent(r"""
            const vm = require('vm'), fs = require('fs')
            const el = () => ({ appendChild() {}, querySelector: () => null, style: {} })
            const ctx = { console, JSON, Date, document: { createElement: el, head: el(), addEventListener() {} },
              cmdEsc: (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
              cmdAgo: () => '1h', cmdPending: () => null, cmdCall: () => null, cmdRev: () => true, cmdOpen: () => [], revList: () => [], cmd: { sent: {} } }
            vm.createContext(ctx)
            for (const f of ['slx.js', 'table.js']) vm.runInContext(fs.readFileSync(process.argv[1] + '/' + f, 'utf8'), ctx)
            vm.runInContext(`
              var items = ` + process.argv[2] + `
              cmd.data = { slx: { tui: true, items }, table: items.map((x) => ({ key: 'x:' + x.id, name: x.from, decisions: [], reviews: [], slx: [x.id], at: 1 })) }
              var html = tblHtml(), foot = slxFoot()
            `, ctx)
            console.log(JSON.stringify({ html: ctx.html, foot: ctx.foot }))
        """)
        r = subprocess.run(["node", "-e", prog, str(office), json.dumps(items)], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_dim_rows_are_faint_with_why_and_the_header_counts_them(self):
        j = self.run_js([{"id": "a", "icon": "📨", "from": "Alice", "text": "fyi", "dim": True, "why": "jev fyi 0.98"}, {"id": "b", "icon": "📨", "from": "Bob", "text": "봐줘", "dim": False, "why": ""}])
        rows = j["html"].split("<tr ")
        a, b = [r for r in rows if "data-row=\"x:a\"" in r][0], [r for r in rows if "data-row=\"x:b\"" in r][0]
        self.assertIn(" dim", a)
        self.assertIn("흐림 · jev fyi 0.98", a)
        self.assertNotIn("dim", b)
        self.assertIn("흐림 1", j["html"])
        self.assertIn("흐림 1", j["foot"])

    def test_an_old_slx_without_dim_is_drawn_as_before(self):
        j = self.run_js([{"id": "a", "icon": "📨", "from": "Alice", "text": "hi"}])
        self.assertNotIn("dim", j["html"])
        self.assertNotIn("흐림", j["html"] + j["foot"])
