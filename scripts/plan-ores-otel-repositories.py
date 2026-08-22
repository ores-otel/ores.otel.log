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


def repository_head(repository: str, *, apply: bool) -> str:
    if not apply:
        return "0" * 40
    result = subprocess.run(
        ["gh", "api", f"repos/{repository}/commits/main", "--jq", ".sha"],
        check=True,
        text=True,
        capture_output=True,
    )
    sha = result.stdout.strip()
    if len(sha) != 40:
        raise RuntimeError(f"invalid main SHA for {repository}: {sha!r}")
    return sha


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


def native_steps(language: str) -> str:
    steps = {
        "nodejs": '''      - uses: actions/setup-node@v7
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: source/package-lock.json
      - run: npm ci
        working-directory: source
      - run: npm run typecheck
        working-directory: source
      - run: npm test
        working-directory: source
''',
        "browser": '''      - uses: actions/setup-node@v7
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: source/package-lock.json
      - run: npm ci
        working-directory: source
      - run: npm run build
        working-directory: source
      - run: npm install --no-save esbuild playwright ws wrangler@3
        working-directory: source
      - run: npx playwright install --with-deps chromium
        working-directory: source
      - name: Browser conformance
        run: node tests/conformance/run-browser.mjs
        working-directory: source
      - name: workerd conformance
        working-directory: source
        shell: bash
        run: |
          set -euo pipefail
          npx wrangler dev --config wrangler.conformance.toml --local --port 8787 >"${RUNNER_TEMP}/workerd.log" 2>&1 &
          worker_pid=$!
          trap 'kill "${worker_pid}" 2>/dev/null || true' EXIT
          for attempt in $(seq 1 60); do
            if curl --fail --silent --output /dev/null http://127.0.0.1:8787/; then
              break
            fi
            if ! kill -0 "${worker_pid}" 2>/dev/null; then
              cat "${RUNNER_TEMP}/workerd.log"
              exit 1
            fi
            sleep 2
          done
          body="$(curl --silent --show-error --write-out '\n%{http_code}' http://127.0.0.1:8787/)"
          status="$(printf '%s' "${body}" | tail -n1)"
          printf '%s\n' "${body}" | sed '$d'
          test "${status}" = "200"
''',
        "python": '''      - name: Python SDK tests
        working-directory: source/sdk/python
        env:
          PYTHONPATH: src
        run: python -m unittest discover -s tests -v
''',
        "go": '''      - uses: actions/setup-go@v7
        with:
          go-version: "1.24.x"
          cache-dependency-path: source/sdk/go/go.sum
      - name: Go race and context tests
        working-directory: source/sdk/go
        run: go test -race ./...
''',
        "rust": '''      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt,clippy
      - run: cargo fmt --manifest-path source/sdk/rust/Cargo.toml -- --check
      - run: cargo test --manifest-path source/sdk/rust/Cargo.toml --locked
      - run: cargo clippy --manifest-path source/sdk/rust/Cargo.toml --all-targets -- -D warnings
''',
        "java": '''      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: "21"
      - name: Java warnings-as-errors conformance
        working-directory: source/sdk/java
        run: bash test.sh
''',
        "dart": '''      - uses: dart-lang/setup-dart@v1
        with:
          sdk: stable
      - run: dart pub get
        working-directory: source/sdk/dart
      - run: dart analyze
        working-directory: source/sdk/dart
      - run: dart run test/conformance.dart
        working-directory: source/sdk/dart
''',
        "gleam": '''      - uses: erlef/setup-beam@v1
        with:
          otp-version: "28"
          gleam-version: "1.17.0"
      - run: gleam format --check src test
        working-directory: source/sdk/gleam
      - run: gleam test
        working-directory: source/sdk/gleam
''',
        "erlang": '''      - uses: erlef/setup-beam@v1
        with:
          otp-version: "28"
          rebar3-version: "3.27.0"
      - run: bash test.sh
        working-directory: source/sdk/erlang
''',
        "elixir": '''      - uses: erlef/setup-beam@v1
        with:
          otp-version: "28"
          elixir-version: "1.19.0"
      - run: bash test.sh
        working-directory: source/sdk/elixir
''',
        "ruby": '''      - uses: ruby/setup-ruby@v1
        with:
          ruby-version: "3.3"
      - run: ruby test/next_loggers_test.rb
        working-directory: source/sdk/ruby
''',
        "wasm": '''      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt
          targets: wasm32-unknown-unknown
      - run: bash test.sh
        working-directory: source/sdk/wasm
''',
    }
    if language not in steps:
        raise ValueError(f"unsupported test language: {language}")
    return steps[language]


def workflow_for(repository: dict[str, Any], canonical_sha: str, legacy_sha: str) -> str:
    language = repository["language"]
    native = native_steps(language)
    return f'''name: Native exact-head conformance

on:
  push:
    branches: [main]
  workflow_dispatch:
  repository_dispatch:
    types: [ores-otel-conformance]

permissions:
  contents: read

concurrency:
  group: native-conformance-${{{{ github.ref }}}}
  cancel-in-progress: true

jobs:
  native:
    name: {language} / ${{{{ matrix.role }}}}
    runs-on: ubuntu-latest
    timeout-minutes: 40
    strategy:
      fail-fast: false
      matrix:
        include:
          - repository: {CANONICAL}
            ref: {canonical_sha}
            role: canonical
          - repository: {LEGACY}
            ref: {legacy_sha}
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
      - name: Validate shared JSON Schema and SDK API manifests
        working-directory: source
        run: |
          python -m pip install --disable-pip-version-check jsonschema==4.26.0 referencing==0.37.0
          python scripts/validate-contracts.py
{native}      - name: Record exact source
        run: echo {shlex.quote(repository['name'])} {shlex.quote(language)} "${{{{ matrix.role }}}}" "${{{{ matrix.ref }}}}"
'''


def seed_test_repo(
    repository: dict[str, Any],
    canonical_sha: str,
    legacy_sha: str,
    *,
    apply: bool,
) -> None:
    full_name = f"{TEST_ORG}/{repository['name']}"
    metadata = dict(repository)
    metadata["status"] = "created"
    metadata["exactHeads"] = {"canonical": canonical_sha, "legacy": legacy_sha}
    metadata_text = json.dumps(metadata, indent=2, sort_keys=True) + "\n"
    readme = f"""# {repository['name']}\n\nNative exact-head conformance harness for **{repository['language']}**.\n\nThis repository compiles and tests both `{CANONICAL}` at `{canonical_sha}` and `{LEGACY}` at `{legacy_sha}`.\nThe declared native command is `{repository['testCommand']}`; the workflow also validates the shared JSON Schema and SDK API manifests before running the language toolchain.\n"""
    put_file(full_name, "README.md", readme, "Document native exact-head conformance", apply=apply)
    put_file(full_name, "conformance.json", metadata_text, "Lock canonical and legacy source heads", apply=apply)
    put_file(
        full_name,
        ".github/workflows/conformance.yml",
        workflow_for(repository, canonical_sha, legacy_sha),
        "Run native exact-head conformance",
        apply=apply,
    )


def mirror_history(*, apply: bool) -> None:
    """Mirror user-owned branch and tag refs, excluding GitHub's read-only refs/pull namespace."""
    refspecs = [
        "refs/heads/*:refs/heads/*",
        "refs/tags/*:refs/tags/*",
    ]
    if not apply:
        print(f"DRY-RUN: gh repo clone {LEGACY} <temporary>/legacy.git -- --mirror")
        print(f"DRY-RUN: git -C <temporary>/legacy.git remote add canonical https://github.com/{CANONICAL}.git")
        print(
            "DRY-RUN: git -C <temporary>/legacy.git push canonical "
            + " ".join(refspecs)
        )
        return
    with tempfile.TemporaryDirectory(prefix="ores-otel-mirror-") as directory:
        mirror = Path(directory) / "legacy.git"
        run(["gh", "repo", "clone", LEGACY, str(mirror), "--", "--mirror"], apply=True)
        run(["git", "-C", str(mirror), "remote", "add", "canonical", f"https://github.com/{CANONICAL}.git"], apply=True)
        run(
            ["git", "-C", str(mirror), "push", "canonical", *refspecs],
            apply=True,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Perform writes. Default is a dry-run.")
    parser.add_argument("--visibility", choices=("private", "public"), help="Required with --apply.")
    parser.add_argument("--mirror-history", action="store_true", help="Mirror all user-owned branch/tag refs after creating canonical repo.")
    parser.add_argument("--seed-tests", action="store_true", help="Seed native exact-head workflows in test repos.")
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
        print("history mirror skipped; pass --mirror-history to preserve branch and tag refs")

    canonical_sha = repository_head(CANONICAL, apply=args.apply)
    legacy_sha = repository_head(LEGACY, apply=args.apply)
    print(f"exact heads: canonical={canonical_sha}, legacy={legacy_sha}")

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
            seed_test_repo(
                repository,
                canonical_sha,
                legacy_sha,
                apply=args.apply,
            )

    print("No token argument is accepted. Authentication must come from a pre-authenticated gh CLI or GitHub App.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
