"""Offline regression tests using disposable Git repositories, no GitHub writes."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("update_submodule", Path(__file__).parents[1] / "update_submodule.py")
updater = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater)


def git(*args: str, cwd: Path) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()


class UpdateTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = Path(os.environ["LOCALAPPDATA"]) / "Temp" / "opencode" if os.environ.get("LOCALAPPDATA") else Path(tempfile.gettempdir())
        temporary.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="beercall-gitlink-", dir=temporary)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old_cwd = Path.cwd()
        self.addCleanup(os.chdir, self.old_cwd)
        self.source = self.root / "source"
        self.source.mkdir()
        self.init(self.source)
        self.a = self.commit(self.source, "a")
        self.b = self.commit(self.source, "b")
        self.c = self.commit(self.source, "c")
        git("switch", "-c", "feature", self.a, cwd=self.source)
        self.feature = self.commit(self.source, "feature")
        git("switch", "main", cwd=self.source)
        self.remote = self.root / "parent.git"
        git("init", "--bare", str(self.remote), cwd=self.root)
        seed = self.root / "seed"
        seed.mkdir()
        self.init(seed)
        git("-c", "protocol.file.allow=always", "submodule", "add", str(self.source), "beercall-frontend", cwd=seed)
        git("checkout", "--detach", self.a, cwd=seed / "beercall-frontend")
        git("update-index", "--cacheinfo", f"160000,{self.a},beercall-frontend", cwd=seed)
        git("commit", "-am", "initial pin", cwd=seed)
        git("remote", "add", "origin", str(self.remote), cwd=seed)
        git("push", "origin", "main", cwd=seed)
        self.work = self.root / "work"
        git("clone", "--branch", "main", str(self.remote), str(self.work), cwd=self.root)
        git("-c", "protocol.file.allow=always", "submodule", "update", "--init", cwd=self.work)
        os.chdir(self.work)

    def init(self, directory: Path) -> None:
        git("init", "-b", "main", cwd=directory)
        git("config", "user.name", "offline-test", cwd=directory)
        git("config", "user.email", "test@example.invalid", cwd=directory)
        git("config", "commit.gpgsign", "false", cwd=directory)

    def commit(self, directory: Path, text: str) -> str:
        (directory / "file.txt").write_text(text, encoding="utf-8")
        git("add", "file.txt", cwd=directory)
        git("commit", "-m", text, cwd=directory)
        return git("rev-parse", "HEAD", cwd=directory)

    def prepare(self, target: str) -> tuple[str, str] | None:
        return updater.prepare("beercall-frontend", target, "main")

    def test_payload(self) -> None:
        updater.validate("beercall-backend", self.a, "main")
        for module, sha, ref in [("other", self.a, "main"), ("beercall-frontend", "a" * 39, "main"),
                                 ("beercall-frontend", self.a, "feature"), ("beercall-frontend", self.a + "\n", "main")]:
            with self.assertRaises(ValueError):
                updater.validate(module, sha, ref)

    def test_only_one_gitlink_and_retry_reuses_commit(self) -> None:
        branch, head = self.prepare(self.b)
        self.assertEqual(git("diff", "--name-only", f"origin/main...{head}", cwd=self.work), "beercall-frontend")
        self.assertEqual(updater.pin(head, "beercall-frontend"), self.b)
        self.assertEqual(self.prepare(self.b), (branch, head))

    def test_delayed_dispatch_cannot_regress_pending_pr(self) -> None:
        branch, head = self.prepare(self.c)
        self.assertIsNone(self.prepare(self.b))
        self.assertEqual(git("ls-remote", "origin", f"refs/heads/{branch}", cwd=self.work).split()[0], head)

    def test_newer_dispatch_updates_same_pr_branch(self) -> None:
        branch, old = self.prepare(self.b)
        newer_branch, head = self.prepare(self.c)
        self.assertEqual(branch, newer_branch)
        self.assertNotEqual(old, head)
        self.assertEqual(updater.pin(head, "beercall-frontend"), self.c)

    def test_remote_edit_is_not_overwritten(self) -> None:
        branch, original = self.prepare(self.b)
        git("fetch", "origin", branch, cwd=self.work)
        self.commit(self.work, "concurrent remote edit")
        concurrent = git("rev-parse", "HEAD", cwd=self.work)
        real_git = updater.git

        def race(*args: str, **kwargs: object) -> str:
            if args[0] == "push":
                git("push", "origin", f"{concurrent}:refs/heads/{branch}", cwd=self.work)
            return real_git(*args, **kwargs)

        with patch.object(updater, "git", side_effect=race):
            with self.assertRaises(subprocess.CalledProcessError):
                self.prepare(self.c)
        self.assertNotEqual(original, concurrent)
        self.assertEqual(git("ls-remote", "origin", f"refs/heads/{branch}", cwd=self.work).split()[0], concurrent)

    def test_rejects_sha_outside_main(self) -> None:
        with self.assertRaises(ValueError):
            self.prepare(self.feature)

    def test_already_pinned_is_noop(self) -> None:
        self.assertIsNone(self.prepare(self.a))

    def test_refreshes_main_and_ignores_merged_older_dispatch(self) -> None:
        branch, head = self.prepare(self.c)
        git("push", "origin", f"{head}:refs/heads/main", cwd=self.work)
        self.assertIsNone(self.prepare(self.b))

    def test_rejects_unrelated_changes_on_existing_branch(self) -> None:
        branch, _ = self.prepare(self.b)
        self.commit(self.work, "unexpected parent change")
        git("push", "origin", branch, cwd=self.work)
        with self.assertRaises(ValueError):
            self.prepare(self.b)

    def test_auto_merge_matches_exact_head(self) -> None:
        with patch.object(updater, "run", side_effect=['[{"number": 42}]', ""]) as command:
            updater.open_pr("beercall-frontend", self.b, "branch", "head")
        self.assertEqual(command.call_args.args, ("gh", "pr", "merge", "42", "--auto", "--squash", "--delete-branch", "--match-head-commit", "head"))

    def test_missing_pr_created_then_resumed(self) -> None:
        with patch.object(updater, "run", side_effect=["[]", "created", '[{"number": 42}]', ""]) as command:
            updater.open_pr("beercall-frontend", self.b, "branch", "head")
        self.assertEqual(command.call_args_list[1].args[:3], ("gh", "pr", "create"))
        self.assertIn("--match-head-commit", command.call_args.args)

    def test_protection_fails_closed_for_admin_token_and_missing_checks(self) -> None:
        valid = {"required_status_checks": {"contexts": ["Validate pinned release", "E2E browser (Chromium)"]},
                 "enforce_admins": {"enabled": True}, "required_pull_request_reviews": {}}
        for protection, expected in [(valid, True), ({**valid, "enforce_admins": {"enabled": False}}, False),
                                     ({**valid, "required_status_checks": {}}, False),
                                     ({**valid, "required_pull_request_reviews": None}, False)]:
            with patch.object(updater, "api_json", return_value=protection):
                if expected:
                    updater.verify_protection()
                else:
                    with self.assertRaises(ValueError):
                        updater.verify_protection()

    def test_ruleset_protection_matches_the_real_github_ruleset(self) -> None:
        ruleset = {
            "id": 24842085,
            "target": "branch",
            "enforcement": "active",
            "bypass_actors": [],
            "current_user_can_bypass": "never",
            "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
            "rules": [
                {"type": "pull_request", "parameters": {}},
                {"type": "required_status_checks", "parameters": {"required_status_checks": [
                    {"context": "Validate pinned release", "integration_id": 15368},
                    {"context": "E2E browser (Chromium)", "integration_id": 15368},
                ]}},
            ],
        }

        def api(path: str):
            if path.endswith("/branches/main/protection"):
                return None
            if path.endswith("/rulesets"):
                return [{"id": 24842085, "target": "branch", "enforcement": "active"}]
            if path.endswith("/rulesets/24842085"):
                return ruleset
            raise AssertionError(path)

        with patch.object(updater, "api_json", side_effect=api):
            updater.verify_protection()

    def test_ruleset_protection_rejects_bypass_and_missing_checks(self) -> None:
        base = {
            "id": 1,
            "target": "branch",
            "enforcement": "active",
            "bypass_actors": [],
            "current_user_can_bypass": "never",
            "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
            "rules": [
                {"type": "pull_request", "parameters": {}},
                {"type": "required_status_checks", "parameters": {"required_status_checks": [
                    {"context": "Validate pinned release"},
                    {"context": "E2E browser (Chromium)"},
                ]}},
            ],
        }
        bypass = {**base, "bypass_actors": [{"actor_id": 1, "bypass_mode": "always"}]}
        missing = {**base, "rules": [base["rules"][0]]}

        def api_for(ruleset: dict):
            def api(path: str):
                if path.endswith("/branches/main/protection"):
                    return None
                if path.endswith("/rulesets"):
                    return [{"id": 1, "target": "branch", "enforcement": "active"}]
                if path.endswith("/rulesets/1"):
                    return ruleset
                raise AssertionError(path)
            return api

        for ruleset in (bypass, missing):
            with patch.object(updater, "api_json", side_effect=api_for(ruleset)):
                with self.assertRaises(ValueError):
                    updater.verify_protection()


if __name__ == "__main__":
    unittest.main()
