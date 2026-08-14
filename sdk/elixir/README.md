# oresoftware_next_loggers_elixir

Dependency-free Elixir implementation of the shared `next-loggers/v1`
structured logging contract. Context is scoped to the current BEAM process and
restored after each callback. OpenTelemetry and Supabase are injected
transports; the package installs no global instrumentation.

## Per-event OpenTelemetry routing

`NextLoggers.new/2` defaults `otel: true`. Existing level functions still send
immediately; `event/4` supports a pipe-friendly override:

```elixir
log = NextLoggers.new("app", otel: false, transports: transports)
log |> NextLoggers.event("INFO", "sampled in") |> NextLoggers.use_otel() |> NextLoggers.send()
log |> NextLoggers.event("WARN", "OTEL excluded") |> NextLoggers.not_otel() |> NextLoggers.send()
log |> NextLoggers.event("INFO", "computed") |> NextLoggers.with_otel(route_to_otel) |> NextLoggers.send()
```

`reset_otel/1` returns to the logger default and `is_otel_enabled/2` resolves
it. `set_otel_enabled/2`, `use_otel/1`, and `not_otel/1` also update logger
maps. Non-OTEL transports always receive the record.
