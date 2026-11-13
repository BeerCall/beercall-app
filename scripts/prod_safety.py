"""Fail-closed backup and rollback checks; never restore or mutate a database."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import socket
import stat
import subprocess
import tempfile
import uuid

FILES = ("db.dump", "uploads.tgz", "config.tgz", "metadata.json", "SHA256SUMS")


def private_file(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or (os.name != "nt" and (info.st_mode & 0o077 or info.st_uid != os.getuid())):
        raise ValueError("Fichier de configuration non privé ou symbolique")


def settings() -> dict:
    path = Path(os.environ.get("BEERCALL_BACKUP_CONFIG", str(Path.home() / ".config/beercall/backup.json")))
    data = {}
    if path.exists():
        private_file(path)
        data = json.loads(path.read_text())
    for variable, field in [("BEERCALL_BACKUP_REMOTE", "remote"), ("BEERCALL_BACKUP_DIR", "backup_dir")]:
        if variable in os.environ:
            data[field] = os.environ[variable]
    if data.get("protocol", "ssh-v1") not in {"ssh-v1", "restricted-v1"}:
        raise ValueError("Protocole backup inconnu")
    return data


def ssh_options() -> list[str]:
    args = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15"]
    config = settings().get("ssh_config")
    if config:
        private_file(Path(config))
        args += ["-F", config]
    return args


def receiver_command(destination: str, operation: str) -> str | None:
    config = settings()
    if config.get("protocol") != "restricted-v1":
        return None
    base = config["remote"].rstrip("/") + "/"
    if not destination.startswith(base):
        raise ValueError("Destination différente du récepteur approuvé")
    run = destination[len(base):]
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}", run):
        raise ValueError("Identifiant backup invalide")
    return f"bc-backup-{operation} {run}"


def remote_parts(destination: str) -> tuple[str, str]:
    match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*):(/[A-Za-z0-9_./-]+)", destination)
    if not match:
        raise ValueError("Destination attendue : utilisateur@hote-distant:/chemin/absolu")
    host, path = match.groups()
    hostname = host.split("@", 1)[1].lower()
    if hostname in {"localhost", "127.0.0.1", "0.0.0.0", socket.gethostname().lower(), socket.getfqdn().lower()} or hostname.startswith("127."):
        raise ValueError("La destination doit être un autre hôte")
    if ".." in path.split("/") or str(PurePosixPath(path)) == "/":
        raise ValueError("Chemin distant non autorisé")
    return host, path.rstrip("/")


def ssh(host: str, command: str) -> str:
    return subprocess.check_output([*ssh_options(), host, command], text=True)


def verify_remote(destination: str, expected: str) -> None:
    host, path = remote_parts(destination)
    # Paths have already been restricted to shell-safe characters.
    manifest = ssh(host, receiver_command(destination, "manifest") or f"cat -- '{path}/SHA256SUMS'")
    if hashlib.sha256(manifest.encode()).hexdigest() != expected:
        raise ValueError("Manifeste de sauvegarde distant différent du marqueur")
    entries = dict((name, digest) for digest, name in re.findall(r"^([0-9a-f]{64})  ([a-z.]+)$", manifest, re.M))
    if set(entries) != set(FILES[:-1]) or len(manifest.splitlines()) != len(FILES) - 1:
        raise ValueError("Manifeste de sauvegarde invalide")
    ssh(host, receiver_command(destination, "verify") or f"cd -- '{path}' && sha256sum --check --strict SHA256SUMS >/dev/null")


def validate_marker(path: Path, release: str, now: datetime | None = None) -> dict:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Marqueur non régulier")
    if os.name != "nt" and (info.st_mode & 0o077 or info.st_uid != os.getuid()):
        raise ValueError("Le marqueur doit appartenir à l'utilisateur et être privé (0600)")
    data = json.loads(path.read_text())
    if data.get("version") != 1 or data.get("release") != release or not re.fullmatch(r"[0-9a-f]{40}", release):
        raise ValueError("Sauvegarde non liée à la release actuelle")
    created = datetime.fromisoformat(data["created_at"])
    if created.tzinfo is None:
        raise ValueError("Date UTC obligatoire")
    age = ((now or datetime.now(timezone.utc)) - created).total_seconds()
    if not 0 <= age <= 24 * 3600:
        raise ValueError("Sauvegarde expirée ou datée dans le futur")
    if not re.fullmatch(r"[0-9a-f]{64}", data.get("manifest_sha256", "")):
        raise ValueError("Empreinte de sauvegarde absente")
    verify_remote(data["remote"], data["manifest_sha256"])
    return data


def backup(app: Path, root: Path, destination: str) -> None:
    host, base = remote_parts(destination)  # before any local archive or dump
    os.umask(0o077)
    app = app.resolve()
    if root.resolve().is_relative_to(app):
        raise ValueError("Les sauvegardes doivent être hors du checkout et des uploads")
    for source in (app / ".env", app / "secrets", app / "beercall-backend/uploads"):
        if source.is_symlink() or not source.exists():
            raise ValueError("Source de sauvegarde absente ou symbolique")
    created = datetime.now(timezone.utc).isoformat()
    release = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=app, text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no", "--ignore-submodules=untracked"], cwd=app, text=True).strip():
        raise ValueError("Checkout sale : sauvegarde de release refusée")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or (os.name != "nt" and root.stat().st_mode & 0o077):
        raise ValueError("Le répertoire des sauvegardes doit être privé (0700)")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12]
    remote = f"{host}:{base}/{stamp}"
    with tempfile.TemporaryDirectory(prefix=".tmp-", dir=root) as temporary:
        work = Path(temporary)
        with (work / "db.dump").open("wb") as dump:
            subprocess.run(["docker", "compose", "exec", "-T", "db_beercall", "sh", "-lc",
                            'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom'], cwd=app, stdout=dump, check=True)
        with (work / "db.dump").open("rb") as dump:
            subprocess.run(["docker", "compose", "exec", "-T", "db_beercall", "pg_restore", "--list"], cwd=app, stdin=dump, stdout=subprocess.DEVNULL, check=True)
        # --list checks only the TOC. Decode all data blocks as SQL as well,
        # without connecting/restoring to any database.
        with (work / "db.dump").open("rb") as dump:
            subprocess.run(["docker", "compose", "exec", "-T", "db_beercall", "pg_restore", "--file=/dev/null"], cwd=app, stdin=dump, stdout=subprocess.DEVNULL, check=True)
        for filename, sources in [("uploads.tgz", ["beercall-backend/uploads"]), ("config.tgz", [".env", ".gitmodules", "nginx", "secrets"])]:
            subprocess.run(["tar", "-C", str(app), "-czf", str(work / filename), *sources], check=True)
        (work / "metadata.json").write_text(json.dumps({"release": release, "gitlinks": subprocess.check_output(
            ["git", "submodule", "status"], cwd=app, text=True).strip()}) + "\n")
        manifest = ""
        for name in FILES[:-1]:
            file_hash = hashlib.sha256()
            with (work / name).open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    file_hash.update(chunk)
            manifest += f"{file_hash.hexdigest()}  {name}\n"
        (work / "SHA256SUMS").write_text(manifest, encoding="ascii")
        digest = hashlib.sha256(manifest.encode()).hexdigest()
        ssh(host, receiver_command(remote, "init") or f"umask 077; mkdir -p -- '{base}' && test ! -L '{base}' && test \"$(stat -c %a -- '{base}')\" = 700 && mkdir -m 700 -- '{base}/{stamp}'")
        subprocess.run(["rsync", "-a", "--chmod=D700,F600", "-e", shlex.join(ssh_options()), str(work) + "/", remote + "/"], check=True)
        verify_remote(remote, digest)
        data = {"version": 1, "release": release, "remote": remote,
                "created_at": created, "manifest_sha256": digest}
        # Atomic publication only after rsync and remote integrity verification.
        marker = work / "LATEST"
        marker.write_text(json.dumps(data) + "\n")
        marker.replace(root / "LATEST")
    print("Sauvegarde copiée et empreintes vérifiées ; restauration isolée encore à qualifier.")


def check_schema(backend: Path, target: str, current: str) -> None:
    files = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", target, "--", "alembic/versions"], cwd=backend, text=True).splitlines()
    revisions, parents = set(), set()
    for filename in files:
        if not filename.endswith(".py"):
            continue
        text = subprocess.check_output(["git", "show", f"{target}:{filename}"], cwd=backend, text=True)
        for field, values in [("revision", revisions), ("down_revision", parents)]:
            match = re.search(rf"^{field}(?:\s*:\s*[^=\n]+)?\s*=\s*['\"]([^'\"]+)['\"]", text, re.M)
            if match:
                values.add(match.group(1))
    if revisions - parents != {current}:
        raise ValueError("Rollback refusé : la cible ne déclare pas exactement le schéma courant ; préparer une release de récupération compatible")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["backup", "verify-backup", "preflight-backup", "check-schema"])
    parser.add_argument("arguments", nargs="*")
    args = parser.parse_args()
    if args.action in {"backup", "preflight-backup"}:
        config = settings()
        root = Path(config.get("backup_dir", str(Path.home() / "beercall_backups")))
        backup(Path(os.environ.get("BEERCALL_APP_DIR", str(Path.home() / "beercall-app"))),
               root, config["remote"])
        if args.action == "preflight-backup":
            validate_marker(root / "LATEST", args.arguments[0])
    elif args.action == "verify-backup":
        validate_marker(Path(args.arguments[0]), args.arguments[1])
    else:
        check_schema(Path(args.arguments[0]), args.arguments[1], args.arguments[2])
