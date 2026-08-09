import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import { BrowserStreamTransport } from '@oresoftware/next-loggers/browser-stream';
import {
  LokiTransport,
  createLoggerPrometheusMetrics,
  createOpenTelemetryTransport,
  createWasmLoggerHost,
} from '@oresoftware/next-loggers/observability';

function lokiCapture() {
  const payloads = [];
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    labels: { cluster: 'test', environment: 'test' },
    batchSize: 1,
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    },
  });
  return { transport, payloads };
}

function lokiRecords(payloads) {
  return payloads.flatMap((payload) =>
    payload.streams.flatMap((stream) =>
      stream.values.map(([, line]) => JSON.parse(line)),
    ),
  );
}

test('default redaction is preserved across memory, OTEL, Prometheus, and Loki fanout', async () => {
  const memory = [];
  const otel = [];
  const prometheus = createLoggerPrometheusMetrics({ environment: 'test' });
  const loki = lokiCapture();
  const logger = createLogger({
    appName: 'security-service',
    console: false,
    transports: [
      { name: 'memory', write: (record) => memory.push(record) },
      createOpenTelemetryTransport({ logger: { emit: (record) => otel.push(record) } }),
      prometheus.transport,
      loki.transport,
    ],
  });
  await logger
    .error('login failed', {
      password: 'hunter2',
      apiToken: 'token-secret',
      nested: { refreshToken: 'refresh-secret' },
    })
    .addFields({ sessionSecret: 'session-secret', requestId: 'request-safe' })
    .send();

  const serializedMemory = JSON.stringify(memory);
  const serializedOtel = JSON.stringify(otel);
  const serializedLoki = JSON.stringify(loki.payloads);
  const prometheusText = prometheus.registry.render();
  for (const secret of [
    'hunter2',
    'token-secret',
    'refresh-secret',
    'session-secret',
  ]) {
    assert.equal(serializedMemory.includes(secret), false);
    assert.equal(serializedOtel.includes(secret), false);
    assert.equal(serializedLoki.includes(secret), false);
    assert.equal(prometheusText.includes(secret), false);
  }
  assert.equal(memory[0].fields.sessionSecret, '[REDACTED]');
  assert.equal(
    otel[0].attributes['next_logger.field.sessionSecret'],
    '[REDACTED]',
  );
  assert.equal(lokiRecords(loki.payloads)[0].fields.sessionSecret, '[REDACTED]');
  assert.match(prometheusText, /app_name="security-service"/);
  await loki.transport.close();
  await logger.close();
});

test('custom redaction policies reach every observability sink consistently', async () => {
  const otel = [];
  const loki = lokiCapture();
  const logger = createLogger({
    console: false,
    redactKeys: ['internalcode'],
    transports: [
      createOpenTelemetryTransport({ logger: { emit: (record) => otel.push(record) } }),
      loki.transport,
    ],
  });
  await logger
    .warn('custom', { internalCode: 'hide-me', password: 'keep-me' })
    .addFields({ internalCode: 'field-hide', password: 'field-keep' })
    .send();
  const lokiRecord = lokiRecords(loki.payloads)[0];
  assert.equal(otel[0].attributes['next_logger.field.internalCode'], '[REDACTED]');
  assert.equal(otel[0].attributes['next_logger.field.password'], 'field-keep');
  assert.equal(lokiRecord.fields.internalCode, '[REDACTED]');
  assert.equal(lokiRecord.fields.password, 'field-keep');
  assert.match(lokiRecord.message, /keep-me/);
  assert.doesNotMatch(lokiRecord.message, /hide-me/);
  await loki.transport.close();
});

test('redaction can be explicitly disabled and sinks receive the resulting record', async () => {
  const otel = [];
  const loki = lokiCapture();
  const logger = createLogger({
    console: false,
    redactKeys: false,
    transports: [
      createOpenTelemetryTransport({ logger: { emit: (record) => otel.push(record) } }),
      loki.transport,
    ],
  });
  await logger.info('raw', { password: 'intentionally-visible' }).send();
  assert.match(JSON.stringify(otel), /intentionally-visible/);
  assert.match(JSON.stringify(loki.payloads), /intentionally-visible/);
  await loki.transport.close();
});

test('logged-in user identity remains in the structured Loki record but is not promoted to OTEL attributes', async () => {
  const otel = [];
  const loki = lokiCapture();
  const logger = createLogger({
    console: false,
    loggedInUser: { id: 'user-1', email: 'person@example.test' },
    transports: [
      createOpenTelemetryTransport({ logger: { emit: (record) => otel.push(record) } }),
      loki.transport,
    ],
  });
  await logger.info('identity').send();
  const lokiRecord = lokiRecords(loki.payloads)[0];
  assert.equal(lokiRecord.loggedInUser.email, 'person@example.test');
  assert.equal(
    Object.keys(otel[0].attributes).some((key) => key.includes('logged_in_user')),
    false,
  );
  await loki.transport.close();
});

test('high-cardinality user, request, trace, and order values never become Prometheus or Loki labels', async () => {
  const prometheus = createLoggerPrometheusMetrics({ environment: 'production' });
  const loki = lokiCapture();
  const logger = createLogger({
    appName: 'cardinality-service',
    console: false,
    transports: [prometheus.transport, loki.transport],
  });
  await logger
    .info('order')
    .addTrace('trace-high-cardinality')
    .addFields({
      requestId: 'request-high-cardinality',
      orderId: 'order-high-cardinality',
      userId: 'user-high-cardinality',
    })
    .send();
  const metrics = prometheus.registry.render();
  const labels = JSON.stringify(loki.payloads[0].streams[0].stream);
  for (const value of [
    'trace-high-cardinality',
    'request-high-cardinality',
    'order-high-cardinality',
    'user-high-cardinality',
  ]) {
    assert.equal(metrics.includes(value), false);
    assert.equal(labels.includes(value), false);
  }
  const body = loki.payloads[0].streams[0].values[0][1];
  assert.match(body, /trace-high-cardinality/);
  assert.match(body, /order-high-cardinality/);
  await loki.transport.close();
});

test('a fail-open OTEL exporter cannot starve memory, Prometheus, or Loki sinks', async () => {
  const memory = [];
  const operations = [];
  const prometheus = createLoggerPrometheusMetrics();
  const loki = lokiCapture();
  const logger = createLogger({
    appName: 'isolated-service',
    console: false,
    transports: [
      createOpenTelemetryTransport({
        logger: {
          emit() {
            throw new Error('OTEL exporter unavailable');
          },
        },
        onError: (_error, operation) => operations.push(operation),
      }),
      { write: (record) => memory.push(record) },
      prometheus.transport,
      loki.transport,
    ],
  });
  await logger.info('still delivered').send();
  assert.deepEqual(operations, ['emit log']);
  assert.equal(memory.length, 1);
  assert.match(prometheus.registry.render(), /records_total.* 1/);
  assert.equal(lokiRecords(loki.payloads).length, 1);
  await loki.transport.close();
});

test('a terminal Loki failure is reported without starving earlier or later transports', async () => {
  const memory = [];
  const failures = [];
  const prometheus = createLoggerPrometheusMetrics();
  const loki = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    maxRetries: 0,
    fetch: async () => new Response('down', { status: 503 }),
  });
  const logger = createLogger({
    appName: 'loki-failure-service',
    console: false,
    transports: [
      { name: 'before', write: (record) => memory.push(`before:${record.id}`) },
      loki,
      prometheus.transport,
      { name: 'after', write: (record) => memory.push(`after:${record.id}`) },
    ],
    onTransportError(error, transport) {
      failures.push({ error, name: transport.name });
    },
  });
  await logger.warn('survives').send();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, 'loki');
  assert.match(String(failures[0].error), /503/);
  assert.equal(memory.length, 2);
  assert.match(memory[0], /^before:/);
  assert.match(memory[1], /^after:/);
  assert.match(prometheus.registry.render(), /records_total.* 1/);
  await loki.close();
});

test('WASM client payload secrets are redacted before OTEL and Loki export', async () => {
  const otel = [];
  const loki = lokiCapture();
  const logger = createLogger({
    appName: 'wasm-security',
    console: false,
    transports: [
      createOpenTelemetryTransport({ logger: { emit: (record) => otel.push(record) } }),
      loki.transport,
    ],
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const payload = new TextEncoder().encode(
    JSON.stringify({
      level: 'warn',
      message: 'client event',
      values: [{ apiToken: 'wasm-token', safe: 'visible' }],
      fields: { refreshToken: 'wasm-refresh', frameId: 'frame-1' },
    }),
  );
  new Uint8Array(memory.buffer).set(payload, 0);
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_json(0, payload.length), 0);
  await host.flush();
  const serialized = JSON.stringify({ otel, loki: loki.payloads });
  assert.doesNotMatch(serialized, /wasm-token/);
  assert.doesNotMatch(serialized, /wasm-refresh/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /frame-1/);
  await loki.transport.close();
});

test('BrowserStream/Supabase wrappers receive already-redacted client records', async () => {
  const delivered = [];
  const stream = new BrowserStreamTransport({
    transport: { write: (record) => delivered.push(record) },
    flushOnPageHide: false,
  });
  const logger = createLogger({
    appName: 'browser-security',
    console: false,
    transports: stream,
  });
  await logger
    .error('client failure', { password: 'browser-password' })
    .addFields({ apiToken: 'browser-token', route: '/checkout' })
    .send();
  await stream.flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].values[1].password, '[REDACTED]');
  assert.equal(delivered[0].fields.apiToken, '[REDACTED]');
  assert.equal(delivered[0].fields.route, '/checkout');
  assert.doesNotMatch(JSON.stringify(delivered), /browser-password|browser-token/);
  await logger.close();
});

test('five hundred concurrent records retain exact sink and metric counts', async () => {
  const memory = [];
  const otel = [];
  const prometheus = createLoggerPrometheusMetrics({ environment: 'stress' });
  const logger = createLogger({
    appName: 'stress-service',
    console: false,
    transports: [
      { write: (record) => memory.push(record) },
      createOpenTelemetryTransport({ logger: { emit: (record) => otel.push(record) } }),
      prometheus.transport,
    ],
  });
  await Promise.all(
    Array.from({ length: 500 }, (_, index) =>
      logger
        .info('stress record')
        .addFields({ sequence: index, password: `secret-${index}` })
        .send(),
    ),
  );
  assert.equal(memory.length, 500);
  assert.equal(otel.length, 500);
  assert.equal(new Set(memory.map((record) => record.id)).size, 500);
  assert.equal(memory.every((record) => record.fields.password === '[REDACTED]'), true);
  const metrics = prometheus.registry.render();
  assert.match(metrics, /records_total\{[^}]*level="INFO"[^}]*\} 500/);
  assert.doesNotMatch(metrics, /secret-/);
});

test('the complete security fanout leaves runtime primitives unchanged', async () => {
  const before = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    promiseThen: Promise.prototype.then,
    consoleLog: console.log,
  };
  const prometheus = createLoggerPrometheusMetrics();
  const logger = createLogger({
    console: false,
    transports: [
      prometheus.transport,
      createOpenTelemetryTransport({ logger: { emit() {} } }),
    ],
  });
  await logger.info('manual only').send();
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(globalThis.setTimeout, before.setTimeout);
  assert.equal(globalThis.clearTimeout, before.clearTimeout);
  assert.equal(Promise.prototype.then, before.promiseThen);
  assert.equal(console.log, before.consoleLog);
});
