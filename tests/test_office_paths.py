"""office/paths.py: which files a 👁 link in an answer may open (/paths, /file)."""

import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
import office  # noqa: E402
import paths  # noqa: E402


class Home(unittest.TestCase):
    def setUp(self):
        # Every path is under a temporary home: the real ~ is never read.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = pathlib.Path(os.path.realpath(tmp.name)) / "home"
        self.home.mkdir()
        self.out = pathlib.Path(os.path.realpath(tmp.name)) / "outside"
        self.out.mkdir()
        env = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        self.draft = self.make("exp/2026-11-04_termius_vra/2026-11-09_bridge-letter-ping_draft.md", "# draft\n")

    def make(self, rel, text="x", root=None):
        p = (root or self.home) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        return p


class ResolveTest(Home):
    def test_a_file_under_home_by_tilde_absolute_and_line_suffix(self):
        want = str(self.draft)
        self.assertEqual(paths.resolve("~/exp/2026-11-04_termius_vra/2026-11-09_bridge-letter-ping_draft.md"), want)
        self.assertEqual(paths.resolve(want), want)
        self.assertEqual(paths.resolve(want + ":12"), want)
        self.assertEqual(paths.resolve(want + ":12:3"), want)

    def test_a_relative_path_is_read_from_the_session_folder_only(self):
        code = self.make("src/app/main.py", "print(1)\n")
        self.assertEqual(paths.resolve("app/main.py", str(self.home / "src")), str(code))
        self.assertEqual(paths.resolve("./app/main.py", "~/src"), str(code))
        self.assertIsNone(paths.resolve("app/main.py"))  # no folder to read it from

    def test_dot_dot_and_symlinks_that_leave_home_are_refused(self):
        secret = self.make("notes.md", "outside", root=self.out)
        self.assertIsNone(paths.resolve(str(secret)))
        self.assertIsNone(paths.resolve("~/../outside/notes.md"))
        (self.home / "link.md").symlink_to(secret)
        self.assertIsNone(paths.resolve("~/link.md"))
        (self.home / "out").symlink_to(self.out)
        self.assertIsNone(paths.resolve("~/out/notes.md"))

    def test_credentials_are_refused_by_folder_and_by_name(self):
        for rel in (".ssh/config.txt", ".aws/credentials", ".aws/config.yaml", ".kube/config.yaml", ".gnupg/x.txt", ".config/gh/hosts.yml",
                    ".npmrc", "proj/.env", "proj/.env.local", "proj/service-credentials.json", "certs/server.pem", "certs/tls.key",
                    ".claude/.credentials.json", ".git-credentials", ".netrc"):
            self.make(rel)
            self.assertIsNone(paths.resolve("~/" + rel), rel)

    def test_case_does_not_get_past_the_deny_list(self):
        # macOS's file system ignores case: ~/.AWS is ~/.aws.
        self.make(".AWS/notes.txt")
        self.make("proj/AWS-Credentials.txt")
        self.assertIsNone(paths.resolve("~/.AWS/notes.txt"))
        self.assertIsNone(paths.resolve("~/proj/AWS-Credentials.txt"))

    def test_a_symlink_inside_home_that_lands_in_a_denied_folder_is_refused(self):
        self.make(".ssh/known.txt")
        (self.home / "keys").symlink_to(self.home / ".ssh")
        self.assertIsNone(paths.resolve("~/keys/known.txt"))
        (self.home / "innocent.txt").symlink_to(self.home / ".ssh" / "known.txt")
        self.assertIsNone(paths.resolve("~/innocent.txt"))

    def test_the_office_token_is_never_shown(self):
        self.make(".claude/state/office/token")
        self.assertIsNone(paths.resolve("~/.claude/state/office/token"))

    def test_too_big_missing_unknown_type_and_urls_are_refused(self):
        big = self.home / "big.log"
        with open(big, "wb") as f:
            f.truncate(paths.VIEW_MAX + 1)
        self.assertIsNone(paths.resolve(str(big)))
        self.assertIsNone(paths.resolve("~/nope.md"))
        self.make("tool.bin")
        self.assertIsNone(paths.resolve("~/tool.bin"))
        self.assertIsNone(paths.resolve("https://example.com/a/b.md"))
        self.assertIsNone(paths.resolve("file:///etc/hosts"))
        self.assertIsNone(paths.resolve("/etc/hosts"))

    def test_a_folder_shows_its_readme(self):
        readme = self.make("exp/topic/README.md", "# topic\n")
        self.assertEqual(paths.resolve("~/exp/topic"), str(readme))
        (self.home / "exp" / "bare").mkdir()
        self.assertIsNone(paths.resolve("~/exp/bare"))

    def test_more_credentials_by_folder_and_name(self):
        for rel in (".doppler/.doppler.yaml", ".config/gh/hosts.yml", ".config/anything/settings.json", ".docker/config.json",
                    ".password-store/x.txt", "Library/Keychains/login.txt", ".claude/.credentials.json", "proj/api_token.txt",
                    "proj/client-secret.json", "proj/passwords.md", "proj/Secrets/plan.md", ".local/share/keyrings/x.txt"):
            self.make(rel)
            self.assertIsNone(paths.resolve("~/" + rel), rel)


SID = "0123abcd-0000-4000-8000-000000000000"


class ViewableTest(Home):
    """/file answers what /paths answered: a link never leads to a refusal,
    and nothing /paths refuses is served. A file is shown only when the
    session named it (its transcript holds the path) or made it."""

    def setUp(self):
        super().setUp()
        self.said = []
        office._paths.clear()
        self.addCleanup(office._paths.clear)
        self.project = self.home / ".claude" / "projects" / "p"
        self.project.mkdir(parents=True)
        p = mock.patch.object(office, "pane_of", return_value={"cwd": str(self.home / "src")})
        p.start()
        self.addCleanup(p.stop)

    def say(self, *texts):
        recs = [{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": t}]}} for t in texts]
        (self.project / f"{SID}.jsonl").write_text("\n".join(json.dumps(r) for r in recs) + "\n")

    def test_a_path_the_session_wrote_opens_and_one_it_never_wrote_does_not(self):
        self.make("exp/other/notes.md", "# other\n")
        self.say("초안은 `~/exp/2026-11-04_termius_vra/2026-11-09_bridge-letter-ping_draft.md` 에 있습니다.")
        code, body, _, _ = office.viewable(SID, "~/exp/2026-11-04_termius_vra/2026-11-09_bridge-letter-ping_draft.md")
        self.assertEqual((code, body), (200, b"# draft\n"))
        self.assertEqual(office.viewable(SID, "~/exp/other/notes.md")[0], 403)
        self.assertEqual(office.viewable("ffffffff-0000", "~/exp/2026-11-04_termius_vra/2026-11-09_bridge-letter-ping_draft.md")[0], 403)

    def test_an_absolute_or_relative_mention_counts_for_the_same_file(self):
        code = self.make("src/app/main.py", "print(1)\n")
        self.say("edited app/main.py")
        self.assertEqual(office.viewable(SID, str(code))[0], 200)
        self.assertEqual(office.shown_paths(SID, ["app/main.py", str(code)]), {"app/main.py": str(code), str(code): str(code)})

    def test_a_named_credential_is_still_refused(self):
        self.make(".aws/credentials")
        self.make(".config/gh/hosts.yml")
        self.say("look at ~/.aws/credentials and ~/.config/gh/hosts.yml")
        self.assertEqual(office.viewable(SID, "~/.aws/credentials")[0], 403)
        self.assertEqual(office.viewable(SID, "~/.config/gh/hosts.yml")[0], 403)
        self.assertEqual(office.shown_paths(SID, ["~/.aws/credentials", "~/.config/gh/hosts.yml"]), {})

    def test_a_path_inside_a_longer_one_is_not_a_mention(self):
        self.make("src/a.md", "a")
        self.make("src/x/a.md", "b")
        self.say("wrote ~/src/x/a.md.bak and other/src/a.md")
        self.assertEqual(office.viewable(SID, "~/src/a.md")[0], 403)
        self.say("wrote `~/src/a.md`. Then ~/src/x/a.md:3")
        self.assertEqual(office.viewable(SID, "~/src/a.md")[0], 200)
        self.assertEqual(office.viewable(SID, "~/src/x/a.md")[0], 200)

    def test_a_named_path_outside_home_is_refused(self):
        outside = self.make("x.md", root=self.out)
        self.say("see " + str(outside))
        self.assertEqual(office.viewable(SID, str(outside))[0], 403)

    def test_source_code_is_served_as_plain_text(self):
        self.make("w/app.js", "alert(1)\n")
        self.say("wrote ~/w/app.js")
        code, _, kind, extra = office.viewable(SID, "~/w/app.js")
        self.assertEqual((code, kind), (200, "text/plain; charset=utf-8"))
        self.assertEqual(extra.get("X-Content-Type-Options"), "nosniff")

    def test_a_session_output_in_a_denied_folder_is_still_refused(self):
        key = self.make(".ssh/notes.md")
        with mock.patch.object(office, "related", return_value=[{"path": str(key)}]):
            self.assertEqual(office.viewable(SID, str(key))[0], 403)

    def test_a_session_output_outside_home_still_opens(self):
        # The old rule stays: a file the session made, wherever it is.
        made = self.make("report.md", "# r\n", root=self.out)
        with mock.patch.object(office, "related", return_value=[{"path": str(made)}]):
            self.assertEqual(office.viewable(SID, str(made))[0], 200)

    def test_shown_paths_maps_only_what_may_be_shown(self):
        self.make("src/a/b.ts", "x")
        self.make("exp/x/unsaid.md")
        self.say("~/exp/2026-11-04_termius_vra/2026-11-09_bridge-letter-ping_draft.md and a/b.ts")
        got = office.shown_paths(SID, ["~/exp/2026-11-04_termius_vra/2026-11-09_bridge-letter-ping_draft.md", "a/b.ts", "~/missing.md", "~/exp/x/unsaid.md"])
        self.assertEqual(got, {"~/exp/2026-11-04_termius_vra/2026-11-09_bridge-letter-ping_draft.md": str(self.draft), "a/b.ts": str(self.home / "src/a/b.ts")})


if __name__ == "__main__":
    unittest.main()
