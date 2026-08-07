# Prometheus metrics without runtime patching

`@oresoftware/next-loggers/prometheus` exposes bounded logger and transport
metrics in the Prometheus text format. It uses explicit registry calls and an
explicit `LogTransport` decorator. It never patches `fetch`, HTTP clients,
console methods, module loading, prototypes, or OpenTelemetry globals.

## Basic endpoint

```ts
import { createServer } from 'node:http';
import {
  InstrumentedTransport,
  createLoggerMetrics,
  observeLoggerRecord,
  updatePendingLogGauge,
} from '@oresoftware/next-loggers/prometheus';
import { createNodeLogger } from '@oresoftware/next-loggers/node';

const { registry, metrics } = createLoggerMetrics();
const otlp = new InstrumentedTransport({
  transport: applicationOwnedOtlpTransport,
  metrics,
  onMetricError(error, operation) {
    process.stderr.write(`[logger metrics:${operation}] ${String(error)}\n`);
  },
});

const logger = createNodeLogger({
  appName: 'billing-api',
  console: false,
  transports: [otlp],
});

// Count the record once before transport fan-out. Do not place this call inside
// every transport or a record sent to three transports will be counted three times.
const record = logger.info('ready').toRecord();
observeLoggerRecord(metrics, record);
await otlp.write(record);
updatePendingLogGauge(metrics, logger.pendingCount());

createServer((request, response) => {
  if (request.url !== '/metrics') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(registry.render());
}).listen(9465, '127.0.0.1');
```

Use the framework's existing request/response adapter when it already has one;
there is no requirement to create a second HTTP server.

## Built-in metrics

`createLoggerMetrics()` creates:

- `next_loggers_records_total{level,runtime}`
- `next_loggers_transport_writes_total{transport,outcome}`
- `next_loggers_transport_write_duration_seconds{transport}`
- `next_loggers_transport_in_flight{transport}`
- `next_loggers_transport_dropped_total{transport,reason}`
- `next_loggers_pending_writes`

These dimensions are intentionally small and bounded. Trace IDs, span IDs,
record IDs, request IDs, user IDs, URLs with identifiers, exception messages,
and arbitrary log fields belong in structured logs, not metric labels.

## Cardinality guard

Every labeled metric has a `maxSeries` limit. One slot is reserved for a
`__overflow__` series; after the ordinary series budget is exhausted, unseen
label combinations collapse into that series. Label values are length-bounded
before they become series keys.

```ts
const events = registry.counter('next_loggers_custom_events_total', {
  help: 'Bounded custom logger events.',
  labelNames: ['kind'],
  maxSeries: 50,
  maxLabelValueLength: 64,
});
```

The overflow series is a safety valve, not a reason to accept unbounded labels.
Alert on overflow and fix the caller's label design.

## Failure ownership

The decorated transport remains the primary operation:

- a transport failure is rethrown unchanged;
- a metric failure cannot convert a successful transport write into a failure;
- diagnostic callback failures are swallowed to prevent recursive logging;
- in-flight gauges are decremented only when their increment succeeded;
- invalid clocks skip the duration observation rather than emitting nonsense.

The application owns registry exposure and lifecycle. No background endpoint,
global singleton, or OpenTelemetry provider is registered by this package.
