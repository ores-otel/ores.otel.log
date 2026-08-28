# Explicit OpenTelemetry integration

`@oresoftware/next-loggers/otel` adapts the stable `next-loggers/v1` record to
application-owned OpenTelemetry log, trace, and metric objects. Application code
continues to call `logger.info(...)`, `logger.error(...)`, and related methods;
OpenTelemetry stays downstream of those calls as a normal logger transport.

## Non-negotiable runtime boundary

This package does **not**:

- register a global tracer, meter, logger, propagator, or context manager;
- install OpenTelemetry automatic instrumentation;
- patch Node.js modules, prototypes, `fetch`, HTTP clients, database drivers,
  console methods, or framework internals;
- use `require-in-the-middle`, `shimmer`, or equivalent hooks;
- import `node:async_hooks` from the browser-safe OTEL adapter.

The application owns SDK startup and passes structural adapters explicitly.
That keeps Node.js, Bun, Deno, workerd, browsers, WASM, Flutter, BEAM, Java, Go,
Rust, Python, and Gleam runtimes consistent and testable.

## TypeScript example

```ts
import { context, logs, metrics, trace } from '@opentelemetry/api';
import { createNodeLogger } from '@oresoftware/next-loggers/node';
import {
  createOpenTelemetryContextProvider,
  createOpenTelemetryTransport,
  withOpenTelemetry,
} from '@oresoftware/next-loggers/otel';

const otelLogger = logs.getLogger('my-service');
const meter = metrics.getMeter('my-service');
const records = meter.createCounter('next_loggers.records');
const errors = meter.createCounter('next_loggers.errors');
const activeSpan = () => trace.getSpan(context.active());

const logger = createNodeLogger({
  appName: 'my-service',
  console: false,
  contextProvider: createOpenTelemetryContextProvider(activeSpan),
  transports: createOpenTelemetryTransport({
    logger: otelLogger,
    activeSpan,
    activeContext: () => context.active(),
    metricAttributes: {
      'deployment.environment.name': 'production',
    },
    recordMetric(name, value, attributes) {
      (name === 'next_loggers.errors' ? errors : records).add(value, attributes);
    },
    onBridgeError(error, operation) {
      // Route this to an application-owned diagnostic sink. Do not feed it back
      // through the same failing OTEL transport.
      process.stderr.write(`[otel bridge:${operation}] ${String(error)}\n`);
    },
  }),
});
```

The OpenTelemetry packages shown above belong to the application, not this
library. `next-loggers` intentionally has no dependency on an OTEL SDK.

## Per-event routing and setup helper

The routing precedence is identical in all 11 SDKs:

1. an event set with `useOtel`/`use_otel` is sent to OTEL;
2. an event set with `notOtel`/`not_otel` is not sent to OTEL;
3. `resetOtel`/`reset_otel` removes that event decision;
4. otherwise the logger `otel` default applies, and defaults to `true`.

The computed form is `withOtel(enabled)` (or `with_otel`) and the resolver is
`isOtelEnabled(fallback)` (or `is_otel_enabled`). Some native SDKs retain their
existing immediate level methods and expose `event`/`event_use_otel` for this
chain; their README contains the exact language-native spelling.

Routing recognizes the built-in OTEL bridge marker and the transport name
`opentelemetry`, so a hand-written bridge can opt into the same behavior. A
record excluded from OTEL continues through every non-OTEL transport.

TypeScript can compose transport and context setup in one call:

```ts
const logger = createNodeLogger(withOpenTelemetry(
  { appName: 'my-service', transports: existingTransports },
  { logger: otelLogger, activeSpan, activeContext: () => context.active() },
));
```

`withOpenTelemetry` appends rather than replaces transports. It derives an OTEL
context provider from `activeSpan` by default, but never replaces an explicitly
supplied `contextProvider`.

## Native SDK bridge contract

Every native SDK exposes an explicit OTEL transport backed by a callback owned
by the application. The callback receives the same logical record:

```json
{
  "body": "payment failed",
  "severityText": "ERROR",
  "severityNumber": 17,
  "timestamp": "2026-01-02T03:04:05.000Z",
  "attributes": {
    "service.name": "payments",
    "next_logger.schema": "next-loggers/v1",
    "next_logger.runtime": "python",
    "log.record.uid": "record-1",
    "trace.id": "0123456789abcdef0123456789abcdef"
  }
}
```

The idiomatic entry points are `OpenTelemetryTransport` in Python, Go, Rust,
Dart, and WASM; `OtelTransport` in Java and Ruby; and `otel_transport` in
Gleam, Erlang, and Elixir. Python also exports `OtelTransport` as an alias.
Each SDK has a matching injected-sender Supabase transport. These adapters do
not take ownership of application OTEL or Supabase clients, so provider startup,
authentication, retries, flush, and shutdown remain explicit at the application
boundary.

### Per-event routing

OTEL delivery defaults to enabled. Disabling it for one event skips only the
transport marked as OpenTelemetry; console, file, memory, Supabase, Loki, and
other application transports still receive the normal `next-loggers/v1`
record. The setting can be changed on the logger and overridden on an event.

The fluent event names are `useOtel`, `notOtel`, `withOtel`, `resetOtel`, and
`isOtelEnabled` in TypeScript, Dart, and Java; their idiomatic snake-case or
exported equivalents are used by Elixir, Erlang, Gleam, Go, Python, and Rust.
Ruby accepts the per-call `otel:` keyword and exposes logger-level
`use_otel`/`not_otel`; the WASM host API uses `log_with_otel` and
`info_with_otel`. The machine-readable symbol mapping for every SDK is in
[`contracts/sdk-manifests`](../contracts/sdk-manifests).

### Explicit span wrappers

Applications can inject their existing tracer/span objects through
`withOpenTelemetrySpan` (TypeScript), `withOtelSpan` (Dart), `withSpan` (Java),
`with_span` (Elixir, Erlang, Gleam, Python, Ruby, Rust, and WASM), or `WithSpan`
(Go). These helpers emit ordinary lifecycle records and wrap only the supplied
OTEL methods. They never create a provider, install instrumentation, or take
over global context.

## Context and sampling semantics

- Node.js, Bun, and Deno can use the package's explicit `AsyncLocalStorage`
  context API from `@oresoftware/next-loggers/context`.
- Rust, Go, Java, Dart, Erlang, Elixir, Gleam, Python, and WASM SDKs use native
  task/thread/process context facilities or explicit context values.
- Browser and workerd builds use explicit request/task context; durable client
  delivery should use an authenticated Supabase ingestion endpoint.
- `createOpenTelemetryContextProvider` reads only the active-span callback the
  application supplies and maps a valid W3C tuple into `traceId`,
  `otel.span_id`, `otel.trace_flags`, `otel.trace_state`, and `otel.remote`.
- A valid **non-recording** span still contributes correlation by default.
  Sampling controls span export; it must not make correlated logs disappear.
  Pass `{ requireRecordingSpan: true }` only when that stricter behavior is
  intentionally required.
- Span events, exception recording, and status updates are performed only for a
  recording span.

The bridge rejects malformed and all-zero W3C trace/span IDs. Attribute count,
string length, primitive-array length, attribute-name length, and trace-state
length are bounded before data reaches an exporter.

## Metric-cardinality boundary

The log payload may contain record IDs, trace IDs, request IDs, users, routes,
and arbitrary fields. Those values are useful in logs but unsafe as metric
labels. `recordMetric` therefore receives only bounded dimensions:

- `service.name`;
- `next_logger.runtime`;
- `next_logger.level`;
- explicit static `metricAttributes` supplied by the application.

Known high-cardinality keys such as `trace.id`, `span.id`, `log.record.uid`, and
`next_logger.field.*` are discarded from `metricAttributes`. Applications must
still keep their remaining custom metric attributes low-cardinality.

## Failure ownership

`logger.emit()` is the primary OTEL log-delivery operation. If it fails, the
transport reports the failure to `next-loggers` in the normal transport path.
Optional bridge effects cannot replace that result:

- active-span/context lookup failures are isolated;
- trace-state serialization failures are isolated;
- span-event, exception, and status failures are isolated independently;
- metric-hook failures are isolated;
- diagnostic callback failures are swallowed to prevent recursive telemetry
  failure.

The application owns OTEL provider startup, flushing, and shutdown. A logger
transport must never shut down a shared provider unless an application-specific
wrapper explicitly grants that ownership.

Pass bound provider methods through `forceFlushCallbacks` when logout or another
application boundary needs export evidence:

```ts
const otelTransport = createOpenTelemetryTransport({
  logger: otelLogger,
  forceFlushCallbacks: [
    loggerProvider.forceFlush.bind(loggerProvider),
    tracerProvider.forceFlush.bind(tracerProvider),
    meterProvider.forceFlush.bind(meterProvider),
  ],
});

// Run while the authenticated exporter/session still exists.
await logger.flush({ timeoutMillis: 2_000, throwOnError: true });
// The application, not ores.otel.log, decides if/when providers shut down.
```

Concurrent flush callers coalesce into one call per callback. Ordinary logger
flushes remain fail-open; `throwOnError: true` makes provider failure or timeout
observable to an authenticated logout coordinator. Neither transport `close()`
nor logger `close()` calls an application-owned provider's `shutdown()`.

## Cluster flow

The supported production flow is:

1. application logger call;
2. explicit OTEL adapter and/or authenticated Supabase client transport;
3. OTLP gRPC/HTTP to an OpenTelemetry Collector;
4. traces to Tempo, logs to Loki, metrics and span metrics to Prometheus;
5. correlation, alerts, and dashboards in Grafana.

Exporters should use bounded queues, retry limits, memory limits, and network
policies. Telemetry failure must not crash the application or silently change
business behavior.
