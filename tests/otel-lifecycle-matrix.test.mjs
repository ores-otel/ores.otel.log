import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import {
  createOpenTelemetryContextProvider,
  createOpenTelemetryTransport,
  logRecordToOtelAttributes,
  withOpenTelemetrySpan,
} from '@oresoftware/next-loggers/otel';

function record(overrides = {}) {
  return {
    schema: 'next-loggers/v1',
    id: 'matrix-record',
    timestamp: '2026-08-03T12:00:00.000Z',
    level: 'INFO',
    runtime: 'node',
    appName: 'matrix-service',
    message: 'matrix message',
    values: ['matrix message'],
    fields: {},
    ...overrides,
  };
}

function memoryLogger(options = {}) {
  const records = [];
  const logger = createLogger({
    appName: 'span-service',
    maxLevel: 'TRACE',
    console: false,
    transports: {
      name: 'memory',
      write(value) {
        records.push(value);
      },
    },
    ...options,
  });
  return { logger, records };
}

function span(overrides = {}) {
  return {
    spanContext: () => ({
      traceId: 'trace-matrix',
      spanId: 'span-matrix',
      traceFlags: 1,
    }),
    isRecording: () => true,
    addEvent() {},
    recordException() {},
    setStatus() {},
    end() {},
    ...overrides,
  };
}

function tracerFor(value) {
  return {
    startActiveSpan(_name, _options, callback) {
      return callback(value);
    },
  };
}

test('transport requires an explicit injected OTEL logger', () => {
  assert.throws(
    () => createOpenTelemetryTransport({}),
    /requires an injected OTEL logger/,
  );
  assert.throws(
    () => createOpenTelemetryTransport({ logger: {} }),
    /requires an injected OTEL logger/,
  );
});

test('all next-loggers levels map to the expected OTEL severity numbers', () => {
  const emitted = [];
  const transport = createOpenTelemetryTransport({
    logger: { emit: (value) => emitted.push(value) },
  });
  for (const level of ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']) {
    transport.write(record({ level, message: level }));
  }
  assert.deepEqual(
    emitted.map(({ severityText, severityNumber }) => [severityText, severityNumber]),
    [
      ['TRACE', 1],
      ['DEBUG', 5],
      ['INFO', 9],
      ['WARN', 13],
      ['ERROR', 17],
      ['FATAL', 21],
    ],
  );
});

test('the active context object is forwarded by identity', () => {
  const emitted = [];
  const context = { request: 'context-object' };
  createOpenTelemetryTransport({
    logger: { emit: (value) => emitted.push(value) },
    activeContext: () => context,
  }).write(record());
  assert.equal(emitted[0].context, context);
});

test('onError exceptions are isolated in fail-open mode', () => {
  const emitted = [];
  const transport = createOpenTelemetryTransport({
    logger: {
      emit(value) {
        emitted.push(value);
        throw new Error('export failed');
      },
    },
    onError() {
      throw new Error('diagnostics failed');
    },
  });
  assert.doesNotThrow(() => transport.write(record()));
  assert.equal(emitted.length, 1);
});

test('spanContext failures are reported and the log still emits without correlation', () => {
  const operations = [];
  const emitted = [];
  const transport = createOpenTelemetryTransport({
    logger: { emit: (value) => emitted.push(value) },
    activeSpan: () =>
      span({
        spanContext() {
          throw new Error('context unavailable');
        },
      }),
    onError(_error, operation) {
      operations.push(operation);
    },
  });
  transport.write(record());
  assert.deepEqual(operations, ['read span context']);
  assert.equal(emitted.length, 1);
  assert.equal('trace.id' in emitted[0].attributes, false);
  assert.equal('span.id' in emitted[0].attributes, false);
});

test('isRecording failures disable span mutation while retaining readable correlation', () => {
  const emitted = [];
  let events = 0;
  const active = span({
    isRecording() {
      throw new Error('recording state unavailable');
    },
    addEvent() {
      events += 1;
    },
  });
  createOpenTelemetryTransport({
    logger: { emit: (value) => emitted.push(value) },
    activeSpan: () => active,
  }).write(record());
  assert.equal(emitted[0].attributes['trace.id'], 'trace-matrix');
  assert.equal(emitted[0].attributes['span.id'], 'span-matrix');
  assert.equal(events, 0);
});

test('emitSpanEvents false suppresses events, exception recording, and status updates', () => {
  let events = 0;
  let exceptions = 0;
  let statuses = 0;
  const active = span({
    addEvent() {
      events += 1;
    },
    recordException() {
      exceptions += 1;
    },
    setStatus() {
      statuses += 1;
    },
  });
  createOpenTelemetryTransport({
    logger: { emit() {} },
    activeSpan: () => active,
    emitSpanEvents: false,
  }).write(record({ level: 'ERROR', errors: [{ message: 'boom' }] }));
  assert.deepEqual({ events, exceptions, statuses }, { events: 0, exceptions: 0, statuses: 0 });
});

test('recordExceptions false still marks ERROR spans as failed', () => {
  let exceptions = 0;
  const statuses = [];
  const active = span({
    recordException() {
      exceptions += 1;
    },
    setStatus(value) {
      statuses.push(value);
    },
  });
  createOpenTelemetryTransport({
    logger: { emit() {} },
    activeSpan: () => active,
    recordExceptions: false,
  }).write(record({ level: 'ERROR', errors: [{ message: 'boom' }] }));
  assert.equal(exceptions, 0);
  assert.deepEqual(statuses, [{ code: 2, message: 'matrix message' }]);
});

test('FATAL records produce both the records and errors metric callbacks', () => {
  const metrics = [];
  createOpenTelemetryTransport({
    logger: { emit() {} },
    recordMetric: (name, value, attributes) => metrics.push({ name, value, attributes }),
  }).write(record({ level: 'FATAL' }));
  assert.deepEqual(
    metrics.map(({ name, value }) => [name, value]),
    [
      ['next_loggers.records', 1],
      ['next_loggers.errors', 1],
    ],
  );
});

test('custom metric allowlists quietly omit keys absent from the record', () => {
  const metrics = [];
  createOpenTelemetryTransport({
    logger: { emit() {} },
    metricAttributeKeys: ['region', 'missing', 'service.name'],
    attributes: { region: 'us-east-1' },
    recordMetric: (_name, _value, attributes) => metrics.push(attributes),
  }).write(record());
  assert.deepEqual(metrics, [{ region: 'us-east-1', 'service.name': 'matrix-service' }]);
});

test('maxAttributeArrayLength values below one are clamped to one element', () => {
  const attributes = logRecordToOtelAttributes(
    record({ fields: { values: ['a', 'b', 'c'] }, tags: ['x', 'y'] }),
    { maxAttributeArrayLength: 0 },
  );
  assert.deepEqual(attributes['next_logger.field.values'], ['a']);
  assert.deepEqual(attributes['next_logger.tags'], ['x']);
});

test('maxAttributeLength zero leaves strings unbounded', () => {
  const long = 'x'.repeat(10_000);
  const attributes = logRecordToOtelAttributes(
    record({ id: long, fields: { long } }),
    { maxAttributeLength: 0 },
  );
  assert.equal(attributes['log.record.uid'], long);
  assert.equal(attributes['next_logger.field.long'], long);
});

test('objects and mixed arrays are exported as bounded JSON strings', () => {
  const attributes = logRecordToOtelAttributes(
    record({
      fields: {
        object: { nested: { answer: 42 } },
        mixed: ['text', { value: true }],
      },
    }),
    { maxAttributeLength: 1_000 },
  );
  assert.equal(attributes['next_logger.field.object'], '{"nested":{"answer":42}}');
  assert.equal(attributes['next_logger.field.mixed'], '["text",{"value":true}]');
});

test('non-finite serialized numeric fields become OTEL-safe JSON text', () => {
  const attributes = logRecordToOtelAttributes(
    record({ fields: { nan: Number.NaN, infinity: Number.POSITIVE_INFINITY } }),
  );
  assert.equal(attributes['next_logger.field.nan'], 'null');
  assert.equal(attributes['next_logger.field.infinity'], 'null');
});

test('context provider returns undefined for no span and non-recording spans', () => {
  assert.equal(createOpenTelemetryContextProvider(() => undefined)(), undefined);
  assert.equal(
    createOpenTelemetryContextProvider(() => span({ isRecording: () => false }))(),
    undefined,
  );
});

test('context provider preserves string trace state', () => {
  const provider = createOpenTelemetryContextProvider(() =>
    span({
      spanContext: () => ({
        traceId: 'trace',
        spanId: 'span',
        traceFlags: 3,
        traceState: 'vendor=state',
      }),
    }),
  );
  assert.deepEqual(provider(), {
    traceId: 'trace',
    traceIds: ['trace'],
    fields: {
      'otel.span_id': 'span',
      'otel.trace_flags': 3,
      'otel.trace_state': 'vendor=state',
    },
    tags: ['otel'],
  });
});

test('custom success and error status codes are passed through unchanged', async () => {
  const statuses = [];
  const success = span({ setStatus: (value) => statuses.push(value) });
  const { logger } = memoryLogger();
  await withOpenTelemetrySpan(logger, tracerFor(success), 'success', async () => 1, {
    lifecycleLevel: false,
    okStatusCode: 77,
  });
  const failure = span({ setStatus: (value) => statuses.push(value) });
  const expected = new Error('failed');
  await assert.rejects(
    withOpenTelemetrySpan(
      logger,
      tracerFor(failure),
      'failure',
      async () => {
        throw expected;
      },
      { lifecycleLevel: false, errorStatusCode: 88 },
    ),
    expected,
  );
  assert.deepEqual(statuses, [{ code: 77 }, { code: 88, message: 'failed' }]);
});

test('lifecycle records include custom fields and tags', async () => {
  const { logger, records } = memoryLogger();
  await withOpenTelemetrySpan(logger, tracerFor(span()), 'decorated', async () => 1, {
    lifecycleLevel: 'INFO',
    logFields: { component: 'checkout', attempt: 2 },
    tags: ['payment', 'critical'],
  });
  assert.equal(records.length, 2);
  for (const value of records) {
    assert.equal(value.fields.component, 'checkout');
    assert.equal(value.fields.attempt, 2);
    assert.equal(value.tags.includes('otel-span'), true);
    assert.equal(value.tags.includes('payment'), true);
    assert.equal(value.tags.includes('critical'), true);
  }
});

test('lifecycleLevel false suppresses successful start and completion records', async () => {
  const { logger, records } = memoryLogger();
  const result = await withOpenTelemetrySpan(
    logger,
    tracerFor(span()),
    'quiet-success',
    async () => 9,
    { lifecycleLevel: false },
  );
  assert.equal(result, 9);
  assert.deepEqual(records, []);
});

test('lifecycleLevel false still emits one next-loggers ERROR record on callback failure', async () => {
  const { logger, records } = memoryLogger();
  const expected = new Error('application failed');
  await assert.rejects(
    withOpenTelemetrySpan(
      logger,
      tracerFor(span()),
      'quiet-failure',
      async () => {
        throw expected;
      },
      { lifecycleLevel: false },
    ),
    expected,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'ERROR');
  assert.match(records[0].message, /span failed: quiet-failure/);
});

test('a failing lifecycle logger transport cannot replace a successful callback result', async () => {
  const logger = createLogger({
    maxLevel: 'TRACE',
    console: false,
    onTransportError: () => undefined,
    transports: {
      write() {
        throw new Error('log transport unavailable');
      },
    },
  });
  const result = await withOpenTelemetrySpan(
    logger,
    tracerFor(span()),
    'logger-failure',
    async () => 13,
    { lifecycleLevel: 'INFO' },
  );
  assert.equal(result, 13);
});

test('span end runs once even when status mutation fails', async () => {
  let ended = 0;
  const active = span({
    setStatus() {
      throw new Error('status unavailable');
    },
    end() {
      ended += 1;
    },
  });
  const { logger, records } = memoryLogger();
  const result = await withOpenTelemetrySpan(
    logger,
    tracerFor(active),
    'status-failure',
    async () => 3,
    { lifecycleLevel: false },
  );
  assert.equal(result, 3);
  assert.equal(ended, 1);
  assert.equal(
    records.some((value) => value.message.startsWith('OpenTelemetry set success status failed')),
    true,
  );
});

test('non-Error callback throws retain their exact identity', async () => {
  const thrown = { code: 'DECLINED' };
  const recorded = [];
  const active = span({ recordException: (value) => recorded.push(value) });
  const { logger } = memoryLogger();
  let caught;
  try {
    await withOpenTelemetrySpan(
      logger,
      tracerFor(active),
      'object-throw',
      async () => {
        throw thrown;
      },
      { lifecycleLevel: false },
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, thrown);
  assert.deepEqual(recorded, [{ message: '[object Object]' }]);
});

test('a no-op fallback span still preserves callback failures after tracer startup fails', async () => {
  const expected = new Error('callback failed');
  const { logger } = memoryLogger();
  await assert.rejects(
    withOpenTelemetrySpan(
      logger,
      {
        startActiveSpan() {
          throw new Error('tracer unavailable');
        },
      },
      'fallback-error',
      async () => {
        throw expected;
      },
    ),
    expected,
  );
});

test('failOnStartError prevents the application callback from running', async () => {
  const { logger } = memoryLogger();
  let called = 0;
  await assert.rejects(
    withOpenTelemetrySpan(
      logger,
      {
        startActiveSpan() {
          throw new Error('tracer unavailable');
        },
      },
      'strict-start',
      async () => {
        called += 1;
      },
      { failOnStartError: true },
    ),
    /tracer unavailable/,
  );
  assert.equal(called, 0);
});

test('one hundred explicit spans produce exact start/end lifecycle counts', async () => {
  const { logger, records } = memoryLogger();
  let ended = 0;
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      withOpenTelemetrySpan(
        logger,
        tracerFor(
          span({
            spanContext: () => ({
              traceId: `trace-${index}`,
              spanId: `span-${index}`,
              traceFlags: 1,
            }),
            end() {
              ended += 1;
            },
          }),
        ),
        `operation-${index}`,
        async () => index,
        { lifecycleLevel: 'DEBUG' },
      ),
    ),
  );
  assert.equal(ended, 100);
  assert.equal(records.length, 200);
  assert.equal(records.filter((value) => value.fields['otel.span_phase'] === 'start').length, 100);
  assert.equal(records.filter((value) => value.fields['otel.span_phase'] === 'end').length, 100);
  assert.equal(new Set(records.map((value) => value.fields['otel.trace_id'])).size, 100);
});
