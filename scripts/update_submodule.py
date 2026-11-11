"""Monotonic gitlink PR updates. Never execute code from the source module."""
import json
from fnmatch import fnmatchcase
import os
from pathlib import Path
import re
import subprocess


def run(*args: str, cwd: str | Path = ".") -> str:
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def git(*args: str, cwd: str | Path = ".") -> str:
    return run("git", *args, cwd=cwd)


def validate(module: str, sha: str, ref: str) -> None:
    if module not in {"beercall-frontend", "beercall-backend"}:
        raise ValueError("Sous-module non autorisé")
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or ref != "main":
        raise ValueError("SHA invalide ou référence différente de main")


def ancestor(module: str, older: str, newer: str) -> bool:
    result = subprocess.run(["git", "merge-base", "--is-ancestor", older, newer], cwd=module)
    if result.returncode not in (0, 1):
        raise RuntimeError("Historique source incomplet ou SHA inconnu")
    return result.returncode == 0


def pin(ref: str, module: str) -> str:
    entry = git("ls-tree", ref, "--", module).split()
    if len(entry) != 4 or entry[:2] != ["160000", "commit"]:
        raise ValueError("Gitlink attendu")
    return entry[2]


def prepare(module: str, target: str, source_ref: str) -> tuple[str, str] | None:
    validate(module, target, source_ref)
    # Re-fetch main instead of trusting repository_dispatch's event-time checkout.
    git("fetch", "origin", "+refs/heads/main:refs/remotes/origin/main")
    git("-C", module, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main")
    if not ancestor(module, target, "origin/main"):
        raise ValueError("Le SHA reçu n'appartient pas à main")
    current = pin("origin/main", module)
    if ancestor(module, target, current):
        print("Dispatch déjà appliqué ou dépassé ; aucune modification.")
        return None
    if not ancestor(module, current, target):
        raise ValueError("Historique divergent : intervention manuelle nécessaire")

    branch = f"chore/submodule-{module}"
    remote = git("ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    expected = remote.split()[0] if remote else ""
    if expected:
        git("fetch", "origin", f"refs/heads/{branch}")
        if git("diff", "--name-only", "origin/main...FETCH_HEAD").splitlines() != [module]:
            raise ValueError("La branche distante doit modifier uniquement le gitlink demandé")
        pending = pin("FETCH_HEAD", module)
        if pending != target:
            if ancestor(module, target, pending):
                print("Une PR propose déjà un SHA plus récent ; dispatch ignoré.")
                return None
            if not ancestor(module, pending, target):
                raise ValueError("Historique de la PR divergent")
        else:
            # Resume after a push succeeded but PR creation/auto-merge failed.
            return branch, expected

    git("switch", "-C", branch, "origin/main")
    git("config", "user.name", "beercall-ci")
    git("config", "user.email", "ci@beercall.fr")
    git("update-index", "--cacheinfo", f"160000,{target},{module}")
    changed = git("diff", "--cached", "--name-only").splitlines()
    if changed != [module]:
        raise ValueError("La PR doit modifier uniquement le gitlink demandé")
    git("commit", "-m", f"chore(submodules): {module} vers {target[:7]}")
    head = git("rev-parse", "HEAD")
    # Reusable module branch: old PRs cannot later merge an older SHA.
    # Exact lease also refuses any concurrent remote edit, even by a human.
    git("push", f"--force-with-lease=refs/heads/{branch}:{expected}", "origin", f"HEAD:refs/heads/{branch}")
    return branch, head


def open_pr(module: str, target: str, branch: str, head: str) -> None:
    prs = json.loads(run("gh", "pr", "list", "--head", branch, "--base", "main", "--state", "open", "--json", "number"))
    if not prs:
        run("gh", "pr", "create", "--base", "main", "--head", branch,
            "--title", f"chore(submodules): {module}",
            "--body", f"Mise à jour de `{module}` vers `{target}`, commit vérifié sur `main`.\n"
            "Les checks obligatoires du parent doivent réussir avant fusion.")
        prs = json.loads(run("gh", "pr", "list", "--head", branch, "--base", "main", "--state", "open", "--json", "number"))
    if len(prs) != 1:
        raise RuntimeError("PR unique introuvable")
    run("gh", "pr", "merge", str(prs[0]["number"]), "--auto", "--squash", "--delete-branch", "--match-head-commit", head)


def verify_protection() -> None:
    """Fail closed on either classic protection or an effective branch ruleset."""
    protection = api_json("repos/BeerCall/beercall-app/branches/main/protection")
    if protection is not None:
        _verify_classic(protection)
        return
    if _verify_rulesets():
        return
    raise ValueError("Aucune protection de branche effective ne protège main")


def api_json(path: str):
    result = subprocess.run(
        ["gh", "api", path],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return json.loads(result.stdout)
    if "404" in result.stderr or "Branch not protected" in result.stderr:
        return None
    raise RuntimeError(f"API GitHub indisponible pour {path}: {result.stderr.strip()}")


def _verify_classic(protection: dict) -> None:
    checks = protection.get("required_status_checks") or {}
    contexts = set(checks.get("contexts") or [])
    contexts.update(check["context"] for check in checks.get("checks", []))
    if not {"Validate pinned release", "E2E browser (Chromium)"} <= contexts:
        raise ValueError("Les deux checks obligatoires doivent protéger main")
    if not protection.get("enforce_admins", {}).get("enabled"):
        raise ValueError("La protection doit aussi s'appliquer au token administrateur")
    if protection.get("required_pull_request_reviews") is None:
        raise ValueError("main doit exiger le passage par PR")


def _verify_rulesets() -> bool:
    rulesets = api_json("repos/BeerCall/beercall-app/rulesets") or []
    applicable = []
    for summary in rulesets:
        if summary.get("target") != "branch" or summary.get("enforcement") != "active":
            continue
        ruleset = api_json(f"repos/BeerCall/beercall-app/rulesets/{summary['id']}")
        if not ruleset or ruleset.get("enforcement") != "active":
            continue
        ref_name = (ruleset.get("conditions") or {}).get("ref_name") or {}
        include = set(ref_name.get("include") or [])
        exclude = set(ref_name.get("exclude") or [])
        def matches(pattern: str) -> bool:
            return pattern in {"~DEFAULT_BRANCH", "~ALL"} or fnmatchcase("refs/heads/main", pattern)

        if any(matches(pattern) for pattern in exclude):
            continue
        if not any(matches(pattern) for pattern in include):
            continue
        applicable.append(ruleset)

    if not applicable:
        return False

    has_pull_request = False
    contexts: set[str] = set()
    admin_can_bypass = False
    for ruleset in applicable:
        if ruleset.get("bypass_actors"):
            admin_can_bypass = True
        if ruleset.get("current_user_can_bypass", "always") != "never":
            admin_can_bypass = True
        for rule in ruleset.get("rules") or []:
            if rule.get("type") == "pull_request":
                has_pull_request = True
            if rule.get("type") == "required_status_checks":
                parameters = rule.get("parameters") or {}
                contexts.update(
                    check["context"]
                    for check in parameters.get("required_status_checks", [])
                )

    if not has_pull_request:
        raise ValueError("main doit exiger le passage par PR")
    if not {"Validate pinned release", "E2E browser (Chromium)"} <= contexts:
        raise ValueError("Les deux checks obligatoires doivent protéger main")
    if admin_can_bypass:
        raise ValueError("La protection doit aussi s'appliquer au token administrateur")
    return True


if __name__ == "__main__":
    module, target, ref = (os.environ[key] for key in ("SUBMODULE", "TARGET_SHA", "SOURCE_REF"))
    validate(module, target, ref)
    verify_protection()
    result = prepare(module, target, ref)
    if result:
        open_pr(module, target, *result)
