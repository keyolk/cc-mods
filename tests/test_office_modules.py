"""A page that got only some of its <script src> files (office.html, the module
guard): the check that finds a missing module, the reload with its backoff and
its stop, and the 지휘 list drawn without table.js."""

import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = pathlib.Path(__file__).parents[1] / "office"
sys.path.insert(0, str(HERE))
import office  # noqa: E402

HTML = (HERE / "office.html").read_text()


def guard_source() -> str:
    m = re.search(r"<script>\n// Module guard\..*?</script>", HTML, re.S)
    assert m, "office.html has no module guard"
    return m.group(0)[len("<script>"):-len("</script>")]


MODULES = [n for n in office.PAGE_FILES if n != "office.html"]
ALL = re.findall(r"\['[a-z]+\.js','([A-Za-z]+)'\]", HTML)


class PageModulesTest(unittest.TestCase):
    def test_every_module_the_server_serves_is_a_script_tag_with_onerror(self):
        tags = re.findall(r'<script src="([^"]+)"([^>]*)></script>', HTML)
        self.assertEqual(sorted(t[0] for t in tags), sorted(MODULES))
        for src, rest in tags:
            self.assertIn('onerror="modErr(this)"', rest, src)

    def test_every_module_has_one_probe_that_is_a_function_declaration_in_its_file(self):
        # A function declaration lands on window; a const arrow function does not.
        mods = re.findall(r"\['([a-z]+\.js)','([A-Za-z]+)'\]", HTML)
        self.assertEqual(sorted(m[0] for m in mods), sorted(MODULES))
        for f, name in mods:
            self.assertRegex((HERE / f).read_text(), r"(?m)^(async )?function " + name + r"\b", f)

    def test_the_guard_runs_before_the_first_module_and_checks_after_the_last(self):
        self.assertLess(HTML.index("function modEnsure"), HTML.index('<script src="brands.js"'))
        self.assertLess(HTML.index('<script src="command.js"'), HTML.index("<script>modEnsure(false)</script>"))

    def test_the_server_queues_a_burst_of_script_requests(self):
        # 14 scripts at once beside /state and /next: the default backlog of 5
        # reset the extra connections while the office was slow to accept.
        self.assertGreaterEqual(office.OfficeServer.request_queue_size, 64)
        self.assertIn("OfficeServer((", (HERE / "office.py").read_text())

    def test_the_poll_checks_the_modules_after_a_state_answer(self):
        self.assertIn("staleStamp(j.stamp); modEnsure(true)", HTML)


GUARD_HARNESS = textwrap.dedent(r"""
    const vm = require('vm'), fs = require('fs')
    const cfg = JSON.parse(process.argv[2])
    const store = cfg.store === 'throws' ? null : Object.assign({}, cfg.store || {})
    const timers = [], reloads = []
    let removed = 0
    const bar = { style: {}, children: [], appendChild(c) { this.children.push(c) }, remove() { removed++ }, set textContent(v) { this.text = v; this.children = [] } }
    const ctx = { console, Math, JSON, Number, String,
      setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length },
      location: { reload() { reloads.push(1) } },
      document: { activeElement: cfg.typing ? { tagName: 'TEXTAREA', value: 'half-typed' } : null, body: { appendChild() {} }, createElement: (t) => (t === 'div' ? bar : { style: {} }) } }
    if (store) ctx.sessionStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) }, removeItem: (k) => { delete store[k] } }
    else Object.defineProperty(ctx, 'sessionStorage', { get() { throw new Error('blocked') } })
    ctx.window = ctx
    vm.createContext(ctx)
    vm.runInContext(fs.readFileSync(process.argv[3], 'utf8'), ctx)
    for (const name of cfg.defined) ctx[name] = function () {}
    const results = []
    for (const call of cfg.calls) {
      results.push(vm.runInContext(call, ctx))
      // The wait ends: the timer's reload runs.
      while (timers.length) timers.shift()[0]()
    }
    console.log(JSON.stringify({ results, reloads: reloads.length, store, text: bar.text, button: bar.children.length, removed }))
""")


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class GuardTest(unittest.TestCase):
    def run_guard(self, **cfg):
        cfg.setdefault("defined", ALL)
        cfg.setdefault("calls", ["modEnsure(false)"])
        with tempfile.TemporaryDirectory() as d:
            h, g = pathlib.Path(d, "h.js"), pathlib.Path(d, "g.js")
            h.write_text(GUARD_HARNESS)
            g.write_text(guard_source())
            r = subprocess.run(["node", str(h), json.dumps(cfg), str(g)], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def without(self, *names):
        return [n for n in ALL if n not in names]

    def test_the_probe_list_covers_the_sixteen_modules(self):
        self.assertEqual(len(ALL), 16)

    def test_all_modules_present_does_nothing_and_clears_an_old_count(self):
        got = self.run_guard(store={"office.modReload": "3"})
        self.assertEqual((got["results"], got["reloads"], got["store"]), ([True], 0, {}))

    def test_a_missing_module_reloads_once_counts_it_and_names_the_files(self):
        got = self.run_guard(defined=self.without("tblHtml", "dfrUntil", "slxFoot"))
        self.assertEqual((got["results"], got["reloads"], got["store"]), ([False], 1, {"office.modReload": "1"}))
        self.assertIn("slx.js, table.js, defer.js", got["text"])

    def test_the_wait_doubles_with_each_try(self):
        waits = []
        for n in range(5):
            got = self.run_guard(defined=self.without("tblHtml"), store={"office.modReload": str(n)})
            self.assertEqual(got["store"], {"office.modReload": str(n + 1)})
            waits.append(re.search(r"(\d+(?:\.\d+)?)초", got["text"]).group(1))
        self.assertEqual(waits, ["0.4", "0.8", "1.6", "3.2", "6.4"])

    def test_after_five_tries_it_stops_with_a_button_and_does_not_reload(self):
        got = self.run_guard(defined=self.without("tblHtml"), store={"office.modReload": "5"})
        self.assertEqual((got["results"], got["reloads"], got["button"]), ([False], 0, 1))
        self.assertIn("table.js", got["text"])

    def test_without_storage_it_does_not_reload_at_all(self):
        # Nothing could count the tries, so a reload might loop: banner only.
        got = self.run_guard(defined=self.without("tblHtml"), store="throws")
        self.assertEqual((got["results"], got["reloads"], got["button"]), ([False], 0, 1))

    def test_a_second_check_while_the_reload_waits_adds_no_second_reload(self):
        got = self.run_guard(defined=self.without("tblHtml"), calls=["[modEnsure(false), modEnsure(true)].join()"])
        self.assertEqual((got["reloads"], got["store"]), (1, {"office.modReload": "1"}))

    def test_the_poll_does_not_reload_a_page_with_text_typed_in_a_box(self):
        got = self.run_guard(defined=self.without("tblHtml"), typing=True, calls=["modEnsure(true)"])
        self.assertEqual((got["results"], got["reloads"], got["store"]), ([False], 0, {}))

    def test_the_load_check_reloads_even_with_a_box_focused(self):
        got = self.run_guard(defined=self.without("tblHtml"), typing=True)
        self.assertEqual(got["reloads"], 1)

    def test_a_script_error_event_is_recorded_by_name(self):
        got = self.run_guard(calls=["modErr({ getAttribute: () => 'table.js' }); MODFAIL.join()"])
        self.assertEqual(got["results"], ["table.js"])

    def test_a_page_that_got_its_modules_back_hides_the_banner(self):
        got = self.run_guard(defined=self.without("tblHtml"), store={"office.modReload": "5"},
                             calls=["modEnsure(true)", "tblHtml = function () {}; modEnsure(true)"])
        self.assertEqual((got["results"], got["removed"], got["store"]), ([False, True], 1, {}))


LIST_HARNESS = textwrap.dedent(r"""
    const vm = require('vm'), fs = require('fs')
    const dir = process.argv[2], without = JSON.parse(process.argv[3])
    const kids = {}
    const el = () => { const e = { style: {}, dataset: {}, classList: { toggle() {} }, appendChild() {}, after() {}, firstChild: null, scrollTop: 0, _html: '', querySelectorAll: () => [], querySelector: () => null }
      Object.defineProperty(e, 'innerHTML', { get() { return this._html }, set(v) { this._html = v; if (v) this.firstChild = {} } }); return e }
    const mk = () => { const e = el(); e.querySelector = (s) => (s === '.list' || s === '.briefs' || s === '.rtabs' ? (kids[s] = kids[s] || el()) : null); return e }
    const ctx = { console, JSON, Math, setTimeout: () => 0, clearTimeout() {}, fetch: () => Promise.reject(new Error('no server')),
      localStorage: { getItem: () => null, setItem() {} },
      document: { createElement: mk, getElementById: el, head: el(), body: el() } }
    vm.createContext(ctx)
    for (const f of ['review.js', 'crew.js', 'look.js', 'briefline.js', 'slx.js', 'table.js', 'defer.js', 'hibernate.js', 'agenda.js', 'command.js']) {
      if (without.includes(f)) continue
      vm.runInContext(fs.readFileSync(dir + '/' + f, 'utf8'), ctx)
    }
    vm.runInContext('cmdRenderSay = () => {}; cmdRenderDoc = () => {}; cmdFirstPick = () => {}', ctx)
    vm.runInContext("cmd.data = { pending: [], coordinators: [], table: [] }", ctx)
    let threw = null
    try { vm.runInContext('cmdRender()', ctx) } catch (e) { threw = String(e) }
    const k = (s) => kids[s]
    console.log(JSON.stringify({ threw, list: k('.list') ? k('.list')._html : null, briefsClick: !!(k('.briefs') && k('.briefs').onclick), tabsClick: !!(k('.rtabs') && k('.rtabs').onclick) }))
""")


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class ListWithoutModulesTest(unittest.TestCase):
    def render(self, without):
        with tempfile.TemporaryDirectory() as d:
            h = pathlib.Path(d, "h.js")
            h.write_text(LIST_HARNESS)
            r = subprocess.run(["node", str(h), str(HERE), json.dumps(without)], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_all_modules_draw_the_table(self):
        got = self.render([])
        self.assertIsNone(got["threw"])
        self.assertNotIn("불러오지 못했습니다", got["list"])
        self.assertTrue(got["briefsClick"] and got["tabsClick"])

    def test_without_table_js_the_render_does_not_throw_and_says_what_is_missing(self):
        got = self.render(["table.js", "defer.js", "slx.js"])
        self.assertIsNone(got["threw"])
        self.assertIn("table.js", got["list"])
        self.assertFalse(got["tabsClick"])

    def test_without_briefline_js_the_table_is_still_drawn(self):
        got = self.render(["briefline.js"])
        self.assertIsNone(got["threw"])
        self.assertNotIn("불러오지 못했습니다", got["list"])
        self.assertFalse(got["briefsClick"])

    def test_without_hibernate_slx_and_defer_the_table_is_still_drawn(self):
        got = self.render(["hibernate.js", "slx.js", "defer.js"])
        self.assertIsNone(got["threw"])
        self.assertNotIn("불러오지 못했습니다", got["list"])


if __name__ == "__main__":
    unittest.main()
