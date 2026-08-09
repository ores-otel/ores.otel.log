import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
    timestamp: '2026-08-02T00:00:00.000Z',
    level: 'INFO',
    runtime: 'node',
    appName: 'payments',
    message: 'ready',
    values: ['ready'],
    fields: {},
    ...overrides,
  };
}

test('registry renders counters, gauges, and cumulative histograms in Prometheus text format', async () => {
  const registry = new PrometheusRegistry();
  const counter = registry.counter('requests_total', {
    help: 'Requests\\received\nfrom clients',
    labelNames: ['method'],
  });
  const gauge = registry.gauge('workers_active', {
    help: 'Active workers',
  });
  const histogram = registry.histogram('request_seconds', {
    help: 'Request duration',
    labelNames: ['route'],
    buckets: [0.1, 0.5, 1],
  });

  counter.inc({ method: 'GET' });
  counter.inc({ method: 'GET' }, 2);
  gauge.set(undefined, 3);
  histogram.observe({ route: '/v1/items' }, 0.25);
  histogram.observe({ route: '/v1/items' }, 0.75);

  const rendered = registry.render();
  assert.match(rendered, /# HELP requests_total Requests\\\\received\\nfrom clients/u);
  assert.match(rendered, /requests_total\{method="GET"\} 3/u);
  assert.match(rendered, /workers_active 3/u);
  assert.match(rendered, /request_seconds_bucket\{route="\/v1\/items",le="0.1"\} 0/u);
  assert.match(rendered, /request_seconds_bucket\{route="\/v1\/items",le="0.5"\} 1/u);
  assert.match(rendered, /request_seconds_bucket\{route="\/v1\/items",le="1"\} 2/u);
  assert.match(rendered, /request_seconds_bucket\{route="\/v1\/items",le="\+Inf"\} 2/u);
  assert.match(rendered, /request_seconds_sum\{route="\/v1\/items"\} 1/u);
  assert.match(rendered, /request_seconds_count\{route="\/v1\/items"\} 2/u);

  const response = registry.response();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    response.headers.get('content-type'),
    'text/plain; version=0.0.4; charset=utf-8',
  );
  assert.equal(await response.text(), rendered);
});

test('series and label values are bounded with a reserved overflow series', () => {
  const registry = new PrometheusRegistry();
  const counter = registry.counter('route_hits_total', {
    help: 'Route hits',
    labelNames: ['route'],
    maxSeries: 2,
    maxLabelValueLength: 12,
  });

  counter.inc({ route: '/first' });
  counter.inc({ route: '/second' });
  counter.inc({ route: '/third' }, 2);

  const rendered = registry.render();
  const samples = rendered.split('\n').filter((line) => line.startsWith('route_hits_total{'));
  assert.equal(samples.length, 2);
  assert.match(rendered, /route_hits_total\{route="\/first"\} 1/u);
  assert.match(rendered, /route_hits_total\{route="__overflow__"\} 3/u);
  assert.equal(counter.get({ route: '/second' }), 3);

  const bounded = registry.gauge('bounded_label', {
    help: 'Bounded label',
    labelNames: ['value'],
    maxLabelValueLength: 8,
  });
  bounded.set({ value: 'abcdefghij' }, 1);
  assert.match(registry.render(), /bounded_label\{value="abcdefg…"\} 1/u);
});

test('registry rejects invalid labels and exposition-name collisions', () => {
  const registry = new PrometheusRegistry();
  assert.throws(
    () => registry.counter('bad-name', { help: 'bad' }),
    /Invalid Prometheus metric name/u,
  );
  assert.throws(
    () => registry.counter('valid_name', { help: 'bad', labelNames: ['__name__'] }),
    /reserved Prometheus label/u,
  );
  registry.histogram('latency_seconds', { help: 'Latency' });
  assert.throws(
    () => registry.counter('latency_seconds_bucket', { help: 'Collision' }),
    /exposition name is already registered/u,
  );
});

test('logger helpers use bounded dimensions and count records only once at the logger boundary', () => {
  const { registry, metrics } = createLoggerMetrics();
  observeLoggerRecord(metrics, record());
  updatePendingLogGauge(metrics, 4);
  observeTransportDrop(metrics, 'supabase-ingest', 'queue-full', 2);

  const rendered = registry.render();
  assert.match(rendered, /next_loggers_records_total\{level="INFO",runtime="node"\} 1/u);
  assert.match(rendered, /next_loggers_pending_writes 4/u);
  assert.match(
    rendered,
    /next_loggers_transport_dropped_total\{transport="supabase-ingest",reason="queue-full"\} 2/u,
  );
  assert.equal(rendered.includes('record-1'), false);
});

test('instrumented transport preserves the inner result even when metrics fail', async () => {
  const { registry, metrics } = createLoggerMetrics();
  const times = [1_000, 1_250, 2_000, 2_500];
  const writes = [];
  const success = new InstrumentedTransport({
    transport: {
      name: 'memory',
      write(value) {
        writes.push(value);
      },
    },
    metrics,
    now: () => times.shift() ?? 0,
  });
  await success.write(record());
  assert.equal(writes.length, 1);
  assert.match(
    registry.render(),
    /next_loggers_transport_writes_total\{transport="memory",outcome="success"\} 1/u,
  );
  assert.match(
    registry.render(),
    /next_loggers_transport_write_duration_seconds_sum\{transport="memory"\} 0.25/u,
  );

  const expected = new Error('collector unavailable');
  const failure = new InstrumentedTransport({
    transport: {
      name: 'failing',
      write() {
        throw expected;
      },
    },
    metrics,
    now: () => times.shift() ?? 0,
  });
  await assert.rejects(failure.write(record()), (error) => error === expected);
  assert.match(
    registry.render(),
    /next_loggers_transport_writes_total\{transport="failing",outcome="failure"\} 1/u,
  );

  const metricFailures = [];
  const brokenMetrics = {
    records: { inc() { throw new Error('records metric failed'); } },
    transportWrites: { inc() { throw new Error('write metric failed'); } },
    transportDurationSeconds: { observe() { throw new Error('duration metric failed'); } },
    transportInFlight: {
      inc() { throw new Error('in-flight metric failed'); },
      dec() { throw new Error('in-flight metric failed'); },
    },
    transportDropped: { inc() { throw new Error('drop metric failed'); } },
    pendingLogs: { set() { throw new Error('pending metric failed'); } },
  };
  let delivered = false;
  const isolated = new InstrumentedTransport({
    transport: { write() { delivered = true; } },
    metrics: brokenMetrics,
    now: () => 1,
    onMetricError: (error, operation) => metricFailures.push([operation, error.message]),
  });
  await isolated.write(record());
  assert.equal(delivered, true);
  assert.deepEqual(metricFailures.map(([operation]) => operation), [
    'in-flight-inc',
    'write-success',
    'in-flight-dec',
    'write-duration',
  ]);
});
