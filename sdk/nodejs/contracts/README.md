# ores.otel.log polyglot contracts

`ores.otel.log` keeps one logical logging API and one wire format across every runtime without pretending that every language should use the same method spelling or context primitive.

Every `ores.otel.log` SDK emits the stable `next-loggers/v1` record defined by
[`log-record.schema.json`](log-record.schema.json). The wire discriminator is
unchanged during the repository migration, while canonical schema IDs are
rooted at the new repository.

The public API is defined separately by
[`logger-api.schema.json`](logger-api.schema.json) and
[`logger-api.json`](logger-api.json). That contract covers all current SDK
families and makes logger, event, transport, context, and explicit OpenTelemetry
semantics machine-checkable instead of relying on prose or one implementation.

The canonical repository is `ores-otel/ores.otel.log`. The historical `ORESoftware/next-loggers.ts` repository remains a compatibility mirror and must retain its history and published package compatibility.

## Contract files

| File | Purpose |
| --- | --- |
| `log-record.schema.json` | Stable `next-loggers/v1` record emitted by every SDK |
| `schemas/log-context.schema.json` | Logical context shared by ALS, task, thread, process, Zone, Fiber, and host adapters |
| `schemas/otel-log-record.schema.json` | Explicit application-owned OTEL bridge structure |
| `schemas/transport-batch.schema.json` | Bounded `next-loggers/batch/v1` client envelope |
| `schemas/backpressure-result.schema.json` | Bounded transport accounting receipt |
| `schemas/backpressure-conformance-vectors.schema.json` | Schema-valid positive and semantic-negative backpressure vectors |
| `schemas/backpressure-conformance-report.schema.json` | Receipt-free adapter result with source/runtime identity and vector digest |
| `schemas/shutdown-transition-vectors.schema.json` | Closed, exhaustive TypeScript/Dart/Rust shutdown transition corpus |
| `schemas/sdk-manifest.schema.json` | Required logical APIs and runtime guarantees for each SDK |
| `schemas/test-repository-matrix.schema.json` | Cross-repository test-org contract |
| `sdk-manifests.json` | Index of per-language symbols, context mechanisms, transports, tests, and promotion blockers |
| `migration/test-repository-matrix.json` | Thirteen planned test repositories spanning twelve language/runtime entries |
| `fixtures/manifest.json` | Positive and negative validation cases |

The bounded-backpressure semantic corpus is executable without a collector or
credential:

```sh
node scripts/run-backpressure-conformance.mjs
```

The report includes the implementation version and source SHA, runtime version,
schema version, and SHA-256 digest of the exact vector bytes. Failure entries
contain only vector and rule identifiers; receipt contents are never copied into
the report.

Every schema uses JSON Schema Draft 2020-12 and a canonical `$id` rooted at the new repository. The old `next-loggers/v1` discriminator is intentionally preserved so the repository move is not a wire-format break.

JSON Schema proves structural validity, not temporal behavior. The shared
transition vectors, executable state-space explorer, and TLA+ safety/liveness
models under [`../formal`](../formal/README.md) cover the shutdown and bounded
delivery semantics that cannot be expressed as a document schema.

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

## Lifecycle and conformance details

`Logger` exposes `trace`, `debug`, `info`, `warn`, `error`, and `fatal`. Each
method creates an unsent `LogEvent`. The event supports fields, users, traces,
routine IDs, tags, context, metadata, normalized errors, and an idempotent
`send`.

`Transport` accepts one complete `LogRecord`. A language may model lifecycle
methods as optional interfaces or default trait methods, but the shared
operations are:

- `write(record)` delivers a record.
- `flush()` drains pending writes.
- `flush_on_exit(records)` gets the records active during shutdown.
- `close()` releases transport resources.

`Logger.flush()` drains writes already sent. `Logger.flush_on_exit()` first
sends every unsent event and then invokes transport shutdown hooks.
`Logger.close()` performs the shutdown flush before closing transports.

The minimum enabled level defaults to `INFO`, matching the TypeScript
`maxLevel` behavior. `send(false)` may write locally but must not invoke remote
transports.

## Context and OpenTelemetry

Every implementation declares either context-local storage or explicit context
propagation. Context is scoped to the current request, task, thread, isolate,
process, or goroutine; it is never stored in unbounded global mutable state.

OpenTelemetry adapters are explicit and application-owned. SDKs extract and
inject context through explicit carriers, correlate valid trace/span IDs, do
not shut down providers they do not own, and never patch console, HTTP, fetch,
module loading, or runtime internals.

## Conformance

Each SDK creates the deterministic record in
[`fixtures/conformance-record.json`](fixtures/conformance-record.json) by
injecting the ID generator and clock. Tests compare decoded JSON values so
object key order is irrelevant while array order remains part of the contract.

Run the dependency-free validator with:

```bash
node scripts/validate-contracts.mjs
```

It validates both JSON Schemas, all 39 canonical operations, every SDK binding,
and the isolated test-fleet declaration.

Language packages live under `sdk/`:

| SDK binding | Language | Package/module |
| --- | --- | --- |
| `nodejs` | TypeScript/JavaScript | `@oresoftware/next-loggers` |
| `python` | Python | `oresoftware-next-loggers` / `next_loggers` |
| `go` | Go | `github.com/ores-otel/ores.otel.log/sdk/go` after cutover |
| `rust` | Rust | `oresoftware-next-loggers` / `next_loggers` |
| `gleam` | Gleam | `oresoftware_next_loggers` |
| `java` | Java | `io.github.oresoftware:next-loggers` |
| `dart` | Dart/Flutter | `oresoftware_next_loggers` |
| `ruby` | Ruby | `oresoftware-next-loggers` / `ORESoftware::NextLoggers` |
| `erlang` | Erlang | `oresoftware_next_loggers_erlang` / `next_loggers` |
| `elixir` | Elixir | `oresoftware_next_loggers` / `NextLoggers` |
| `wasm` | Rust/WebAssembly | `oresoftware-next-loggers-wasm` / `next_loggers_wasm` |

All packages expose the same transport boundary: a transport receives one
complete `next-loggers/v1` record and owns delivery. Each native SDK includes
an explicit OpenTelemetry adapter and an authenticated-sender Supabase adapter;
neither adapter installs global instrumentation.

## Isolated old/new consumer fleet

[`test-org-matrix.schema.json`](test-org-matrix.schema.json) and
[`test-org-matrix.json`](test-org-matrix.json) declare 22 private repositories
in `ores-otel-test`: a legacy and canonical consumer for each of the 11 SDK
bindings. Live application is blocked until both source repositories have exact
commit refs. Production writes are forbidden by contract.

See [`../docs/REPOSITORY-MIGRATION.md`](../docs/REPOSITORY-MIGRATION.md) for the
history-preserving cutover and promotion gates.
