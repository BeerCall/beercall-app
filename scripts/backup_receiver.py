#!/usr/bin/env python3
"""Forced SSH command: append-only backup receiver, no interactive shell.

Install root-owned outside the archive, with a dedicated unprivileged account.
The producer may upload new runs, verify them and read their checksum manifest;
it cannot download archives, overwrite sealed runs, delete files or run a shell.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

ROOT = Path("/var/lib/beercall-backup/archive")
RRSYNC = "/usr/local/libexec/beercall-rrsync"
FILES = {"db.dump", "uploads.tgz", "config.tgz", "metadata.json"}
RUN_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}")


def run_path(run: str) -> Path:
    if not RUN_RE.fullmatch(run):
        raise ValueError("Invalid run id")
    path = ROOT / run
    if ROOT.is_symlink() or path.is_symlink():
        raise ValueError("Symbolic backup path refused")
    return path


def dispatch(command: str) -> None:
    args = shlex.split(command)
    if len(args) == 2 and args[0] in {"bc-backup-init", "bc-backup-manifest", "bc-backup-verify"}:
        path = run_path(args[1])
        if args[0] == "bc-backup-init":
            path.mkdir(mode=0o700)  # never reuse an existing run
        elif args[0] == "bc-backup-manifest":
            manifest = path / "SHA256SUMS"
            if manifest.is_symlink() or not manifest.is_file():
                raise ValueError("Missing manifest")
            sys.stdout.write(manifest.read_text(encoding="ascii"))
        else:
            entries = list(path.iterdir())
            if {p.name for p in entries} - {".sealed"} != FILES | {"SHA256SUMS"}:
                raise ValueError("Unexpected backup contents")
            if any(p.is_symlink() or not p.is_file() for p in entries):
                raise ValueError("Only regular backup files allowed")
            manifest = (path / "SHA256SUMS").read_text(encoding="ascii")
            checks = re.findall(r"^([0-9a-f]{64})  ([a-z.]+)$", manifest, re.M)
            if len(checks) != len(FILES) or {name for _, name in checks} != FILES:
                raise ValueError("Invalid checksum manifest")
            for digest, name in checks:
                actual = hashlib.sha256()
                with (path / name).open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        actual.update(block)
                if actual.hexdigest() != digest:
                    raise ValueError("Backup integrity mismatch")
            if not (path / ".sealed").exists():
                (path / ".sealed").touch(mode=0o600, exist_ok=False)
        return
    if len(args) >= 5 and args[:2] == ["rsync", "--server"] and "--sender" not in args:
        # rrsync applies its own strict server-option allowlist. Never permit
        # paths outside one initialized, not-yet-sealed run.
        destination = args[-1].rstrip("/")
        prefix = ROOT.as_posix() + "/"
        if not destination.startswith(prefix):
            raise ValueError("Destination outside archive")
        run = destination[len(prefix):]
        path = run_path(run)
        if not path.is_dir() or (path / ".sealed").exists():
            raise ValueError("Run missing or sealed")
        args[-1] = "./"
        env = {**os.environ, "SSH_ORIGINAL_COMMAND": shlex.join(args)}
        subprocess.run([RRSYNC, "-wo", "-no-del", "-munge", "-no-lock", str(path)], env=env, check=True)
        return
    raise ValueError("Command not permitted")


if __name__ == "__main__":
    import fcntl

    os.umask(0o077)
    try:
        # Keep the lock through rsync itself: no concurrent upload may alter a
        # run between integrity verification and sealing.
        with (ROOT / ".receiver.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            dispatch(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Backup receiver refused request: {error}", file=sys.stderr)
        raise SystemExit(1)
