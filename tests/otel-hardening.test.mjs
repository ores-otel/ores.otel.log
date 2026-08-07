import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import {
  createOpenTelemetryContextProvider,
  createOpenTelemetryTransport,
  logRecordToOtelAttributes,
  withOpenTelemetrySpan,
} from '@oresoftware/next-loggers/otel';

function baseRecord(overrides = {}) {
  return {
    schema: 'next-loggers/v1',
    id: 'record-1',
    timestamp: '2026-08-03T03:00:00.000Z',
    level: 'INFO',
    runtime: 'node',
    appName: 'checkout',
    message: 'hello',
    values: ['hello'],
    fields: {},
    ...overrides,
  };
}

test('OTEL transport fails open and reports individual exporter operations', async () => {
  const operations = [];
  const metrics = [];
  const memory = [];
  const span = {
    spanContext: () => ({ traceId: 'trace-1', spanId: 'span-1', traceFlags: 1 }),
    isRecording: () => true,
    addEvent() { throw new Error('event unavailable'); },
    recordException() { throw new Error('exception unavailable'); },
    setStatus() { throw new Error('status unavailable'); },
  };
  const transport = createOpenTelemetryTransport({
    logger: { emit() { throw new Error('logs unavailable'); } },
    activeSpan: () => span,
    attributes: { 'deployment.environment': 'test' },
    recordMetric(name, value, attributes) {
      metrics.push({ name, value, attributes });
      throw new Error('metrics unavailable');
    },
    onError(_error, operation) { operations.push(operation); },
  });
  const logger = createLogger({
    appName: 'checkout',
    console: false,
    transports: [
      { name: 'memory', write: (record) => void memory.push(record) },
      transport,
    ],
  });

  await logger.error('declined', new Error('boom')).addFields({ orderId: 'order-42' }).send();

  assert.equal(memory.length, 1);
  assert.equal(operations.includes('emit log'), true);
  assert.equal(operations.includes('add span event'), true);
  assert.equal(operations.includes('record exception'), true);
  assert.equal(operations.includes('set span status'), true);
  assert.equal(operations.includes('record log metric'), true);
  assert.equal(operations.includes('record error metric'), true);
  for (const metric of metrics) {
    assert.equal('trace.id' in metric.attributes, false);
    assert.equal('span.id' in metric.attributes, false);
    assert.equal('next_logger.field.orderId' in metric.attributes, false);
    assert.equal(metric.attributes['service.name'], 'checkout');
    assert.equal(metric.attributes['deployment.environment'], 'test');
  }
});

test('OTEL transport can be configured fail-closed for validation environments', () => {
  const transport = createOpenTelemetryTransport({
    logger: { emit() { throw new Error('expected exporter failure'); } },
    failOpen: false,
  });
  assert.throws(() => transport.write(baseRecord()), /expected exporter failure/);
});

test('OTEL attributes have explicit string and array bounds', () => {
  const attributes = logRecordToOtelAttributes(
    baseRecord({
      fields: {
        large: { value: 'x'.repeat(200) },
        tags: Array.from({ length: 20 }, (_, index) => `value-${index}`),
      },
    }),
    { maxAttributeLength: 32, maxAttributeArrayLength: 3 },
  );
  assert.match(attributes['next_logger.field.large'], /truncated/);
  assert.equal(attributes['next_logger.field.tags'].length, 3);
});

test('OTEL context provider fails open when application context access is broken', () => {
  assert.equal(
    createOpenTelemetryContextProvider(() => { throw new Error('broken context'); })(),
    undefined,
  );
  assert.equal(
    createOpenTelemetryContextProvider(() => ({
      spanContext() { throw new Error('broken span'); },
      addEvent() {},
    }))(),
    undefined,
  );
});

test('explicit span wrapper logs lifecycle and preserves successful application results', async () => {
  const records = [];
  const span = {
    spanContext: () => ({ traceId: 'trace-span', spanId: 'span-span', traceFlags: 1 }),
    addEvent() {},
    setStatus() { throw new Error('status unavailable'); },
    end() { throw new Error('end unavailable'); },
  };
  const tracer = {
    startActiveSpan(_name, _options, callback) { return callback(span); },
  };
  const logger = createLogger({
    appName: 'orders',
    maxLevel: 'DEBUG',
    console: false,
    transports: { write: (record) => void records.push(record) },
  });

  const value = await withOpenTelemetrySpan(logger, tracer, 'orders.create', async () => 7, {
    lifecycleLevel: 'INFO',
    tags: ['orders'],
  });

  assert.equal(value, 7);
  assert.equal(records.some((record) => record.message === 'span started: orders.create'), true);
  assert.equal(records.some((record) => record.message === 'span completed: orders.create'), true);
  assert.equal(
    records.some((record) => record.message.startsWith('OpenTelemetry set success status failed')),
    true,
  );
  assert.equal(
    records.some((record) => record.message.startsWith('OpenTelemetry end span failed')),
    true,
  );
});

test('explicit span wrapper records and rethrows application failures', async () => {
  const records = [];
  const statuses = [];
  const exceptions = [];
  let ended = 0;
  const span = {
    spanContext: () => ({ traceId: 'trace-error', spanId: 'span-error', traceFlags: 1 }),
    addEvent() {},
    recordException(error) { exceptions.push(error); },
    setStatus(status) { statuses.push(status); },
    end() { ended += 1; },
  };
  const logger = createLogger({
    console: false,
    transports: { write: (record) => void records.push(record) },
  });
  const failure = new Error('declined');

  await assert.rejects(
    withOpenTelemetrySpan(
      logger,
      { startActiveSpan: (_name, _options, callback) => callback(span) },
      'orders.fail',
      async () => { throw failure; },
      { lifecycleLevel: false },
    ),
    failure,
  );

  assert.deepEqual(exceptions, [failure]);
  assert.deepEqual(statuses, [{ code: 2, message: 'declined' }]);
  assert.equal(ended, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'ERROR');
  assert.equal(records[0].traceId, undefined);
  assert.equal(records[0].fields['otel.trace_id'], 'trace-error');
});
