import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import { createOpenTelemetryTransport, withOpenTelemetry } from '@oresoftware/next-loggers/otel';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const SPAN_ID = '0123456789abcdef';

test('per-event OTEL routing never suppresses ordinary log transports', async () => {
  const ordinary = [];
  const telemetry = [];
  const logger = createLogger({
    console: false,
    transports: [
      { name: 'memory', write: (record) => ordinary.push(record.message) },
      createOpenTelemetryTransport({ logger: { emit: (record) => telemetry.push(record.body) } }),
    ],
  });

  await logger.info('default').send();
  await logger.info('ordinary-only').notOtel().send();
  await logger.info('reset').notOtel().resetOtel().send();
  logger.notOtel();
  await logger.info('logger-default-off').send();
  await logger.info('event-override-on').useOtel().send();
  logger.useOtel();
  await logger.info('explicit-off').withOtel(false).send();

  assert.deepEqual(ordinary, [
    'default',
    'ordinary-only',
    'reset',
    'logger-default-off',
    'event-override-on',
    'explicit-off',
  ]);
  assert.deepEqual(telemetry, ['default', 'reset', 'event-override-on']);
});

test('withOpenTelemetry preserves existing sinks and merges inherited context', async () => {
  const ordinary = [];
  const telemetry = [];
  const base = createLogger({
    appName: 'routing',
    console: false,
    contextProvider: () => ({ fields: { tenant: 'stable' }, tags: ['inherited'] }),
    transports: { write: (record) => ordinary.push(record) },
  });
  const logger = withOpenTelemetry(base, {
    logger: { emit: (record) => telemetry.push(record) },
    activeSpan: () => ({
      spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 0 }),
      isRecording: () => false,
      addEvent() {},
    }),
  });

  await logger.info('correlated').send();

  assert.equal(ordinary.length, 1);
  assert.equal(ordinary[0].fields.tenant, 'stable');
  assert.deepEqual(ordinary[0].tags, ['inherited', 'otel']);
  assert.equal(ordinary[0].traceId, TRACE_ID);
  assert.equal(telemetry[0].attributes['trace.id'], TRACE_ID);
  assert.equal(telemetry[0].attributes['span.id'], SPAN_ID);
});
