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
