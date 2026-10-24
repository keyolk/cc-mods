import json
import pathlib
import sys
import tempfile
import time
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
import resources  # noqa: E402


CCPROXY = {
    "accounts": [
        {"name": "claude-a", "provider": "anthropic", "state": "ready", "stale_quota": True,
         "budget": {"kind": "windows", "five_hour": {"left_pct": 71.4, "reset_at": 100}, "seven_day": {"left_pct": 96}}},
        {"name": "claude-b", "provider": "anthropic", "state": "cooldown", "cooldown_until": 200, "cooldown": "retry after 3h",
         "budget": {"kind": "windows", "five_hour": {"left_pct": 100}, "seven_day": {"left_pct": 0}}},
        {"name": "codex-a", "provider": "codex", "state": "ready", "budget": {"kind": "spend_cap"}},
        {"name": "low", "provider": "anthropic", "state": "ready", "budget": {"kind": "windows", "five_hour": {"left_pct": 8}}},
        {"name": "pool", "provider": "x", "state": "auth-failed", "budget": {"kind": "pool", "pool_name": "team", "pool": {"left_pct": 40}}},
        {"name": "off", "provider": "x", "state": "disabled", "budget": {"kind": "none", "reason": "no usage API"}},
    ]
}


def done(stdout="", code=0, stderr=""):
    return types.SimpleNamespace(stdout=stdout, returncode=code, stderr=stderr)


class CcproxyTest(unittest.TestCase):
    def setUp(self):
        self.acc = {a["id"]: a for a in resources.ccproxy_accounts(json.dumps(CCPROXY))}

    def test_windows_become_gauges(self):
        a = self.acc["claude-a"]
        self.assertEqual(a["state"], "ok")
        self.assertEqual(a["gauges"], [{"name": "5h", "left_pct": 71, "reset_at": 100}, {"name": "7d", "left_pct": 96}])
        self.assertTrue(a["stale"])

    def test_cooldown_keeps_its_end(self):
        a = self.acc["claude-b"]
        self.assertEqual((a["state"], a["until"], a["note"]), ("cooldown", 200, "retry after 3h"))

    def test_a_nearly_empty_window_is_soon(self):
        self.assertEqual(self.acc["low"]["state"], "soon")

    def test_other_budgets(self):
        self.assertEqual(self.acc["codex-a"]["gauges"], [])
        self.assertEqual(self.acc["codex-a"]["note"], "spend cap")
        self.assertEqual(self.acc["pool"]["state"], "expired")
        self.assertEqual(self.acc["pool"]["gauges"], [{"name": "team", "left_pct": 40}])
        self.assertEqual((self.acc["off"]["state"], self.acc["off"]["note"]), ("off", "no usage API"))


class CcoTest(unittest.TestCase):
    def test_providers_as_lamps(self):
        out = resources.cco_accounts(json.dumps({"healthz": {
            "anthropic": {"available": False, "configured": False},
            "codex": {"available": True, "cooldown_remaining_seconds": None},
        }}))
        self.assertEqual([(a["id"], a["state"]) for a in out], [("codex", "ok")])

    def test_cooldown(self):
        out = resources.cco_accounts(json.dumps({"healthz": {"anthropic": {"configured": True, "cooldown_remaining_seconds": 60}}}))
        self.assertEqual(out[0]["state"], "cooldown")
        self.assertGreater(out[0]["until"], time.time())


class ReadTest(unittest.TestCase):
    def test_a_failed_read_keeps_the_last_one_stale(self):
        good = resources.read("ccproxy", None, run=lambda *a, **k: done(json.dumps(CCPROXY)))
        self.assertTrue(good["ok"])
        bad = resources.read("ccproxy", good, run=lambda *a, **k: done("", 1, "dial tcp: i/o timeout"))
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["error"], "dial tcp: i/o timeout")
        self.assertEqual(len(bad["accounts"]), len(good["accounts"]))
        self.assertTrue(all(a["stale"] for a in bad["accounts"]))

    def test_a_first_failure_is_empty_not_raised(self):
        def boom(*a, **k):
            raise FileNotFoundError("ccproxy")
        r = resources.read("ccproxy", None, run=boom)
        self.assertEqual((r["ok"], r["accounts"]), (False, []))


class ConfigTest(unittest.TestCase):
    def test_the_config_picks_known_sources_in_its_order(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"resources": ["cco", "nope", "ccproxy"]}, f)
        old = resources.CONFIG
        resources.CONFIG = f.name
        try:
            self.assertEqual(resources.enabled(), ["cco", "ccproxy"])
        finally:
            resources.CONFIG = old


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        resources._cache.update(at=0.0, items=[], busy=False)
        self.calls = 0

    def run_(self, *a, **k):
        self.calls += 1
        return done(json.dumps(CCPROXY))

    def test_refreshes_once_per_ttl_in_the_background(self):
        old = resources.enabled
        resources.enabled = lambda: ["ccproxy"]
        try:
            # The first call returns at once, before the background read lands.
            resources.snapshot(run=self.run_)
            for _ in range(50):
                if resources._cache["items"]:
                    break
                time.sleep(0.02)
            self.assertEqual(self.calls, 1)
            at = resources._cache["at"]
            resources.snapshot(now=at + 1, run=self.run_)
            resources.snapshot(now=at + 2, run=self.run_)
            self.assertEqual(self.calls, 1)
        finally:
            resources.enabled = old


if __name__ == "__main__":
    unittest.main()
