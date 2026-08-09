# Prometheus metrics

`@oresoftware/next-loggers/prometheus` provides a dependency-free Prometheus
registry plus explicit transport instrumentation. It does not patch HTTP,
`fetch`, console methods, module loading, or runtime internals.

## Cardinality rules

Prometheus labels must remain bounded. The supplied logger metrics use only:

- log level and runtime at the logger boundary;
- transport name and bounded outcome/reason values at transport boundaries.

Never use record IDs, trace/span IDs, request IDs, user IDs, raw URLs, exception
messages, or arbitrary log fields as labels. Those values belong in structured
logs and OTEL attributes, not metric series.

Each metric has a configurable `maxSeries`. One series is reserved for an
`__overflow__` label tuple so previously unseen combinations collapse into a
bounded bucket instead of creating unbounded memory and Prometheus series.
Label values are length-bounded before storage and exposition.

## Registry and metrics endpoint

```ts
import {
  createLoggerMetrics,
  observeLoggerRecord,
  updatePendingLogGauge,
} from '@oresoftware/next-loggers/prometheus';
import { getPendingLogCount } from '@oresoftware/next-loggers/base';

const { registry, metrics } = createLoggerMetrics();

observeLoggerRecord(metrics, record); // once, before transport fan-out
updatePendingLogGauge(metrics, getPendingLogCount());

export function metricsResponse(): Response {
  return registry.response();
}
```

`registry.response()` emits Prometheus text format with `cache-control: no-store`.
Protect the endpoint with network policy or authentication when it is not
cluster-internal.

## Explicit transport instrumentation

```ts
import {
  InstrumentedTransport,
  createLoggerMetrics,
} from '@oresoftware/next-loggers/prometheus';
import { createOpenTelemetryTransport } from '@oresoftware/next-loggers/otel';

const { metrics } = createLoggerMetrics();
const transport = new InstrumentedTransport({
  metrics,
  transport: createOpenTelemetryTransport({
    logger: applicationOwnedOtelLogger,
  }),
  onMetricError(error, operation) {
    process.stderr.write(`[logger metrics:${operation}] ${String(error)}\n`);
  },
});
```

Metric failures are isolated and cannot replace the result of the wrapped
transport. The decorator delegates `flush`, `flushOnExit`, and `close` without
assuming ownership of the wrapped transport or any shared telemetry provider.

## Default metric set

`createLoggerMetrics()` registers:

- `next_loggers_records_total`
- `next_loggers_transport_writes_total`
- `next_loggers_transport_write_duration_seconds`
- `next_loggers_transport_in_flight`
- `next_loggers_transport_dropped_total`
- `next_loggers_pending_writes`

Count a record once with `observeLoggerRecord`; do not increment it once per
transport. Transport write metrics intentionally describe fan-out separately.
