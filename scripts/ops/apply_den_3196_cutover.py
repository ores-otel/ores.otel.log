#!/usr/bin/env python3
"""Apply the bounded DEN-3196 canonical repository cutover.

This one-run helper is deleted by the publication commit. It changes only the
reviewed Go-module, release, CLI/Zed, validator, and migration-evidence files.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEGACY_GO_MODULE = "github.com/ORESoftware/next-loggers.ts/sdk/go"
CANONICAL_GO_MODULE = "github.com/ores-otel/ores.otel.log/sdk/go"

MODULE_PATH_FILES = (
    "sdk/go/go.mod",
    "sdk/go/README.md",
    "sdk/go/.zpkg-smoke.sh",
    ".zpkg.toml",
    "docs/CLI.md",
    "docs/RELEASING.md",
    "src/cli/package-catalog.ts",
    "tests/zpkg.test.mjs",
    ".github/workflows/release-native.yml",
)


def replace_required(path: Path, old: str, new: str) -> int:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count == 0:
        raise SystemExit(f"expected reviewed text in {path.relative_to(ROOT)}: {old!r}")
    path.write_text(text.replace(old, new), encoding="utf-8")
    return count


def update_module_metadata() -> None:
    for relative in MODULE_PATH_FILES:
        path = ROOT / relative
        count = replace_required(path, LEGACY_GO_MODULE, CANONICAL_GO_MODULE)
        print(f"updated {relative}: {count} Go-module reference(s)")


def update_release_contract() -> None:
    path = ROOT / ".github/workflows/release-native.yml"
    replace_required(
        path,
        "      - run: dart run test/conformance.dart\n        working-directory: sdk/dart",
        "      - run: dart test\n        working-directory: sdk/dart",
    )


def update_migration_evidence() -> None:
    path = ROOT / "MIGRATION.md"
    replace_required(
        path,
        "The new repository was initialized from the complete legacy Git history, including branches and tags.",
        (
            "The new repository was initialized from the complete legacy Git history and every branch "
            "present at cutover. Direct verification found no tags or releases in either repository, "
            "so none were omitted from the migration."
        ),
    )


def update_contract_validator() -> None:
    path = ROOT / "scripts/validate-contracts.py"
    text = path.read_text(encoding="utf-8")
    marker = "\ndef validate_migration(registry: Registry[Any], manifests: list[dict[str, Any]]) -> int:\n"
    function = "\n".join(
        [
            "",
            "def validate_repository_identity(manifests: list[dict[str, Any]]) -> None:",
            "    \"\"\"Keep canonical and legacy Go module identities explicit during migration.\"\"\"",
            "    go_manifest = next((manifest for manifest in manifests if manifest[\"language\"] == \"go\"), None)",
            "    if go_manifest is None:",
            "        raise Failure(\"Go SDK manifest is missing\")",
            "    repository_context = (",
            "        os.environ.get(\"ORES_OTEL_SOURCE_REPOSITORY\")",
            "        or os.environ.get(\"EXPECTED_REPOSITORY\")",
            "        or os.environ.get(\"GITHUB_REPOSITORY\")",
            "        or CANONICAL",
            "    )",
            "    package_names = go_manifest[\"package\"]",
            "    expected = (",
            "        package_names[\"legacyName\"]",
            "        if repository_context == LEGACY",
            "        else package_names[\"canonicalName\"]",
            "    )",
            "    go_mod = ROOT / \"sdk\" / \"go\" / \"go.mod\"",
            "    first_line = go_mod.read_text(encoding=\"utf-8\").splitlines()[0]",
            "    if first_line != f\"module {expected}\":",
            "        raise Failure(",
            "            \"Go module identity does not match the source repository context: \"",
            "            f\"repository={repository_context!r}, expected={expected!r}, observed={first_line!r}\"",
            "        )",
            "",
        ]
    )
    if marker not in text:
        raise SystemExit("validate_migration insertion point not found")
    if "def validate_repository_identity(" in text:
        raise SystemExit("repository identity validator already exists")
    text = text.replace(marker, function + marker, 1)
    old_main = (
        "        manifest_count, manifests = validate_manifests(registry)\n"
        "        repositories = validate_migration(registry, manifests)"
    )
    new_main = (
        "        manifest_count, manifests = validate_manifests(registry)\n"
        "        validate_repository_identity(manifests)\n"
        "        repositories = validate_migration(registry, manifests)"
    )
    if text.count(old_main) != 1:
        raise SystemExit("validator main call site not found")
    path.write_text(text.replace(old_main, new_main), encoding="utf-8")


def verify() -> None:
    manifest = json.loads((ROOT / "contracts/sdk-manifests/go.json").read_text(encoding="utf-8"))
    package = manifest["package"]
    if package["legacyName"] != LEGACY_GO_MODULE:
        raise SystemExit("legacy Go package identity drifted")
    if package["canonicalName"] != CANONICAL_GO_MODULE:
        raise SystemExit("canonical Go package identity drifted")
    observed = (ROOT / "sdk/go/go.mod").read_text(encoding="utf-8").splitlines()[0]
    if observed != f"module {CANONICAL_GO_MODULE}":
        raise SystemExit(f"canonical go.mod identity drifted: {observed!r}")
    for relative in MODULE_PATH_FILES:
        if LEGACY_GO_MODULE in (ROOT / relative).read_text(encoding="utf-8"):
            raise SystemExit(f"stale legacy Go path remains in {relative}")
    release = (ROOT / ".github/workflows/release-native.yml").read_text(encoding="utf-8")
    if "dart run test/conformance.dart" in release or "dart test" not in release:
        raise SystemExit("canonical Dart release command was not reconciled")
    compile((ROOT / "scripts/validate-contracts.py").read_text(encoding="utf-8"), "validate-contracts.py", "exec")
    subprocess.run(["git", "diff", "--check"], cwd=ROOT, check=True)


def main() -> int:
    update_module_metadata()
    update_release_contract()
    update_migration_evidence()
    update_contract_validator()
    verify()
    print("DEN-3196 semantic cutover validated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
