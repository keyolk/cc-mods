import json
import os
import pathlib
import stat
import sys
import tempfile
import textwrap
import time
import unittest
from datetime import datetime
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
import agenda  # noqa: E402


def ts(h: int, m: int = 0, day: int = 0) -> float:
    d = datetime.now().replace(hour=h, minute=m, second=0, microsecond=0)
    return d.timestamp() + day * 86400


def iso(t: float) -> str:
    return datetime.fromtimestamp(t).astimezone().isoformat()


def ev(id: str, h0: int, m0: int, h1: int, m1: int, mine: str = "accepted", people=(), day: int = 0) -> dict:
    s, e = ts(h0, m0, day), ts(h1, m1, day)
    return {"id": id, "title": id, "start": iso(s), "end": iso(e), "allDay": False, "myResponse": mine, "attendees": [{"email": "me@x.com", "self": True, "response": mine}, *people]}


def dump(*events) -> str:
    return json.dumps({"calendar": "me@x.com", "events": list(events)})


class ParseCase(unittest.TestCase):
    def test_parse_keeps_people_and_drops_bad_rows(self):
        out = agenda.parse(dump(
            ev("b", 11, 0, 11, 30, people=[{"email": "Jace.Son@x.com", "name": "Jace"}]),
            {"id": "home", "title": "Home", "allDay": True, "date": datetime.now().strftime("%Y-%m-%d")},
            {"title": "no id"},
            {"id": "bad", "start": "nope", "end": "nope"},
            ev("a", 9, 0, 9, 30),
        ))
        self.assertEqual([e["id"] for e in out], ["home", "a", "b"])
        b = out[2]
        self.assertEqual(b["attendees"][1]["email"], "jace.son@x.com")
        self.assertEqual(b["mine"], "accepted")
        self.assertEqual(b["day"], 0)

    def test_parse_refuses_what_is_not_gcl_json(self):
        with self.assertRaises(ValueError):
            agenda.parse("[]")
        with self.assertRaises(ValueError):
            agenda.parse("not json")


class SummaryCase(unittest.TestCase):
    def events(self):
        return agenda.parse(dump(
            ev("standup", 9, 30, 10, 0),
            ev("sync", 10, 0, 11, 0),
            ev("declined", 13, 0, 14, 0, mine="declined"),
            ev("review", 15, 0, 16, 0),
            ev("tomorrow", 9, 30, 10, 0, day=1),
        ))

    def test_now_next_and_until(self):
        s = agenda.summarize(self.events(), ts(10, 15))
        self.assertEqual(s["now"], ["sync"])
        # A declined meeting is not next: the person is not going.
        self.assertEqual(s["next"], "review")
        self.assertEqual(s["untilNext"], int(ts(15) - ts(10, 15)))

    def test_evening_next_is_tomorrow(self):
        s = agenda.summarize(self.events(), ts(20))
        self.assertEqual(s["now"], [])
        self.assertEqual(s["next"], "tomorrow")

    def test_free_spans_skip_declined_and_short_gaps(self):
        evs = self.events() + agenda.parse(dump(ev("gap20", 11, 20, 12, 0)))
        free = agenda.free_spans(evs, ts(8), day_start=9, day_end=19)
        got = [(datetime.fromtimestamp(f["start"]).strftime("%H:%M"), datetime.fromtimestamp(f["end"]).strftime("%H:%M")) for f in free]
        # 09:00-09:30 (30 min) counts; 11:00-11:20 (20 min) does not; the
        # declined 13:00 does not split 12:00-15:00.
        self.assertEqual(got, [("09:00", "09:30"), ("12:00", "15:00"), ("16:00", "19:00")])

    def test_free_spans_start_now(self):
        free = agenda.free_spans(self.events(), ts(16, 30), day_start=9, day_end=19)
        self.assertEqual(len(free), 1)
        self.assertEqual(free[0]["start"], ts(16, 30))


class PeopleCase(unittest.TestCase):
    VIEW = {
        "table": [{"sid": "s1", "name": "office-gcl", "summary": "jace.son 리뷰 요청 대응"}, {"sid": "s2", "name": "Mark Yeon", "summary": ""}],
        "reviews": [{"id": "r1", "coord": "c", "title": "PR", "links": ["https://github.com/o/r/pull/1"], "check": "reviewer octo-cat"}],
        "recent": [],
        "pending": [],
        "slx": {"items": [{"id": "C1/1", "trigger": "slack", "from": "Evan Kim", "where": "#team", "text": "봐 주세요", "link": "https://x"}]},
    }

    def events(self):
        return agenda.parse(dump(ev("m", 9, 0, 10, 0, people=[
            {"email": "jace.son@x.com"},
            {"email": "mark.yeon@x.com"},
            {"email": "evan.kim@x.com", "name": "Evan Kim"},
            {"email": "octo@x.com"},
            {"email": "ab@x.com"},
        ])))

    def test_links_by_email_name_and_alias_never_me(self):
        got = agenda.link_people(self.events(), self.VIEW, extra={"octo@x.com": {"github": "octo-cat"}})
        self.assertEqual([h["ref"] for h in got["jace.son@x.com"]], [{"sid": "s1"}])
        self.assertEqual(got["mark.yeon@x.com"][0]["kind"], "session")
        self.assertEqual(got["evan.kim@x.com"][0]["kind"], "slack")
        self.assertEqual(got["octo@x.com"][0]["kind"], "review")
        self.assertNotIn("me@x.com", got)
        # "ab" is shorter than MIN_KEY: it would match everything.
        self.assertNotIn("ab@x.com", got)

    def test_people_file_is_optional(self):
        with mock.patch.object(agenda, "PEOPLE_FILE", "/nonexistent/people.json"):
            self.assertEqual(agenda.people_map(), {})


class ReadCase(unittest.TestCase):
    """The gcl run: probed for -json, cached, and kept on failure."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.dir, ignore_errors=True))
        agenda._cache.update(at=0.0, events=None, error=None, day="")
        agenda._knows.clear()
        self.out = os.path.join(self.dir, "out.json")
        self.count = os.path.join(self.dir, "count")

    def fake(self, knows_json=True):
        p = os.path.join(self.dir, "gcl")
        usage = "-json" if knows_json else "-dump"
        with open(p, "w") as f:
            f.write(textwrap.dedent(f"""\
                #!/bin/sh
                if [ "$1" = "-h" ]; then echo "  {usage}" >&2; exit 2; fi
                echo x >> {self.count}
                if [ -f {self.out} ]; then cat {self.out}; else echo "boom" >&2; exit 1; fi
                """))
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        return p

    def runs(self) -> int:
        try:
            return len(open(self.count).read().split())
        except OSError:
            return 0

    def test_old_gcl_is_not_run(self):
        with mock.patch.dict(os.environ, {"GCL_BIN": self.fake(knows_json=False)}):
            evs, err, _ = agenda.read(wait=True)
        self.assertIsNone(evs)
        self.assertIn("-json을 모릅니다", err)
        self.assertEqual(self.runs(), 0)

    def test_cached_then_kept_on_failure(self):
        with open(self.out, "w") as f:
            f.write(dump(ev("a", 9, 0, 9, 30)))
        with mock.patch.dict(os.environ, {"GCL_BIN": self.fake()}):
            evs, err, _ = agenda.read(wait=True)
            self.assertEqual([e["id"] for e in evs], ["a"])
            agenda.read(wait=True)
            self.assertEqual(self.runs(), 1, "a second read inside CACHE_S runs gcl again")
            os.remove(self.out)
            agenda._cache["at"] = time.time() - agenda.CACHE_S - 1
            evs, err, _ = agenda.read(wait=True)
        self.assertEqual([e["id"] for e in evs], ["a"])
        self.assertIn("boom", err)
        self.assertEqual(self.runs(), 2)

    def test_view_never_waits_on_gcl(self):
        with open(self.out, "w") as f:
            f.write(dump(ev("a", 9, 0, 9, 30)))
        with mock.patch.dict(os.environ, {"GCL_BIN": self.fake()}), mock.patch.object(agenda.threading, "Thread") as th:
            v = agenda.view()
        th.assert_called_once()
        self.assertEqual(v["events"], [])
        self.assertTrue(v["loading"])
        agenda._running["on"] = False


class ActCase(unittest.TestCase):
    """The writes: through gcl only, for a meeting in today's list, with a
    gcl that knows them; and a link opens only when the view showed it."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.dir, ignore_errors=True))
        self.log = os.path.join(self.dir, "argv")
        agenda._knows.clear()
        agenda._cache.update(at=time.time(), day=datetime.now().strftime("%Y-%m-%d"), error=None, events=agenda.parse(dump(
            ev("inv", 10, 0, 11, 0, mine="needsAction", people=[{"email": "a@x.com"}]),
            {"id": "mine", "title": "Focus", "start": iso(ts(12)), "end": iso(ts(13)), "attendees": []},
        )))

    def fake(self, knows=True):
        p = os.path.join(self.dir, "gcl")
        usage = "gcl rsvp gcl find -json" if knows else "-json"
        with open(p, "w") as f:
            f.write(textwrap.dedent(f"""\
                #!/bin/sh
                if [ "$1" = "-h" ]; then echo "{usage}" >&2; exit 2; fi
                echo "$@" >> {self.log}
                case "$1" in
                  rsvp) echo '{{"id": "'$2'", "title": "T", "response": "declined", "before": "needsAction"}}';;
                  find) echo '{{"window": "w", "duration": 30, "people": [], "slots": []}}';;
                esac
                """))
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        return p

    def argv(self) -> list[str]:
        try:
            return open(self.log).read().splitlines()
        except OSError:
            return []

    def test_rsvp_runs_gcl_and_marks_the_reply(self):
        with mock.patch.dict(os.environ, {"GCL_BIN": self.fake()}):
            code, out = agenda.act({"kind": "agenda_rsvp", "id": "inv", "reply": "no"})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.argv(), ["rsvp inv no"])
        self.assertEqual(agenda._event_by_id("inv")["mine"], "declined")
        self.assertEqual(agenda._cache["at"], 0.0, "the next read must ask Google again")

    def test_rsvp_refuses_what_is_not_an_invitation_in_the_list(self):
        with mock.patch.dict(os.environ, {"GCL_BIN": self.fake()}):
            self.assertEqual(agenda.act({"kind": "agenda_rsvp", "id": "gone", "reply": "yes"})[0], 404)
            self.assertEqual(agenda.act({"kind": "agenda_rsvp", "id": "mine", "reply": "yes"})[0], 409)
            self.assertEqual(agenda.act({"kind": "agenda_rsvp", "id": "inv", "reply": "sure"})[0], 400)
            self.assertEqual(agenda.act({"kind": "agenda_rsvp", "id": "a;rm -rf", "reply": "yes"})[0], 400)
        self.assertEqual(self.argv(), [])

    def test_a_gcl_without_rsvp_is_not_run(self):
        with mock.patch.dict(os.environ, {"GCL_BIN": self.fake(knows=False)}):
            code, out = agenda.act({"kind": "agenda_rsvp", "id": "inv", "reply": "yes"})
        self.assertEqual(code, 502)
        self.assertIn("rsvp/find를 모릅니다", out["error"])
        self.assertEqual(self.argv(), [])

    def test_find_passes_people_and_work_hours(self):
        with mock.patch.dict(os.environ, {"GCL_BIN": self.fake()}), mock.patch.object(agenda, "day_hours", return_value=(10, 18)):
            code, out = agenda.act({"kind": "agenda_find", "with": ["A@x.com", "a@x.com", "not an email"], "minutes": 30, "days": 7})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.argv(), ["find -with a@x.com -d 30 -days 7 -n 8 -hours 10-18 -weekdays"])
        with mock.patch.dict(os.environ, {"GCL_BIN": self.fake()}):
            self.assertEqual(agenda.act({"kind": "agenda_find", "with": [], "minutes": 30})[0], 400)
            self.assertEqual(agenda.act({"kind": "agenda_find", "with": ["a@x.com"], "minutes": 1000})[0], 400)

    def test_open_only_a_shown_link(self):
        evs = agenda.parse(dump({**ev("m", 9, 0, 10, 0), "link": "https://calendar/e1"}))
        with mock.patch.object(agenda.ghprs, "prs", return_value=(None, None)):
            agenda.people(evs, {})
        with mock.patch.object(agenda.subprocess, "Popen") as po:
            self.assertEqual(agenda.act({"kind": "agenda_open", "url": "https://evil.example/"})[0], 400)
            po.assert_not_called()
            self.assertEqual(agenda.act({"kind": "agenda_open", "url": "https://calendar/e1"})[0], 200)
            po.assert_called_once()
        self.assertEqual(po.call_args[0][0], ["open", "https://calendar/e1"])

    def test_day_hours_from_config(self):
        cfg = os.path.join(self.dir, "office.json")
        with open(cfg, "w") as f:
            json.dump({"agenda": {"dayStart": 10, "dayEnd": 18}}, f)
        with mock.patch.object(agenda, "CONFIG", cfg):
            self.assertEqual(agenda.day_hours(), (10, 18))
        with open(cfg, "w") as f:
            json.dump({"agenda": {"dayStart": 20, "dayEnd": 8}}, f)
        with mock.patch.object(agenda, "CONFIG", cfg):
            self.assertEqual(agenda.day_hours(), (20, 21))
        with mock.patch.object(agenda, "CONFIG", "/nonexistent"):
            self.assertEqual(agenda.day_hours(), (9, 19))


if __name__ == "__main__":
    unittest.main()
