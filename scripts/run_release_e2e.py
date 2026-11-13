"""Run the current 39 browser scenarios on a disposable, instrumented release.

Never uses production credentials, bind-mounted uploads or the personal demo DB.
Coverage scopes are those of the existing frontend report scripts, unchanged.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
# Current release recipe: the fluidite suite without the world-probe measurements.
RELEASE_SCENARIOS = 39
EXCLUDED_SPECS = {"world-probe.spec.ts"}


def command(args, **kwargs):
    print("+", " ".join(map(str, args)), flush=True)
    return subprocess.run(list(map(str, args)), check=True, **kwargs)


def playwright_cli(frontend):
    """Use the pinned local Playwright; never let npx download another version."""
    cli = frontend / "node_modules" / "@playwright" / "test" / "cli.js"
    if not cli.is_file():
        raise ValueError("Dépendances E2E absentes : exécute `npm ci` dans beercall-frontend")
    return ["node", str(cli)]


def playwright_test(frontend, *args):
    return [*playwright_cli(frontend), "test", "--config", "playwright.fluidite.config.ts", *args]


def gate(front, back):
    # Compare raw fractions, not rounded percentages. No changed exclusions.
    for name, covered, total in [("frontend", front["total"]["lines"]["covered"], front["total"]["lines"]["total"]),
                                  ("backend", back["covered"], back["total"])]:
        if total <= 0 or covered * 100 < 75 * total:
            raise ValueError(f"E2E coverage {name} below 75%: {covered}/{total}")
        print(f"E2E COVERAGE {name}: {100 * covered / total:.2f}% ({covered}/{total})", flush=True)


def remap_front(raw, frontend):
    for filename in raw.glob("*.json"):
        data = json.loads(filename.read_text(encoding="utf-8"))
        mapped = {}
        for name, entry in data.items():
            if name.startswith("/app/src/"):
                name = (frontend / "src" / name.removeprefix("/app/src/")).as_posix()
                entry["path"] = name
            mapped[name] = entry
        filename.write_text(json.dumps(mapped), encoding="utf-8")


def release_specs(frontend):
    specs = sorted((frontend / "tests" / "fluidite").glob("*.spec.ts"))
    selected = [spec for spec in specs if spec.name not in EXCLUDED_SPECS]
    if not selected:
        raise ValueError("Aucun scénario de release trouvé dans tests/fluidite")
    return selected


def lock_recipe(frontend, specs, env):
    """Fail before running if the recipe no longer contains exactly 39 scenarios."""
    args = [spec.relative_to(frontend).as_posix() for spec in specs]
    listed = subprocess.check_output(
        playwright_test(frontend, "--list", *args),
        cwd=frontend, env=env, text=True,
    )
    match = re.search(r"Total: (\d+) tests? in (\d+) files?", listed)
    if not match:
        raise ValueError("Playwright --list n'a pas produit de total exploitable")
    tests, files = int(match.group(1)), int(match.group(2))
    if tests != RELEASE_SCENARIOS:
        raise ValueError(f"Recette de release modifiée : {tests} scénarios dans {files} fichiers, attendu {RELEASE_SCENARIOS}")
    print(f"RELEASE RECIPE LOCKED: {tests} scénarios dans {files} fichiers", flush=True)


def verify_results(report):
    """A listed test is not necessarily executed: skips/expected failures are red."""
    data = json.loads(report.read_text(encoding="utf-8"))
    tests = []

    def visit(suite):
        for spec in suite.get("specs", []):
            tests.extend(spec.get("tests", []))
        for child in suite.get("suites", []):
            visit(child)

    visit(data)
    if data.get("errors") or len(tests) != RELEASE_SCENARIOS:
        raise ValueError("Rapport E2E incomplet ou erreurs globales Playwright")
    for test in tests:
        results = test.get("results", [])
        if (test.get("expectedStatus") != "passed" or test.get("status") != "expected"
                or len(results) != 1 or results[0].get("status") != "passed"):
            raise ValueError("Les 39 scénarios doivent réussir sans skip, échec attendu ni retry")
    print(f"RELEASE RESULTS VERIFIED: {len(tests)} scénarios réussis", flush=True)


def run_recipe_and_reports(frontend, specs, env, compose, out):
    """Collect partial coverage even on a red recipe, without masking its error."""
    recipe_error = None
    try:
        command(playwright_test(frontend, *[spec.relative_to(frontend).as_posix() for spec in specs]),
                cwd=frontend, env=env)
        verify_results(out / "playwright/report.json")
    except Exception as error:
        recipe_error = error
    try:
        command([*compose, "stop", "backend", "beer_worker", "daily_worker", "avatar-sprite-worker"], env=env)
        # A fresh one-shot container combines only the API/worker data files.
        command([*compose, "run", "--rm", "--no-deps", "backend", "python", "-m", "coverage", "combine"], env=env)
        command([*compose, "run", "--rm", "--no-deps", "backend", "python", "-m", "coverage", "json", "-o", "/coverage/coverage.json"], env=env)
        remap_front(out / "front-raw", frontend)
        command(["node", frontend / "scripts/fluidite/coverage-report.mjs", out / "front-raw", frontend / "src", out / "front-report"], env=env)
        command(["node", frontend / "scripts/fluidite/backend-coverage-report.mjs", out / "backend-raw/coverage.json", out / "backend-report.json"], env=env)
        gate(json.loads((out / "front-report/coverage-summary.json").read_text()), json.loads((out / "backend-report.json").read_text()))
    except Exception as error:
        if recipe_error is None:
            raise
        print(f"Rapports partiels indisponibles : {error}", file=sys.stderr)
    if recipe_error is not None:
        raise recipe_error


def cleanup(compose, env, out, config, failed):
    """Try every cleanup step; retain the original failure and always remove keys."""
    errors = []
    try:
        try:
            with (out / "compose.log").open("w", encoding="utf-8") as log:
                command([*compose, "logs", "--no-color", "--tail", "150"], env=env, stdout=log, stderr=subprocess.STDOUT)
        except Exception as error:
            errors.append(error)
        try:
            command([*compose, "down", "-v", "--remove-orphans"], env=env)
        except Exception as error:
            errors.append(error)
    finally:
        config.unlink(missing_ok=True)
    for error in errors:
        print(f"Nettoyage E2E incomplet : {error}", file=sys.stderr)
    if errors and not failed:
        raise errors[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--port", type=int, default=5181)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise ValueError("An unprivileged loopback port is required")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", args.port))
    out = args.output.resolve()
    if out.exists():
        raise ValueError("Output must be new: stale coverage must never be reused")
    out.mkdir(parents=True)
    for name in ["backend-raw", "front-raw", "sw-build", "playwright"]:
        (out / name).mkdir(mode=0o777)
        (out / name).chmod(0o777)
    frontend = ROOT / "beercall-frontend"
    backend = ROOT / "beercall-backend"
    project = "beercall-release-e2e-" + secrets.token_hex(5)
    config = out / "compose.json"
    env = dict(os.environ)
    env["FLUIDITE_TEST_SECRET"] = secrets.token_hex(32)
    # Resolve the already versioned local-test topology, then confine every
    # source, image, volume and port to this new release-test project.
    base = json.loads(subprocess.check_output(["docker", "compose", "-f", str(ROOT / "docker-compose.fluidite-test.yml"),
                                               "config", "--format", "json"], env=env, text=True))
    base["name"] = project
    for volume in base.get("volumes", {}).values():
        volume.pop("name", None)
    for network in base.get("networks", {}).values():
        network.pop("name", None)
    services = base["services"]
    # `dockerfile_inline` is passed through Compose interpolation again: escape
    # every dollar so `${PYTHON_IMAGE}`/`${NODE_IMAGE}` stay Dockerfile ARGs.
    backend_dockerfile = ((backend / "Dockerfile").read_text() + "\nRUN pip install --no-cache-dir coverage==7.17.2\n").replace("$", "$$")
    frontend_dockerfile = (frontend / "Dockerfile").read_text().replace("WORKDIR /app", "WORKDIR /app\nENV VITE_E2E_COVERAGE=1", 1).replace("$", "$$")
    coverage_mount = {"type": "bind", "source": str(out / "backend-raw"), "target": "/coverage"}
    rc_mount = {"type": "bind", "source": str(ROOT / "scripts/ci/e2e.coveragerc"), "target": "/e2e.coveragerc", "read_only": True}
    for name, service in services.items():
        service.pop("container_name", None)
        service["restart"] = "no"
        service["labels"] = {"beercall.test": "release-e2e"}
        if name in {"migrate", "backend", "beer_worker", "daily_worker", "avatar-sprite-worker"}:
            service["image"] = project + "-backend"
        if "build" in service:
            build = service["build"]
            build.pop("dockerfile", None)
            if name == "migrate":
                build.update(context=str(backend), dockerfile_inline=backend_dockerfile)
            elif name == "frontend":
                build.update(context=str(frontend), dockerfile_inline=frontend_dockerfile)
                # The Dockerfile re-exports these ARGs through ENV: an injected
                # ENV would be overwritten by the empty build ARG defaults.
                build.setdefault("args", {}).update({"VITE_WORLD_PROBE": "1"})
                service["image"] = project + "-frontend"
            elif name == "avatar-renderer":
                build.update(context=str(frontend), dockerfile="tools/avatar-renderer/Dockerfile")
                service["image"] = project + "-renderer"
        if name == "avatar-renderer":
            service["volumes"] = [
                {"type": "bind", "source": str(backend / "static/models"), "target": "/models", "read_only": True},
                {"type": "bind", "source": str(frontend / "public/animations"), "target": "/animations", "read_only": True}]
        if name == "nginx_beercall":
            service["ports"] = [{"target": 80, "published": str(args.port), "host_ip": "127.0.0.1", "protocol": "tcp"}]
        if name in {"backend", "beer_worker", "daily_worker", "avatar-sprite-worker"}:
            service.setdefault("volumes", []).extend([coverage_mount, rc_mount])
            service.setdefault("environment", {})["COVERAGE_RCFILE"] = "/e2e.coveragerc"
            module = {"backend": "uvicorn", "beer_worker": "workers.beer_call_worker", "daily_worker": "workers.daily_checks", "avatar-sprite-worker": "workers.avatar_sprite_worker"}[name]
            service["command"] = ["python", "-m", "coverage", "run", "-m", module] + (["main:app", "--host", "0.0.0.0", "--port", "8000"] if name == "backend" else [])
            service["stop_grace_period"] = "30s"
    config.write_text(json.dumps(base), encoding="utf-8")
    config.chmod(0o600)
    compose = ["docker", "compose", "-p", project, "-f", str(config)]
    started = False
    try:
        started = True
        command([*compose, "build", "migrate", "frontend", "avatar-renderer"], env=env)
        # Initialise le volume uploads depuis l'image avant le demarrage
        # concurrent des services qui le montent (course Docker mkdir/aperos).
        command([*compose, "run", "--rm", "--no-deps", "-T", "backend",
                 "python", "-c", "print('uploads volume ready')"], env=env)
        command([*compose, "up", "-d", "--wait", "--wait-timeout", "240"], env=env)
        cid = subprocess.check_output([*compose, "ps", "-q", "backend"], env=env, text=True).strip()
        command([*compose, "exec", "-T", "backend", "python", "scripts/seed_fluidite_demo.py"], env=env)
        command([*compose, "exec", "-T", "backend", "python", "-c",
                 "from db.database import SessionLocal; from models.user import User; d=SessionLocal(); d.query(User).filter(User.id==1).update({'capsules':3750}); d.commit(); d.close()"], env=env)
        front_cid = subprocess.check_output([*compose, "ps", "-q", "frontend"], env=env, text=True).strip()
        command(["docker", "cp", front_cid + ":/usr/share/nginx/html/.", out / "sw-build"])
        env.update(FLUIDITE_BASE_URL=f"http://127.0.0.1:{args.port}", FLUIDITE_BACKEND_CONTAINER=cid,
                   FLUIDITE_RUN_DIR=str(out / "playwright"), FLUIDITE_COVERAGE_DIR=str(out / "front-raw"),
                   FLUIDITE_SW_BUILD_DIR=str(out / "sw-build"))
        # Tests write their existing screenshots here; never the shared checkout.
        (frontend.parent / ".openchamber/screenshots").mkdir(parents=True, exist_ok=True)
        specs = release_specs(frontend)
        lock_recipe(frontend, specs, env)
        run_recipe_and_reports(frontend, specs, env, compose, out)
    finally:
        if started:
            cleanup(compose, env, out, config, failed=sys.exc_info()[0] is not None)
        else:
            config.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
