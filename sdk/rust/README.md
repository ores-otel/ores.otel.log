# oresoftware-next-loggers

Rust implementation of the repository's
[`next-loggers/v1`](../../contracts/README.md) structured logging contract.

```rust
use next_loggers::{Logger, MemoryTransport, Options};
use std::sync::Arc;

let transport = Arc::new(MemoryTransport::default());
let logger = Logger::new(Options::default().with_transport(transport.clone()));
logger.info(vec!["hello".into()]).send()?;
logger.close()?;
# Ok::<(), next_loggers::LoggerError>(())
```

`OpenTelemetryTransport` emits the shared OTEL bridge record through an
application-owned closure; `SupabaseTransport` sends the complete
`next-loggers/v1` record through an injected authenticated client. Both are
dependency-free `Transport` implementations and install no global providers.

```rust
let otel = Arc::new(next_loggers::OpenTelemetryTransport::new(|record| {
    otel_logger.emit(record)
}));
let supabase = Arc::new(next_loggers::SupabaseTransport::new(send_to_supabase));
```
