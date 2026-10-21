import importlib.machinery
import importlib.util
import io
import pathlib
import threading
import unittest


PATH = pathlib.Path(__file__).parents[1] / "bin" / "cc-browser"
loader = importlib.machinery.SourceFileLoader("cc_browser", str(PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
cc_browser = importlib.util.module_from_spec(spec)
loader.exec_module(cc_browser)


class FakeEngine:
    def __init__(self, stdout):
        self.stdout = io.BytesIO(stdout)


class AnchorTest(unittest.TestCase):
    def test_anchor_is_found_right_of_the_cockpit_edge(self):
        line = "transcript quotes │ go: here" + " " * 12 + "││ go: https://x │ ⌘ CTRL"
        edge = line.index("││")
        self.assertEqual(cc_browser.anchor_column(line, edge), edge + 1)

    def test_transcript_left_of_the_edge_is_never_the_anchor(self):
        self.assertIsNone(cc_browser.anchor_column("answer mentions │ go: here      │ other", 30))

    def test_edge_counts_display_cells_not_characters(self):
        # Two wide characters take four cells before the anchor.
        self.assertEqual(cc_browser.anchor_column("한글│ go:", 4), 2)


class LeaveTest(unittest.TestCase):
    def test_leave_endpoint_is_routed(self):
        src = PATH.read_text()
        self.assertIn('self.path == "/leave"', src)
        self.assertIn('emit(event="leave")', src)


class TerminalRoutingTest(unittest.TestCase):
    def test_silence_kitty_replies_changes_only_kitty_headers(self):
        frame = (b"before\x1b[4;9H\x1b_Ga=T,f=100,q=1;YWJj\x1b\\"
                 b"middle\x1b_Ga=p,i=7\x1b\\after")

        self.assertEqual(
            cc_browser.silence_kitty_replies(frame),
            (b"before\x1b[4;9H\x1b_Ga=T,f=100,q=2;YWJj\x1b\\"
             b"middle\x1b_Ga=p,i=7,q=2\x1b\\after"),
        )

    def test_silence_kitty_replies_handles_tmux_doubled_escapes(self):
        wrapped = b"\x1bPtmux;\x1b\x1b_Ga=d,d=I,i=7\x1b\x1b\\\x1b\\"

        self.assertEqual(
            cc_browser.silence_kitty_replies(wrapped),
            b"\x1bPtmux;\x1b\x1b_Ga=d,d=I,i=7,q=2\x1b\x1b\\\x1b\\",
        )

    def test_frame_pump_writes_only_addressed_frame_payload(self):
        payload = b"\x1b[2J\x1b_Ga=T,i=7;YWJj\x1b\\"
        stdout = (b"Chromium diagnostic with \x1b[5n\n"
                  b"READY 2\n"
                  b"@%8 FRAME " + payload.hex().encode() + b"\n"
                  b"@%7 FRAME " + payload.hex().encode() + b"\n")
        bridge = cc_browser.Bridge.__new__(cc_browser.Bridge)
        bridge.pane = "%7"
        bridge.engine = FakeEngine(stdout)
        bridge.host_ready = threading.Event()
        bridge.host_error = ""
        bridge.lock = threading.Lock()
        bridge.shown = True
        bridge.up = True
        bridge.tty = io.BytesIO()

        bridge.pump_frames()

        self.assertTrue(bridge.host_ready.is_set())
        self.assertEqual(
            bridge.tty.getvalue(),
            b"\x1b[2J\x1b_Ga=T,i=7,q=2;YWJj\x1b\\",
        )

    def test_frame_pump_rejects_wrong_protocol(self):
        bridge = cc_browser.Bridge.__new__(cc_browser.Bridge)
        bridge.pane = "%7"
        bridge.engine = FakeEngine(b"READY 99\n")
        bridge.host_ready = threading.Event()
        bridge.host_error = ""
        bridge.lock = threading.Lock()
        bridge.shown = True
        bridge.up = True
        bridge.tty = io.BytesIO()

        bridge.pump_frames()

        self.assertEqual(bridge.host_error, "TWeb hosted protocol 99, expected 2")


if __name__ == "__main__":
    unittest.main()
