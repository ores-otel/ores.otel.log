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
    id: 'record-1',
    timestamp: '2026-08-03T04:00:00.000Z',
    level: 'INFO',
    runtime: 'node',
    appName: 'checkout',
    name: 'payments',
    message: 'charge started',
    values: ['charge started'],
    fields: {},
    ...overrides,
  };
}

function memoryLogger(options = {}) {
  const records = [];
  const logger = createLogger({
    appName: 'test-app',
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

test('resource attributes cannot override protected record identity attributes', () => {
  const attributes = logRecordToOtelAttributes(record(), {
    attributes: {
      'service.name': 'attacker-service',
      'next_logger.runtime': 'attacker-runtime',
      'next_logger.level': 'FATAL',
      'log.record.uid': 'attacker-id',
      'deployment.environment': 'production',
    },
  });
  assert.equal(attributes['service.name'], 'checkout');
  assert.equal(attributes['next_logger.runtime'], 'node');
  assert.equal(attributes['next_logger.level'], 'INFO');
  assert.equal(attributes['log.record.uid'], 'record-1');
  assert.equal(attributes['deployment.environment'], 'production');
});

test('field and values export can be disabled independently', () => {
  const value = record({
    fields: { orderId: 'order-1' },
    values: ['charge started', 42],
  });
  const withoutFields = logRecordToOtelAttributes(value, {
    includeFields: false,
    includeValues: true,
  });
  assert.equal('next_logger.field.orderId' in withoutFields, false);
  assert.equal(withoutFields['next_logger.values'], '["charge started",42]');

  const withoutValues = logRecordToOtelAttributes(value, {
    includeFields: true,
    includeValues: false,
  });
  assert.equal(withoutValues['next_logger.field.orderId'], 'order-1');
  assert.equal('next_logger.values' in withoutValues, false);
});

test('attribute strings, arrays, objects, tags, and values obey explicit bounds', () => {
  const attributes = logRecordToOtelAttributes(
    record({
      tags: ['one', 'two', 'three', 'four'],
      values: ['x'.repeat(100)],
      fields: {
        text: 'x'.repeat(100),
        array: ['one', 'two', 'three', 'four'],
        object: { nested: 'y'.repeat(100) },
      },
    }),
    {
      includeValues: true,
      maxAttributeLength: 24,
      maxAttributeArrayLength: 2,
    },
  );
  assert.match(attributes['next_logger.field.text'], /truncated/);
  assert.deepEqual(attributes['next_logger.field.array'], ['one', 'two']);
  assert.match(attributes['next_logger.field.object'], /truncated/);
  assert.deepEqual(attributes['next_logger.tags'], ['one', 'two']);
  assert.match(attributes['next_logger.values'], /truncated/);
});

test('non-recording spans correlate logs but do not receive events or status updates', () => {
  const emitted = [];
  let events = 0;
  let statuses = 0;
  const span = {
    spanContext: () => ({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
    }),
    isRecording: () => false,
    addEvent() {
      events += 1;
    },
    setStatus() {
      statuses += 1;
    },
  };
  const transport = createOpenTelemetryTransport({
    logger: { emit: (value) => emitted.push(value) },
    activeSpan: () => span,
  });
  transport.write(record({ level: 'ERROR' }));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].attributes['trace.id'], '0123456789abcdef0123456789abcdef');
  assert.equal(emitted[0].attributes['span.id'], '0123456789abcdef');
  assert.equal(events, 0);
  assert.equal(statuses, 0);
});

test('active span and active context lookup failures are reported and logs still emit', () => {
  const operations = [];
  const emitted = [];
  const transport = createOpenTelemetryTransport({
    logger: { emit: (value) => emitted.push(value) },
    activeSpan() {
      throw new Error('span lookup failed');
    },
    activeContext() {
      throw new Error('context lookup failed');
    },
    onError(_error, operation) {
      operations.push(operation);
    },
  });
  transport.write(record());
  assert.deepEqual(operations, ['read active span', 'read active context']);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].context, undefined);
});

test('log exporter failure does not suppress span events or metrics in fail-open mode', () => {
  const operations = [];
  const events = [];
  const metrics = [];
  const span = {
    spanContext: () => ({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
    }),
    isRecording: () => true,
    addEvent: (...args) => events.push(args),
  };
  const transport = createOpenTelemetryTransport({
    logger: {
      emit() {
        throw new Error('logs exporter unavailable');
      },
    },
    activeSpan: () => span,
    recordMetric: (...args) => metrics.push(args),
    onError(_error, operation) {
      operations.push(operation);
    },
  });
  transport.write(record());
  assert.deepEqual(operations, ['emit log']);
  assert.equal(events.length, 1);
  assert.equal(metrics.length, 1);
});

test('fail-closed mode throws exporter errors for validation environments', () => {
  const expected = new Error('exporter unavailable');
  const transport = createOpenTelemetryTransport({
    logger: {
      emit() {
        throw expected;
      },
    },
    failOpen: false,
  });
  assert.throws(() => transport.write(record()), expected);
});

test('metric attributes use the default low-cardinality allowlist', () => {
  const metrics = [];
  const transport = createOpenTelemetryTransport({
    logger: { emit() {} },
    attributes: {
      'deployment.environment': 'production',
      'service.version': '1.2.3',
      'customer.id': 'customer-high-cardinality',
    },
    recordMetric: (name, value, attributes) =>
      metrics.push({ name, value, attributes }),
  });
  transport.write(
    record({
      traceId: 'trace-high-cardinality',
      fields: { orderId: 'order-high-cardinality' },
    }),
  );
  assert.equal(metrics.length, 1);
  assert.deepEqual(metrics[0].attributes, {
    'service.name': 'checkout',
    'next_logger.runtime': 'node',
    'next_logger.level': 'INFO',
    'deployment.environment': 'production',
    'service.version': '1.2.3',
  });
});

test('a custom metric allowlist is exact and does not implicitly include trace data', () => {
  const metrics = [];
  const transport = createOpenTelemetryTransport({
    logger: { emit() {} },
    attributes: { region: 'us-east-1', tenant: 'stable-tenant' },
    metricAttributeKeys: ['region'],
    recordMetric: (_name, _value, attributes) => metrics.push(attributes),
  });
  transport.write(record({ traceId: 'trace-1' }));
  assert.deepEqual(metrics, [{ region: 'us-east-1' }]);
});

test('ERROR records set span status even when no exception object is present', () => {
  const statuses = [];
  let exceptions = 0;
  const span = {
    spanContext: () => ({ traceId: 'trace', spanId: 'span', traceFlags: 1 }),
    isRecording: () => true,
    addEvent() {},
    setStatus: (status) => statuses.push(status),
    recordException() {
      exceptions += 1;
    },
  };
  createOpenTelemetryTransport({
    logger: { emit() {} },
    activeSpan: () => span,
  }).write(record({ level: 'ERROR', errors: [] }));
  assert.deepEqual(statuses, [{ code: 2, message: 'charge started' }]);
  assert.equal(exceptions, 0);
});

test('structured error records are converted back to Error objects for spans', () => {
  const exceptions = [];
  const span = {
    spanContext: () => ({ traceId: 'trace', spanId: 'span', traceFlags: 1 }),
    isRecording: () => true,
    addEvent() {},
    setStatus() {},
    recordException: (error) => exceptions.push(error),
  };
  createOpenTelemetryTransport({
    logger: { emit() {} },
    activeSpan: () => span,
  }).write(
    record({
      level: 'ERROR',
      errors: [
        {
          name: 'PaymentError',
          message: 'declined',
          stack: 'PaymentError: declined\n at checkout',
        },
      ],
    }),
  );
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0] instanceof Error, true);
  assert.equal(exceptions[0].name, 'PaymentError');
  assert.equal(exceptions[0].message, 'declined');
  assert.match(exceptions[0].stack, /checkout/);
});

test('context provider tolerates broken trace-state serialization', () => {
  const provider = createOpenTelemetryContextProvider(() => ({
    spanContext: () => ({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
      traceState: {
        serialize() {
          throw new Error('bad state');
        },
      },
    }),
    isRecording: () => true,
    addEvent() {},
  }));
  assert.deepEqual(provider(), {
    traceId: '0123456789abcdef0123456789abcdef',
    traceIds: ['0123456789abcdef0123456789abcdef'],
    fields: {
      'otel.span_id': '0123456789abcdef',
      'otel.trace_flags': 1,
    },
    tags: ['otel'],
  });
});

test('span start failure runs the application callback with a no-op span by default', async () => {
  const { logger, records } = memoryLogger();
  const result = await withOpenTelemetrySpan(
    logger,
    {
      startActiveSpan() {
        throw new Error('tracer unavailable');
      },
    },
    'fallback.operation',
    async (span) => {
      assert.deepEqual(span.spanContext(), {
        traceId: '',
        spanId: '',
        traceFlags: 0,
      });
      span.addEvent('safe noop');
      return 17;
    },
  );
  assert.equal(result, 17);
  assert.equal(
    records.some((value) => value.message.startsWith('OpenTelemetry start span failed')),
    true,
  );
});

test('span start failure can be made fail-closed explicitly', async () => {
  const { logger } = memoryLogger();
  const expected = new Error('tracer unavailable');
  await assert.rejects(
    withOpenTelemetrySpan(
      logger,
      {
        startActiveSpan() {
          throw expected;
        },
      },
      'strict.operation',
      async () => 1,
      { failOnStartError: true },
    ),
    expected,
  );
});

test('synchronous and asynchronous callback failures preserve identity and end the span', async (t) => {
  for (const mode of ['sync', 'async']) {
    await t.test(mode, async () => {
      let ended = 0;
      const recorded = [];
      const statuses = [];
      const span = {
        spanContext: () => ({ traceId: 'trace', spanId: 'span', traceFlags: 1 }),
        addEvent() {},
        recordException: (error) => recorded.push(error),
        setStatus: (status) => statuses.push(status),
        end() {
          ended += 1;
        },
      };
      const tracer = {
        startActiveSpan(_name, _options, callback) {
          return callback(span);
        },
      };
      const { logger } = memoryLogger();
      const expected = new Error(`${mode} failure`);
      const callback =
        mode === 'sync'
          ? () => {
              throw expected;
            }
          : async () => {
              await Promise.resolve();
              throw expected;
            };
      await assert.rejects(
        withOpenTelemetrySpan(logger, tracer, `${mode}.operation`, callback, {
          lifecycleLevel: false,
        }),
        expected,
      );
      assert.deepEqual(recorded, [expected]);
      assert.deepEqual(statuses, [{ code: 2, message: `${mode} failure` }]);
      assert.equal(ended, 1);
    });
  }
});

test('invalid lifecycle levels fall back to DEBUG instead of crashing', async () => {
  const { logger, records } = memoryLogger();
  const span = {
    spanContext: () => ({ traceId: 'trace', spanId: 'span', traceFlags: 1 }),
    addEvent() {},
    setStatus() {},
    end() {},
  };
  const result = await withOpenTelemetrySpan(
    logger,
    {
      startActiveSpan(_name, _options, callback) {
        return callback(span);
      },
    },
    'invalid-level',
    async () => 5,
    { lifecycleLevel: 'NOT_A_LEVEL' },
  );
  assert.equal(result, 5);
  assert.deepEqual(
    records.map((value) => value.level),
    ['DEBUG', 'DEBUG'],
  );
});

test('manual instrumentation does not monkey-patch runtime globals or prototypes', async () => {
  const before = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    promiseThen: Promise.prototype.then,
    consoleLog: console.log,
    eventTargetAdd: EventTarget.prototype.addEventListener,
  };
  const emitted = [];
  const transport = createOpenTelemetryTransport({
    logger: { emit: (value) => emitted.push(value) },
  });
  transport.write(record());
  const { logger } = memoryLogger();
  await withOpenTelemetrySpan(
    logger,
    {
      startActiveSpan(_name, _options, callback) {
        return callback({
          spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
          addEvent() {},
          setStatus() {},
          end() {},
        });
      },
    },
    'manual',
    async () => undefined,
    { lifecycleLevel: false },
  );
  assert.equal(emitted.length, 1);
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(globalThis.setTimeout, before.setTimeout);
  assert.equal(Promise.prototype.then, before.promiseThen);
  assert.equal(console.log, before.consoleLog);
  assert.equal(EventTarget.prototype.addEventListener, before.eventTargetAdd);
});
