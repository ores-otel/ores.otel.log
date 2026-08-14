# oresoftware-next-loggers

Ruby implementation of the shared `next-loggers/v1` structured logging contract.
It uses scoped thread-local context and never patches Ruby, OpenTelemetry, HTTP,
or application globals. Applications own the OTEL and Supabase sinks.

```ruby
require "oresoftware/next_loggers"

logger = ORESoftware::NextLoggers::Logger.new(app_name: "payments")
record = ORESoftware::NextLoggers.with_context(trace_id: "trace-1") do
  logger.info("charged order", orderId: "order-42")
end
```

## Per-event OpenTelemetry routing

`otel: true` is the logger default. Immediate level calls stay compatible;
use `event` for an explicit override chain:

```ruby
log = ORESoftware::NextLoggers::Logger.new(app_name: "app", otel: false, transports: transports)
log.event(:info, "sampled in").use_otel.send
log.event(:warn, "OTEL excluded").not_otel.send
log.event(:info, "computed").with_otel(route_to_otel).send
```

`reset_otel` restores the logger default and `otel_enabled?(fallback)` resolves
it. Logger `set_otel_enabled`, `use_otel`, and `not_otel` update the default.
Only OTEL-marked/named transports are filtered.
