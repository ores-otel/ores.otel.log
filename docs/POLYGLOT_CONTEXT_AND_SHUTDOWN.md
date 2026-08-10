# Polyglot context propagation and two-phase shutdown

This document is the cross-runtime contract for TypeScript/Node.js, Go, Rust,
Dart/Flutter, and Gleam/OTP servers using `next-loggers/v1` records and an
application-owned OpenTelemetry SDK.

## Invariants

1. Context is scoped, copied at handoff boundaries, and never stored in a
   mutable process-global user variable.
2. The active context can carry fields, logged-in user, related users, trace
   IDs, routine/operation ID, tags, and diagnostic context.
3. The logging package adapts to an injected OpenTelemetry exporter; it does
   not install or replace a global provider.
4. Shutdown phases are `running -> draining -> forcing -> stopped`.
5. The first shutdown request stops new work and drains in-flight work.
6. A second request while draining, or expiration of the grace deadline,
   force-closes remaining work.
7. In an interactive terminal, SIGINT/SIGTERM starts drain and a second signal
   or stdin EOF (Ctrl-D) forces. In non-interactive service environments, one
   signal starts drain; the deadline performs escalation without requiring a
   second signal.
8. WebSocket, HTTP/2, hijacked, upgraded, queue, and background-task handles
   must be tracked separately when the server framework does not own them.
9. The `stopped` lifecycle record is emitted before log/trace flushing.

Lifecycle fields use the same names in every runtime:

- `shutdown.phase`
- `shutdown.previous_phase`
- `shutdown.trigger`
- `shutdown.interactive`
- `shutdown.attempt`
- `shutdown.elapsed_ms`

The language-neutral event shape is in
`contracts/shutdown-event.schema.json`.

## TypeScript and Node.js

Use `@oresoftware/next-loggers/context` for AsyncLocalStorage capture/re-entry,
`@oresoftware/next-loggers/shutdown` for the runtime-neutral state machine, and
`@oresoftware/next-loggers/shutdown/node` for HTTP and signal wiring.

```ts
import {
  captureLogContext,
  runWithCapturedLogContext,
  runWithLogContext,
} from '@oresoftware/next-loggers/context';
import {
  createShutdownLoggerObserver,
} from '@oresoftware/next-loggers/shutdown';
import {
  createNodeHttpShutdown,
} from '@oresoftware/next-loggers/shutdown/node';

runWithLogContext({
  traceId: spanContext.traceId,
  fields: { requestId },
  loggedInUser: { id: session.user.id },
}, () => handleRequest());

const captured = captureLogContext();
queue.add(() => runWithCapturedLogContext(captured, runJob));

const shutdown = createNodeHttpShutdown({
  servers: [httpServer],
  onEvent: createShutdownLoggerObserver(log),
  flush: async () => {
    await log.flush?.(true);
    await otelSdk.shutdown();
  },
  forceCloseUpgrades: async () => {
    for (const socket of upgradedSockets) socket.destroy();
  },
});
```

`server.close()` is the drain path. `closeAllConnections()` is force-only and
cannot close upgraded WebSocket or HTTP/2 connections, so applications must
provide `forceCloseUpgrades` for those resources.

## Go

Use `context.Context` as the explicit request/goroutine carrier. Do not derive
request work from `context.Background()`; use the request context. Capture a
snapshot before detached work and re-enter it under a deliberately chosen
parent context.

```go
requestContext := nextloggers.WithLogContext(r.Context(), nextloggers.LogContext{
    TraceID: traceID,
    Fields: map[string]any{"request.id": requestID},
    LoggedInUser: map[string]any{"id": userID},
})
logger.InfoContext(requestContext, "request accepted").Send()

listener, err := net.Listen("tcp", server.Addr)
if err != nil { return err }
return nextloggers.ServeHTTPWithShutdown(ctx, server, listener,
    nextloggers.HTTPShutdownOptions{
        GracePeriod: 30 * time.Second,
        Observer: nextloggers.LoggerShutdownObserver(logger),
        Flush: func(ctx context.Context) error {
            return errors.Join(logger.FlushOnExit(), otelShutdown(ctx))
        },
        ForceClose: closeHijackedConnections,
    },
)
```

`http.Server.Shutdown(ctx)` closes listeners, closes idle connections, and
waits for active connections. `http.Server.Close()` is the escalation path and
does not manage hijacked connections.

## Rust

`context::with_log_context` provides synchronous scoped context.
`context::ContextualFuture` installs the captured frame for every poll, giving
task-local behavior without taking a dependency on Tokio, async-std, smol, or
a global OpenTelemetry context manager.

```rust
use next_loggers::context::{capture_log_context, contextualize_future, LogContext};
use next_loggers::shutdown::{ShutdownDecision, ShutdownTrigger};

let captured = capture_log_context();
if let Some(context) = captured {
    tokio::spawn(contextualize_future(context, run_job()));
}

match coordinator.request(ShutdownTrigger::SigInt, stdin_is_tty) {
    ShutdownDecision::Drain => graceful_token.cancel(),
    ShutdownDecision::Force => abort_tracked_connections_and_tasks(),
    ShutdownDecision::Ignore => {}
}
```

For Axum/Hyper, wire the drain decision into the server's graceful-shutdown
future. Track the spawned server task, upgraded connections, and independent
background tasks so the force decision can abort or close them explicitly.

## Dart and Flutter

The core package uses `Zone` frames and remains browser-safe. Native command
line, server, mobile, and desktop applications can import the IO entrypoint for
`ProcessSignal` and stdin EOF support.

```dart
import 'package:oresoftware_next_loggers/oresoftware_next_loggers_io.dart';

late LogContext? captured;
withLogContext(
  const LogContext(
    traceId: '...',
    loggedInUser: {'id': 'user-1'},
  ),
  () {
    captured = captureLogContext();
  },
);

final coordinator = ShutdownCoordinator(
  drain: (_) => server.close(force: false),
  force: (_) => server.close(force: true),
  onEvent: loggerShutdownObserver(logger),
  flush: loggerShutdownFlush(logger),
);
final binding = installIoShutdownSignals(coordinator);
```

Use `withCapturedLogContext` or `bindLogContext` for callbacks and queue work.
An isolate boundary requires an explicit serializable context handoff.

## Gleam and OTP

BEAM context is process-local. The typed context module hides the Erlang process
dictionary and supplies explicit capture/re-entry and spawn helpers. A newly
spawned process does not inherit its parent's context automatically.

```gleam
import oresoftware_next_loggers/context as log_context
import oresoftware_next_loggers/shutdown

let captured = log_context.capture()
let _pid = case captured {
  Some(context) ->
    log_context.start_with_log_context(context, True, fn() { run_job() })
  None -> process.start(run_job, True)
}

case shutdown.request(coordinator, shutdown.Sigterm, False) {
  shutdown.Drain -> stop_accepting_and_drain_connections()
  shutdown.Force -> force_close_tracked_connections()
  shutdown.Ignore -> Nil
}
```

A library should not silently replace the BEAM's global OS signal handling.
The OTP application/supervision layer should translate release stop events or
an application-owned signal bridge into coordinator requests. Mist/Wisp
listener shutdown and connection draining remain framework-owned hooks.

## Repository rollout gate

For every server repository:

1. Add a context middleware/interceptor that extracts the active OTEL span and
   authenticated user into the runtime-native carrier.
2. Add the two-phase shutdown adapter and resource registry for upgraded or
   detached work.
3. Test graceful drain, timeout escalation, second signal, Ctrl-D in a TTY,
   non-TTY first signal, flush ordering, and idempotency.
4. Run the candidate exact commit in the matching `*-test` organization before
   promotion to the production organization.
5. Record the exact test commit, workflow run, production PR, and exceptions in
   Linear.

`scripts/audit-server-shutdown.mjs` provides an advisory first-pass scan over
checked-out repositories. It is intentionally not a substitute for framework-
specific tests.
