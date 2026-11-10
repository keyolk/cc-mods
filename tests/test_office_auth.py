import json
import os
import pathlib
import re
import subprocess
import tempfile
import textwrap
import unittest

OFFICE = pathlib.Path(__file__).parents[1] / "office"

# auth.js under node with office.html's helpers it uses (esc, clock) and just
# enough of a page: a panel element whose innerHTML writes are counted, and a
# clipboard that records what was copied.
HARNESS = textwrap.dedent(r"""
    const vm = require('vm'), fs = require('fs')
    const html = fs.readFileSync(process.argv[3], 'utf8')
    const esc = html.match(/^function esc\(s\) \{.*\}$/m)[0]
    const copied = []
    const ctx = { console, JSON, Math, Date, String, Promise, copied,
      navigator: { clipboard: { writeText: async (t) => { if (ctx.denyClipboard) throw new Error('denied'); copied.push(t) } } },
      document: { body: { appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }), execCommand: () => false } }
    vm.createContext(ctx)
    vm.runInContext(esc + '\nfunction clock(at) { return "T" + at }', ctx)
    vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx)
    // A row as the panel holds it: the attributes authHtml wrote, as dataset.
    vm.runInContext(`
      function rows(h) {
        const out = []
        for (const m of h.matchAll(/<div class="r[^"]*"([^>]*)>/g)) {
          const ds = {}
          for (const a of m[1].matchAll(/data-([a-z]+)="([^"]*)"/g)) ds[a[1]] = a[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          out.push(ds)
        }
        return out
      }
      function pressOn(ds) { return authPress({ target: { closest: (q) => (q === '[data-act]' && ds.act ? { dataset: ds } : null) } }) }
    `, ctx)
    Promise.resolve(vm.runInContext(process.argv[4], ctx)).then((v) => process.stdout.write(JSON.stringify(v)))
""")

ITEMS = [
    {"label": "AWS SSO", "state": "soon", "detail": "d-1.awsapps.com", "expiresAt": 1_790_000_000, "fix": 'aws sso logout --profile "p"; aws sso login --profile "p"', "connector": False, "mine": False},
    {"label": "ArgoCD ×2", "state": "expired", "detail": "argocd, argocd-kb", "expiresAt": None, "fix": "argocd login a --sso && argocd login b --sso", "connector": False, "mine": False},
    {"label": "Coder apne2", "state": "unknown", "detail": "no session", "expiresAt": None, "fix": None, "connector": False, "mine": False},
    {"label": "gh keyolk", "state": "ok", "detail": "", "expiresAt": None, "fix": "gh auth login", "connector": False, "mine": False},
    {"label": "MCP Canva", "state": "unknown", "detail": "needs auth", "expiresAt": None, "fix": "/mcp", "connector": True, "mine": False},
]


class AuthPanelTest(unittest.TestCase):
    def run_js(self, body: str):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(HARNESS)
        self.addCleanup(os.unlink, f.name)
        r = subprocess.run(["node", f.name, str(OFFICE / "auth.js"), str(OFFICE / "office.html"), "(async () => {" + body + "})()"], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_a_soon_row_and_an_expired_row_both_copy_their_fix_on_a_press(self):
        # The report: a ⏳ 곧 만료 row did nothing when pressed. Rows were text
        # only; soon and expired are one case (a login is due), so both answer.
        got = self.run_js("""
            const rs = rows(authHtml({ at: 1, items: %s }, ''))
            const soon = await pressOn(rs[0]), exp = await pressOn(rs[1])
            return [rs.map((r) => r.act || null), soon, exp, copied]
        """ % json.dumps(ITEMS))
        acts, soon, exp, copied = got
        # Needs-login rows first (AWS, ArgoCD, Coder), then the fine one, then the folded connector.
        self.assertEqual(acts, ["copy", "copy", "how", None, "copy"])
        self.assertEqual(copied, ['aws sso logout --profile "p"; aws sso login --profile "p"', "argocd login a --sso && argocd login b --sso"])
        self.assertTrue(soon.startswith("📋 복사했습니다 · 터미널에 붙여 넣으세요: aws sso logout"), soon)
        self.assertIn("argocd login a --sso && argocd login b --sso", exp)

    def test_a_row_without_a_fix_still_answers_and_a_slash_fix_goes_to_a_prompt(self):
        got = self.run_js("""
            const rs = rows(authHtml({ at: 1, items: %s }, ''))
            return [await pressOn(rs[2]), await pressOn(rs[4]), await pressOn(rs[3])]
        """ % json.dumps(ITEMS))
        self.assertEqual(got[0], "❔ 아무 세션에서나 /auth로 다시 확인")
        self.assertEqual(got[1], "📋 복사했습니다 · 아무 세션 프롬프트에 붙여 넣으세요: /mcp")
        # A fine row is not a button: the press is not the panel's.
        self.assertIsNone(got[2])

    def test_a_copy_the_page_may_not_make_says_so_with_the_command(self):
        got = self.run_js("""
            denyClipboard = true
            return await pressOn(rows(authHtml({ at: 1, items: %s }, ''))[0])
        """ % json.dumps(ITEMS[:1]))
        self.assertEqual(got, '⚠ 복사하지 못했습니다 · 직접 입력하세요: aws sso logout --profile "p"; aws sso login --profile "p"')

    def test_the_panel_is_drawn_again_only_when_what_it_shows_changed(self):
        # /state polls every few seconds. A rewrite on each one dropped the
        # click that straddled it, a selection in a <code>, and the open fold.
        got = self.run_js("""
            let writes = 0
            const el = { dataset: {} }
            Object.defineProperty(el, 'innerHTML', { set() { writes++ } })
            const a = { at: 1, items: %s }
            const r = [authPaint(el, authHtml(a, '')), authPaint(el, authHtml(a, '')), authPaint(el, authHtml(a, '')), writes]
            r.push(authPaint(el, authHtml(a, '📋 복사했습니다')), writes)
            return r
        """ % json.dumps(ITEMS))
        self.assertEqual(got, [True, False, False, 1, True, 2])

    def test_the_connector_fold_stays_as_it_was_left(self):
        got = self.run_js("""
            const a = { at: 1, items: %s }
            const shut = /<details open>/.test(authHtml(a, ''))
            authFold.open = true
            return [shut, /<details open>/.test(authHtml(a, ''))]
        """ % json.dumps(ITEMS))
        self.assertEqual(got, [False, True])

    def test_the_line_a_press_left_shows_at_the_top_escaped(self):
        got = self.run_js("return authHtml({ at: 1, items: %s }, '📋 <x>')" % json.dumps(ITEMS[:1]))
        self.assertIn('<div class="said">📋 &lt;x&gt;</div>', got)

    def test_the_page_loads_auth_js_and_the_server_serves_it(self):
        page = (OFFICE / "office.html").read_text()
        self.assertIn('<script src="auth.js"></script>', page)
        self.assertNotIn("function authHtml", page)
        # The panel's rows answer through one listener on the panel, which
        # outlives the rows a redraw replaces.
        self.assertRegex(page, r"authp\.addEventListener\('click'")
        self.assertIsNone(re.search(r"authp\.innerHTML\s*=", page))
        self.assertIn('"/auth.js"', (OFFICE / "office.py").read_text())


if __name__ == "__main__":
    unittest.main()
