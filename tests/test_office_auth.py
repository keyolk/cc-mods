import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock

OFFICE = pathlib.Path(__file__).parents[1] / "office"
sys.path.insert(0, str(OFFICE))
import office  # noqa: E402

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
      function pressOn(ds, send) { return authPress({ target: { closest: (q) => (q === '[data-act]' && ds.act ? { dataset: ds } : null) } }, send) }
    `, ctx)
    Promise.resolve(vm.runInContext(process.argv[4], ctx)).then((v) => process.stdout.write(JSON.stringify(v)))
""")

ITEMS = [
    {"id": "aws-sso", "label": "AWS SSO", "state": "soon", "detail": "d-1.awsapps.com", "expiresAt": 1_790_000_000, "fix": 'aws sso logout --profile "p"; aws sso login --profile "p"', "connector": False, "mine": False},
    {"id": "argocd:*", "label": "ArgoCD ×2", "state": "expired", "detail": "argocd, argocd-kb", "expiresAt": None, "fix": "argocd login a --sso && argocd login b --sso", "connector": False, "mine": False},
    {"id": "coder:apne2", "label": "Coder apne2", "state": "unknown", "detail": "no session", "expiresAt": None, "fix": None, "connector": False, "mine": False},
    {"id": "gh:keyolk", "label": "gh keyolk", "state": "ok", "detail": "", "expiresAt": None, "fix": "gh auth login", "connector": False, "mine": False},
    {"id": "mcp:claude.ai Canva", "label": "MCP Canva", "state": "unknown", "detail": "needs auth", "expiresAt": None, "fix": "/mcp", "connector": True, "mine": False},
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

    def test_with_a_session_to_take_it_a_press_hands_the_row_id_over_and_says_to_whom(self):
        # The person chose (brief 2026-11-11-office-auth-login-start) that a
        # press starts the login in a live session's cockpit, not a copy.
        got = self.run_js("""
            const to = { sid: 's1', name: 'cc-mods-d9' }, sent = []
            const send = async (id) => { sent.push(id); return to }
            const rs = rows(authHtml({ at: 1, items: %s }, '', to))
            const aws = await pressOn(rs[0], send), argo = await pressOn(rs[1], send), mcp = await pressOn(rs[4], send), coder = await pressOn(rs[2], send)
            return [rs.map((r) => r.act || null), sent, aws, argo, mcp, coder, copied]
        """ % json.dumps(ITEMS))
        acts, sent, aws, argo, mcp, coder, copied = got
        # A /mcp row still copies: it logs in to one session's own connection.
        self.assertEqual(acts, ["run", "run", "how", None, "copy"])
        # Only the ids go: the session runs its own row (its foldLogins batch for argocd:*).
        self.assertEqual(sent, ["aws-sso", "argocd:*"])
        self.assertEqual(aws, "▶ 로그인 시작: cc-mods-d9 · 진행과 결과는 그 세션 화면에 뜹니다")
        self.assertEqual(argo, aws)
        self.assertEqual(mcp, "📋 복사했습니다 · 아무 세션 프롬프트에 붙여 넣으세요: /mcp")
        self.assertEqual(coder, "❔ 아무 세션에서나 /auth로 다시 확인")
        self.assertEqual(copied, ["/mcp"])

    def test_a_handoff_nobody_took_copies_the_fix_instead(self):
        got = self.run_js("""
            const rs = rows(authHtml({ at: 1, items: %s }, '', { sid: 's1', name: 'x' }))
            return [await pressOn(rs[0], async () => null), copied]
        """ % json.dumps(ITEMS[:1]))
        self.assertTrue(got[0].startswith("📋 복사했습니다 · 터미널에 붙여 넣으세요: aws sso logout"), got[0])
        self.assertEqual(len(got[1]), 1)

    def test_the_panel_names_the_session_a_press_goes_to(self):
        got = self.run_js("return [authHtml({ at: 1, items: %s }, '', { sid: 's', name: 'co<x>' }), authHtml({ at: 1, items: %s }, '')]" % (json.dumps(ITEMS[:1]), json.dumps(ITEMS[:1])))
        self.assertIn("누르면 co&lt;x&gt; 세션이 로그인 시작", got[0])
        self.assertIn("▶ 로그인", got[0])
        self.assertIn("누르면 명령 복사", got[1])
        self.assertIn("📋 복사", got[1])

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


# The server's half: which session a press goes to, and what it is handed.
RADAR = {
    "at": 1_790_000_000_000,
    "items": [
        {"id": "aws-sso", "label": "AWS SSO", "state": "soon", "fix": ["sh", "-c", 'aws sso logout --profile "$0"; aws sso login --profile "$0"', "p"]},
        {"id": "argocd:a", "label": "ArgoCD a", "state": "expired", "fix": ["argocd", "login", "a", "--sso", "--grpc-web"]},
        {"id": "argocd:b", "label": "ArgoCD b", "state": "soon", "fix": ["argocd", "login", "b", "--sso", "--grpc-web"]},
        {"id": "gh:keyolk", "label": "gh keyolk", "state": "ok", "fix": ["gh", "auth", "login"]},
        {"id": "coder:x", "label": "Coder x", "state": "expired"},
        {"id": "mcp:portal", "label": "MCP portal", "state": "expired", "fix": ["/mcp"], "mine": True},
    ],
}


class AuthHandoffTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        h = pathlib.Path(self.home.name)
        store = h / ".claude/plugins/store"
        store.mkdir(parents=True)
        (store / "cc-mods_inline-1.json").write_text(json.dumps({"radar": RADAR}))
        self.fix = h / ".claude/state/office/fix"
        for p in (mock.patch.dict(os.environ, {"HOME": self.home.name}), mock.patch.object(office, "FIX_DIR", str(self.fix)), mock.patch.dict(office._radar, {}, clear=True)):
            p.start()
            self.addCleanup(p.stop)
        self.spoke = {}
        p = mock.patch.object(office, "last_spoke", side_effect=lambda sid: self.spoke.get(sid))
        p.start()
        self.addCleanup(p.stop)

    def able(self, *sids):
        self.fix.mkdir(parents=True, exist_ok=True)
        for s in sids:
            (self.fix / (s + ".on")).write_text("{}")

    PEOPLE = [{"id": "w1", "name": "worker"}, {"id": "co", "name": "cc-mods-d9-win", "coord": True, "coordName": "cc-mods-d9"}, {"id": "w2", "name": "other"}]

    def test_rows_carry_their_radar_id_and_a_fold_its_cockpit_id(self):
        ids = [i["id"] for i in office.auth()["items"]]
        self.assertIn("argocd:*", ids)
        self.assertNotIn("argocd:a", ids)
        self.assertIn("aws-sso", ids)

    def test_only_a_session_whose_module_takes_a_fix_is_picked_the_coordinator_first(self):
        self.assertIsNone(office.auth_target(self.PEOPLE))
        # An older module never wrote .on: the coordinator is passed over.
        self.able("w1", "w2")
        self.spoke = {"w1": 100, "w2": 200}
        self.assertEqual(office.auth_target(self.PEOPLE), {"sid": "w2", "name": "other"})
        self.able("co")
        self.assertEqual(office.auth_target(self.PEOPLE), {"sid": "co", "name": "cc-mods-d9"})
        # A .on left by a session that ended names nobody alive.
        self.assertIsNone(office.auth_target([{"id": "gone-elsewhere", "name": "z"}]))

    def test_a_press_writes_only_the_row_id_for_the_picked_session(self):
        self.able("co", "w1")
        code, out = office.auth_handoff("argocd:*", self.PEOPLE)
        self.assertEqual((code, out["to"]), (200, {"sid": "co", "name": "cc-mods-d9"}))
        sent = json.loads((self.fix / "co.run.json").read_text())
        self.assertEqual(set(sent), {"id", "at"})
        self.assertEqual(sent["id"], "argocd:*")
        self.assertFalse((self.fix / "w1.run.json").exists())

    def test_a_press_with_nothing_to_hand_over_is_refused_and_writes_nothing(self):
        self.assertEqual(office.auth_handoff("aws-sso", self.PEOPLE)[0], 409)  # nobody takes one
        self.able("co")
        for bad in ("gh:keyolk", "coder:x", "mcp:portal", "nope", ""):
            self.assertIn(office.auth_handoff(bad, self.PEOPLE)[0], (400, 409), bad)
        self.assertFalse((self.fix / "co.run.json").exists())

    def test_the_act_kind_picks_the_session_itself(self):
        self.able("co")
        with mock.patch.object(office, "snapshot", return_value=self.PEOPLE):
            code, out = office.act({"kind": "fix", "value": "aws-sso", "sid": "w1"})
        self.assertEqual(code, 200)
        self.assertEqual(out["to"]["sid"], "co")
        self.assertTrue((self.fix / "co.run.json").exists())

    def test_the_office_still_runs_no_fix(self):
        # It hands one over; nothing in office.py starts a login itself.
        src = (OFFICE / "office.py").read_text()
        for cmd in ("aws sso login", "argocd login", "coder login", "gh auth login"):
            self.assertNotIn(cmd, src)


if __name__ == "__main__":
    unittest.main()
