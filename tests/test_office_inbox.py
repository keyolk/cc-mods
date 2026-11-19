"""The session registry read file by file (office/registry.py), the office
inbox's lock, append and sweep (office/inboxfile.py, bin/inbox-lock,
bin/coord-report) and the status sweep (office/sweep.py)."""

import json
import multiprocessing
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))

import hibstate  # noqa: E402
import inboxfile  # noqa: E402
import office  # noqa: E402
import registry  # noqa: E402
import sweep  # noqa: E402

BIN = pathlib.Path(__file__).parents[1] / "bin"
DEAD_PID = 2**22 + 7
S1 = "11111111-1111-1111-1111-111111111111"
S2 = "22222222-2222-2222-2222-222222222222"
S3 = "33333333-3333-3333-3333-333333333333"
DAY = 86400


def load(p) -> dict:
    with open(p) as f:
        return json.load(f)


def torn(d: dict) -> str:
    # What Claude Code left on 2026-11-20 in 4 of 23 registry files: a
    # complete object, then one `}` of the longer record it overwrote.
    return json.dumps(d) + "}"


class Home(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        env = mock.patch.dict(os.environ, {"HOME": self.home.name})
        env.start()
        self.addCleanup(env.stop)
        self.inbox = pathlib.Path(inboxfile.folder())
        self.sessions = pathlib.Path(self.home.name, ".claude", "sessions")

    def register(self, pid: int, text: str) -> None:
        self.sessions.mkdir(parents=True, exist_ok=True)
        (self.sessions / f"{pid}.json").write_text(text)


class RegistryTest(Home):
    def test_a_torn_file_is_read_up_to_its_first_object(self):
        self.assertEqual(registry.leading_json(torn({"sessionId": S1, "pid": 1})), {"sessionId": S1, "pid": 1})
        self.assertEqual(registry.leading_json('{"a": "}"}\n}}'), {"a": "}"})
        self.assertIsNone(registry.leading_json('{"a": '))
        self.assertIsNone(registry.leading_json(""))

    def test_one_torn_file_hides_neither_itself_nor_the_others(self):
        office._registry.update(at=0.0, by={}, alive=set(), read=False)
        self.register(os.getpid(), torn({"pid": os.getpid(), "sessionId": S1, "name": "torn-one"}))
        self.register(os.getppid(), json.dumps({"pid": os.getppid(), "sessionId": S2, "name": "whole-one"}))
        self.register(DEAD_PID, '{"pid": ')  # cut short: only this one is lost
        self.assertEqual(office.alive_sessions(), {S1, S2})
        self.assertEqual(office.registry()["torn-one"]["sid"], S1)
        self.assertEqual(set(hibstate.registry()), {S1, S2})


class LockTest(Home):
    def test_put_appends_under_the_lock_and_keeps_the_other_fields(self):
        p = str(self.inbox / (S1 + ".json"))
        os.makedirs(self.inbox)
        with open(p, "w") as f:
            json.dump({"text": "[coordinator] do it", "at": 5, "keep": True, "from": S2, "slug": "w", "tries": 2}, f)
        inboxfile.put(p, "reply", by="the office page (the person's action there)")
        d = load(p)
        self.assertEqual(d["text"], "[coordinator] do it\n\nreply")
        self.assertEqual((d["from"], d["slug"], d["tries"], d["keep"]), (S2, "w", 2, True))
        self.assertEqual(d["by"], ["the office page (the person's action there)"])
        self.assertFalse(os.path.exists(p + ".lock"))
        self.assertEqual(sorted(os.listdir(self.inbox)), [S1 + ".json"])

    def test_a_writer_waits_for_a_lock_taken_through_bin_inbox_lock(self):
        p = str(self.inbox / (S1 + ".json"))
        env = {**os.environ, "HOME": self.home.name}
        r = subprocess.run([sys.executable, str(BIN / "inbox-lock"), "acquire", p], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        token = r.stdout.strip()
        done = threading.Event()
        threading.Thread(target=lambda: (inboxfile.put(p, "late"), done.set()), daemon=True).start()
        self.assertFalse(done.wait(0.3))
        subprocess.run([sys.executable, str(BIN / "inbox-lock"), "release", p, "wrong"], env=env, check=True)
        self.assertFalse(done.wait(0.2))  # another token does not let it go
        subprocess.run([sys.executable, str(BIN / "inbox-lock"), "release", p, token], env=env, check=True)
        self.assertTrue(done.wait(5))
        self.assertEqual(load(p)["text"], "late")

    def test_bin_inbox_lock_refuses_a_file_outside_the_inbox(self):
        env = {**os.environ, "HOME": self.home.name}
        r = subprocess.run([sys.executable, str(BIN / "inbox-lock"), "acquire", os.path.join(self.home.name, "x.json")], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)

    def test_a_lock_left_by_a_holder_that_died_is_broken_once_stale(self):
        p = str(self.inbox / (S1 + ".json"))
        os.makedirs(self.inbox)
        with open(p + ".lock", "w") as f:
            f.write("dead")
        old = time.time() - inboxfile.LOCK_STALE_S - 5
        os.utime(p + ".lock", (old, old))
        inboxfile.put(p, "after")
        self.assertEqual(load(p)["text"], "after")
        self.assertFalse(os.path.exists(p + ".lock"))


def _writer(path: str, who: str, n: int, home: str) -> None:
    os.environ["HOME"] = home
    for i in range(n):
        inboxfile.put(path, f"{who}-{i}", keep=True, by=who)


def _taker(path: str, stop, out, home: str) -> None:
    """What register.ts officeInbox does: the rename under the lock, then the
    taken file read and removed."""
    os.environ["HOME"] = home
    got = []
    sending = path + ".sending"
    while True:
        last = stop.is_set()
        with inboxfile.locked(path):
            moved = os.path.exists(path)
            if moved:
                os.rename(path, sending)
        if moved:
            got += inboxfile.read(sending)["text"].split("\n\n")
            os.unlink(sending)
        if last:
            break
        time.sleep(0.003)
    out.put(got)


class ConcurrencyTest(Home):
    def test_two_writers_100_appends_each_while_the_taker_takes_deliver_200_once(self):
        p = str(self.inbox / (S1 + ".json"))
        os.makedirs(self.inbox)
        ctx = multiprocessing.get_context("spawn")
        stop, out = ctx.Event(), ctx.Queue()
        taker = ctx.Process(target=_taker, args=(p, stop, out, self.home.name))
        writers = [ctx.Process(target=_writer, args=(p, w, 100, self.home.name)) for w in ("a", "b")]
        taker.start()
        for w in writers:
            w.start()
        for w in writers:
            w.join(60)
        stop.set()
        got = out.get(timeout=60)
        taker.join(10)
        want = sorted(f"{w}-{i}" for w in ("a", "b") for i in range(100))
        self.assertEqual(sorted(got), want)  # every line, none twice
        self.assertFalse(os.path.exists(p))

    def test_two_coord_report_runs_racing_lose_nothing(self):
        env = {**os.environ, "HOME": self.home.name}
        procs = [subprocess.Popen([sys.executable, str(BIN / "coord-report"), S1, f"[worker {w}] NOTE {i}"], env=env, stdout=subprocess.DEVNULL) for i in range(15) for w in ("a", "b")]
        for pr in procs:
            self.assertEqual(pr.wait(30), 0)
        d = load(self.inbox / (S1 + ".json"))
        self.assertEqual(len(d["text"].split("\n\n")), 30)
        self.assertEqual(d["by"], ["a worker session (bin/coord-report)"])


class SweepTest(Home):
    def write(self, name: str, d: dict | str, age: float = 0) -> str:
        self.inbox.mkdir(parents=True, exist_ok=True)
        p = self.inbox / name
        p.write_text(d if isinstance(d, str) else json.dumps(d))
        t = time.time() - age
        os.utime(p, (t, t))
        return name

    def test_expired_files_go_whoever_they_were_for_and_the_rest_stay(self):
        now = time.time()
        gone = {
            self.write(S1 + ".json", {"text": "x", "at": now - 9 * DAY, "keep": True, "from": S2}),  # the orphan seen on 11-20
            self.write(S2 + ".json", {"text": "x", "at": now - 3600}),  # a quick reply an hour late
            self.write(S3 + ".json.tmp.1.ab", "{", age=2 * 3600),
            self.write(S3 + ".json.lock", "dead", age=2 * 3600),
            self.write(S3 + ".json.sending", {"text": "x", "at": now - 2 * DAY}, age=2 * DAY),
        }
        kept = {
            self.write(S3 + ".json", {"text": "x", "at": now - 20 * 3600, "keep": True}),  # still within its day
            self.write("44444444-4444-4444-4444-444444444444.json", {"text": "x", "at": now - 60}),  # not yet 2 minutes
            self.write("55555555-5555-5555-5555-555555555555.json.sending", {"text": "x", "at": now}),
        }
        os.makedirs(self.inbox / "failed")
        self.write("failed/" + S1 + "-1.json", {"text": "x", "at": 0}, age=30 * DAY)
        self.assertEqual(set(inboxfile.sweep(now)), gone)
        self.assertEqual(set(os.listdir(self.inbox)), kept | {"failed"})
        self.assertEqual(os.listdir(self.inbox / "failed"), [S1 + "-1.json"])

    def test_a_message_just_past_its_limit_is_left_for_the_taker(self):
        now = time.time()
        self.write(S1 + ".json", {"text": "x", "at": now - inboxfile.STALE_S - 60})
        self.assertEqual(inboxfile.sweep(now), [])


class StatusSweepTest(Home):
    def setUp(self):
        super().setUp()
        self.dir = pathlib.Path(sweep.status_folder())
        self.dir.mkdir(parents=True)

    def status(self, sid: str, age: float) -> None:
        p = self.dir / (sid + ".json")
        p.write_text(json.dumps({"state": "working", "at": 0}))
        t = time.time() - age
        os.utime(p, (t, t))

    def test_only_an_old_record_of_an_ended_session_goes(self):
        dormant = "44444444-4444-4444-4444-444444444444"
        recent = "55555555-5555-5555-5555-555555555555"
        self.status(S1, 10 * DAY)  # alive, however old
        self.status(S2, 10 * DAY)  # ended long ago: goes
        self.status(S3, 1 * DAY)  # ended yesterday: kept
        self.status(dormant, 10 * DAY)  # asleep: the office wakes it later
        self.status(recent, 10 * DAY)  # its transcript moved lately
        os.makedirs(hibstate.folder())
        pathlib.Path(hibstate.folder(), dormant + ".json").write_text(json.dumps({"sid": dormant}))
        proj = pathlib.Path(self.home.name, ".claude", "projects", "p")
        proj.mkdir(parents=True)
        (proj / (recent + ".jsonl")).write_text("{}\n")
        self.assertEqual(sweep.status({S1}), [S2 + ".json"])
        self.assertEqual(sorted(os.listdir(self.dir)), sorted(s + ".json" for s in (S1, S3, dormant, recent)))

    def test_an_unread_registry_removes_nothing(self):
        self.status(S2, 10 * DAY)
        self.assertEqual(sweep.status(None), [])
        self.assertEqual(sweep.tick(lambda: None)["status"], [])
        self.assertEqual(os.listdir(self.dir), [S2 + ".json"])


if __name__ == "__main__":
    unittest.main()
