# Repository migration: `next-loggers.ts` to `ores.otel.log`

## Canonical ownership

The intended canonical repository is `ores-otel/ores.otel.log`. The existing
`ORESoftware/next-loggers.ts` repository remains the legacy source until the
new repository exists, contains the complete Git history, and passes exact-head
legacy/canonical conformance.

Do not create a historyless replacement and do not force-push either default
branch. The migration must preserve commit ancestry so tags, release provenance,
and audit links remain attributable.

After the gate passes, local clones use these remotes:

```text
origin  https://github.com/ores-otel/ores.otel.log.git
legacy  https://github.com/ORESoftware/next-loggers.ts.git
```

The old repository should remain readable with a prominent migration notice.
Archival or disabling writes is a separate reviewed operation after package and
consumer cutover.

## Contract source of truth

Three layers are intentionally separate:

1. `contracts/log-record.schema.json` defines the stable `next-loggers/v1` wire
   record. Existing records remain compatible during the repository rename.
2. `contracts/logger-api.schema.json` and `contracts/logger-api.json` define the
   required logger, event, transport, context, and explicit OpenTelemetry API.
3. `contracts/test-org-matrix.schema.json` and
   `contracts/test-org-matrix.json` define the isolated old/new consumer fleet.

`node scripts/validate-contracts.mjs` validates both JSON Schemas without a
network install, checks all 39 required operations, verifies every SDK path and
capability declaration, and rejects an incomplete test matrix.

## Language scope

The contract covers all current SDK families:

- TypeScript/JavaScript
- Python
- Go
- Rust
- Java
- Dart/Flutter
- Ruby
- Gleam
- Erlang
- Elixir
- Rust/WebAssembly

Every SDK must preserve structured records, deterministic conformance fixtures,
transport lifecycle semantics, explicit OpenTelemetry integration, and either
context-local storage or explicit context propagation. Global patching of
console, HTTP, fetch, module loading, or runtime internals is forbidden.

## Test organization

`ores-otel-test` is an isolated non-production owner. The declared fleet contains
22 private repositories: one legacy and one canonical consumer for each of the
11 SDK families. This exceeds the required 10 repositories and 7 languages
without mixing production writes into the test owner.

The canonical entries remain truthfully marked `blocked` until
`ores-otel/ores.otel.log` exists and has an exact 40-character commit ref. A live
bootstrap must fail closed unless both source refs are exact, the owner is
exactly `ores-otel-test`, and production writes remain disabled.

## Safe activation sequence

1. Use the protected repository-bootstrap capability tracked by Linear issue
   `DEN-319`; repository creation is not performed by embedding a PAT in source,
   workflow YAML, logs, or tickets.
2. Dry-run creation of `ores-otel/ores.otel.log`, review the owner, name,
   visibility, initialization mode, and idempotency result, then submit the exact
   confirmation string.
3. Mirror all refs and verify the canonical `main` head matches the reviewed
   legacy head before changing package metadata or module paths.
4. Set the canonical remote as `origin` and retain the old repository as
   `legacy` in migration tooling.
5. Replace the canonical track's null ref in `test-org-matrix.json` with the
   exact reviewed commit and change its status to `ready`.
6. Provision the 22 private test repositories from the validated matrix. Each
   repository must pin its source commit and publish both `contract` and
   `consumer` checks.
7. Require all legacy/canonical pairs to produce equivalent decoded
   `next-loggers/v1` fixtures and equivalent lifecycle/context/OTEL behavior.
8. Update registry metadata, Go module paths, source links, release workflows,
   and documentation only after exact-head test-org evidence is green.
9. Add a migration notice to the legacy repository. Archive it only through a
   separate reviewed change after downstream adoption is measured.

## Promotion evidence

The promotion record must include:

- legacy repository and exact commit;
- canonical repository and exact commit;
- the 22 test repositories and their exact workflow heads;
- contract-validator output;
- consumer check conclusions for every language pair;
- confirmation that no credential-shaped value entered Git, Linear, artifacts,
  or logs;
- a semantic diff proving the only intended package-path changes are those
  required by the new canonical owner.
