# Rust HTTP/HTTPS graceful shutdown

`ores-otel/ores.otel.log` owns the shared Rust lifecycle policy. Product servers own runtime integration: OS signal listeners, readiness, TCP/TLS listener shutdown, protocol-specific connection draining, task cancellation, and the actual logger/OpenTelemetry flush.

## Required sequence

On the first SIGINT or SIGTERM:

1. call `HttpShutdownController::handle_trigger(...)`;
2. if the decision is `Drain`, immediately mark readiness false and stop accepting new TCP/TLS connections;
3. place the controller admission gate before expensive HTTP middleware/handlers so newly arriving requests are rejected with HTTP 429, `Retry-After`, and `Connection: close` for HTTP/1.x;
4. start a timer for `DEFAULT_HTTP_GRACE_PERIOD` (5 seconds);
5. allow already-admitted requests to finish during that window;
6. on graceful completion call `GracefulComplete`; on timer expiry call `force_if_deadline_expired()` and cancel/force-close remaining requests, HTTP/2 streams/sessions, WebSockets/upgrades, and runtime tasks;
7. after network/task cleanup, only the caller that wins `claim_finalization()` performs the bounded logger/OpenTelemetry flush.

The shared controller does not call `process::exit`, install global signal handlers, own a Tokio runtime, or depend on Axum/Hyper. That keeps it reusable from `*-lib-core` crates and across server implementations.

## Interactive terminal policy

When stdin is attached to a terminal, the first SIGINT begins the same 5-second drain and returns a warning suitable for stderr: new requests are rejected, in-flight work is draining, and Ctrl-D can force shutdown immediately. A repeated SIGINT is ignored while draining; stdin EOF / Ctrl-D forces. SIGTERM remains an operational termination signal and a second SIGTERM forces even in an interactive process.

For unattended services, the first SIGINT/SIGTERM drains and a second signal may force immediately. The deadline independently guarantees eventual escalation.

## Server adapter sketch

```rust
use ores_logger::{
    HttpAdmission, HttpShutdownController, ShutdownDecision, ShutdownTrigger,
};
use std::sync::Arc;

let shutdown = Arc::new(HttpShutdownController::default());

// HTTP admission middleware, before expensive/auth/database work:
match shutdown.admission() {
    HttpAdmission::Accept => {
        // continue
    }
    HttpAdmission::Reject(rejection) => {
        // return rejection.status_code (429), Retry-After, and Connection: close
    }
}

// Signal task:
let outcome = shutdown.handle_trigger(ShutdownTrigger::SigTerm, false);
if outcome.decision == ShutdownDecision::Drain {
    // readiness=false; close listener; start 5-second timer
}
```

Adapters should preserve protocol semantics. Closing the listener prevents new connections, while the HTTP admission gate covers keep-alive connections that were already accepted before draining began. HTTP/2/3 and upgraded connections require their native drain/GOAWAY/close mechanisms; the 5-second deadline still bounds them.

## Logging and OpenTelemetry

Lifecycle logs should be emitted before the final flush and should include the phase/trigger and whether force escalation occurred. `claim_finalization()` is an exactly-once arbitration primitive; it does not hide exporter errors or choose a transport. The application should bound its flush operation independently so a broken exporter cannot keep shutdown alive forever.
