# oresoftware-next-loggers-context

Execution-context and shutdown-policy companion for the Rust
`oresoftware-next-loggers` SDK.

## Context model

- `LogContext` carries user, trace/span, trace flags/state, baggage, fields,
  routine ID, tags, context, and metadata.
- `with_thread_context` is an RAII/LIFO scope for synchronous work. Its guard is
  deliberately neither `Send` nor `Sync`.
- `with_task_context` uses a Tokio task local and is the preferred ambient scope
  for async server code.
- `spawn_with_current_context` snapshots and explicitly propagates the active
  context into a newly spawned Tokio task.
- `LoggerContextExt` adds explicit (`info_with_context`) and ambient
  (`info_ambient`) event constructors without colliding with the canonical SDK's
  inherent `info_context(values)` ambient API.

```rust
use next_loggers::{json, JsonObject, Logger, Options, Value};
use oresoftware_next_loggers_context::{
    spawn_with_current_context, with_task_context, LogContext, LoggerContextExt,
};

let logger = Logger::new(Options::default());
let mut user = JsonObject::new();
user.insert("id".into(), Value::String("user-1".into()));

with_task_context(
    LogContext {
        logged_in_user: user,
        trace_id: Some("trace-1".into()),
        span_id: Some("span-1".into()),
        trace_flags: Some(0),
        ..LogContext::default()
    },
    async {
        let _event = logger.info_ambient(vec![json!("request accepted")]);
        spawn_with_current_context(async move {
            // The child sees the captured task context.
        })
        .await
        .expect("child task");
    },
)
.await;
```

Tokio task locals are scoped and are not inherited by ordinary `tokio::spawn`.
Use the helper or pass `LogContext` explicitly.

## Shutdown policy

`ShutdownState` is framework-neutral:

- first event: `BeginGraceful`;
- second event while draining: `Force`;
- timeout while draining: `Force`;
- events after force/close: `Ignore`.

With the `tokio` feature, `tokio_support::next_shutdown_cause()` waits for
SIGINT, SIGTERM (Unix), or optional stdin EOF. Call it once to begin graceful
shutdown and again while the server drains so a second Ctrl-C or Ctrl-D can
force. `stdin_is_terminal()` selects the interactive policy.

For Axum/Hyper/tonic, map `BeginGraceful` to the framework's graceful-shutdown
future/cancellation token. Map `Force` to aborting the server task and closing
WebSockets, HTTP/2 sessions, and application-owned task groups.
