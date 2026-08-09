#!/usr/bin/env python3
"""Validate ores.otel.log schemas, fixtures, SDK manifests, and migration matrix."""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Iterable

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "contracts"
CANONICAL = "ores-otel/ores.otel.log"
LEGACY = "ORESoftware/next-loggers.ts"
LANGUAGES = {"nodejs", "python", "go", "rust", "java", "dart", "gleam", "erlang", "elixir", "ruby", "wasm"}
REQUIRED_CAPABILITIES = {"record-schema", "api-manifest", "context-isolation", "otel-explicit", "no-monkey-patching", "lifecycle"}
FORBIDDEN = (
    ("automatic instrumentation", re.compile(r"registerInstrumentations\s*\(")),
    ("global tracer provider", re.compile(r"setGlobalTracerProvider\s*\(")),
    ("global meter provider", re.compile(r"setGlobalMeterProvider\s*\(")),
    ("global logger provider", re.compile(r"setGlobalLoggerProvider\s*\(")),
    ("require-in-the-middle", re.compile(r"require-in-the-middle", re.I)),
    ("shimmer", re.compile(r"(?:from|require\s*\()\s*['\"]shimmer['\"]", re.I)),
    ("Node module loader replacement", re.compile(r"Module\s*\.\s*_load\s*=(?!=|>)")),
    ("prototype replacement", re.compile(r"\.\s*prototype\s*\.[A-Za-z_$][\w$]*\s*=(?!=|>)")),
    ("console replacement", re.compile(r"console\s*\.\s*(?:log|debug|info|warn|error)\s*=(?!=|>)")),
    ("global fetch replacement", re.compile(r"globalThis\s*\.\s*fetch\s*=(?!=|>)")),
)

class Failure(RuntimeError):
    pass


def load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise Failure(f"missing required file: {path.relative_to(ROOT)}") from exc
    except json.JSONDecodeError as exc:
        raise Failure(f"invalid JSON in {path.relative_to(ROOT)}:{exc.lineno}:{exc.colno}: {exc.msg}") from exc


def schema_documents() -> dict[str, tuple[Path, dict[str, Any]]]:
    paths = [CONTRACTS / "log-record.schema.json", *sorted((CONTRACTS / "schemas").glob("*.json"))]
    documents: dict[str, tuple[Path, dict[str, Any]]] = {}
    for path in paths:
        document = load(path)
        Draft202012Validator.check_schema(document)
        identifier = document.get("$id")
        if not isinstance(identifier, str) or "ores-otel/ores.otel.log" not in identifier:
            raise Failure(f"{path.relative_to(ROOT)} must use a canonical ores-otel $id")
        if identifier in documents:
            raise Failure(f"duplicate schema $id: {identifier}")
        documents[identifier] = (path, document)
    return documents


def registry_for(documents: dict[str, tuple[Path, dict[str, Any]]]) -> Registry[Any]:
    registry: Registry[Any] = Registry()
    for identifier, (_, document) in documents.items():
        registry = registry.with_resource(identifier, Resource.from_contents(document))
    return registry


def validator(path: Path, registry: Registry[Any]) -> Draft202012Validator:
    return Draft202012Validator(load(path), registry=registry, format_checker=FormatChecker())


def keyword_set(error: Any) -> set[str]:
    values = {str(error.validator)}
    for child in error.context:
        values.update(keyword_set(child))
    return values


def first_error(errors: Iterable[Any]) -> str:
    error = next(iter(errors))
    location = "/".join(map(str, error.absolute_path)) or "<root>"
    return f"{location}: {error.message}"


def validate_fixtures(registry: Registry[Any]) -> int:
    manifest_path = CONTRACTS / "fixtures" / "manifest.json"
    manifest = load(manifest_path)
    errors = sorted(validator(CONTRACTS / "schemas" / "fixture-manifest.schema.json", registry).iter_errors(manifest), key=lambda e: list(e.absolute_path))
    if errors:
        raise Failure(f"invalid fixture manifest: {first_error(errors)}")
    seen: set[str] = set()
    for case in manifest["cases"]:
        fixture_path = ROOT / case["path"]
        if case["path"] in seen:
            raise Failure(f"duplicate fixture case: {case['path']}")
        seen.add(case["path"])
        errors = sorted(validator(ROOT / case["schema"], registry).iter_errors(load(fixture_path)), key=lambda e: (list(e.absolute_path), e.message))
        if case["valid"] and errors:
            raise Failure(f"expected valid fixture {case['path']}: {first_error(errors)}")
        if not case["valid"]:
            if not errors:
                raise Failure(f"expected invalid fixture to fail: {case['path']}")
            observed: set[str] = set()
            for error in errors:
                observed.update(keyword_set(error))
            if case["expectedKeyword"] not in observed:
                raise Failure(f"{case['path']} failed for {sorted(observed)}, not {case['expectedKeyword']!r}")
    return len(manifest["cases"])


def validate_manifests(registry: Registry[Any]) -> tuple[int, list[dict[str, Any]]]:
    index_path = CONTRACTS / "sdk-manifests.json"
    index = load(index_path)
    errors = list(validator(CONTRACTS / "schemas" / "sdk-manifest-set.schema.json", registry).iter_errors(index))
    if errors:
        raise Failure(f"invalid SDK manifest index: {first_error(errors)}")
    manifest_validator = validator(CONTRACTS / "schemas" / "sdk-manifest.schema.json", registry)
    manifests: list[dict[str, Any]] = []
    seen: set[str] = set()
    for relative in index["manifests"]:
        manifest = load(ROOT / relative)
        errors = sorted(manifest_validator.iter_errors(manifest), key=lambda e: (list(e.absolute_path), e.message))
        if errors:
            raise Failure(f"invalid SDK manifest {relative}: {first_error(errors)}")
        language = manifest["language"]
        if language in seen:
            raise Failure(f"duplicate SDK manifest language: {language}")
        seen.add(language)
        otel = manifest["telemetry"]["opentelemetry"]
        if any((otel["automaticInstrumentation"], otel["monkeyPatching"], otel["ownsProvider"])):
            raise Failure(f"{language} enables forbidden OTEL behavior")
        if not otel["explicit"] or not otel["wrapsLoggerCalls"]:
            raise Failure(f"{language} OTEL must remain explicit and downstream of logger calls")
        promotion = manifest["promotion"]
        if promotion["ready"]:
            required = {
                "implemented context": manifest["context"]["status"] == "implemented",
                "schema validation": manifest["conformance"]["validatesJsonSchema"],
                "context isolation tests": manifest["conformance"]["testsContextIsolation"],
                "anti-patching tests": manifest["conformance"]["testsNoMonkeyPatching"],
                "sampled-out correlation": otel["sampledOutCorrelation"],
                "recording-only span events": otel["recordingSpanEventsOnly"],
            }
            missing = [name for name, value in required.items() if not value]
            if missing:
                raise Failure(f"{language} is promotion-ready without {', '.join(missing)}")
        elif not promotion["blockers"]:
            raise Failure(f"{language} is not ready but has no explicit blockers")
        if os.environ.get("ORES_OTEL_SKIP_SOURCE_CHECK") != "1":
            if not (ROOT / manifest["sourceRoot"]).is_dir():
                raise Failure(f"{language} source root does not exist: {manifest['sourceRoot']}")
            for source in manifest["conformance"]["sourceFiles"]:
                source_path = ROOT / source
                if not source_path.is_file():
                    raise Failure(f"{language} source file does not exist: {source}")
                text = source_path.read_text(encoding="utf-8")
                for description, pattern in FORBIDDEN:
                    if pattern.search(text):
                        raise Failure(f"{description} is forbidden in {source}")
        manifests.append(manifest)
    if seen != LANGUAGES:
        raise Failure(f"SDK manifest set drifted; missing={sorted(LANGUAGES-seen)}, extra={sorted(seen-LANGUAGES)}")
    return len(manifests), manifests


def validate_repository_identity(manifests: list[dict[str, Any]]) -> None:
    """Keep canonical and legacy Go module identities explicit during migration."""
    go_manifest = next((manifest for manifest in manifests if manifest["language"] == "go"), None)
    if go_manifest is None:
        raise Failure("Go SDK manifest is missing")
    repository_context = (
        os.environ.get("ORES_OTEL_SOURCE_REPOSITORY")
        or os.environ.get("EXPECTED_REPOSITORY")
        or os.environ.get("GITHUB_REPOSITORY")
        or CANONICAL
    )
    package_names = go_manifest["package"]
    expected = (
        package_names["legacyName"]
        if repository_context == LEGACY
        else package_names["canonicalName"]
    )
    go_mod = ROOT / "sdk" / "go" / "go.mod"
    first_line = go_mod.read_text(encoding="utf-8").splitlines()[0]
    if first_line != f"module {expected}":
        raise Failure(
            "Go module identity does not match the source repository context: "
            f"repository={repository_context!r}, expected={expected!r}, observed={first_line!r}"
        )

def validate_migration(registry: Registry[Any], manifests: list[dict[str, Any]]) -> int:
    aliases = load(CONTRACTS / "migration" / "repository-aliases.json")
    matrix = load(CONTRACTS / "migration" / "test-repository-matrix.json")
    for document, schema in (
        (aliases, CONTRACTS / "schemas" / "repository-aliases.schema.json"),
        (matrix, CONTRACTS / "schemas" / "test-repository-matrix.schema.json"),
    ):
        errors = list(validator(schema, registry).iter_errors(document))
        if errors:
            raise Failure(f"invalid {schema.name}: {first_error(errors)}")
    repositories = matrix["repositories"]
    names = [repo["name"] for repo in repositories]
    if len(names) != len(set(names)):
        raise Failure("test repository names must be unique")
    languages = {repo["language"] for repo in repositories}
    requirements = aliases["promotionRequirements"]
    if len(repositories) < requirements["minimumRepositories"] or len(languages) < requirements["minimumLanguages"]:
        raise Failure("test matrix does not meet repository/language minimums")
    manifest_languages = {manifest["language"] for manifest in manifests}
    for repo in repositories:
        if set(repo["sources"]) != {CANONICAL, LEGACY}:
            raise Failure(f"{repo['name']} must test canonical and legacy sources exactly")
        if not REQUIRED_CAPABILITIES.issubset(repo["capabilities"]):
            raise Failure(f"{repo['name']} is missing required capabilities")
        if repo["language"] not in manifest_languages | {"browser"}:
            raise Failure(f"{repo['name']} has no SDK manifest for {repo['language']}")
        if not repo["name"].startswith("ores-otel-log-"):
            raise Failure(f"invalid test repository prefix: {repo['name']}")
    return len(repositories)


def main() -> int:
    try:
        documents = schema_documents()
        registry = registry_for(documents)
        fixtures = validate_fixtures(registry)
        manifest_count, manifests = validate_manifests(registry)
        validate_repository_identity(manifests)
        repositories = validate_migration(registry, manifests)
    except Failure as error:
        print(f"contract validation failed: {error}", file=sys.stderr)
        return 1
    print(f"contract validation passed: {len(documents)} schemas, {fixtures} fixtures, {manifest_count} SDK manifests, {repositories} test repositories")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
