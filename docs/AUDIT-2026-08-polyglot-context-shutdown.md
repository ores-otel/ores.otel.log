# Polyglot context and shutdown audit — August 2026

## Scope

This audit covers execution-context propagation, logger enrichment, signal handling, graceful drain, force escalation, and telemetry flushing in the TypeScript/Node.js, Go, Rust/Tokio, Dart, and Gleam/OTP SDK paths.

The goal is semantic parity, not an artificial identical API. Each runtime uses its safe native carrier and requires explicit handoff where ambient state does not cross a concurrency boundary.

## Resolved findings

### Context shape drift

**Risk:** The TypeScript ambient context previously represented less trace, baggage, routine, and metadata state than some native SDK paths, making “parity” ambiguous.

**Resolution:** A shared execution-context shape now includes logged-in user information, users, fields, trace and span identifiers, explicit trace flags, trace state, baggage, routine/request ID, tags, contextual payload, and metadata. Explicit zero trace flags are distinguishable from absent flags.

### Mutable or leaking ambient state

**Risk:** Reusing mutable maps or relying on accidental runtime inheritance can leak one request's user or trace state into another request.

**Resolution:** Context updates produce defensive snapshots. Node uses `AsyncLocalStorage`; Go uses `context.Context`; Rust separates guarded thread-local and Tokio task-local state; Dart uses Zones; Gleam uses BEAM process-local state with restoration through `try ... after`. Tests cover nested restoration and concurrent isolation where the local toolchain was available.

### Unsafe concurrency assumptions

**Risk:** Goroutines, Tokio tasks, BEAM processes, and Dart isolates do not provide one universal ambient-context behavior.

**Resolution:** The API and documentation require explicit propagation at boundaries that do not safely inherit context. Go does not emulate goroutine-local storage. Rust provides an explicit task spawn helper. BEAM child processes and Dart isolates receive snapshots explicitly.

### Import-time process mutation

**Risk:** A logging library that installs signal handlers on import can conflict with frameworks, tests, workers, and applications that own the process lifecycle.

**Resolution:** Lifecycle installation is explicit. Reusable APIs do not call unconditional process-exit functions.

### Listener close confused with graceful drain

**Risk:** Closing a listener directly can stop admission without correctly coordinating active requests and can surface misleading network errors.

**Resolution:** Go uses `http.Server.Shutdown(ctx)` for graceful drain and `Close()` only for force. Node uses `server.close()` for graceful admission stop and `closeAllConnections()` only during force. Rust, Dart, and OTP integrations preserve the same two-phase distinction through their framework-native hooks.

### Unbounded graceful or force cleanup

**Risk:** A stuck request, telemetry exporter, cleanup callback, or WebSocket can block termination forever.

**Resolution:** Graceful and force phases are independently deadline-bounded. A graceful deadline escalates to force. Force hooks and telemetry flushing cannot hold the process indefinitely.

### Duplicate telemetry flushes

**Risk:** A timeout, second signal, and graceful completion can race and invoke non-idempotent exporter shutdown more than once.

**Resolution:** The lifecycle coordinators serialize state transitions and execute the flush hook exactly once across graceful/force races.

### Ambiguous interactive shutdown

**Risk:** Development servers often terminate too aggressively on the first Ctrl-C, while production workloads need one signal to begin the full termination sequence.

**Resolution:** Non-TTY execution begins graceful shutdown on the first SIGINT or SIGTERM. TTY execution starts graceful shutdown on the first request and requires a second request for force; stdin EOF (Ctrl-D) is accepted as that force request. Timeout escalation remains active in both modes.

## Residual risks and required controls

### Logged-in user data is potentially sensitive

The context carrier can hold user information, but applications must define an allowlist for fields emitted to logs. Passwords, raw tokens, session cookies, recovery codes, government identifiers, payment data, and unrestricted profile objects must never be attached. Transport-level redaction remains mandatory.

### Context size is application-controlled

Large baggage, metadata, or user payloads can increase allocations and log volume. Applications should cap baggage cardinality, field depth, serialized size, and per-request enrichment. The generic context library intentionally does not silently truncate business data.

### Active upgraded protocols are application-owned

`server.closeAllConnections()` and framework graceful APIs do not universally cover every WebSocket, HTTP/2 session, upgraded stream, Go hijacked connection, detached Tokio task, or linked BEAM process. Each server must register a force hook for resources it owns and test it under load.

### Signal support differs by platform

Unix exposes SIGINT and SIGTERM directly. Windows, browser, worker, mobile, and embedded targets expose different lifecycle events. A repository must document unsupported inputs and map the same state machine onto the lifecycle events its platform actually provides.

### Ctrl-D is stdin EOF, not a signal

Ctrl-D behavior exists only where an interactive stdin stream is attached and raw terminal configuration does not consume it differently. Services without stdin still rely on SIGINT/SIGTERM and deadline escalation.

### OTP owns application lifecycle

In production BEAM releases, supervision and application stop callbacks are the graceful path. `erlang:halt/1` is only a last-resort force mechanism. A wrapper script or release handler may be required to implement the exact second-request/Ctrl-D policy without fighting the VM's own signal handling.

### Rust task abortion is not resource cleanup

Aborting a Tokio task drops its future; it does not guarantee that external systems observe a clean application-level close. Force hooks must explicitly close owned sockets, queues, leases, and telemetry providers before a final abort deadline.

### Go request context is not goroutine-local storage

Only code that receives the derived `context.Context` can access request state. Spawning background goroutines with `context.Background()` intentionally drops request context. Callers must choose whether to pass a bounded snapshot or detach from the request.

### Dart Zones do not cross isolates

An isolate receives only explicitly serialized state. User and trace snapshots must be validated again at the isolate boundary, and secrets should not be copied merely for logging convenience.

### Text audit is not behavioral proof

The lifecycle auditor locates evidence and classifies risk. It cannot prove ordering, deadlines, connection draining, or data isolation. Test-organization canaries must exercise the behavioral matrix before production promotion.

## Required release gates

- TypeScript compilation and Node lifecycle/context tests.
- Go tests under the race detector.
- Rust formatting, unit tests, thread-local tests, and Tokio task-local tests.
- Dart analyzer/tests for Zone context and signal escalation.
- Gleam formatting/tests plus Erlang FFI compilation.
- Audit classifier tests and JSON report generation.
- Exact-head CI checks on the draft PR.
- Matching `*-test` canary evidence before production rollout.

## Security conclusion

The shared implementation removes the highest-risk inconsistencies: mutable ambient state, implicit process mutation, listener-only shutdown, unbounded cleanup, duplicate flushes, and ambiguous interactive behavior. Remaining risk is primarily integration-specific and is therefore controlled through explicit force hooks, data allowlists, platform exceptions, and test-organization promotion gates rather than hidden behind a misleading universal abstraction.
