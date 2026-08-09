import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import {
  PrometheusRegistry,
  createLoggerPrometheusMetrics,
  isErrorLevel,
} from '@oresoftware/next-loggers/prometheus';

function lines(text, prefix) {
  return text.split('\n').filter((line) => line.startsWith(prefix));
}

test('empty registry renders a valid empty exposition snapshot', () => {
  const registry = new PrometheusRegistry();
  assert.equal(registry.render(), '\n');
});

test('non-positive maxSeriesPerMetric is clamped to one series', () => {
  for (const limit of [0, -1, -100]) {
    const registry = new PrometheusRegistry({ maxSeriesPerMetric: limit });
    const counter = registry.counter({
      name: `bounded_${Math.abs(limit)}_total`,
      help: 'Bounded',
      labelNames: ['key'],
    });
    counter.inc({ key: 'first' });
    counter.inc({ key: 'second' });
    const output = registry.render();
    assert.match(output, /key="first"\} 1/);
    assert.doesNotMatch(output, /key="second"/);
    assert.match(output, /dropped_series_total.* 1/);
  }
});

test('fractional maxSeriesPerMetric is floored deterministically', () => {
  const registry = new PrometheusRegistry({ maxSeriesPerMetric: 2.99 });
  const counter = registry.counter({
    name: 'fractional_total',
    help: 'Fractional',
    labelNames: ['key'],
  });
  counter.inc({ key: 'a' });
  counter.inc({ key: 'b' });
  counter.inc({ key: 'c' });
  assert.equal(lines(registry.render(), 'next_loggers_fractional_total{').length, 2);
});

test('already-prefixed metric names are not double-prefixed', () => {
  const registry = new PrometheusRegistry({ prefix: 'checkout' });
  registry.counter({ name: 'checkout_orders_total', help: 'Orders' }).inc();
  const output = registry.render();
  assert.match(output, /checkout_orders_total 1/);
  assert.doesNotMatch(output, /checkout_checkout_orders_total/);
});

test('raw and already-prefixed aliases collide instead of creating duplicate metrics', () => {
  const registry = new PrometheusRegistry({ prefix: 'checkout' });
  registry.counter({ name: 'orders_total', help: 'Orders' });
  assert.throws(
    () => registry.counter({ name: 'checkout_orders_total', help: 'Alias' }),
    /already registered/,
  );
});

test('numeric and boolean labels use stable string representations', () => {
  const registry = new PrometheusRegistry();
  const counter = registry.counter({
    name: 'typed_labels_total',
    help: 'Typed labels',
    labelNames: ['status', 'cached'],
  });
  counter.inc({ status: 204, cached: false });
  assert.match(
    registry.render(),
    /typed_labels_total\{status="204",cached="false"\} 1/,
  );
});

test('mutating the caller label object cannot mutate stored series labels', () => {
  const registry = new PrometheusRegistry();
  const counter = registry.counter({
    name: 'immutable_labels_total',
    help: 'Immutable labels',
    labelNames: ['route'],
  });
  const labels = { route: '/before' };
  counter.inc(labels);
  labels.route = '/after';
  const output = registry.render();
  assert.match(output, /route="\/before"/);
  assert.doesNotMatch(output, /route="\/after"/);
});

test('label ordering follows the declared schema rather than object insertion order', () => {
  const registry = new PrometheusRegistry();
  const counter = registry.counter({
    name: 'ordered_labels_total',
    help: 'Ordered labels',
    labelNames: ['method', 'status'],
  });
  counter.inc({ status: 200, method: 'GET' });
  assert.match(
    registry.render(),
    /ordered_labels_total\{method="GET",status="200"\} 1/,
  );
});

test('gauge add creates a new series and subsequent set replaces its value', () => {
  const registry = new PrometheusRegistry();
  const gauge = registry.gauge({
    name: 'inflight',
    help: 'Inflight',
    labelNames: ['worker'],
  });
  gauge.add(3, { worker: 'a' });
  gauge.set(8, { worker: 'a' });
  gauge.add(-2, { worker: 'a' });
  assert.match(registry.render(), /inflight\{worker="a"\} 6/);
});

test('gauge accepts and preserves exact zero', () => {
  const registry = new PrometheusRegistry();
  registry.gauge({ name: 'queue_depth', help: 'Queue depth' }).set(0);
  assert.match(registry.render(), /next_loggers_queue_depth 0/);
});

test('histogram accepts negative and zero observations', () => {
  const registry = new PrometheusRegistry();
  const histogram = registry.histogram({
    name: 'signed_value',
    help: 'Signed value',
    buckets: [-10, 0, 10],
  });
  for (const value of [-11, -10, -1, 0, 1]) histogram.observe(value);
  const output = registry.render();
  assert.match(output, /signed_value_bucket\{le="-10"\} 2/);
  assert.match(output, /signed_value_bucket\{le="0"\} 4/);
  assert.match(output, /signed_value_bucket\{le="10"\} 5/);
  assert.match(output, /signed_value_count 5/);
  assert.match(output, /signed_value_sum -21/);
});

test('default record-size buckets include exact boundaries cumulatively', async () => {
  const metrics = createLoggerPrometheusMetrics();
  const logger = createLogger({
    appName: 'default-buckets',
    console: false,
    transports: metrics.transport,
  });
  await logger.info('small').send();
  const output = metrics.registry.render();
  assert.match(output, /record_bytes_bucket.*le="64".* [01]/);
  assert.match(output, /record_bytes_bucket.*le="262144".* 1/);
  assert.match(output, /record_bytes_bucket.*le="\+Inf".* 1/);
});

test('repeated render calls are byte-for-byte stable without mutations', () => {
  const registry = new PrometheusRegistry({ prefix: 'stable' });
  registry.counter({ name: 'a_total', help: 'A' }).add(3);
  registry.gauge({ name: 'b', help: 'B' }).set(-2);
  const first = registry.render();
  const second = registry.render();
  assert.equal(second, first);
});

test('a Response captures the registry snapshot at creation time', async () => {
  const registry = new PrometheusRegistry();
  const counter = registry.counter({ name: 'snapshot_total', help: 'Snapshot' });
  counter.inc();
  const first = registry.response();
  counter.add(4);
  const second = registry.response();
  assert.match(await first.text(), /snapshot_total 1/);
  assert.match(await second.text(), /snapshot_total 5/);
});

test('response header objects are isolated between calls', () => {
  const registry = new PrometheusRegistry();
  const first = registry.response({ headers: { 'x-one': '1' } });
  const second = registry.response({ headers: { 'x-two': '2' } });
  assert.equal(first.headers.get('x-one'), '1');
  assert.equal(first.headers.get('x-two'), null);
  assert.equal(second.headers.get('x-one'), null);
  assert.equal(second.headers.get('x-two'), '2');
});

test('separate registries do not share metrics or dropped-series state', () => {
  const left = new PrometheusRegistry({ prefix: 'left', maxSeriesPerMetric: 1 });
  const right = new PrometheusRegistry({ prefix: 'right', maxSeriesPerMetric: 1 });
  const leftCounter = left.counter({
    name: 'work_total',
    help: 'Work',
    labelNames: ['key'],
  });
  const rightCounter = right.counter({
    name: 'work_total',
    help: 'Work',
    labelNames: ['key'],
  });
  leftCounter.inc({ key: 'one' });
  leftCounter.inc({ key: 'two' });
  rightCounter.inc({ key: 'only' });
  assert.match(left.render(), /dropped_series_total/);
  assert.doesNotMatch(right.render(), /dropped_series_total/);
  assert.doesNotMatch(left.render(), /right_/);
  assert.doesNotMatch(right.render(), /left_/);
});

test('INFO records do not increment the error counter', async () => {
  const metrics = createLoggerPrometheusMetrics();
  const logger = createLogger({ console: false, transports: metrics.transport });
  await logger.info('healthy').send();
  const output = metrics.registry.render();
  assert.doesNotMatch(output, /error_records_total\{[^}]*level="INFO"[^}]*\} 1/);
});

test('FATAL records increment records, errors, and correlation counters exactly once', async () => {
  const metrics = createLoggerPrometheusMetrics({ environment: 'production' });
  const logger = createLogger({
    appName: 'fatal-service',
    console: false,
    transports: metrics.transport,
  });
  await logger.fatal('fatal').addTrace('trace-fatal').send();
  const output = metrics.registry.render();
  assert.match(output, /records_total\{[^}]*level="FATAL"[^}]*\} 1/);
  assert.match(output, /error_records_total\{[^}]*level="FATAL"[^}]*\} 1/);
  assert.match(output, /trace_correlated_records_total\{[^}]*level="FATAL"[^}]*\} 1/);
});

test('secondary traceIds without a primary traceId do not claim correlation', () => {
  const metrics = createLoggerPrometheusMetrics();
  metrics.transport.write({
    schema: 'next-loggers/v1',
    id: 'record',
    timestamp: '2026-08-03T00:00:00.000Z',
    level: 'INFO',
    runtime: 'node',
    appName: 'app',
    message: 'message',
    values: [],
    fields: {},
    traceIds: ['secondary-only'],
  });
  const output = metrics.registry.render();
  assert.match(output, /# HELP next_loggers_trace_correlated_records_total/);
  assert.equal(lines(output, 'next_loggers_trace_correlated_records_total{').length, 0);
});

test('isErrorLevel recognizes exactly ERROR and FATAL', () => {
  assert.deepEqual(
    ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].map((level) => [
      level,
      isErrorLevel(level),
    ]),
    [
      ['TRACE', false],
      ['DEBUG', false],
      ['INFO', false],
      ['WARN', false],
      ['ERROR', true],
      ['FATAL', true],
    ],
  );
});

test('ten thousand updates retain a single stable series and exact count', () => {
  const registry = new PrometheusRegistry({ maxSeriesPerMetric: 1 });
  const counter = registry.counter({
    name: 'stress_total',
    help: 'Stress',
    labelNames: ['kind'],
  });
  for (let index = 0; index < 10_000; index += 1) {
    counter.inc({ kind: 'stable' });
  }
  const output = registry.render();
  assert.equal(lines(output, 'next_loggers_stress_total{').length, 1);
  assert.match(output, /kind="stable"\} 10000/);
  assert.doesNotMatch(output, /dropped_series_total/);
});
