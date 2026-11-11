"""layers.js: Esc closes the layer opened last (인증 over 지휘 goes first), a
layer closed some other way is skipped, and the 지휘 view backs out of its
own steps before it closes. office.html asks the stack before command.js."""
import json
import pathlib
import re
import subprocess
import textwrap
import unittest

HERE = pathlib.Path(__file__).parents[1] / "office"
HTML = (HERE / "office.html").read_text()

HARNESS = textwrap.dedent(r"""
    const vm = require('vm'), fs = require('fs')
    const ctx = { console }
    vm.createContext(ctx)
    vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx)
    vm.runInContext(`
      const open = {}, closed = []
      const layer = (id, step) => { open[id] = true; layerUp(id, () => open[id], () => { open[id] = false; closed.push(id) }, step) }
      const out = {}
      // 지휘, then 인증: Esc closes 인증, then 지휘.
      layer('command'); layer('auth')
      out.top = layerTop()
      layerEsc(); out.afterOne = [layerOpen(), closed.slice()]
      layerEsc(); out.afterTwo = [layerOpen(), closed.slice()]
      out.empty = layerEsc()
      // A layer closed by its ✕ (not by Esc) is skipped.
      closed.length = 0
      layer('command'); layer('settings'); layer('auth'); open.auth = false
      layerEsc(); out.skipped = closed.slice()
      // Opened again: it moves to the top.
      layer('auth'); layer('help'); layer('auth')
      out.reopen = layerOpen()
      // A step takes an Esc and stays up until it has nothing to back out of.
      closed.length = 0; layers.length = 0
      let picked = 2
      layer('command', () => (picked > 0 ? (picked--, true) : false))
      layerEsc(); layerEsc(); out.stepped = [layerOpen(), closed.slice()]
      layerEsc(); out.stepClosed = [layerOpen(), closed.slice()]
      // An up() that throws counts as closed.
      layerUp('bad', () => { throw new Error('x') }, () => {})
      out.bad = layerOpen()
      console.log(JSON.stringify(out))
    `, ctx)
""")


class LayersTest(unittest.TestCase):
    def test_esc_closes_the_layer_opened_last(self):
        import tempfile, os
        with tempfile.TemporaryDirectory() as d:
            h = os.path.join(d, "h.js")
            open(h, "w").write(HARNESS)
            r = subprocess.run(["node", h, str(HERE / "layers.js")], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        o = json.loads(r.stdout)
        self.assertEqual(o["top"], "auth")
        self.assertEqual(o["afterOne"], [["command"], ["auth"]])
        self.assertEqual(o["afterTwo"], [[], ["auth", "command"]])
        self.assertFalse(o["empty"])
        self.assertEqual(o["skipped"], ["settings"])
        self.assertEqual(o["reopen"][-2:], ["help", "auth"])
        self.assertEqual(o["stepped"], [["command"], []])
        self.assertEqual(o["stepClosed"], [[], ["command"]])
        self.assertEqual(o["bad"], [])

    def test_office_asks_the_stack_before_the_command_view_and_menus_before_both(self):
        key = re.search(r"function officeKey\(e\) \{.*?\n\}", HTML, re.S).group(0)
        self.assertLess(key.index("menuKey(quietMenu"), key.index("layerEsc()"))
        self.assertLess(key.index("layerEsc()"), key.index("commandKey(e, k, typing)"))
        # No overlay keeps an Esc line of its own: the stack closes them.
        for gone in ("hit(closeViewer)", "hit(closeSettings)", "toggleAuth(false))\n", "hit(closeCard)"):
            self.assertNotIn(gone, key)

    def test_every_overlay_goes_on_the_stack_when_it_opens(self):
        for id_ in ("'auth'", "'settings'", "'viewer'", "'card'", "'help'"):
            self.assertIn("layerUp(" + id_, HTML)
        self.assertIn("layerUp('command'", (HERE / "command.js").read_text())

    def test_the_auth_panel_has_a_close_button(self):
        self.assertIn('class="authx"', (HERE / "auth.js").read_text())
        self.assertIn("button.authx", HTML)


if __name__ == "__main__":
    unittest.main()
