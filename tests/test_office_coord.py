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
            ],
        )
        rel = coord.relations()
        self.assertEqual(rel["c1"], {"role": "coordinator", "name": "coord-a", "workers": 2})
        self.assertEqual(rel["w1"]["role"], "owned")
        self.assertEqual(rel["w1"]["by"], "coord-a")
        self.assertEqual(rel["w2"]["role"], "adopted")
        # An ended worker is observed again: no entry.
        self.assertNotIn("w3", rel)

    def test_a_coordinator_turned_off_draws_nothing(self):
        self.write("c1", on=False, workers=[{"slug": "a", "sid": "w1"}])
        (self.dir / "broken.json").write_text("{")
        self.assertEqual(coord.relations(), {})
        self.assertEqual(coord.view(), [])


if __name__ == "__main__":
    unittest.main()
