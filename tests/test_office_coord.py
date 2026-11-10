import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
import coord  # noqa: E402


class CoordRelationsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = pathlib.Path(tmp.name)
        patch = mock.patch.object(coord, "COORD_DIR", str(self.dir))
        patch.start()
        self.addCleanup(patch.stop)
        coord._cache.update(at=0.0, ledgers=[])

    def write(self, sid: str, **ledger) -> None:
        (self.dir / f"{sid}.json").write_text(json.dumps({"sid": sid, **ledger}))

    def test_relations_of_an_on_coordinator(self):
        self.write(
            "c1",
            on=True,
            name="coord-a",
            workers=[
                {"slug": "a", "sid": "w1", "relation": "owned", "model": "sonnet", "effort": "medium"},
                {"slug": "b", "sid": "w2", "relation": "adopted"},
                {"slug": "c", "sid": "w3", "relation": "owned", "endedAt": 1},
                {"slug": "d", "relation": "owned"},
            ],
        )
        rel = coord.relations()
        self.assertEqual(rel["c1"]["name"], "coord-a")
        # The crew is every live worker, one not yet started (no sid) too.
        self.assertEqual([w["slug"] for w in rel["c1"]["crew"]], ["a", "b", "d"])
        self.assertEqual(rel["w1"]["boss"], {"sid": "c1", "name": "coord-a", "relation": "owned", "slug": "a", "model": "sonnet", "effort": "medium"})
        self.assertEqual(rel["w2"]["boss"]["relation"], "adopted")
        # An ended worker is observed again: no entry.
        self.assertNotIn("w3", rel)

    def test_an_auto_adopted_session_is_marked(self):
        # The coordinator adopted it by itself: the office labels it 자동 입양.
        self.write("c1", on=True, name="lead", workers=[{"slug": "ops", "sid": "w1", "relation": "adopted", "auto": True}, {"slug": "b", "sid": "w2", "relation": "adopted"}])
        rel = coord.relations()
        self.assertEqual(rel["w1"]["boss"]["auto"], True)
        self.assertEqual(rel["c1"]["crew"][0]["auto"], True)
        self.assertNotIn("auto", rel["w2"]["boss"])

    def test_a_coordinator_turned_off_draws_nothing(self):
        self.write("c1", on=False, workers=[{"slug": "a", "sid": "w1"}])
        (self.dir / "broken.json").write_text("{")
        self.assertEqual(coord.relations(), {})
        self.assertEqual(coord.view(), [])


class CoordPlaceTest(CoordRelationsTest):
    """The /state fields each session row carries, with 0, 1 and 2 coordinators."""

    def test_no_coordinator(self):
        self.assertEqual(coord.place(coord.relations(), "s1"), {"coord": False, "coordName": None, "crew": [], "boss": None})

    def test_one_coordinator(self):
        self.write("c1", on=True, name="lead", workers=[{"slug": "a", "sid": "w1", "relation": "owned"}])
        rel = coord.relations()
        c = coord.place(rel, "c1")
        self.assertTrue(c["coord"])
        self.assertEqual(c["coordName"], "lead")
        self.assertIsNone(c["boss"])
        self.assertEqual([w["sid"] for w in c["crew"]], ["w1"])
        w = coord.place(rel, "w1")
        self.assertFalse(w["coord"])
        self.assertEqual((w["boss"]["sid"], w["boss"]["relation"]), ("c1", "owned"))
        self.assertEqual(coord.place(rel, "other")["boss"], None)

    def test_two_coordinators_one_adopting_the_other(self):
        # c2 is itself a coordinator and an adopted worker of c1: both marks.
        self.write("c1", on=True, name="one", workers=[{"slug": "x", "sid": "w1"}, {"slug": "two", "sid": "c2", "relation": "adopted"}])
        self.write("c2", on=True, name="two", workers=[{"slug": "y", "sid": "w2", "relation": "owned"}])
        rel = coord.relations()
        self.assertEqual(coord.place(rel, "w1")["boss"]["sid"], "c1")
        self.assertEqual(coord.place(rel, "w1")["boss"]["relation"], "owned")
        self.assertEqual(coord.place(rel, "w2")["boss"]["sid"], "c2")
        c2 = coord.place(rel, "c2")
        self.assertTrue(c2["coord"])
        self.assertEqual(c2["coordName"], "two")
        self.assertEqual((c2["boss"]["sid"], c2["boss"]["relation"]), ("c1", "adopted"))
        self.assertEqual([w["slug"] for w in c2["crew"]], ["y"])


if __name__ == "__main__":
    unittest.main()
