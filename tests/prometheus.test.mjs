import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Counter,
  InstrumentedTransport,
  PrometheusRegistry,
  createLoggerMetrics,
  observeLoggerRecord,
  observeTransportDrop,
  updatePendingLogGauge,
} from '@oresoftware/next-loggers/prometheus';

function record(overrides = {}) {
  return {
    schema: 'next-loggers/v1',
    id: 'record-1',
    timestamp: '2026-08-03T00:00:00.000Z',
    level: 'INFO',
    runtime: 'node',
    appName: 'payments',
    message: 'ready',
    values: [],
    fields: {},
    ...overrides,
  };
}

test('registry renders valid counter, gauge, and cumulative histogram exposition', async () => {
  const registry = new PrometheusRegistry();
  const counter = registry.counter('requests_total', {
    help: 'Requests\\accepted\nby the service',
    labelNames: ['method'],
  });
  const gauge = registry.gauge('queue_depth', {
    help: 'Current queue depth.',
  });
  const histogram = registry.histogram('request_duration_seconds', {
    help: 'Request duration.',
    labelNames: ['route'],
    buckets: [0.1, 0.5, 1],
  });

  counter.inc({ method: 'GET' });
  counter.inc({ method: 'GET' }, 2);
  counter.inc({ method: 'POST\n"quoted"' });
  gauge.set(undefined, 4);
  histogram.observe({ route: '/health' }, 0.05);
  histogram.observe({ route: '/health' }, 0.75);

  const rendered = registry.render();
  assert.match(rendered, /# HELP requests_total Requests\\\\accepted\\nby the service/u);
  assert.match(rendered, /requests_total\{method="GET"\} 3/u);
  assert.match(rendered, /requests_total\{method="POST\\n\\"quoted\\""\} 1/u);
  assert.match(rendered, /queue_depth 4/u);
  assert.match(rendered, /request_duration_seconds_bucket\{route="\/health",le="0.1"\} 1/u);
  assert.match(rendered, /request_duration_seconds_bucket\{route="\/health",le="0.5"\} 1/u);
  assert.match(rendered, /request_duration_seconds_bucket\{route="\/health",le="1"\} 2/u);
  assert.match(rendered, /request_duration_seconds_bucket\{route="\/health",le="\+Inf"\} 2/u);
  assert.match(rendered, /request_duration_seconds_sum\{route="\/health"\} 0.8/u);
  assert.match(rendered, /request_duration_seconds_count\{route="\/health"\} 2/u);

  const response = registry.response();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
  assert.equal(await response.text(), rendered);
});

test('series and label bounds collapse untrusted dimensions into one overflow series', () => {
  const counter = new Counter('events_total', {
    help: 'Bounded events.',
    labelNames: ['tenant'],
    maxSeries: 3,
    maxLabelValueLength: 6,
  });

  counter.inc({ tenant: 'alpha' });
  counter.inc({ tenant: 'bravo-too-long' });
  counter.inc({ tenant: 'charlie' });
  counter.inc({ tenant: 'delta' }, 2);

  const rendered = counter.render().join('\n');
  assert.match(rendered, /events_total\{tenant="alpha"\} 1/u);
  assert.match(rendered, /events_total\{tenant="bravo…"\} 1/u);
  assert.match(rendered, /events_total\{tenant="__overflow__"\} 3/u);
  assert.equal((rendered.match(/^events_total\{/gmu) ?? []).length, 3);
  assert.equal(counter.get({ tenant: 'charlie' }), 3);
  assert.equal(counter.get({ tenant: 'anything-new' }), 3);
});

test('invalid labels, non-finite values, negative counters, and exposition collisions fail closed', () => {
  const registry = new PrometheusRegistry();
  assert.throws(
    () => registry.counter('bad-name', { help: 'bad' }),
    /Invalid Prometheus metric name/u,
  );
  assert.throws(
    () => registry.counter('good_name', { help: 'bad', labelNames: ['__name__'] }),
    /reserved Prometheus label/u,
  );
  assert.throws(
    () => registry.counter('dupe', { help: 'bad', labelNames: ['kind', 'kind'] }),
    /duplicate label/u,
  );

  const counter = registry.counter('safe_total', { help: 'safe', labelNames: ['kind'] });
  assert.throws(() => counter.inc({ unknown: 'x' }), /Unknown Prometheus labels/u);
  assert.throws(() => counter.inc({ kind: 'x' }, -1), /cannot decrease/u);
  assert.throws(() => counter.inc({ kind: 'x' }, Number.NaN), /must be finite/u);

  registry.histogram('latency_seconds', { help: 'latency' });
  assert.throws(
    () => registry.counter('latency_seconds_sum', { help: 'collision' }),
    /exposition name is already registered/u,
  );
});

test('transport instrumentation preserves the primary result and keeps record counts at the logger boundary', async () => {
  const { registry, metrics } = createLoggerMetrics();
  const delivered = [];
  const clock = [100, 350];
  const transport = new InstrumentedTransport({
    transport: {
      name: 'memory',
      write(value) {
        delivered.push(value);
      },
    },
    metrics,
    now: () => clock.shift(),
  });

  const value = record();
  observeLoggerRecord(metrics, value);
  await transport.write(value);
  updatePendingLogGauge(metrics, 7);
  observeTransportDrop(metrics, 'supabase-ingest', 'queue-full', 2);

  assert.deepEqual(delivered, [value]);
  assert.equal(metrics.records.get({ level: 'INFO', runtime: 'node' }), 1);
  assert.equal(metrics.transportWrites.get({ transport: 'memory', outcome: 'success' }), 1);
  assert.equal(metrics.transportInFlight.get({ transport: 'memory' }), 0);
  assert.equal(metrics.pendingLogs.get(), 7);
  assert.equal(
    metrics.transportDropped.get({ transport: 'supabase-ingest', reason: 'queue-full' }),
    2,
  );
  assert.match(
    registry.render(),
    /next_loggers_transport_write_duration_seconds_sum\{transport="memory"\} 0.25/u,
  );

  const expected = new Error('collector down');
  const failing = new InstrumentedTransport({
    transport: {
      name: 'otlp',
      write() {
        throw expected;
      },
    },
    metrics,
    now: () => 500,
  });
  await assert.rejects(failing.write(record()), (error) => error === expected);
  assert.equal(metrics.transportWrites.get({ transport: 'otlp', outcome: 'failure' }), 1);
});

test('metric and diagnostic failures never replace a successful transport write', async () => {
  const operations = [];
  let delivered = 0;
  const throwingMetric = {
    inc() {
      throw new Error('metric unavailable');
    },
    dec() {
      throw new Error('metric unavailable');
    },
    set() {
      throw new Error('metric unavailable');
    },
    observe() {
      throw new Error('metric unavailable');
    },
  };
  const transport = new InstrumentedTransport({
    transport: {
      name: 'primary',
      write() {
        delivered += 1;
      },
    },
    metrics: {
      records: throwingMetric,
      transportWrites: throwingMetric,
      transportDurationSeconds: throwingMetric,
      transportInFlight: throwingMetric,
      transportDropped: throwingMetric,
      pendingLogs: throwingMetric,
    },
    now() {
      throw new Error('clock unavailable');
    },
    onMetricError(error, operation) {
      operations.push([operation, error.message]);
      throw new Error('diagnostic unavailable');
    },
  });

  await transport.write(record());
  assert.equal(delivered, 1);
  assert.deepEqual(operations, [
    ['clock-start', 'clock unavailable'],
    ['in-flight-inc', 'metric unavailable'],
    ['write-success', 'metric unavailable'],
  ]);
});
