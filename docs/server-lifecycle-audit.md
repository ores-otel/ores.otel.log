# Server lifecycle and execution-context audit

The lifecycle auditor is a dependency-free discovery and rollout tool for Node.js/TypeScript, Go, Rust, Gleam/OTP, and Dart repositories. It finds likely server entry points and records evidence for the canonical context and shutdown contract documented in [`context-and-shutdown.md`](./context-and-shutdown.md).

It does **not** prove that a shutdown implementation is correct. A matching token such as `Shutdown(ctx)` or `with_graceful_shutdown` is evidence that a human or a conformance test must inspect. The audit intentionally reports file paths so false positives and framework-specific exceptions are reviewable.

## Run locally

```bash
node scripts/audit-server-lifecycle.mjs .
node scripts/audit-server-lifecycle.mjs --format=json .
node scripts/audit-server-lifecycle.mjs \
  --format=json \
  --output=artifacts/lifecycle.json \
  ../repo-a ../repo-b ../repo-c
```

Use `--strict` in a test organization after an initial baseline has been reviewed. Strict mode exits with code `2` when any detected server is classified as high risk.

```bash
node scripts/audit-server-lifecycle.mjs --strict ../checked-out-repositories/*
```

The JSON document conforms to [`schemas/server-lifecycle-audit.schema.json`](../schemas/server-lifecycle-audit.schema.json).

## Reusable GitHub Actions gate

After the canonical branch lands on the default branch, another repository can call the reusable workflow:

```yaml
name: Server lifecycle conformance

on:
  pull_request:

jobs:
  lifecycle:
    uses: ores-otel/ores.otel.log/.github/workflows/server-lifecycle-audit.yml@main
    with:
      roots: .
      strict: true
```

Start with `strict: false` in production repositories and `strict: true` in their matching `*-test` canaries. Promote the production change only after the canary exercises the same server framework and exact commit.

## Evidence required before promotion

A low-risk text audit is necessary but not sufficient. Each server migration should retain evidence for:

1. A long-running request drains during graceful shutdown.
2. New connections are refused after graceful shutdown begins.
3. Keep-alive connections do not indefinitely prevent completion.
4. WebSocket, HTTP/2, upgraded, or hijacked connections have a separate force hook.
5. Non-TTY execution begins shutdown on the first SIGINT or SIGTERM.
6. TTY execution starts graceful shutdown on the first signal and forces on the second.
7. TTY stdin EOF (Ctrl-D) requests force without being counted twice.
8. A graceful deadline escalates to force.
9. A force deadline prevents a hung cleanup hook from blocking process termination forever.
10. Log, trace, and metric providers flush at most once across competing shutdown paths.
11. Request/user/trace context does not leak between concurrent requests or tasks.
12. Child goroutines, Tokio tasks, BEAM processes, Dart Zones, and Node async work receive context only through the documented propagation mechanism.

## Language-specific interpretation

### Node.js / TypeScript

The graceful hook calls `server.close()` and may call `closeIdleConnections()` after admission stops. The force hook calls `closeAllConnections()` and separately closes upgraded protocols. Context uses `AsyncLocalStorage`; libraries install signal handlers only through an explicit lifecycle object.

### Go

The graceful hook calls `http.Server.Shutdown(ctx)`. The force hook calls `http.Server.Close()` plus application-owned WebSocket or hijacked-connection cleanup. Request context derives from `context.Context`; arbitrary goroutine-local state is not inferred.

### Rust / Tokio

The server uses its framework's graceful-shutdown future and an owned cancellation token. Force aborts or cancels remaining tasks after a deadline. Synchronous code may use a guarded thread-local stack, while Tokio tasks use task-local context and explicit spawn helpers.

### Gleam / OTP

Graceful shutdown is expressed through supervision and application stop semantics. Forceful halt is a last resort, not the normal server API. Ambient context is BEAM process-local and must be copied explicitly when spawning a new process.

### Dart

Graceful shutdown closes `HttpServer` with `force: false`; force uses `force: true` and closes upgraded resources separately. Ambient context is Zone-local and immutable snapshots are passed when work crosses an isolate boundary.
