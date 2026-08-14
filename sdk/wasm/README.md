# oresoftware-next-loggers-wasm

WASM-safe Rust implementation of the shared `next-loggers/v1` structured
logging contract. Context and telemetry sinks are injected explicitly; the
crate does not install global OpenTelemetry providers or patch a host runtime.

The crate is suitable for `wasm32-unknown-unknown` and native conformance tests.

## Per-event OpenTelemetry routing

OpenTelemetry is enabled by default. Configure an opt-in logger with
`with_otel_enabled(false)` and use `event` for a record override:

```rust
let logger = Logger::new("app")?.with_otel_enabled(false);
logger.event(LogLevel::Info, "sampled in", None, BTreeMap::new()).use_otel().send()?;
logger.event(LogLevel::Warn, "OTEL excluded", None, BTreeMap::new()).not_otel().send()?;
logger.event(LogLevel::Info, "computed", None, BTreeMap::new()).with_otel(route_to_otel).send()?;
```

`reset_otel()` restores the logger default and `is_otel_enabled(fallback)`
resolves it. Mutable `set_otel_enabled` updates an existing logger; the builder
`use_otel`/`not_otel` forms set the inherited default. Regular host transports
still receive records excluded from OTEL.
