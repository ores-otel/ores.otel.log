# ores.otel.log polyglot contracts

`ores.otel.log` keeps one logical logging API and one wire format across every runtime without pretending that every language should use the same method spelling or context primitive.

The canonical repository is `ores-otel/ores.otel.log`. The historical `ORESoftware/next-loggers.ts` repository remains a compatibility mirror and must retain its history and published package compatibility.

## Contract files

| File | Purpose |
| --- | --- |
| `log-record.schema.json` | Stable `next-loggers/v1` record emitted by every SDK |
| `schemas/log-context.schema.json` | Logical context shared by ALS, task, thread, process, Zone, Fiber, and host adapters |
| `schemas/otel-log-record.schema.json` | Explicit application-owned OTEL bridge structure |
| `schemas/transport-batch.schema.json` | Bounded `next-loggers/batch/v1` client envelope |
| `schemas/sdk-manifest.schema.json` | Required logical APIs and runtime guarantees for each SDK |
| `schemas/test-repository-matrix.schema.json` | Cross-repository test-org contract |
| `sdk-manifests.json` | Index of per-language symbols, context mechanisms, transports, tests, and promotion blockers |
| `migration/test-repository-matrix.json` | Thirteen planned test repositories spanning twelve language/runtime entries |
| `fixtures/manifest.json` | Positive and negative validation cases |

Every schema uses JSON Schema Draft 2020-12 and a canonical `$id` rooted at the new repository. The old `next-loggers/v1` discriminator is intentionally preserved so the repository move is not a wire-format break.

## Logical API

Each SDK manifest maps language-native symbols onto the same operations.

- Logger: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `flush`, `flushOnExit`, and `close`.
- Event: add fields, traces, routine IDs, tags, context, metadata, and users, then idempotent `send`.
- Transport: `write`, `flush`, `flushOnExit`, and `close`.
- Context: enter a scope, read/update it, apply it to a record, and run an explicit span.

Method spelling remains idiomatic. The manifest records native symbols while JSON Schema enforces the logical operation set.

## Runtime context strategies

| SDK | Canonical strategy |
| --- | --- |
| Node.js/Bun/Deno | `AsyncLocalStorage` |
| Browser/workerd | explicit context; ALS only when the runtime supplies it |
| Python | `contextvars` |
| Go | explicit `context.Context` value |
| Rust | scoped thread-local plus explicit async task adapter |
| Java | guarded `ThreadLocal` plus executor wrappers |
| Dart/Flutter | `Zone` |
| Erlang/Elixir/Gleam | scoped process dictionary |
| Ruby | Fiber-local with thread fallback |
| WASM | explicit host-owned context |

No SDK may emulate goroutine-local storage, patch promises/timers, intercept module loading, replace `fetch`/console, or install an OTEL global provider.

## OpenTelemetry guarantees

The application owns OTEL SDK startup, context management, exporters, flushing, and shutdown. `ores.otel.log` wraps those application-owned objects behind its own logger and transport APIs.

Every SDK manifest requires explicit instrumentation, logger calls as the application-facing API, no automatic instrumentation, no monkey patching, no provider ownership, sampled-out trace correlation before canonical promotion, and span events only for recording spans before canonical promotion.

High-cardinality record, trace, span, request, and user identifiers stay in logs or structured metadata. They must not become Prometheus labels or Loki stream labels.

## Compatibility and IDs

New OTEL integrations should emit lowercase non-zero W3C IDs: 32 hexadecimal characters for trace IDs and 16 for span IDs. The `next-loggers/v1` schema still accepts legacy correlation IDs such as `trace-1` because deployed consumers already use them. OTEL adapters must reject zero IDs and malformed W3C tuples when converting to an OTEL span context.

## Validation

```sh
python -m pip install jsonschema==4.26.0 referencing==0.37.0
python scripts/validate-contracts.py
```

The validator checks schema validity, positive and negative fixtures, the exact eleven-SDK manifest set, source paths, explicit OTEL rules, no-monkey-patching patterns, promotion readiness, and the minimum ten-repository/seven-language test-org requirement.

`promotion.ready` is deliberately false for SDKs whose context isolation or schema tests have not landed. Metadata cannot declare an SDK ready merely because its basic logger compiles.

## Migration pairing contract

The compatibility-era `logger-api.json` and `logger-api.schema.json` provide
a second, dependency-free check of the complete logical API. They are retained
alongside the richer per-SDK manifests so older consumer provisioning tools can
validate all 39 canonical operations during migration.

The `test-org-matrix.json` pair describes isolated legacy and canonical
consumers for all eleven SDK families. It is a planning contract: repository
writes are limited to `ores-otel-test`, production writes are forbidden, and
an apply run remains blocked until it is given the exact final canonical ref.

Run this compatibility validator with:

```sh
node scripts/validate-contracts.mjs
```

The primary validator remains `python scripts/validate-contracts.py`; both
contracts must pass while the compatibility fleet is supported.
