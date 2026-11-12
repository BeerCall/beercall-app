import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("receiver", Path(__file__).parents[1] / "backup_receiver.py")
receiver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receiver)
RUN = "20261111T210000Z-0123456789ab"


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        base = Path(os.environ["LOCALAPPDATA"]) / "Temp/opencode" if os.environ.get("LOCALAPPDATA") else Path(tempfile.gettempdir())
        self.temp = tempfile.TemporaryDirectory(prefix="backup-receiver-", dir=base)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        patcher = patch.object(receiver, "ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_rejects_shell_download_and_traversal(self):
        for command in ["id", "sh", "bc-backup-init ../x", "bc-backup-init x;id",
                        f"rsync --server --sender -log . {self.root.as_posix()}/{RUN}/"]:
            with self.assertRaises(ValueError):
                receiver.dispatch(command)

    def test_cannot_reuse_run(self):
        receiver.dispatch(f"bc-backup-init {RUN}")
        with self.assertRaises(FileExistsError):
            receiver.dispatch(f"bc-backup-init {RUN}")

    def test_verify_seals_then_refuses_more_uploads(self):
        receiver.dispatch(f"bc-backup-init {RUN}")
        folder = self.root / RUN
        manifest = ""
        for filename in sorted(receiver.FILES):
            (folder / filename).write_bytes(b"synthetic")
            manifest += hashlib.sha256(b"synthetic").hexdigest() + "  " + filename + "\n"
        (folder / "SHA256SUMS").write_text(manifest)
        receiver.dispatch(f"bc-backup-verify {RUN}")
        self.assertTrue((folder / ".sealed").is_file())
        receiver.dispatch(f"bc-backup-verify {RUN}")
        with self.assertRaises(ValueError):
            receiver.dispatch(f"rsync --server -logDtpre.iLsfxCIvu . {folder.as_posix()}/")

    def test_upload_confined_to_one_unsealed_run_without_delete(self):
        receiver.dispatch(f"bc-backup-init {RUN}")
        with patch.object(receiver.subprocess, "run") as command:
            receiver.dispatch(f"rsync --server -logDtpre.iLsfxCIvu . {self.root.as_posix()}/{RUN}/")
        self.assertEqual(command.call_args.args[0], [receiver.RRSYNC, "-wo", "-no-del", "-munge", "-no-lock", str(self.root / RUN)])

    def test_checksum_failure_does_not_seal(self):
        receiver.dispatch(f"bc-backup-init {RUN}")
        folder = self.root / RUN
        manifest = ""
        for filename in sorted(receiver.FILES):
            (folder / filename).write_bytes(b"broken")
            manifest += "0" * 64 + "  " + filename + "\n"
        (folder / "SHA256SUMS").write_text(manifest)
        with self.assertRaises(ValueError):
            receiver.dispatch(f"bc-backup-verify {RUN}")
        self.assertFalse((folder / ".sealed").exists())
