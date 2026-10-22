import importlib.machinery
import importlib.util
import pathlib
import tempfile
import unittest


PATH = pathlib.Path(__file__).parents[1] / "bin" / "cc-mods-tools"
loader = importlib.machinery.SourceFileLoader("cc_mods_tools", str(PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
tools = importlib.util.module_from_spec(spec)
loader.exec_module(tools)


def assets(*names):
    return [{"name": n, "url": "u/" + n} for n in names]


class PickAssetTest(unittest.TestCase):
    def test_goreleaser_archive_for_the_platform(self):
        a = assets("checksums.txt", "narwhal_0.1.0_darwin_amd64.tar.gz", "narwhal_0.1.0_darwin_arm64.tar.gz", "narwhal_0.1.0_linux_arm64.tar.gz")
        self.assertEqual(tools.pick_asset("narwhal", a, "darwin", "arm64")["name"], "narwhal_0.1.0_darwin_arm64.tar.gz")

    def test_raw_binary_layout(self):
        a = assets("SHA256SUMS", "ccproxy-darwin-amd64", "ccproxy-darwin-arm64", "ccproxy-linux-arm64")
        self.assertEqual(tools.pick_asset("ccproxy", a, "linux", "arm64")["name"], "ccproxy-linux-arm64")

    def test_no_asset_for_the_platform(self):
        self.assertIsNone(tools.pick_asset("tweb", assets("tweb_0.1.0_darwin_arm64.tar.gz"), "linux", "amd64"))

    def test_another_tools_asset_is_not_taken(self):
        self.assertIsNone(tools.pick_asset("tweb", assets("twebd-darwin-arm64.sig"), "darwin", "amd64"))


class LocalStateTest(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.tool = {"name": "narwhal", "bins": ["narwhal"]}

    def test_missing(self):
        self.assertEqual(tools.local_state(self.tool, None, self.dir), "missing")

    def test_unrecorded_binary_is_a_local_build(self):
        (self.dir / "narwhal").write_bytes(b"built here")
        self.assertEqual(tools.local_state(self.tool, None, self.dir), "local")

    def test_recorded_and_unchanged_is_managed(self):
        (self.dir / "narwhal").write_bytes(b"release")
        rec = {"files": {"narwhal": tools.sha256(self.dir / "narwhal")}}
        self.assertEqual(tools.local_state(self.tool, rec, self.dir), "managed")

    def test_make_install_over_a_release_is_modified(self):
        (self.dir / "narwhal").write_bytes(b"release")
        rec = {"files": {"narwhal": tools.sha256(self.dir / "narwhal")}}
        (self.dir / "narwhal").write_bytes(b"make install")
        self.assertEqual(tools.local_state(self.tool, rec, self.dir), "modified")


if __name__ == "__main__":
    unittest.main()
