# oresoftware-next-loggers

Python implementation of the repository's
[`next-loggers/v1`](../../contracts/README.md) structured logging contract.

```python
from next_loggers import Logger, MemoryTransport

transport = MemoryTransport()
log = Logger(app_name="payments", transports=[transport])
log.error("payment failed").add_tags("payments").send()
log.close()
```

`OpenTelemetryTransport` (`OtelTransport` is an alias) converts each record to
the shared OTEL bridge shape and calls an application-owned emitter.
`SupabaseTransport` calls an injected authenticated sender with the complete
`next-loggers/v1` dictionary. Neither adapter installs a global client.

```python
from next_loggers import Logger, OpenTelemetryTransport, SupabaseTransport

log = Logger(
    app_name="payments",
    transports=[
        OpenTelemetryTransport(otel_logger.emit),
        SupabaseTransport(send_to_supabase),
    ],
)
```
