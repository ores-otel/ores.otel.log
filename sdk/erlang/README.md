# oresoftware_next_loggers_erlang

Dependency-free Erlang implementation of the shared `next-loggers/v1`
structured logging contract. Context is process-local and restored after each
callback. OpenTelemetry and Supabase are injected transports; no global runtime
instrumentation is installed.

## Per-event OpenTelemetry routing

Logger maps default `otel` to `true`. Existing `info/3`, `error/3`, and `log/4`
calls still send immediately; `event/4` exposes the explicit chain:

```erlang
Logger = next_loggers:not_otel(next_loggers:new(<<"app">>, <<"erlang">>, Transports)),
next_loggers:send(next_loggers:use_otel(
    next_loggers:event(Logger, <<"INFO">>, <<"sampled in">>, #{}))),
next_loggers:send(next_loggers:not_otel(
    next_loggers:event(Logger, <<"WARN">>, <<"OTEL excluded">>, #{}))).
```

`with_otel/2`, `reset_otel/1`, and `is_otel_enabled/2` provide the computed and
fallback forms; `set_otel_enabled/2`, `use_otel/1`, and `not_otel/1` also accept
logger maps. OTEL transports are tagged by `otel_transport/1`; all other
transports still receive excluded records.
