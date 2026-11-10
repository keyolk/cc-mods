"""Input put off in the command view: a session set aside until a time
(⏰ 나중에) and memos left on it (📝), office/defer.py, office/turn.py and
office/defer.js."""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import defer  # noqa: E402
import office  # noqa: E402
import turn  # noqa: E402
from test_office_command import KEYS_HARNESS  # noqa: E402

S1 = "11111111-1111-1111-1111-111111111111"
S2 = "22222222-2222-2222-2222-222222222222"
COORD = "c0000000-0000-0000-0000-00000000c0de"


class HomeCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = pathlib.Path(tmp.name)
        p = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        p.start()
        self.addCleanup(p.stop)

    def file(self, sid: str) -> pathlib.Path:
        return self.home / ".claude/state/office/defer" / (sid + ".json")


class DeferStoreTest(HomeCase):
    def test_a_deferral_and_memos_are_kept_under_the_state_folder_per_session(self):
        self.assertEqual(defer.act({"kind": "defer_set", "sid": S1, "until": "3h", "seen": ["c:100"]}, {S1})[0], 200)
        code, j = defer.act({"kind": "memo_add", "sid": S1, "text": "  B안으로 가자  "}, {S1})
        self.assertEqual(code, 200)
        d = json.loads(self.file(S1).read_text())
        self.assertAlmostEqual(d["until"], time.time() + 3 * 3600, delta=5)
        self.assertEqual((d["seen"], [m["text"] for m in d["memos"]], j["memo"]["text"]), (["c:100"], ["B안으로 가자"], "B안으로 가자"))
        # Read again as the next process would (an office restart).
        self.assertEqual(set(defer.held({S1, S2})), {S1})

    def test_refusals(self):
        live = {S1}
        self.assertEqual(defer.act({"kind": "defer_set", "sid": "../x", "until": "1h"}, live)[0], 400)
        self.assertEqual(defer.act({"kind": "defer_set", "sid": S2, "until": "1h"}, live)[0], 404)
        self.assertEqual(defer.act({"kind": "memo_add", "sid": S2, "text": "x"}, live)[0], 404)
        for bad in ("", "soon", "0h", "2020-01-01T00:00Z", "9999h"):
            self.assertEqual(defer.act({"kind": "defer_set", "sid": S1, "until": bad}, live)[0], 400, bad)
        self.assertEqual(defer.act({"kind": "memo_add", "sid": S1, "text": "  "}, live)[0], 400)
        self.assertEqual(defer.act({"kind": "memo_add", "sid": S1, "text": "x" * 4001}, live)[0], 400)
        self.assertEqual(defer.act({"kind": "memo_del", "sid": S1, "id": "m1"}, live)[0], 404)
        self.assertFalse(self.file(S1).exists())

    def test_an_iso_time_from_the_slx_choices_is_taken(self):
        t = time.time() + 86400
        iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
        self.assertAlmostEqual(defer.until_of(iso), t, delta=1)
        # What choices 3 and 4 send: Date.toISOString(), milliseconds and Z.
        self.assertAlmostEqual(defer.until_of(time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))), int(t), delta=1)

    def test_a_memo_is_thrown_away_and_the_empty_file_goes(self):
        defer.act({"kind": "memo_add", "sid": S1, "text": "a"}, {S1})
        mid = defer.load(S1)["memos"][0]["id"]
        self.assertEqual(defer.act({"kind": "memo_del", "sid": S1, "id": mid}, {S1})[0], 200)
        self.assertFalse(self.file(S1).exists())

    def test_an_ended_sessions_memos_are_kept_but_out_of_the_view_and_can_still_go(self):
        defer.act({"kind": "memo_add", "sid": S1, "text": "a"}, {S1})
        self.assertEqual(defer.held({S2}), {})
        self.assertTrue(self.file(S1).exists())
        mid = defer.load(S1)["memos"][0]["id"]
        self.assertEqual(defer.act({"kind": "memo_del", "sid": S1, "id": mid}, set())[0], 200)

    def test_due_wakes_it_with_its_memos_until_seen_and_new_drops_the_time(self):
        defer.act({"kind": "defer_set", "sid": S1, "until": "1h"}, {S1})
        defer.act({"kind": "memo_add", "sid": S1, "text": "a"}, {S1})
        defer.wake(S1, "due", now=123.0)
        d = defer.load(S1)
        self.assertEqual((d["until"], d["woke"], len(d["memos"])), (None, 123.0, 1))
        defer.act({"kind": "defer_seen", "sid": S1}, {S1})
        self.assertEqual(defer.load(S1)["woke"], None)
        defer.act({"kind": "defer_set", "sid": S2, "until": "1h"}, {S2})
        defer.wake(S2, "new")
        self.assertFalse(self.file(S2).exists())


class MemoSendTest(HomeCase):
    def test_a_memo_goes_as_the_sessions_reply_and_only_then_leaves(self):
        defer.act({"kind": "memo_add", "sid": S1, "text": "B로 해"}, {S1})
        mid = defer.load(S1)["memos"][0]["id"]
        sent = []
        me = {"id": S1, "pane": "%9", "state": "working"}
        with mock.patch.object(office, "snapshot", return_value=[me]), mock.patch.object(office, "inbox_put", side_effect=lambda s, t, **k: sent.append((s, t))), \
                mock.patch.object(office, "inbox_waiting", return_value=None), mock.patch.object(office, "set_mute"):
            # At work: busy, as a reply is, and the memo stays.
            code, j = office.act({"kind": "memo_send", "sid": S1, "id": mid})
            self.assertEqual((code, j.get("busy"), sent, len(defer.load(S1)["memos"])), (409, "working", [], 1))
            code, j = office.act({"kind": "memo_send", "sid": S1, "id": mid, "force": True})
        self.assertEqual((code, sent, defer.load(S1)["memos"]), (200, [(S1, "B로 해")], []))
        with mock.patch.object(office, "snapshot", return_value=[me]):
            self.assertEqual(office.act({"kind": "memo_send", "sid": S1, "id": mid})[0], 404)

    def test_office_routes_the_defer_kinds_with_the_live_sessions(self):
        with mock.patch.object(office, "snapshot", return_value=[{"id": S1}]):
            self.assertEqual(office.act({"kind": "defer_set", "sid": S1, "until": "1h"})[0], 200)
            self.assertEqual(office.act({"kind": "defer_set", "sid": S2, "until": "1h"})[0], 404)


class TableDeferTest(unittest.TestCase):
    NOW = 1_800_000_000.0

    def calls(self, since=100):
        return [{"sid": S1, "since": since, "name": "one"}]

    def test_a_row_set_aside_leaves_my_turn_while_it_holds_what_it_held(self):
        held = {S1: {"until": self.NOW + 3600, "seen": ["c:100"], "memos": []}}
        r = turn.table([], self.calls(), [], [], now=self.NOW, held=held)[0]
        self.assertEqual((r["needs"], r["deferred"], r["wake"]), (False, self.NOW + 3600, None))

    def test_a_new_wait_or_question_or_trigger_brings_it_back_at_once(self):
        held = {S1: {"until": self.NOW + 3600, "seen": ["c:100"], "memos": []}}
        r = turn.table([], self.calls(since=200), [], [], now=self.NOW, held=held)[0]
        self.assertEqual((r["needs"], r["deferred"], r["wake"]), (True, None, "new"))
        waiting = [{"file": "a.html", "decision": {"id": "q1", "coordinator": S1}, "questions": [{"id": "q1"}], "sessions": []}]
        r = turn.table(waiting, self.calls(), [], [], now=self.NOW, held=held)
        self.assertEqual([(x["key"], x["wake"]) for x in r if x["sid"] == S1], [("s:" + S1, "new")])
        trig = [{"id": "t1", "merged": True, "sid": S1, "alive": True}]
        r = turn.table([], self.calls(), [], [], trig, now=self.NOW, held=held)[0]
        self.assertEqual(r["wake"], "new")

    def test_its_time_brings_it_back_with_its_memos_even_with_nothing_else(self):
        memos = [{"id": "m1", "text": "B안 확인", "at": 1}]
        coords = [{"sid": COORD, "name": "d9", "workers": [{"slug": "w", "sid": S2, "state": "working", "live": True}]}]
        held = {S2: {"until": self.NOW - 1, "seen": [], "memos": memos}}
        r = next(x for x in turn.table([], [], [], coords, now=self.NOW, held=held) if x["sid"] == S2)
        self.assertEqual((r["needs"], r["woke"], r["wake"], r["memos"]), (True, True, "due", memos))
        # Woke and not opened yet: still up on the next poll.
        held = {S2: {"until": None, "woke": self.NOW - 1, "seen": [], "memos": memos}}
        r = next(x for x in turn.table([], [], [], coords, now=self.NOW, held=held) if x["sid"] == S2)
        self.assertEqual((r["needs"], r["woke"], r["wake"]), (True, True, None))

    def test_a_session_with_memos_and_no_other_row_gets_one_and_memos_alone_need_nothing(self):
        held = {S2: {"until": None, "seen": [], "memos": [{"id": "m1", "text": "x"}], "info": {"name": "two", "summary": "조사", "state": "idle"}}}
        r = turn.table([], [], [], [], now=self.NOW, held=held)[0]
        self.assertEqual((r["key"], r["summary"], r["needs"], len(r["memos"])), ("s:" + S2, "조사", False, 1))


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class DeferKeysTest(unittest.TestCase):
    """defer.js and its hooks in table.js and command.js, under node."""

    SETUP = """
      var posts = []
      cmdPost = async (b) => { posts.push(b); return b.kind === 'defer_set' ? { until: 2e9, sent: 's' } : b.kind === 'memo_add' ? { memo: { id: 'm9', text: b.text, at: 1 } } : {} }
      function deferTable() {
        table()
        cmd.data.table[1].needKeys = ['c:200']
        cmd.data.table[3].memos = [{ id: 'm1', text: 'Twingate 다시 볼 것', at: 1 }]
        cmd.sel = null; cmd.row = null
      }
    """

    def run_js(self, body: str):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(KEYS_HARNESS)
        self.addCleanup(os.unlink, f.name)
        js = pathlib.Path(__file__).parents[1] / "office" / "command.js"
        r = subprocess.run(["node", f.name, str(js), "(() => {" + self.SETUP + body + "})()"], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_z_arms_the_choices_a_digit_picks_and_enter_sets_the_row_aside(self):
        got = self.run_js("""
            return (async () => {
              deferTable()
              tblOpen('s:s1')
              const z = press('z'), armed = !!dfr.armed, two = press('2'), at = dfr.armed.i
              press('Enter'); await new Promise((r) => r())
              await null
              return [z, armed, two, at, posts[0], tblFind('s:s1').needs, tblHtml().includes('⏰ 미룸 1'), cmd.row]
            })()
        """)
        self.assertEqual(got[:4], [True, True, True, 1])
        self.assertEqual(got[4], {"kind": "defer_set", "sid": "s1", "until": "3h", "seen": ["c:200"]})
        # Out of 내 차례, folded, and on to the next row that needs the person.
        self.assertEqual(got[5:], [False, True, "s:c1"])

    def test_one_stray_key_never_sets_a_row_aside_and_esc_backs_out(self):
        got = self.run_js("""
            deferTable(); tblOpen('s:s1')
            press('z')
            const enter = press('Enter'), esc = press('Escape'), still = cmd.sel && cmd.sel.sid
            // Unarmed again: a digit is the session's quick reply, j walks.
            cmd.ask = { sid: 's1', suggestions: ['네'] }
            press('1')
            return [enter, esc, still, dfr.armed, posts, cmd.armed, press('j'), cmd.row]
        """)
        self.assertEqual(got, [True, True, "s1", None, [], {"call": "s1", "i": 0}, True, "s:c1"])

    def test_z_typed_in_a_box_is_typing_and_alt_z_works_there(self):
        got = self.run_js("""
            deferTable(); tblOpen('s:s1')
            const typed = press('z', true), a1 = dfr.armed
            const alt = press('z', true, true), a2 = !!dfr.armed
            return [typed, a1, alt, a2]
        """)
        self.assertEqual(got, [False, None, True, True])

    def test_alt_enter_in_the_reply_box_keeps_a_memo_and_never_sends(self):
        got = self.run_js("""
            return (async () => {
              deferTable(); tblOpen('s:s1')
              cmd.ask = { sid: 's1', suggestions: [] }
              const box = { value: 'B안으로', blur() {} }
              const e = { key: 'Enter', altKey: true, shiftKey: false, isComposing: false, keyCode: 13, target: box, preventDefault() {} }
              cmdCallKey(e, cmd.sel); await null; await null
              // Composing Hangul: not taken.
              const c = cmdCallKey({ ...e, isComposing: true, keyCode: 229 }, cmd.sel)
              return [posts, replies, box.value, c, tblFind('s:s1').memos.map((m) => m.text), tblCells(tblFind('s:s1'))]
            })()
        """)
        self.assertEqual(got[0], [{"kind": "memo_add", "sid": "s1", "text": "B안으로"}])
        self.assertEqual(got[1:], [[], "", False, ["B안으로"], "🙋 📝1"])

    def test_a_rows_memos_are_its_tab_and_a_badge_and_memos_alone_need_nothing(self):
        got = self.run_js("""
            deferTable()
            const R = tblFind('s:w4')
            tblOpen('s:w4', 'memo')
            return [R.needs, tblTabs(R).map((t) => t.label), tblCells(R), tblTabNow(), cmd.sel.memos, tblAsk(R)]
        """)
        self.assertEqual(got, [False, ["📝 메모 1", "마지막 답", "🗂 카드"], "📝1 ✓", "memo", "w4", "📝 Twingate 다시 볼 것"])

    def test_a_row_whose_time_came_is_up_until_opened_and_left(self):
        got = self.run_js("""
            deferTable()
            cmd.data.table[3].woke = true
            const up = tblFind('s:w4').needs, cells = tblCells(tblFind('s:w4'))
            cmd.sel = { memos: 'w4' }; cmd.row = 's:w4'
            dfrLeave('s:w4'); dfrLeave('s:s1')
            return [up, cells, posts, tblFind('s:w4').needs]
        """)
        self.assertEqual(got, [True, "⏰ 📝1", [{"kind": "defer_seen", "sid": "w4"}], False])

    def test_a_row_set_aside_by_the_server_is_folded_and_not_opened_on_its_own(self):
        got = self.run_js("""
            deferTable()
            cmd.data.table[0].deferred = 2e9
            cmd.sel = null; cmd.shut = null
            return [tblOrder(), tblHtml().includes('⏰ 미룸 1'), tblFind('s:w1').needs]
        """)
        self.assertEqual(got, [["s:s1", "s:c1"], True, False])

    def test_a_deferred_row_holding_a_decision_is_never_opened_on_its_own_and_z_goes_on(self):
        got = self.run_js("""
            return (async () => {
              deferTable()
              // fix (w1) holds the decision, its call and a review: open it, set it aside for 3 h.
              tblOpen('s:w1')
              const before = cmd.sel.file
              press('z'); press('2'); press('Enter'); await null; await null
              const moved = [cmd.row, cmd.sel && cmd.sel.file]
              // The server shows it set aside; the next render picks nothing on its own.
              cmd.data.table[0].deferred = 2e9
              dfr.local = {}
              cmd.sel = null; cmd.row = null; cmd.shut = null
              cmdFirstPick(cmd.data)
              return [before, moved, cmd.sel, tblAsk(tblFind('s:w1')).startsWith('⏰'), tblAsk(tblFind('s:w1')).includes('Z?')]
            })()
        """)
        self.assertEqual(got, ["a.html", ["s:s1", None], None, True, True])

    def test_now_again_clears_a_deferral(self):
        got = self.run_js("""
            return (async () => {
              deferTable()
              cmd.data.table[1].deferred = 2e9
              cmd.row = 's:s1'; cmd.sel = { sid: 's1', name: 'one' }
              const before = tblFind('s:s1').needs
              press('z'); const ch = dfrChoices(tblFind('s:s1')).map((c) => c[0])
              press(String(ch.length)); press('Enter'); await null; await null
              cmd.data.table[1].deferred = null
              return [before, ch[ch.length - 1], posts, tblFind('s:s1').needs]
            })()
        """)
        self.assertEqual(got, [False, "지금 다시 올리기", [{"kind": "defer_clear", "sid": "s1"}], True])

    def test_on_the_memo_tab_the_task_box_speaks_to_the_session(self):
        got = self.run_js("""
            return (async () => {
              deferTable()
              tblOpen('s:w4', 'memo')
              const ab = cmdAbout()
              await cmdSay('계속해')
              return [ab.kind, ab.sid, ab.label, replies]
            })()
        """)
        self.assertEqual(got, ["session", "w4", "👷 Twingate 조사 에게", [["w4", {"kind": "reply", "value": "계속해"}, "지시"]]])

    def test_typing_in_the_memo_box_is_never_cancelled_and_enter_keeps_it(self):
        got = self.run_js("""
            return (async () => {
              deferTable()
              let ta = null
              const mk = () => { const e = { dataset: {}, style: {}, className: '', kids: {}, focus() {}, value: '' }
                e.querySelector = (q) => e.kids[q] || null
                Object.defineProperty(e, 'innerHTML', { set(v) { if (v.includes('memoadd')) { ta = mk(); ta.value = ''; e.kids['.memoadd textarea'] = ta; e.kids['.memos'] = mk() } if (v.includes('class="m"')) e.kids['.m'] = mk(); if (v.includes('shut')) e.kids['.shut'] = mk() }, get: () => '' })
                return e }
              const bar = mk(), doc = mk(), dec = mk()
              dfrRenderMemos(bar, doc, dec, { memos: 'w4', name: 'w4n' })
              const keys = ['a', 'j', 'k', 'z', '1', 'Tab', '', 'ㅎ']
              const cancelled = keys.filter((k) => { let stopped = false; return ta.onkeydown({ key: k, altKey: false, shiftKey: false, isComposing: k === 'ㅎ', keyCode: k === 'ㅎ' ? 229 : 0, target: ta, preventDefault: () => { stopped = true } }) === false || stopped })
              ta.value = '나중에 볼 것'
              ta.onkeydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, target: ta, preventDefault() {} })
              await null
              return [cancelled, posts]
            })()
        """)
        self.assertEqual(got, [[], [{"kind": "memo_add", "sid": "w4", "text": "나중에 볼 것"}]])


if __name__ == "__main__":
    unittest.main()
