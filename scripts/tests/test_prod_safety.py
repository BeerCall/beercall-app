"""No Docker, live SSH, database or remote filesystem writes in these tests."""
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("prod_safety", Path(__file__).parents[1] / "prod_safety.py")
safety = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(safety)
SHA = "a" * 40
REMOTE = "backup@backup.example.invalid:/private/beercall/run"
NOW = datetime(2026, 11, 11, 20, tzinfo=timezone.utc)


class SafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        base = Path(os.environ["LOCALAPPDATA"]) / "Temp/opencode" if os.environ.get("LOCALAPPDATA") else Path(tempfile.gettempdir())
        self.temp = tempfile.TemporaryDirectory(prefix="beercall-safety-", dir=base)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.marker = self.root / "LATEST"
        self.data = {"version": 1, "release": SHA, "remote": REMOTE, "created_at": NOW.isoformat(), "manifest_sha256": "b" * 64}

    def marker_write(self, data: dict) -> None:
        self.marker.write_text(json.dumps(data))
        self.marker.chmod(0o600)

    def test_requires_real_ssh_destination_before_any_command(self) -> None:
        for destination in ["/local/path", "backup@localhost:/backup", "backup@127.0.0.1:/backup", "backup@host:/x/../y", "backup@host:/x;false", "-option@host:/backup"]:
            with patch.object(safety.subprocess, "check_output") as command:
                with self.assertRaises(ValueError):
                    safety.backup(self.root, self.root / "backups", destination)
                command.assert_not_called()

    def test_marker_checks_contents_not_mtime(self) -> None:
        for changes in [{"created_at": (NOW - timedelta(days=2)).isoformat()}, {"created_at": (NOW + timedelta(seconds=1)).isoformat()},
                        {"release": "c" * 40}, {"manifest_sha256": ""}, {"version": 0}]:
            self.marker_write({**self.data, **changes})
            os.utime(self.marker, None)  # touching an old or unrelated receipt cannot make it valid
            with patch.object(safety, "verify_remote") as remote:
                with self.assertRaises(ValueError):
                    safety.validate_marker(self.marker, SHA, NOW)
                remote.assert_not_called()

    def test_valid_marker_rechecks_remote_integrity(self) -> None:
        self.marker_write(self.data)
        with patch.object(safety, "verify_remote") as remote:
            self.assertEqual(safety.validate_marker(self.marker, SHA, NOW), self.data)
        remote.assert_called_once_with(REMOTE, "b" * 64)

    def test_remote_must_match_marker_and_all_files(self) -> None:
        manifest = "".join(f"{'a' * 64}  {name}\n" for name in safety.FILES[:-1])
        digest = hashlib.sha256(manifest.encode()).hexdigest()
        with patch.object(safety, "ssh", side_effect=[manifest, ""]) as ssh:
            safety.verify_remote(REMOTE, digest)
        self.assertIn("sha256sum --check --strict", ssh.call_args.args[1])
        with patch.object(safety, "ssh", return_value=manifest):
            with self.assertRaises(ValueError):
                safety.verify_remote(REMOTE, "0" * 64)
        incomplete = f"{'a' * 64}  db.dump\n"
        with patch.object(safety, "ssh", return_value=incomplete):
            with self.assertRaises(ValueError):
                safety.verify_remote(REMOTE, hashlib.sha256(incomplete.encode()).hexdigest())

    def test_restricted_receiver_protocol_cannot_use_another_destination(self) -> None:
        base = "beercall_backup@backup.example.invalid:/var/lib/beercall-backup/archive"
        run = "20261111T210000Z-0123456789ab"
        with patch.object(safety, "settings", return_value={"protocol": "restricted-v1", "remote": base}):
            self.assertEqual(safety.receiver_command(base + "/" + run, "init"), f"bc-backup-init {run}")
            self.assertEqual(safety.receiver_command(base + "/" + run, "verify"), f"bc-backup-verify {run}")
            for destination in [base + "/../escape", base + "/other", REMOTE]:
                with self.assertRaises(ValueError):
                    safety.receiver_command(destination, "init")

    def test_backup_configuration_requires_a_private_regular_file(self) -> None:
        path = self.root / "backup.json"
        path.write_text(json.dumps({"protocol": "restricted-v1", "remote": REMOTE}))
        path.chmod(0o600)
        with patch.dict(os.environ, {"BEERCALL_BACKUP_CONFIG": str(path)}):
            self.assertEqual(safety.settings()["protocol"], "restricted-v1")
            path.write_text(json.dumps({"protocol": "unknown"}))
            with self.assertRaises(ValueError):
                safety.settings()

    def test_remote_verification_failure_blocks_deployment(self) -> None:
        self.marker_write(self.data)
        with patch.object(safety, "verify_remote", side_effect=subprocess.CalledProcessError(1, "ssh")):
            with self.assertRaises(subprocess.CalledProcessError):
                safety.validate_marker(self.marker, SHA, NOW)

    def test_backup_failure_does_not_publish_new_marker(self) -> None:
        self.backup_case(fail_at="rsync")

    def test_broken_dump_payload_does_not_publish_marker(self) -> None:
        self.backup_case(fail_at="decode")

    def test_backup_success_is_atomic_and_checks_remote_copy(self) -> None:
        self.backup_case(fail_at=None)

    def backup_case(self, fail_at: str | None) -> None:
        app = self.root / "app"
        app.mkdir()
        (app / ".env").write_text("synthetic-only")
        (app / "secrets").mkdir()
        (app / "beercall-backend/uploads").mkdir(parents=True)
        backups = self.root / "backups"
        backups.mkdir(mode=0o700)
        marker = backups / "LATEST"
        marker.write_text("previous-marker")

        def command(args: list[str], **kwargs: object):
            if args[0] == "docker" and "sh" in args:
                kwargs["stdout"].write(b"synthetic-dump")
            if args[0] == "tar":
                Path(args[args.index("-czf") + 1]).write_bytes(b"synthetic-archive")
            if (args[0] == "rsync" and fail_at == "rsync") or ("--file=/dev/null" in args and fail_at == "decode"):
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0)

        with patch.object(safety.subprocess, "check_output", side_effect=[SHA, "", "module hashes"]), \
             patch.object(safety.subprocess, "run", side_effect=command), \
             patch.object(safety, "ssh", return_value="") as ssh, \
             patch.object(safety, "verify_remote") as verify:
            if fail_at:
                with self.assertRaises(subprocess.CalledProcessError):
                    safety.backup(app, backups, "backup@backup.example.invalid:/private/beercall")
                self.assertEqual(marker.read_text(), "previous-marker")
                verify.assert_not_called()
            else:
                safety.backup(app, backups, "backup@backup.example.invalid:/private/beercall")
                receipt = json.loads(marker.read_text())
                self.assertEqual(receipt["release"], SHA)
                self.assertIn("backup@backup.example.invalid:", receipt["remote"])
                verify.assert_called_once_with(receipt["remote"], receipt["manifest_sha256"])
                self.assertIn("mkdir", ssh.call_args.args[1])
        self.assertEqual([p.name for p in backups.iterdir()], ["LATEST"])

    def test_rollback_refuses_newer_database_before_mutation(self) -> None:
        old = "revision: str = 'old'\ndown_revision = None\n"
        with patch.object(safety.subprocess, "check_output", side_effect=["alembic/versions/old.py", old]):
            with self.assertRaises(ValueError):
                safety.check_schema(self.root, SHA, "new")
        with patch.object(safety.subprocess, "check_output", side_effect=["alembic/versions/old.py", old]):
            safety.check_schema(self.root, SHA, "old")


if __name__ == "__main__":
    unittest.main()
