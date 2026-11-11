import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "office"))
import ghprs  # noqa: E402


def node(num, author, requested=(), reviews=(), repo="o/r", title="t"):
    return {"number": num, "title": title, "url": f"https://github.com/{repo}/pull/{num}", "isDraft": False, "repository": {"nameWithOwner": repo}, "author": {"login": author},
            "reviewRequests": {"nodes": [{"requestedReviewer": {"login": r}} for r in requested] + [{"requestedReviewer": {}}]},
            "latestReviews": {"nodes": [{"author": {"login": a}, "state": s} for a, s in reviews]}}


SEARCH = json.dumps({"data": {
    "a": {"nodes": [node(1, "me", requested=["Kairo-Kim"], reviews=[("evan-sb", "APPROVED"), ("github-actions", "COMMENTED")])]},
    "r": {"nodes": [node(2, "Kairo-Kim", requested=["me"]), node(1, "me")]},
}})


class ParseCase(unittest.TestCase):
    def test_prs_merge_both_searches_and_drop_bots(self):
        prs = ghprs.parse_prs(SEARCH)
        self.assertEqual([(p["number"], p["mine"]) for p in prs], [(1, True), (2, False)])
        self.assertEqual(prs[0]["reviewers"], {"Kairo-Kim": "REQUESTED", "evan-sb": "APPROVED"})

    def test_prs_refuse_an_error_answer(self):
        with self.assertRaises(ValueError):
            ghprs.parse_prs(json.dumps({"errors": [{"message": "x"}]}))

    def test_people_read_every_page(self):
        page = lambda pairs: json.dumps({"data": {"organization": {"samlIdentityProvider": {"externalIdentities": {"nodes": [{"samlIdentity": {"nameId": e}, "user": {"login": lg}} for lg, e in pairs]}}}}})
        out = ghprs.parse_people(page([("Evan-SB", "Evan.Kim@x.com")]) + "\n" + page([("zz", "zz@x.com"), ("nouser", "")]))
        self.assertEqual(out, {"evan-sb": "evan.kim@x.com", "zz": "zz@x.com"})


class LinkCase(unittest.TestCase):
    EMAILS = {"kairo.kim@x.com", "evan.kim@x.com", "milo@x.com"}

    def test_login_to_email(self):
        # By its letters, by the org's SAML, by the people file.
        self.assertEqual(ghprs.login_email("Kairo-Kim", self.EMAILS, {}, {}), "kairo.kim@x.com")
        self.assertEqual(ghprs.login_email("evan-sb", self.EMAILS, {"evan-sb": "evan.kim@x.com"}, {}), "evan.kim@x.com")
        self.assertEqual(ghprs.login_email("milo-sk", self.EMAILS, {}, {"milo@x.com": {"github": "Milo-SK"}}), "milo@x.com")
        self.assertIsNone(ghprs.login_email("stranger", self.EMAILS, {}, {}))
        # A SAML email of someone not in the meeting is not a match.
        self.assertIsNone(ghprs.login_email("zz", self.EMAILS, {"zz": "zz@x.com"}, {}))

    def test_link_puts_what_waits_on_me_first(self):
        got = ghprs.link(self.EMAILS, ghprs.parse_prs(SEARCH), {"evan-sb": "evan.kim@x.com"}, {})
        self.assertEqual([h["role"] for h in got["kairo.kim@x.com"]], ["작성", "리뷰 요청됨"])
        self.assertEqual(got["kairo.kim@x.com"][0]["ref"], {"url": "https://github.com/o/r/pull/2"})
        self.assertEqual([h["role"] for h in got["evan.kim@x.com"]], ["승인"])
        self.assertNotIn("milo@x.com", got)

    def test_config_ignores_bad_values(self):
        import os
        import tempfile
        d = tempfile.mkdtemp()
        p = os.path.join(d, "office.json")
        with open(p, "w") as f:
            json.dump({"agenda": {"ghUser": "a b; rm", "ghOrg": "ok-org"}}, f)
        old = ghprs.CONFIG
        ghprs.CONFIG = p
        try:
            self.assertEqual(ghprs.config(), {"ghUser": "", "ghOrg": "ok-org"})
        finally:
            ghprs.CONFIG = old


if __name__ == "__main__":
    unittest.main()
