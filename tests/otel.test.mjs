import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import {
  OTEL_FIELD_KEYS,
  createOpenTelemetryContextProvider,
  createOpenTelemetryTransport,
  isValidSpanId,
  isValidTraceId,
  logRecordToOtelAttributes,
  withOpenTelemetry,
} from '@oresoftware/next-loggers/otel';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const SPAN_ID = '0123456789abcdef';

function record(overrides = {}) {
  return {
    schema: 'next-loggers/v1',
    id: 'record-1',
    timestamp: '2026-08-02T00:00:00.000Z',
    level: 'ERROR',
    runtime: 'node',
    appName: 'payments',
    message: 'declined',
    values: ['declined'],
    fields: {
      [OTEL_FIELD_KEYS.spanId]: SPAN_ID,
      [OTEL_FIELD_KEYS.traceFlags]: 1,
      orderId: 'order-1',
    },
    traceId: TRACE_ID,
    ...overrides,
  };
}

test('logger calls explicitly fan out to OTEL logs, recording spans, exceptions, and low-cardinality metrics', async () => {
  const emitted = [];
  const events = [];
  const exceptions = [];
  const statuses = [];
  const metrics = [];
  const bridgeErrors = [];
  const span = {
    spanContext() {
      return {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
        traceState: { serialize: () => 'vendor=value' },
        isRemote: false,
      };
    },
    isRecording: () => true,
    addEvent(name, attributes, time) {
      events.push({ name, attributes, time });
    },
    recordException(error, time) {
      exceptions.push({ error, time });
    },
    setStatus(status) {
      statuses.push(status);
    },
  };
  const activeSpan = () => span;
  const transport = createOpenTelemetryTransport({
    logger: { emit: (value) => emitted.push(value) },
    activeSpan,
    activeContext: () => ({ request: 'application-owned-context' }),
    attributes: { 'deployment.environment.name': 'test' },
    metricAttributes: {
      environment: 'test',
      'trace.id': 'must-be-dropped',
      'next_logger.field.requestId': 'must-be-dropped',
    },
    includeValues: true,
    recordMetric: (name, value, attributes) => metrics.push({ name, value, attributes }),
    onBridgeError: (error, operation) => bridgeErrors.push({ error, operation }),
  });
  const logger = createLogger({
    appName: 'otel-test',
    name: 'request',
    console: false,
    clock: () => new Date('2026-08-03T03:00:00.000Z'),
    idFactory: () => 'record-1',
    contextProvider: createOpenTelemetryContextProvider(activeSpan),
    transports: transport,
  });

  await logger
    .error('request failed', new Error('boom'))
    .addFields({ route: '/v1/items', attempts: 2, nested: { safe: true } })
    .send();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].body, 'request failed boom');
  assert.equal(emitted[0].severityNumber, 17);
  assert.equal(emitted[0].severityText, 'ERROR');
  assert.equal(emitted[0].attributes['service.name'], 'otel-test');
  assert.equal(emitted[0].attributes['logger.name'], 'request');
  assert.equal(emitted[0].attributes['trace.id'], TRACE_ID);
  assert.equal(emitted[0].attributes['span.id'], SPAN_ID);
  assert.equal(emitted[0].attributes[OTEL_FIELD_KEYS.traceState], 'vendor=value');
  assert.equal(emitted[0].attributes[OTEL_FIELD_KEYS.remote], false);
  assert.equal(emitted[0].attributes['next_logger.field.route'], '/v1/items');
  assert.equal(emitted[0].attributes['next_logger.field.nested'], '{"safe":true}');
  assert.deepEqual(emitted[0].context, { request: 'application-owned-context' });

  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'log.error');
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].error.message, 'boom');
  assert.deepEqual(statuses, [{ code: 2, message: 'request failed boom' }]);
  assert.deepEqual(
    metrics.map(({ name, value }) => ({ name, value })),
    [
      { name: 'next_loggers.records', value: 1 },
      { name: 'next_loggers.errors', value: 1 },
    ],
  );
  for (const metric of metrics) {
    assert.equal(metric.attributes.environment, 'test');
    assert.equal('trace.id' in metric.attributes, false);
    assert.equal('span.id' in metric.attributes, false);
    assert.equal('log.record.uid' in metric.attributes, false);
    assert.equal('next_logger.field.route' in metric.attributes, false);
    assert.equal('next_logger.field.requestId' in metric.attributes, false);
  }
  assert.deepEqual(bridgeErrors, []);
});

test('sampled-out spans retain valid correlation while span events remain recording-only', () => {
  let events = 0;
  const span = {
    spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 0 }),
    isRecording: () => false,
    addEvent() {
      events += 1;
    },
  };
  const provider = createOpenTelemetryContextProvider(() => span);
  assert.deepEqual(provider(), {
    traceId: TRACE_ID,
    traceIds: [TRACE_ID],
    fields: {
      [OTEL_FIELD_KEYS.spanId]: SPAN_ID,
      [OTEL_FIELD_KEYS.traceFlags]: 0,
    },
    tags: ['otel'],
  });
  assert.equal(
    createOpenTelemetryContextProvider(() => span, { requireRecordingSpan: true })(),
    undefined,
  );

  const emitted = [];
  createOpenTelemetryTransport({
    logger: { emit: (value) => emitted.push(value) },
    activeSpan: () => span,
  }).write(record());
  assert.equal(events, 0);
  assert.equal(emitted[0].attributes['trace.id'], TRACE_ID);
  assert.equal(emitted[0].attributes['span.id'], SPAN_ID);
});

test('invalid and all-zero W3C identifiers never become correlation attributes', () => {
  assert.equal(isValidTraceId(TRACE_ID), true);
  assert.equal(isValidSpanId(SPAN_ID), true);
  assert.equal(isValidTraceId('0'.repeat(32)), false);
  assert.equal(isValidSpanId('0'.repeat(16)), false);
  assert.equal(isValidTraceId('trace-1'), false);
  assert.equal(isValidSpanId('span-1'), false);

  const provider = createOpenTelemetryContextProvider(() => ({
    spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 }),
    addEvent() {},
  }));
  assert.equal(provider(), undefined);

  const emitted = [];
  createOpenTelemetryTransport({ logger: { emit: (value) => emitted.push(value) } }).write(
    record({
      traceId: '0'.repeat(32),
      fields: {
        [OTEL_FIELD_KEYS.spanId]: '0'.repeat(16),
        [OTEL_FIELD_KEYS.traceFlags]: 1,
      },
    }),
  );
  assert.equal('trace.id' in emitted[0].attributes, false);
  assert.equal('span.id' in emitted[0].attributes, false);
});

test('record conversion bounds attribute count, arrays, names, and stringified values', () => {
  const attributes = logRecordToOtelAttributes(
    record({
      level: 'INFO',
      runtime: 'browser',
      appName: 'web',
      message: 'ready',
      values: [],
      fields: {
        long: 'abcdefghij',
        primitives: [true, false, true, false],
        object: { answer: 42 },
        ['x'.repeat(400)]: 'bounded-name',
      },
    }),
    {
      maxAttributes: 10,
      maxAttributeValueLength: 8,
      maxArrayLength: 2,
    },
  );
  assert.ok(Object.keys(attributes).length <= 10);
  assert.equal(attributes['next_logger.field.long'], 'abcdefg…');
  assert.deepEqual(attributes['next_logger.field.primitives'], [true, false]);
  assert.equal(attributes['next_logger.field.object'], '{"answe…');
  assert.ok(Object.keys(attributes).every((key) => key.length <= 256));
});

test('optional bridge failures are isolated while primary log delivery remains authoritative', () => {
  const emitted = [];
  const failures = [];
  const transport = createOpenTelemetryTransport({
    logger: { emit: (value) => emitted.push(value) },
    activeSpan: () => ({
      spanContext: () => ({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
        traceState: { serialize() { throw new Error('trace state unavailable'); } },
      }),
      isRecording() {
        return true;
      },
      addEvent() {
        throw new Error('span event unavailable');
      },
      recordException() {
        throw new Error('exception recording unavailable');
      },
      setStatus() {
        throw new Error('status unavailable');
      },
    }),
    activeContext() {
      throw new Error('context unavailable');
    },
    recordMetric() {
      throw new Error('metric unavailable');
    },
    onBridgeError: (error, operation) => failures.push([operation, error.message]),
  });
  transport.write(record({ errors: [{ name: 'Error', message: 'boom' }] }));
  assert.equal(emitted.length, 1);
  assert.deepEqual(failures, [
    ['trace-state', 'trace state unavailable'],
    ['active-context', 'context unavailable'],
    ['span-event', 'span event unavailable'],
    ['record-exception', 'exception recording unavailable'],
    ['span-status', 'status unavailable'],
    ['metric', 'metric unavailable'],
    ['metric', 'metric unavailable'],
  ]);

  const primary = createOpenTelemetryTransport({
    logger: {
      emit() {
        throw new Error('collector down');
      },
    },
    failOpen: false,
  });
  assert.throws(() => primary.write(record()), /collector down/);
});

test('provider lookup failures and diagnostic failures never escape into application logging', () => {
  const diagnostics = [];
  const provider = createOpenTelemetryContextProvider(
    () => {
      throw new Error('context manager unavailable');
    },
    {
      onBridgeError(error, operation) {
        diagnostics.push([operation, error.message]);
        throw new Error('diagnostic sink unavailable');
      },
    },
  );
  assert.equal(provider(), undefined);
  assert.deepEqual(diagnostics, [['active-span', 'context manager unavailable']]);
});

test('withOpenTelemetry preserves transports and explicit context while installing correlation by default', async () => {
  const emitted = [];
  const regular = [];
  const explicitContext = () => ({ fields: { source: 'explicit' } });
  const bridge = {
    logger: { emit: (value) => emitted.push(value) },
    activeSpan: () => ({
      spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 }),
      addEvent() {},
    }),
  };
  const options = withOpenTelemetry(
    {
      appName: 'helper',
      console: false,
      contextProvider: explicitContext,
      transports: { name: 'memory', write: (value) => regular.push(value) },
    },
    bridge,
  );
  assert.equal(options.contextProvider, explicitContext);
  assert.equal(options.transports.length, 2);
  await createLogger(options).info('helper-event').send();
  assert.equal(regular.length, 1);
  assert.equal(emitted.length, 1);

  const correlated = withOpenTelemetry({ console: false }, bridge);
  assert.equal(correlated.contextProvider().traceId, TRACE_ID);
});
