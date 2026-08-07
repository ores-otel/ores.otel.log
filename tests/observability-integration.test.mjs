import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import {
  LokiTransport,
  PrometheusRegistry,
  createLoggerPrometheusMetrics,
  createOpenTelemetryContextProvider,
  createOpenTelemetryTransport,
  createWasmLoggerHost,
} from '@oresoftware/next-loggers/observability';

function activeSpan() {
  const state = {
    events: [],
    exceptions: [],
    statuses: [],
  };
  return {
    state,
    span: {
      spanContext: () => ({
        traceId: 'trace-e2e',
        spanId: 'span-e2e',
        traceFlags: 1,
        traceState: 'vendor=value',
      }),
      isRecording: () => true,
      addEvent: (...args) => state.events.push(args),
      recordException: (...args) => state.exceptions.push(args),
      setStatus: (...args) => state.statuses.push(args),
    },
  };
}

test('observability barrel exports the public consumer surface', async () => {
  const module = await import('@oresoftware/next-loggers/observability');
  for (const name of [
    'LokiTransport',
    'PrometheusRegistry',
    'createLoggerPrometheusMetrics',
    'createOpenTelemetryContextProvider',
    'createOpenTelemetryTransport',
    'withOpenTelemetrySpan',
    'createWasmLogger',
    'createWasmLoggerHost',
  ]) {
    assert.equal(typeof module[name], 'function', `${name} is exported`);
  }
});

test('one logger fans a correlated record out to OTEL, Prometheus, and Loki', async () => {
  const { span, state } = activeSpan();
  const otelLogs = [];
  const otelMetrics = [];
  const lokiPayloads = [];
  const records = [];
  const prometheus = createLoggerPrometheusMetrics({ environment: 'test' });
  const otel = createOpenTelemetryTransport({
    logger: { emit: (value) => otelLogs.push(value) },
    activeSpan: () => span,
    attributes: {
      'deployment.environment': 'test',
      'service.version': '1.2.3',
    },
    recordMetric: (name, value, attributes) =>
      otelMetrics.push({ name, value, attributes }),
  });
  const loki = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    labels: { cluster: 'test-cluster', environment: 'test' },
    batchSize: 1,
    fetch: async (_url, init) => {
      lokiPayloads.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    },
  });
  const logger = createLogger({
    appName: 'checkout',
    console: false,
    contextProvider: createOpenTelemetryContextProvider(() => span),
    transports: [
      { name: 'memory', write: (record) => records.push(record) },
      otel,
      prometheus.transport,
      loki,
    ],
  });

  await logger
    .info('charging order')
    .addFields({ orderId: 'order-42', customerId: 'customer-9' })
    .send();

  assert.equal(records.length, 1);
  assert.equal(records[0].traceId, 'trace-e2e');
  assert.equal(records[0].fields['otel.span_id'], 'span-e2e');
  assert.equal(records[0].fields.orderId, 'order-42');

  assert.equal(otelLogs.length, 1);
  assert.equal(otelLogs[0].attributes['trace.id'], 'trace-e2e');
  assert.equal(otelLogs[0].attributes['span.id'], 'span-e2e');
  assert.equal(
    otelLogs[0].attributes['next_logger.field.orderId'],
    'order-42',
  );
  assert.equal(state.events.length, 1);
  assert.equal(otelMetrics.length, 1);
  assert.equal('trace.id' in otelMetrics[0].attributes, false);
  assert.equal('next_logger.field.orderId' in otelMetrics[0].attributes, false);

  const prometheusOutput = prometheus.registry.render();
  assert.match(prometheusOutput, /app_name="checkout"/);
  assert.doesNotMatch(prometheusOutput, /trace-e2e/);
  assert.doesNotMatch(prometheusOutput, /order-42/);
  assert.doesNotMatch(prometheusOutput, /customer-9/);

  assert.equal(lokiPayloads.length, 1);
  const lokiStream = lokiPayloads[0].streams[0];
  assert.deepEqual(lokiStream.stream, {
    service_name: 'checkout',
    runtime: 'base',
    level: 'info',
    cluster: 'test-cluster',
    environment: 'test',
  });
  assert.equal('traceId' in lokiStream.stream, false);
  const lokiRecord = JSON.parse(lokiStream.values[0][1]);
  assert.equal(lokiRecord.traceId, 'trace-e2e');
  assert.equal(lokiRecord.fields.orderId, 'order-42');

  await loki.close();
  await logger.close();
});

test('ERROR fanout increments both error metrics and marks the active span', async () => {
  const { span, state } = activeSpan();
  const emitted = [];
  const metrics = [];
  const prometheus = createLoggerPrometheusMetrics();
  const logger = createLogger({
    appName: 'billing',
    console: false,
    contextProvider: createOpenTelemetryContextProvider(() => span),
    transports: [
      createOpenTelemetryTransport({
        logger: { emit: (value) => emitted.push(value) },
        activeSpan: () => span,
        recordMetric: (name, value, attributes) =>
          metrics.push({ name, value, attributes }),
      }),
      prometheus.transport,
    ],
  });
  const expected = new Error('invoice declined');
  await logger.error('invoice failed', expected).send();

  assert.equal(emitted[0].severityText, 'ERROR');
  assert.deepEqual(
    metrics.map((metric) => metric.name),
    ['next_loggers.records', 'next_loggers.errors'],
  );
  assert.equal(state.events.length, 1);
  assert.equal(state.exceptions.length, 1);
  assert.deepEqual(state.statuses, [[{ code: 2, message: 'invoice failed Error: invoice declined' }]]);

  const output = prometheus.registry.render();
  assert.match(output, /next_loggers_error_records_total.* 1/);
  assert.match(output, /next_loggers_trace_correlated_records_total.* 1/);
});

test('WASM records use the exact same fanout transports and correlation policy', async () => {
  const { span } = activeSpan();
  const otelLogs = [];
  const prometheus = createLoggerPrometheusMetrics();
  const memoryRecords = [];
  const logger = createLogger({
    appName: 'wasm-audio',
    console: false,
    contextProvider: createOpenTelemetryContextProvider(() => span),
    transports: [
      { write: (record) => memoryRecords.push(record) },
      createOpenTelemetryTransport({
        logger: { emit: (value) => otelLogs.push(value) },
        activeSpan: () => span,
      }),
      prometheus.transport,
    ],
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const payload = new TextEncoder().encode(
    JSON.stringify({
      level: 'warn',
      message: 'decoder jitter',
      fields: { frameId: 'frame-high-cardinality' },
    }),
  );
  new Uint8Array(memory.buffer).set(payload, 128);
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_json(128, payload.length), 0);
  await host.flush();

  assert.equal(memoryRecords[0].traceId, 'trace-e2e');
  assert.equal(memoryRecords[0].tags.includes('wasm'), true);
  assert.equal(otelLogs[0].attributes['next_logger.field.frameId'], 'frame-high-cardinality');
  const output = prometheus.registry.render();
  assert.doesNotMatch(output, /frame-high-cardinality/);
  assert.doesNotMatch(output, /trace-e2e/);
});

test('custom Prometheus registry can coexist with logger metrics and application metrics', async () => {
  const registry = new PrometheusRegistry({ prefix: 'checkout' });
  const business = registry.counter({
    name: 'orders_total',
    help: 'Orders accepted by stable payment method.',
    labelNames: ['method'],
  });
  const loggerMetrics = createLoggerPrometheusMetrics({ registry });
  const logger = createLogger({
    appName: 'checkout',
    console: false,
    transports: loggerMetrics.transport,
  });
  business.inc({ method: 'card' });
  business.add(2, { method: 'bank' });
  await logger.info('accepted').send();
  const output = registry.render();
  assert.match(output, /checkout_orders_total\{method="card"\} 1/);
  assert.match(output, /checkout_orders_total\{method="bank"\} 2/);
  assert.match(output, /checkout_records_total.* 1/);
});

test('observability setup leaves runtime primitives untouched end to end', async () => {
  const before = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    promiseThen: Promise.prototype.then,
    consoleLog: console.log,
  };
  const registry = new PrometheusRegistry();
  registry.counter({ name: 'test_total', help: 'Test' }).inc();
  const { span } = activeSpan();
  createOpenTelemetryTransport({
    logger: { emit() {} },
    activeSpan: () => span,
  }).write({
    schema: 'next-loggers/v1',
    id: 'record',
    timestamp: '2026-01-01T00:00:00.000Z',
    level: 'INFO',
    runtime: 'node',
    appName: 'app',
    message: 'message',
    values: [],
    fields: {},
  });
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(globalThis.setTimeout, before.setTimeout);
  assert.equal(globalThis.clearTimeout, before.clearTimeout);
  assert.equal(Promise.prototype.then, before.promiseThen);
  assert.equal(console.log, before.consoleLog);
});
