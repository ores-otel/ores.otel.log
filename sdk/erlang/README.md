# oresoftware_next_loggers_erlang

Dependency-free Erlang implementation of the shared `next-loggers/v1`
structured logging contract. Context is process-local and restored after each
callback. OpenTelemetry and Supabase are injected transports; no global runtime
instrumentation is installed.
