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

## Per-event OpenTelemetry routing

`Options::default().otel` is `true`. Set it to `false` for opt-in telemetry,
then use the chain on any `Event`:

```rust
let logger = Logger::new(Options { otel: false, ..Options::default() });
logger.info(vec![json!("sampled in")]).use_otel().send()?;
logger.warn(vec![json!("OTEL excluded")]).not_otel().send()?;
logger.info(vec![json!("computed")]).with_otel(route_to_otel).send()?;
```

`reset_otel()` restores the logger default and
`is_otel_enabled(fallback)` resolves it. Logger-level `set_otel_enabled`,
`use_otel`, and `not_otel` update the inherited default. Non-OTEL transports
always retain the record.

## `.ores-otel.toml` and APM metrics

`next_loggers::config` loads the cross-language
[`.ores-otel.toml`](../../docs/ores-otel-config.md) contract without extra
dependencies: a strict TOML-subset reader, strict v1 key/range checks, role
selection, `ORES_OTEL_*` environment and flags-2-env overrides, and a
`to_json_value()` rendering identical to the shared parity fixtures.

```rust
use next_loggers::config::{load_ores_otel_config, LoadOptions, RuntimeRole};

let options = LoadOptions::from_process_env();
let options = LoadOptions {
    resolve: options.resolve.with_role(RuntimeRole::Server).with_flag_overrides(flags_2_env_map),
    ..options
};
let loaded = load_ores_otel_config(options)?; // missing file => defaults
```

`next_loggers::apm` turns snapshots into OpenTelemetry semantic-convention
points (`resource_metric_points`, `LatencyHistogramSnapshot::metric_point`) and
hands them to any `MetricSink` (closures implement it), so an application's
own `Meter` stays in charge. `ResourceThresholds::from_resolved` and
`LatencyHistogramConfig::from_resolved` bridge resolved config to the samplers.
The `apm` feature enables live process sampling on Linux and macOS and
filesystem sampling on Unix.
