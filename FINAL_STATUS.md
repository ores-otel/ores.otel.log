# Final status — polyglot execution context and graceful shutdown

Date: 2026-08-08

Branch: `agent/polyglot-context-shutdown-20260808`

Status: **draft review; production merge and downstream promotion blocked**

## Completed implementation

### Shared semantics

The review branch defines one semantic contract for TypeScript/Node.js, Go, Rust/Tokio, Dart, and Gleam/OTP:

- immutable execution-context snapshots
- logged-in user and user collection
- fields and tags
- W3C trace ID, span ID, explicit trace flags, trace state, and baggage
- request/routine/task correlation ID
- contextual payload and metadata
- language-native ambient propagation
- explicit propagation at concurrency boundaries that do not inherit context safely

The shutdown state machine is explicit and application-installed:

- SIGINT and SIGTERM where the platform exposes them
- non-TTY: first termination request starts graceful shutdown
- TTY: first request starts graceful drain; second request forces
- TTY stdin EOF (Ctrl-D) may provide the force request after graceful shutdown begins
- graceful phase stops admission and drains active work
- graceful deadline escalates to a separate force hook
- force hook closes active sockets, WebSockets, HTTP/2 sessions, upgraded/hijacked connections, tasks, or supervised processes owned by the application
- force cleanup is deadline-bounded
- telemetry/log/trace/metric flushing executes at most once across races
- reusable libraries do not install process-global handlers at import time or call unconditional process-exit APIs

### Language adapters

- **TypeScript/Node.js:** `AsyncLocalStorage`, HTTP server graceful/force adapter, TTY/EOF coordinator.
- **Go:** `context.Context`, HTTP middleware, `http.Server.Shutdown(ctx)` graceful path, `Close()` force path, race-tested isolation.
- **Rust:** guarded thread-local stack, Tokio task-local propagation and spawn helpers, cancellation/deadline-based lifecycle integration.
- **Dart:** immutable Zone-local context, explicit isolate handoff, graceful/force server hooks.
- **Gleam/OTP:** BEAM process-local context with restoration, explicit child-process handoff, supervisor/application-stop graceful semantics.

## Audit, schema, and rollout tooling

The branch also contains:

- `scripts/audit-server-lifecycle.mjs`
- `schemas/server-lifecycle-audit.schema.json`
- `schemas/execution-context.v1.schema.json`
- shared execution-context and shutdown conformance fixtures
- classifier and fixture invariant tests
- reusable internal and external GitHub Actions workflows
- a security audit with residual-risk controls
- machine-readable organization/repository rollout registries
- a concrete `ores-otel-test/ores.otel.log` canary branch
- draft organization workflow templates in confirmed `*-test` organizations

A static text audit is discovery evidence, not behavioral proof. It cannot establish ordering, draining, deadlines, connection ownership, or context isolation by itself.

## Validation completed outside GitHub Actions

The implementation was locally validated with the toolchains available in the working runtime:

- TypeScript compilation for the new modules
- 13 Node lifecycle/context tests
- Go `go test -race ./...`, including concurrent context-isolation coverage
- dependency-free audit-classifier tests
- schema/fixture invariant tests
- JavaScript syntax checks for the polyglot/audit runners

A separate fresh-clone report is produced as `next-loggers-hardening-status.md` and JSON in the conversation artifacts. That report is intentionally independent of this repository file.

## Required before canonical merge

- exact-head GitHub Actions checks pass
- Rust formatting/tests and Tokio context tests pass
- Dart analyzer/tests pass
- Gleam formatting/tests and Erlang FFI compilation pass
- integrated TypeScript package/build/runtime tests pass
- temporary one-time publication/patch workflows and payload files are absent
- reusable workflow references are pinned to a reviewed immutable commit or release for general use
- review confirms no secret or unrestricted PII is serialized into execution context

## Required before a downstream production PR

For the exact matching test-organization canary commit, retain evidence that:

1. A long request drains during graceful shutdown.
2. New work is refused after admission closes.
3. Keep-alive cannot hang termination indefinitely.
4. WebSocket, HTTP/2, upgraded, or hijacked resources have a force hook.
5. Non-TTY first SIGINT/SIGTERM begins the termination sequence.
6. TTY first request is graceful and second request is force.
7. TTY Ctrl-D can supply the force request.
8. Graceful timeout escalates.
9. Force cleanup is bounded.
10. Telemetry flush executes exactly once across races.
11. Logged-in user and trace context remain isolated under concurrency.
12. Runtime-specific child work receives context only through the documented mechanism.

## Production decision

No production repository or deployment manifest is approved for promotion merely because the canonical code, a static audit, or an organization workflow template exists. Production promotion remains blocked until the canonical exact-head checks and the matching repository canary are green and linked.

## Credential incident note

Credentials pasted into chat must be treated as exposed. Revoke and replace the GitHub PAT, both Linear API keys, the Cloudflare API token, and the R2 access-key pair. None of those credentials should be committed, copied into issues, or used as long-lived CI secrets.
