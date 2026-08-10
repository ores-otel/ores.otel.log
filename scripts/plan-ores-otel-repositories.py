#!/usr/bin/env python3
"""Plan or apply the ores-otel repository migration using a pre-authenticated gh CLI."""
from __future__ import annotations

import argparse
import base64
import json
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MATRIX_PATH = ROOT / "contracts" / "migration" / "test-repository-matrix.json"
CANONICAL = "ores-otel/ores.otel.log"
LEGACY = "ORESoftware/next-loggers.ts"
TEST_ORG = "ores-otel-test"


def load_matrix() -> dict[str, Any]:
    return json.loads(MATRIX_PATH.read_text(encoding="utf-8"))


def display(command: list[str]) -> str:
    return " ".join(shlex.quote(value) for value in command)


def run(command: list[str], *, apply: bool, check: bool = True) -> subprocess.CompletedProcess[str] | None:
    print(("+ " if apply else "DRY-RUN: ") + display(command))
    if not apply:
        return None
    return subprocess.run(command, check=check, text=True, capture_output=not check)


def repo_exists(repository: str, *, apply: bool) -> bool:
    if not apply:
        return False
    result = subprocess.run(
        ["gh", "repo", "view", repository, "--json", "nameWithOwner"],
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def ensure_repo(repository: str, description: str, visibility: str, *, apply: bool, add_readme: bool = False) -> None:
    if repo_exists(repository, apply=apply):
        print(f"exists: {repository}")
        return
    command = [
        "gh", "repo", "create", repository,
        f"--{visibility}",
        "--description", description,
        "--disable-wiki",
    ]
    if add_readme:
        command.append("--add-readme")
    run(command, apply=apply)


def existing_file_sha(repository: str, path: str, *, apply: bool) -> str | None:
    if not apply:
        return None
    result = subprocess.run(
        ["gh", "api", f"repos/{repository}/contents/{path}", "--jq", ".sha"],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        return None
    sha = result.stdout.strip()
    return sha or None


def put_file(repository: str, path: str, content: str, message: str, *, apply: bool) -> None:
    encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
    command = [
        "gh", "api", "--method", "PUT",
        f"repos/{repository}/contents/{path}",
        "-f", f"message={message}",
        "-f", f"content={encoded}",
    ]
    sha = existing_file_sha(repository, path, apply=apply)
    if sha:
        command.extend(["-f", f"sha={sha}"])
    run(command, apply=apply)


def workflow_for(repository: dict[str, Any]) -> str:
    language = repository["language"]
    return f'''name: Exact-head contract conformance

on:
  workflow_dispatch:
    inputs:
      canonical_sha:
        description: Exact commit SHA in ores-otel/ores.otel.log
        required: true
        type: string
      legacy_sha:
        description: Exact commit SHA in ORESoftware/next-loggers.ts
        required: true
        type: string
  repository_dispatch:
    types: [ores-otel-conformance]

permissions:
  contents: read

jobs:
  contracts:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        include:
          - repository: ores-otel/ores.otel.log
            ref: ${{{{ inputs.canonical_sha || github.event.client_payload.canonical_sha }}}}
            role: canonical
          - repository: ORESoftware/next-loggers.ts
            ref: ${{{{ inputs.legacy_sha || github.event.client_payload.legacy_sha }}}}
            role: legacy
    steps:
      - uses: actions/checkout@v7
        with:
          repository: ${{{{ matrix.repository }}}}
          ref: ${{{{ matrix.ref }}}}
          path: source
          persist-credentials: false
      - uses: actions/setup-python@v7
        with:
          python-version: "3.13"
          cache: pip
          cache-dependency-path: source/.github/workflows/contracts.yml
      - run: python -m pip install --disable-pip-version-check jsonschema==4.26.0 referencing==0.37.0
      - run: python scripts/validate-contracts.py
        working-directory: source
      - name: Record tested source
        run: echo {shlex.quote(repository['name'])} {shlex.quote(language)} "${{{{ matrix.role }}}}" "${{{{ matrix.ref }}}}"
'''


def seed_test_repo(repository: dict[str, Any], *, apply: bool) -> None:
    full_name = f"{TEST_ORG}/{repository['name']}"
    metadata = json.dumps(repository, indent=2, sort_keys=True) + "\n"
    readme = f"""# {repository['name']}\n\nExact-head conformance harness for **{repository['language']}**.\n\nThis repository tests both `{CANONICAL}` and `{LEGACY}` using explicit commit SHAs.\nThe required native command is recorded in `conformance.json`: `{repository['testCommand']}`.\n"""
    put_file(full_name, "README.md", readme, "Document conformance repository", apply=apply)
    put_file(full_name, "conformance.json", metadata, "Add conformance metadata", apply=apply)
    put_file(full_name, ".github/workflows/conformance.yml", workflow_for(repository), "Add exact-head contract workflow", apply=apply)


def mirror_history(*, apply: bool) -> None:
    if not apply:
        print(f"DRY-RUN: gh repo clone {LEGACY} <temporary>/legacy.git -- --mirror")
        print(f"DRY-RUN: git -C <temporary>/legacy.git remote add canonical https://github.com/{CANONICAL}.git")
        print("DRY-RUN: remove provider-owned and temporary relay refs")
        print("DRY-RUN: git -C <temporary>/legacy.git push --mirror canonical")
        return
    with tempfile.TemporaryDirectory(prefix="ores-otel-mirror-") as directory:
        mirror = Path(directory) / "legacy.git"
        run(["gh", "repo", "clone", LEGACY, str(mirror), "--", "--mirror"], apply=True)
        refs = subprocess.run(
            [
                "git", "-C", str(mirror), "for-each-ref", "--format=%(refname)",
                "refs/pull", "refs/remotes", "refs/merge-requests",
                "refs/heads/agent/pat-publication-relay-",
            ],
            check=True,
            text=True,
            capture_output=True,
        ).stdout.splitlines()
        for ref in refs:
            if ref:
                run(["git", "-C", str(mirror), "update-ref", "-d", ref], apply=True)
        run(["git", "-C", str(mirror), "remote", "add", "canonical", f"https://github.com/{CANONICAL}.git"], apply=True)
        run(["git", "-C", str(mirror), "push", "--mirror", "canonical"], apply=True)
        run(
            [
                "gh", "api", "--method", "PATCH", f"repos/{CANONICAL}",
                "-f", "default_branch=main", "-F", "has_wiki=false",
            ],
            apply=True,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Perform writes. Default is a dry-run.")
    parser.add_argument("--visibility", choices=("private", "public"), help="Required with --apply.")
    parser.add_argument("--mirror-history", action="store_true", help="Mirror all Git refs after creating canonical repo.")
    parser.add_argument("--seed-tests", action="store_true", help="Seed exact-head contract workflows in test repos.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.apply and not args.visibility:
        print("--visibility is required with --apply", file=sys.stderr)
        return 2
    if args.apply:
        if shutil.which("gh") is None:
            print("gh is required", file=sys.stderr)
            return 2
        subprocess.run(["gh", "auth", "status"], check=True)

    visibility = args.visibility or "private"
    matrix = load_matrix()
    repositories = matrix["repositories"]
    languages = {repository["language"] for repository in repositories}
    print(f"plan: canonical={CANONICAL}, test repositories={len(repositories)}, languages={len(languages)}")

    ensure_repo(
        CANONICAL,
        "Canonical polyglot structured logging, OpenTelemetry, Loki, Prometheus, Grafana, and Supabase contracts",
        visibility,
        apply=args.apply,
        add_readme=False,
    )
    if args.mirror_history:
        mirror_history(apply=args.apply)
    else:
        print("history mirror skipped; pass --mirror-history to preserve all refs")

    for repository in repositories:
        full_name = f"{TEST_ORG}/{repository['name']}"
        ensure_repo(
            full_name,
            f"{repository['language']} conformance for canonical and legacy ores.otel.log sources",
            visibility,
            apply=args.apply,
            add_readme=not args.seed_tests,
        )
        if args.seed_tests:
            seed_test_repo(repository, apply=args.apply)

    print("No token argument is accepted. Authentication must come from a pre-authenticated gh CLI or GitHub App.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
