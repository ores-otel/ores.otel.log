import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PrometheusRegistry,
  createLoggerPrometheusMetrics,
} from '@oresoftware/next-loggers/prometheus';
import { createLogger } from '@oresoftware/next-loggers/base';

function metricLines(text, prefix) {
  return text
    .split('\n')
    .filter((line) => line.startsWith(prefix));
}

test('counter accepts zero and repeated increments for an existing series', () => {
  const registry = new PrometheusRegistry({ prefix: 'service' });
  const counter = registry.counter({
    name: 'requests_total',
    help: 'Requests',
    labelNames: ['method'],
  });
  counter.add(0, { method: 'GET' });
  counter.inc({ method: 'GET' });
  counter.add(4, { method: 'GET' });
  assert.match(
    registry.render(),
    /service_requests_total\{method="GET"\} 5/,
  );
});

test('counter rejects negative and non-finite increments', () => {
  const counter = new PrometheusRegistry().counter({
    name: 'requests_total',
    help: 'Requests',
  });
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => counter.add(value), /non-negative/);
  }
});

test('gauge supports negative values but rejects non-finite values and deltas', () => {
  const registry = new PrometheusRegistry();
  const gauge = registry.gauge({ name: 'temperature', help: 'Temperature' });
  gauge.set(-4);
  gauge.add(1.5);
  gauge.dec();
  assert.match(registry.render(), /next_loggers_temperature -3\.5/);
  assert.throws(() => gauge.set(Number.NaN), /finite value/);
  assert.throws(() => gauge.add(Number.NEGATIVE_INFINITY), /finite delta/);
});

test('histogram boundaries are inclusive and bucket counts are cumulative', () => {
  const registry = new PrometheusRegistry({ prefix: 'api' });
  const histogram = registry.histogram({
    name: 'latency_seconds',
    help: 'Latency',
    buckets: [0.1, 0.5, 1],
  });
  for (const value of [0.1, 0.5, 0.75, 1, 2]) {
    histogram.observe(value);
  }
  const output = registry.render();
  assert.match(output, /api_latency_seconds_bucket\{le="0.1"\} 1/);
  assert.match(output, /api_latency_seconds_bucket\{le="0.5"\} 2/);
  assert.match(output, /api_latency_seconds_bucket\{le="1"\} 4/);
  assert.match(output, /api_latency_seconds_bucket\{le="\+Inf"\} 5/);
  assert.match(output, /api_latency_seconds_count 5/);
  assert.match(output, /api_latency_seconds_sum 4\.35/);
});

test('histogram rejects empty, duplicate, descending, and non-finite buckets', () => {
  const invalid = [
    [],
    [1, 1],
    [2, 1],
    [1, Number.POSITIVE_INFINITY],
    [Number.NaN],
  ];
  for (const buckets of invalid) {
    assert.throws(
      () =>
        new PrometheusRegistry().histogram({
          name: 'latency',
          help: 'Latency',
          buckets,
        }),
      /strictly increasing/,
    );
  }
});

test('histogram rejects non-finite observations', () => {
  const histogram = new PrometheusRegistry().histogram({
    name: 'latency',
    help: 'Latency',
  });
  assert.throws(() => histogram.observe(Number.NaN), /finite observation/);
  assert.throws(
    () => histogram.observe(Number.POSITIVE_INFINITY),
    /finite observation/,
  );
});

test('registry rejects duplicate metric registration across metric types', () => {
  const registry = new PrometheusRegistry({ prefix: 'app' });
  registry.counter({ name: 'work', help: 'Work' });
  assert.throws(
    () => registry.gauge({ name: 'work', help: 'Other work' }),
    /already registered/,
  );
});

test('metric and label identifiers are validated strictly', () => {
  assert.throws(
    () => new PrometheusRegistry({ prefix: 'bad-prefix' }),
    /metric prefix/,
  );
  const registry = new PrometheusRegistry();
  for (const name of ['1bad', 'bad-name', 'bad name']) {
    assert.throws(
      () => registry.counter({ name, help: 'bad' }),
      /identifier/,
    );
  }
  assert.throws(
    () =>
      registry.counter({
        name: 'valid_total',
        help: 'valid',
        labelNames: ['bad-label'],
      }),
    /label name/,
  );
  assert.throws(
    () =>
      registry.counter({
        name: 'valid_total',
        help: 'valid',
        labelNames: ['le'],
      }),
    /reserved/,
  );
});

test('duplicate labels and label-schema drift are rejected', () => {
  const registry = new PrometheusRegistry();
  assert.throws(
    () =>
      registry.counter({
        name: 'requests_total',
        help: 'Requests',
        labelNames: ['route', 'route'],
      }),
    /duplicate/,
  );
  const counter = registry.counter({
    name: 'responses_total',
    help: 'Responses',
    labelNames: ['status'],
  });
  assert.throws(() => counter.inc({}), /missing/);
  assert.throws(
    () => counter.inc({ status: 200, extra: true }),
    /unexpected/,
  );
});

test('HELP text and label values are escaped for exposition format', () => {
  const registry = new PrometheusRegistry({ prefix: 'escape' });
  const counter = registry.counter({
    name: 'records_total',
    help: 'line one\\line two\nline three',
    labelNames: ['value'],
  });
  counter.inc({ value: 'quote" slash\\ newline\n' });
  const output = registry.render();
  assert.match(
    output,
    /# HELP escape_records_total line one\\\\line two\\nline three/,
  );
  assert.match(
    output,
    /value="quote\\" slash\\\\ newline\\n"/,
  );
});

test('existing series continue updating after the cardinality limit is reached', () => {
  const registry = new PrometheusRegistry({ maxSeriesPerMetric: 2 });
  const counter = registry.counter({
    name: 'bounded_total',
    help: 'Bounded',
    labelNames: ['key'],
  });
  counter.inc({ key: 'a' });
  counter.inc({ key: 'b' });
  counter.inc({ key: 'c' });
  counter.add(4, { key: 'a' });
  counter.inc({ key: 'd' });
  const output = registry.render();
  assert.match(output, /key="a"\} 5/);
  assert.match(output, /key="b"\} 1/);
  assert.doesNotMatch(output, /key="c"/);
  assert.doesNotMatch(output, /key="d"/);
  assert.match(output, /dropped_series_total.* 2/);
});

test('metric output is deterministic regardless of registration order', () => {
  const registry = new PrometheusRegistry({ prefix: 'deterministic' });
  registry.gauge({ name: 'zeta', help: 'Zeta' }).set(1);
  registry.counter({ name: 'alpha_total', help: 'Alpha' }).inc();
  registry.histogram({ name: 'middle', help: 'Middle', buckets: [1] }).observe(2);
  const helpLines = registry
    .render()
    .split('\n')
    .filter((line) => line.startsWith('# HELP'));
  assert.deepEqual(helpLines, [
    '# HELP deterministic_alpha_total Alpha',
    '# HELP deterministic_middle Middle',
    '# HELP deterministic_zeta Zeta',
  ]);
});

test('response preserves caller status and headers while enforcing no-store', async () => {
  const registry = new PrometheusRegistry();
  registry.counter({ name: 'ready_total', help: 'Ready' }).inc();
  const response = registry.response({
    status: 202,
    headers: {
      'x-test': 'yes',
      'content-type': 'application/openmetrics-text',
    },
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('x-test'), 'yes');
  assert.equal(response.headers.get('content-type'), 'application/openmetrics-text');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /next_loggers_ready_total 1/);
});

test('logger metrics never promote trace IDs, messages, or arbitrary fields to labels', async () => {
  const metrics = createLoggerPrometheusMetrics({ environment: 'production' });
  const logger = createLogger({
    appName: 'checkout',
    console: false,
    transports: metrics.transport,
  });
  await logger
    .error('card declined')
    .addTrace('trace-secret-123')
    .addFields({ orderId: 'order-high-cardinality', customerId: 'customer-9' })
    .send();
  const output = metrics.registry.render();
  assert.match(output, /app_name="checkout"/);
  assert.match(output, /environment="production"/);
  assert.doesNotMatch(output, /trace-secret-123/);
  assert.doesNotMatch(output, /card declined/);
  assert.doesNotMatch(output, /order-high-cardinality/);
  assert.doesNotMatch(output, /customer-9/);
});

test('record-size histogram accounts for small and large structured records', async () => {
  const metrics = createLoggerPrometheusMetrics({
    recordSizeBuckets: [128, 512, 4096],
  });
  const logger = createLogger({
    appName: 'sizes',
    console: false,
    transports: metrics.transport,
  });
  await logger.info('small').send();
  await logger.info('large').addFields({ payload: 'x'.repeat(2000) }).send();
  const output = metrics.registry.render();
  assert.match(output, /record_bytes_bucket.*le="4096".* 2/);
  assert.match(output, /record_bytes_count.* 2/);
});

test('many low-cardinality updates collapse to the configured series count', () => {
  const registry = new PrometheusRegistry({ maxSeriesPerMetric: 4 });
  const counter = registry.counter({
    name: 'fuzz_total',
    help: 'Fuzz',
    labelNames: ['bucket'],
  });
  for (let index = 0; index < 1000; index += 1) {
    counter.inc({ bucket: String(index % 4) });
  }
  const lines = metricLines(registry.render(), 'next_loggers_fuzz_total{');
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.match(line, / 250$/);
  }
});
