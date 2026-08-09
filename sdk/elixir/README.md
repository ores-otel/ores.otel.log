# oresoftware_next_loggers_elixir

Dependency-free Elixir implementation of the shared `next-loggers/v1`
structured logging contract. Context is scoped to the current BEAM process and
restored after each callback. OpenTelemetry and Supabase are injected
transports; the package installs no global instrumentation.
