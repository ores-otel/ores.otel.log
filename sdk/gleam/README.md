# oresoftware_next_loggers

Gleam implementation of the shared `next-loggers/v1` contract.

The public `Logger`, `LogEvent`, `LogRecord`, `Options`, `Level`, and
`Transport` types use normal Gleam composition. An OTP actor owns pending
events, making `flush_on_exit` and `close` recover event values whose `send`
was omitted.

```gleam
import gleam/json
import oresoftware_next_loggers as logging

let options =
  logging.options(
    "payments",
    "gleam",
    fn() { "replace-with-an-id" },
    fn() { "2026-01-02T03:04:05.000Z" },
  )
let logger = logging.new(options, logging.noop_transport())

let assert Ok(_) =
  logging.info(logger, "charged order", [json.string("charged order")])
  |> logging.add_fields([#("orderId", json.string("order-42"))])
  |> logging.send

let assert Ok(Nil) = logging.close(logger)
```

Production applications should provide collision-resistant IDs, UTC RFC 3339
timestamps, and a `Transport` that persists the encoded records.

`otel_transport` converts records to the public `OtelLogRecord` bridge type and
calls an application-owned emitter. `supabase_transport` calls an injected
authenticated sender with the original `LogRecord`. Both are ordinary
transports and install no global providers:

```gleam
let otel = logging.otel_transport(emit_to_otel)
let supabase = logging.supabase_transport(send_to_supabase)
```

## Per-event OpenTelemetry routing

`Options.otel` defaults to `True`. Set it to `False` for opt-in telemetry and
override the event before `send`:

```gleam
let logger = logging.new(logging.Options(..options, otel: False), otel)
logging.info(logger, "sampled in", [])
|> logging.event_use_otel
|> logging.send
logging.warn(logger, "OTEL excluded", [])
|> logging.event_not_otel
|> logging.send
```

`with_otel`, `reset_otel`, and `is_otel_enabled` provide the programmatic
forms. `set_otel_enabled`, `use_otel`, and `not_otel` return a logger carrying
the updated default. A `Transport` is treated as OTEL when `otel` is `True` or
its name is `"opentelemetry"`; regular transports are never suppressed.
