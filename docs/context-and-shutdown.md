# Execution context and server shutdown contract

This document is the canonical contract for `@oresoftware/next-loggers` and the
Go, Rust, Dart, and Gleam SDKs. Server repositories should depend on these
primitives instead of maintaining ad-hoc signal handlers or request-context
maps.

## 1. Execution context

Every request, job, message, or command may carry an immutable child context:

- authenticated user and related users;
- structured fields;
- trace ID(s), span ID, trace flags, and trace state;
- OpenTelemetry baggage;
- routine/handler ID and tags;
- structured context and metadata payloads.

Nested scopes merge maps, append lists, de-duplicate trace IDs and tags, and let
present scalar values override their parent. An explicit trace-flags value of
zero is preserved; zero must not be confused with an absent value.

Do not put credentials, cookies, authorization headers, private keys, or raw
session tokens in logging context. Prefer stable internal user/tenant IDs. The
logger's normal redaction and serialization limits still apply, but request
context should be deliberately small.

### TypeScript / Node, Bun, Deno, workerd

Use `@oresoftware/next-loggers/execution-context`. Node/Bun/Deno use
`AsyncLocalStorage`. The browser and workerd entry points keep their existing
runtime-specific behavior; callers should check the base context module's
`isAsyncContextTracked()` result before relying on concurrent isolation in a
fallback runtime.

```ts
import logger from '@oresoftware/next-loggers';
import {
  enrichEventFromExecutionContext,
  installExecutionLogContextProvider,
  runWithExecutionLogContext,
} from '@oresoftware/next-loggers/execution-context';

const uninstall = installExecutionLogContextProvider();

await runWithExecutionLogContext(
  {
    loggedInUser: { id: session.userId },
    traceId: traceId,
    spanId: spanId,
    traceFlags: 1,
    baggage: { tenant: tenantId },
    routineId: 'GET /v1/quotes/:id',
  },
  async () => {
    await enrichEventFromExecutionContext(logger.info('quote loaded')).send();
  },
);

uninstall();
```

Ordinary logger calls receive user/trace/span/baggage state through the
installed provider. `enrichEventFromExecutionContext()` additionally places
`context` and `meta` in their top-level wire fields.

### Go

`context.Context` and `*http.Request.Context()` are the only ambient propagation
mechanisms. Never infer or key state by goroutine ID.

```go
handler := nextloggers.LogContextMiddleware(func(r *http.Request) nextloggers.LogContext {
    return nextloggers.LogContext{
        LoggedInUser: map[string]any{"id": authenticatedUserID(r)},
        TraceID:       traceIDFrom(r),
        SpanID:        spanIDFrom(r),
        RoutineID:     r.Method + " " + r.URL.Path,
    }
})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    _ = logger.InfoContext(r.Context(), "request accepted").Send()
    w.WriteHeader(http.StatusNoContent)
}))
```

Use `WithTraceFlags(ctx, 0)` when an explicit zero must override a sampled
parent. `TraceFlagsSet` exists for struct-literal callers that need the same
presence semantics.

### Rust

The `sdk/rust-context` companion crate provides:

- an RAII, LIFO, non-`Send` thread-local guard for synchronous work;
- Tokio task-local context for futures that may move between threads;
- explicit `spawn_with_current_context()` propagation because Tokio task locals
  are not inherited by `tokio::spawn`;
- logger extension methods for explicit (`*_with_context`) and ambient
  (`*_ambient`) context.

Task-local context wins over thread-local context. Nested helper scopes merge
with their parent and restore it on return or panic.

### Dart

Dart uses `Zone` values. `withLogContext()` / `runWithLogContext()` isolate
concurrent asynchronous work and restore the parent Zone automatically.

```dart
await runWithLogContext(
  LogContext(
    loggedInUser: {'id': userId},
    traceId: traceId,
    spanId: spanId,
    traceFlags: 0,
  ),
  () => logger.info('request accepted'),
);
```

### Gleam / BEAM

Gleam uses process-local storage backed by the Erlang process dictionary and a
`try ... after` restoration boundary. Context is not inherited by a newly
spawned BEAM process. Pass the snapshot explicitly and install it in the child
process with `with_context()`.

Process-local storage is appropriate here because a BEAM process is the unit of
concurrency. Long-lived or pooled processes must scope each request/message and
must not leave a context installed between messages.

## 2. Graceful and forceful shutdown

One component owns process signals for the application. Libraries must not add
signal handlers at import/initialization time.

The required sequence is:

1. Mark the instance unready and stop accepting new work.
2. Gracefully close listeners and wait for active HTTP requests/jobs.
3. Flush logs, traces, metrics, and durable queues exactly once.
4. Close remaining application resources.
5. On timeout or a second termination event, force-close active connections,
   WebSocket sessions, HTTP/2 sessions, hijacked Go connections, and task groups.

### Interaction policy

- **TTY stdin:** the first SIGINT/SIGTERM begins a graceful drain. A second
  SIGINT/SIGTERM forces. Ctrl-D (stdin EOF) may replace the second Ctrl-C.
- **Non-TTY stdin:** one SIGINT/SIGTERM is sufficient to begin shutdown. The
  process exits when the graceful drain completes; timeout still forces.
- A single Ctrl-D may begin graceful shutdown, but EOF is a one-shot event and
  must never be counted twice.
- Shutdown logging is best-effort and must never block termination.
- Application code sets an exit code after completion; shared helpers do not
  call `process.exit`, `os.Exit`, or equivalent during the graceful path.

### Node.js

Use `@oresoftware/next-loggers/server-lifecycle`.

```ts
import { createServer } from 'node:http';
import logger from '@oresoftware/next-loggers';
import {
  createNodeLoggerShutdownSink,
  installNodeServerShutdown,
} from '@oresoftware/next-loggers/server-lifecycle';

const server = createServer(app);
const sockets = new Set<WebSocket>();

const shutdown = installNodeServerShutdown({
  servers: server,
  beforeGraceful: () => readiness.markUnready(),
  flush: () => logger.flushOnExit({ timeoutMillis: 2_000 }),
  force: () => {
    for (const socket of sockets) socket.terminate();
  },
  onLog: createNodeLoggerShutdownSink(logger),
  timeoutMillis: 15_000,
  forceTimeoutMillis: 5_000,
});

await shutdown.done;
```

`server.close()` is called before `closeIdleConnections()` or
`closeAllConnections()`. `closeAllConnections()` does not cover upgraded
WebSockets or HTTP/2 sessions, so those belong in the force hook.

### Go

Use `RunGracefulShutdown`. `http.Server.Shutdown(ctx)` is the graceful path;
`http.Server.Close()` is only the force path.

```go
result := nextloggers.RunGracefulShutdown(
    context.Background(),
    server,
    nextloggers.ShutdownOptions{
        Timeout: 15 * time.Second,
        BeforeGraceful: func(ctx context.Context, cause nextloggers.ShutdownCause) error {
            return readiness.MarkUnready(ctx)
        },
        Flush: func(ctx context.Context, cause nextloggers.ShutdownCause) error {
            if err := ctx.Err(); err != nil {
                return err
            }
            return logger.FlushOnExit()
        },
        Force: func(cause nextloggers.ShutdownCause) error {
            return websocketRegistry.CloseAll()
        },
        Log: nextloggers.LoggerShutdownLog(logger),
    },
)
```

`Shutdown` does not wait for hijacked connections such as WebSockets. Register
those in `Force`, and arrange a graceful close notification separately if the
protocol supports it.

### Rust / Tokio

Use `ShutdownState`, `stdin_is_terminal()`, and
`tokio_support::next_shutdown_cause()`. Map `BeginGraceful` to a cancellation
signal consumed by Axum/Hyper/tonic, and map `Force` to aborting the server task
and destroying application-owned sessions. A second call to
`next_shutdown_cause()` while draining implements the second-event policy.

### Dart

Use `installProcessShutdown()`. `graceful` closes listeners and awaits active
work; `force` destroys survivors. The coordinator serializes telemetry flushes
across graceful/force races and bounds force hooks with `forceTimeout`.

### Gleam / OTP

The pure Gleam module exposes the same state transitions, but OS integration is
intentionally a launcher/supervision concern:

- OTP maps SIGTERM into normal VM shutdown and supervised termination.
- Portable pure Gleam code cannot implement Node-style in-process SIGINT/TTY
  handling on every launcher.
- A foreground launcher may translate first SIGINT, second SIGINT, and stdin EOF
  into the state machine.
- `graceful_stop()` delegates to `init:stop/0`; `force_stop()` delegates to
  `erlang:halt/1` and is a last-resort escalation only.

## 3. Required conformance tests in every server repository

A server rollout is not complete until CI proves:

1. concurrent requests never observe another request's user/trace/span/baggage;
2. nested context restores after normal return and panic/exception;
3. explicit zero trace flags survive a nested override;
4. one non-TTY signal drains and exits normally;
5. first interactive signal drains; second signal forces;
6. Ctrl-D can replace the second Ctrl-C;
7. timeout forces active connections/tasks;
8. WebSockets, HTTP/2 sessions, hijacked connections, and background task groups
   have registered force hooks;
9. telemetry flush runs exactly once under graceful/force races;
10. a hung hook cannot block force completion indefinitely;
11. lifecycle records include phase, cause, interactivity, and signal count;
12. repeated shutdown events after `closed`/`forced` are idempotent.

Test organizations should run the exact production commit before production PRs
are merged. Production branches remain PR-only.
