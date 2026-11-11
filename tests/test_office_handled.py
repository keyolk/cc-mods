"""What the person already handled (office/handled.py) and how 내 차례
(office/turn.py) takes it: a block or a trigger the person answered goes to
✔ 처리 중, and a new ask brings it back."""

import json
import os
import pathlib
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))

import handled  # noqa: E402
import turn  # noqa: E402

COORD = "c0000000-0000-0000-0000-00000000c0de"
LUTHER = "6feb9596-0dae-4988-837e-b2b2bb0c7ef7"  # the slx session of the item
OTHER = "5d65b085-f479-419b-877f-c1f5da412ffd"  # a worker the coordinator started for it
WORKER = "11111111-1111-1111-1111-111111111111"
TS = "1793600933.468369"
ITEM = "C01J3BC0VMZ/" + TS
T0 = 1794362122.0  # the mention came (2026-11-11 01:55Z)


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def user(t: float, text: str, origin: dict | None = None, **kw) -> dict:
    return {"type": "user", "timestamp": iso(t), "origin": origin if origin is not None else {"kind": "human"}, "message": {"role": "user", "content": text}, **kw}


def tool(t: float, name: str, inp: dict) -> dict:
    return {"type": "assistant", "timestamp": iso(t), "message": {"role": "assistant", "content": [{"type": "tool_use", "name": name, "input": inp}]}}


def result(t: float, text: str) -> dict:
    return {"type": "user", "timestamp": iso(t), "origin": {"kind": "human"}, "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x", "content": text}]}}


SLX_FIRST = "Slack에서 나에게 온 요청을 처리해 주세요.\n\n스레드: https://x.slack.com/archives/C01J3BC0VMZ/p1793600933468369\n"
SLX_MORE = "이 스레드에 새 멘션이 2건 더 왔습니다. 가장 최근 것:\n보낸 사람: Luther\n> ok\n"
ASUSER = {"kind": "plugin", "name": "cc-mods", "asUser": True}


class Case(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = pathlib.Path(tmp.name)
        (self.root / "p").mkdir()
        p = mock.patch.object(handled, "ROOT", str(self.root))
        p.start()
        self.addCleanup(p.stop)
        handled._files.clear()
        handled._list.update(at=0.0, paths=[])

    def write(self, sid: str, entries: list[dict]) -> str:
        path = self.root / "p" / (sid + ".jsonl")
        with open(path, "a") as f:
            for e in entries:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
        return str(path)

    def states(self) -> dict:
        handled._list["at"] = 0.0
        return handled.scan(now=T0 + 3600)


class PersonTest(Case):
    def test_what_the_person_wrote_and_what_a_program_wrote_in_their_name(self):
        said = lambda text, origin=None: handled.by_person(user(T0, text, origin), text)
        self.assertTrue(said("luther가 요구했던 사항이 구현 및 테스트가 다된건지?"))
        self.assertTrue(said("keep going"))
        # From the office (a reply, a brief answer): the person's.
        self.assertTrue(said("2번으로 해 주세요", ASUSER))
        self.assertTrue(said("[brief answer] a.html: 보내기", ASUSER))
        # slx types into the pane: origin human, but slx's words.
        self.assertFalse(said(SLX_FIRST))
        self.assertFalse(said(SLX_MORE))
        self.assertFalse(said("<pasted_content id=\"1\">\n같은 종류의 알럿이 1건 더 왔습니다."))
        self.assertFalse(said("https://meerkat/x\n\nslx가 Meerkat incident로 연 RCA 세션입니다"))
        # ... unless the person added an instruction with slx's b.
        self.assertTrue(said(SLX_MORE + "\n추가 지시: 답장 초안만"))
        # A coordinator's spawn and sends, worker reports, auto-continue, notices.
        self.assertFalse(said("You are worker `luther` for the coordinator session `d9`.\n일"))
        self.assertFalse(said("사람의 말(원문): ...\n---\nYou are worker `x` for the coordinator session `d9`."))
        self.assertFalse(said("[coordinator] 진행하세요", ASUSER))
        self.assertFalse(said("[worker fix] READY abc", ASUSER))
        self.assertFalse(said("네, 진행해 주세요. (auto_continue: 확인 없이 이어서 진행합니다)", ASUSER))
        self.assertFalse(said("<task-notification>x</task-notification>", {"kind": "task-notification"}))
        self.assertFalse(said("x", {"kind": "plugin", "name": "cc-mods"}))
        self.assertFalse(handled.by_person(user(T0, "hi", isMeta=True), "hi"))

    def test_refs_a_text_and_an_item_name(self):
        self.assertEqual(handled.refs_in("thread 1793600933.468369 and /p1793600933468369, DM D0AK3A3TDGC, inc-ad1129eb94e427f2584b704e"), {TS, "D0AK3A3TDGC", "inc-ad1129eb94e427f2584b704e"})
        self.assertEqual(handled.item_refs({"id": ITEM}), {TS})
        self.assertEqual(handled.item_refs({"id": "D0AK3A3TDGC"}), {"D0AK3A3TDGC"})
        self.assertEqual(handled.item_refs({"id": "meerkat:inc-ad1129eb94e427f2584b704e"}), {"inc-ad1129eb94e427f2584b704e"})


class SlxTest(Case):
    def test_luther_a_reply_from_another_session_handles_it(self):
        # The case the person met: the item's own session (slx's) never got a
        # word from them; a coordinator started another worker, and the reply
        # went to the thread from the coordinator.
        self.write(LUTHER, [user(T0 - 7 * 86400, SLX_FIRST)])
        self.write(OTHER, [user(T0 + 100, "사람의 말(원문): ...Luther 스레드(C01J3BC0VMZ, thread ts " + TS + ")\nYou are worker `luther` for the coordinator session `d9`."), tool(T0 + 120, "mcp__claude_ai_Slack__slack_read_thread", {"channel_id": "C01J3BC0VMZ", "message_ts": TS})])
        item = {"id": ITEM, "at": iso(T0), "sid": LUTHER, "alive": False}
        h = handled.handled(item, self.states())
        self.assertEqual((h["how"], h["sid"]), ("relay", OTHER))
        self.write(COORD, [tool(T0 + 900, "mcp__claude_ai_Slack__slack_send_message", {"channel_id": "C01J3BC0VMZ", "thread_ts": TS, "message": "hi"})])
        h = handled.handled(item, self.states())
        self.assertEqual((h["how"], h["sid"]), ("reply", COORD))
        # A new mention after the reply: the person's turn again.
        self.assertIsNone(handled.handled({**item, "at": iso(T0 + 1000)}, self.states()))

    def test_slx_own_prompts_take_nothing_up_and_the_person_typing_does(self):
        self.write(LUTHER, [user(T0 - 3600, SLX_FIRST), user(T0 + 60, SLX_MORE), tool(T0 + 90, "mcp__claude_ai_Slack__slack_read_thread", {"message_ts": TS})])
        item = {"id": ITEM, "at": iso(T0), "sid": LUTHER, "alive": False}
        # slx delivered the new mention and its session read the thread: no one took it up.
        self.assertIsNone(handled.handled(item, self.states()))
        self.write(LUTHER, [user(T0 + 300, "답장 써줘")])
        self.assertEqual(handled.handled(item, self.states())["how"], "typed")

    def test_a_session_started_for_the_thread_counts_its_typing(self):
        # Its first prompt names the thread: the person's words to it are about it.
        self.write(OTHER, [user(T0 - 60, "You are worker `l` for the coordinator session `d9`. thread " + TS), user(T0 + 500, "보내기")])
        h = handled.handled({"id": ITEM, "at": iso(T0), "sid": LUTHER}, self.states())
        self.assertEqual((h["how"], h["sid"]), ("typed", OTHER))

    def test_a_dm_typed_to_elsewhere_only_maybe_and_a_long_summary_names_nothing(self):
        self.write(OTHER, [user(T0 - 86400, "Slack에서 나에게 온 요청을 처리해 주세요.\n스레드: https://x/archives/D041AL73NP5/p1794274151653059"), user(T0 + 60, "retry")])
        h = handled.handled({"id": "D041AL73NP5", "at": iso(T0)}, self.states())
        self.assertEqual(h["how"], "relay")
        summary = user(T0 - 100, "summary " + " ".join(["1794274151.65305%d" % i for i in range(5)]) + " " + TS, None, isCompactSummary=True)
        self.write(WORKER, [summary, user(T0 + 60, "check")])
        self.assertEqual(self.states()[WORKER]["first"], [])
        self.assertIsNone(handled.handled({"id": ITEM, "at": iso(T0)}, {WORKER: self.states()[WORKER]}))

    def test_a_listing_and_a_tool_result_name_items_without_taking_them_up(self):
        ids = " ".join(["D0AK3A3TDGC", "D041AL73NP5", "D02S4S05SMP", "C0/1794357820.649579", TS])
        self.write(OTHER, [tool(T0 + 10, "Bash", {"command": "slx triage " + ids}), tool(T0 + 20, "mcp__claude_ai_Slack__slack_search_public", {"query": ids}), result(T0 + 30, ids)])
        self.assertIsNone(handled.handled({"id": ITEM, "at": iso(T0)}, self.states()))

    def test_reads_on_from_where_it_stopped_and_starts_over_on_a_rewrite(self):
        p = self.write(OTHER, [user(T0 + 10, "a")])
        st = self.states()
        self.assertEqual(st[OTHER]["typed"], handled._epoch(iso(T0 + 10)))
        off = handled._files[p]["off"]
        self.write(OTHER, [user(T0 + 20, "b")])
        st = self.states()
        self.assertGreater(handled._files[p]["off"], off)
        self.assertEqual(st[OTHER]["typed"], handled._epoch(iso(T0 + 20)))
        with open(p, "w") as f:
            f.write(json.dumps(user(T0 + 5, "c")) + "\n")
        self.assertEqual(self.states()[OTHER]["typed"], handled._epoch(iso(T0 + 5)))


class TurnTest(Case):
    def status(self, at: float) -> dict:
        return {"state": "blocked", "kind": "question", "needs": "보낼지 정해 주세요", "at": at * 1000}

    def rows(self, st: dict, state: str = "waiting", triggers=None) -> dict:
        coords = [{"sid": COORD, "name": "d9", "workers": [{"slug": "w", "sid": WORKER, "live": True, "state": state, "status": st}]}]
        seen = handled.seen(self.states(), triggers or [])
        return {r["key"]: r for r in turn.table([], [], [], coords, triggers, now=T0 + 3600, seen=seen)}

    def test_a_block_the_person_typed_after_is_handled_until_it_asks_again(self):
        self.write(WORKER, [user(T0 - 600, "You are worker `w` for the coordinator session `d9`.")])
        r = self.rows(self.status(T0))["s:" + WORKER]
        self.assertTrue(r["needs"])
        self.assertIsNone(r["handled"])
        # The person typed to it after it asked.
        self.write(WORKER, [user(T0 + 60, "2번으로 해")])
        r = self.rows(self.status(T0))["s:" + WORKER]
        self.assertFalse(r["needs"])
        self.assertEqual(r["handled"]["how"], "typed")
        self.assertNotIn("t:", "".join(r["needKeys"]))
        # It asks again later: up again.
        r = self.rows(self.status(T0 + 120))["s:" + WORKER]
        self.assertTrue(r["needs"])

    def test_a_worker_the_coordinator_answered_and_now_at_work_is_not_the_persons(self):
        # "내가 시켜서 일하고 있는 애도 지금 내 차례라고": a coordinator's send
        # after the block, and the worker working on it.
        self.write(WORKER, [user(T0 + 60, "[coordinator] 예, 진행하세요", ASUSER)])
        self.assertTrue(self.rows(self.status(T0), state="waiting")["s:" + WORKER]["needs"])
        r = self.rows(self.status(T0), state="working")["s:" + WORKER]
        self.assertFalse(r["needs"])
        self.assertEqual(r["handled"]["how"], "working")
        # A monitor event that woke it answers nothing.
        os.unlink(self.root / "p" / (WORKER + ".jsonl"))
        handled._files.clear()
        self.write(WORKER, [user(T0 + 60, "The cc-mods plugin sent a message: <task-notification>", ASUSER)])
        self.assertTrue(self.rows(self.status(T0), state="working")["s:" + WORKER]["needs"])

    def test_a_block_about_a_thread_another_session_replied_to_is_handled(self):
        # service-catalog asked "draft the Luther reply?"; the person had a new
        # worker do it, and the coordinator sent it to the thread.
        self.write(WORKER, [user(T0 - 86400, "Luther 스레드(" + TS + ") 진행")])
        self.assertTrue(self.rows(self.status(T0))["s:" + WORKER]["needs"])
        self.write(COORD, [tool(T0 + 900, "mcp__claude_ai_Slack__slack_send_message", {"channel_id": "C01J3BC0VMZ", "thread_ts": TS})])
        r = self.rows(self.status(T0))["s:" + WORKER]
        self.assertFalse(r["needs"])
        self.assertEqual((r["handled"]["how"], r["handled"]["sid"]), ("reply", COORD))
        # It asks again after the reply: up again.
        self.assertTrue(self.rows(self.status(T0 + 1000))["s:" + WORKER]["needs"])

    def test_a_trigger_replied_to_leaves_my_turn_and_one_only_read_elsewhere_stays_faint(self):
        x = {"id": ITEM, "from": "Luther Lee", "at": iso(T0), "sid": LUTHER, "alive": False}
        self.write(OTHER, [tool(T0 + 100, "mcp__claude_ai_Slack__slack_read_thread", {"message_ts": TS})])
        r = self.rows(None, triggers=[x])["x:" + ITEM]
        self.assertTrue(r["needs"])
        self.assertEqual(r["handled"]["how"], "relay")
        self.write(COORD, [tool(T0 + 900, "mcp__claude_ai_Slack__slack_send_message", {"channel_id": "C01J3BC0VMZ", "thread_ts": TS})])
        r = self.rows(None, triggers=[x])["x:" + ITEM]
        self.assertFalse(r["needs"])
        self.assertEqual(r["handled"]["how"], "reply")

    def test_without_seen_the_table_is_as_before(self):
        coords = [{"sid": COORD, "name": "d9", "workers": [{"slug": "w", "sid": WORKER, "live": True, "status": self.status(T0)}]}]
        x = {"id": ITEM, "from": "L", "at": iso(T0), "alive": False}
        rows = {r["key"]: r for r in turn.table([], [], [], coords, [x], now=T0 + 3600)}
        self.assertTrue(rows["s:" + WORKER]["needs"])
        self.assertTrue(rows["x:" + ITEM]["needs"])


if __name__ == "__main__":
    unittest.main()
