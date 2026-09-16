import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ORES_TRACE_HEADER,
  buildErrorTraceTelemetry,
  buildOresTraceHeaders,
  isOresRoutineId,
  isOresTraceId,
  isOtelSpanId,
  isOtelTraceId,
  isReleaseSha,
  readOresTraceIdHeader,
} from '@oresoftware/next-loggers/error-trace';

const record = (overrides = {}) => ({
  schema: 'next-loggers/v1',
  id: 'log-1',
  timestamp: '2026-09-15T12:00:00.000Z',
  level: 'ERROR',
  runtime: 'node',
  appName: 'payments-api',
  message: 'query failed for user 123456',
  values: [],
  fields: {},
  ...overrides,
});

const legacyTraceId = (suffix) => ['dd', 'trace', suffix].join('-');
const legacyRoutineId = (suffix) => ['ddl', 'routine', suffix].join('-');

test('builds the portable error-trace telemetry envelope without fingerprint semantics', () => {
  const input = record({
    traceId: 'ores-trace-V1StGXR8_Z5jdHi6B-myT',
    routineId: 'ores-routine-V1StGXR8_Z5jdHi6B-myT',
    fields: {
      environment: 'prod',
      repository: 'payments/payments-api-server.rs',
      release_sha: '0123456789abcdef0123456789abcdef01234567',
      parent_trace_id: 'ores-trace-Qp8sVnH2Kx4M3zY7wT9aBc',
      otel_trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
      otel_span_id: '00f067aa0ba902b7',
      error_type: 'database',
      operation: 'POST /payments/:id',
      file_name: 'src/db.ts',
      authorization: 'Bearer must-not-leak',
    },
    errors: [{ name: 'DbError', message: 'connection timeout', code: 'DB_TIMEOUT' }],
    stackTrace: ['src/db.ts:123:45', 'src/handler.ts:10:2'],
  });

  const before = JSON.stringify(input);
  const telemetry = buildErrorTraceTelemetry(input);

  assert.equal(JSON.stringify(input), before, 'builder must not mutate the LogRecord');
  assert.deepEqual(telemetry, {
    version: 1,
    kind: 'error',
    service: 'payments-api',
    environment: 'prod',
    repository: 'payments/payments-api-server.rs',
    release_sha: '0123456789abcdef0123456789abcdef01234567',
    trace_id: 'ores-trace-V1StGXR8_Z5jdHi6B-myT',
    parent_trace_id: 'ores-trace-Qp8sVnH2Kx4M3zY7wT9aBc',
    otel_trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    otel_span_id: '00f067aa0ba902b7',
    exception_type: 'DbError',
    error_type: 'database',
    error_code: 'DB_TIMEOUT',
    message: 'query failed for user 123456',
    error_list: ['connection timeout'],
    top_frame: 'src/db.ts:123:45',
    operation: 'POST /payments/:id',
    severity: 'error',
    runtime: 'node',
    source: 'ores.otel.log',
    routine_id: 'ores-routine-V1StGXR8_Z5jdHi6B-myT',
    file_name: 'src/db.ts',
  });
  assert.equal('authorization' in telemetry, false);
  assert.equal('fingerprint' in telemetry, false);
});

test('explicit options override only reviewed contract fields', () => {
  const telemetry = buildErrorTraceTelemetry(record(), {
    service: 'worker-api',
    environment: 'staging',
    repository: 'acme/worker',
    releaseSha: 'abcdef1',
    errorType: 'database',
    errorCode: 'E_DB',
    operation: 'worker.consume',
    source: 'integration-test',
    fileName: 'src/worker.ts',
  });
  assert.equal(telemetry.service, 'worker-api');
  assert.equal(telemetry.environment, 'staging');
  assert.equal(telemetry.release_sha, 'abcdef1');
  assert.equal(telemetry.error_code, 'E_DB');
  assert.equal(telemetry.operation, 'worker.consume');
});

test('identifier guards reject legacy or malformed correlation values', () => {
  const oldTraceId = legacyTraceId('V1StGXR8_Z5jdHi6B-myT');
  const oldRoutineId = legacyRoutineId('old');
  assert.equal(isOresTraceId('ores-trace-V1StGXR8_Z5jdHi6B-myT'), true);
  assert.equal(isOresTraceId(oldTraceId), false);
  assert.equal(isOresRoutineId('ores-routine-V1StGXR8_Z5jdHi6B-myT'), true);
  assert.equal(isOtelTraceId('4bf92f3577b34da6a3ce929d0e0e4736'), true);
  assert.equal(isOtelSpanId('00f067aa0ba902b7'), true);
  assert.equal(isReleaseSha('abcdef1'), true);

  assert.throws(
    () => buildErrorTraceTelemetry(record({ traceId: oldTraceId })),
    /invalid trace_id/u,
  );
  assert.throws(
    () => buildErrorTraceTelemetry(record(), { otelTraceId: 'not-an-otel-trace' }),
    /invalid otel_trace_id/u,
  );
  assert.throws(
    () => buildErrorTraceTelemetry(record({ routineId: oldRoutineId })),
    /invalid routine_id/u,
  );
  assert.throws(
    () => buildErrorTraceTelemetry(record(), { releaseSha: 'NOT-A-SHA' }),
    /invalid release_sha/u,
  );
});

test('bounded text fields remain contract-valid without widening the schema', () => {
  const telemetry = buildErrorTraceTelemetry(record({
    message: 'm'.repeat(9000),
    stackTrace: ['f'.repeat(2000)],
    errors: Array.from({ length: 40 }, (_, index) => `error-${index}`),
  }));
  assert.equal(telemetry.message.length, 8192);
  assert.equal(telemetry.top_frame.length, 1024);
  assert.equal(telemetry.error_list.length, 32);
});

test('x-ores-trace-id is authored lowercase and incoming matching is case-insensitive', () => {
  const id = 'ores-trace-V1StGXR8_Z5jdHi6B-myT';
  const outgoing = buildOresTraceHeaders(id);
  assert.equal(ORES_TRACE_HEADER, 'x-ores-trace-id');
  assert.deepEqual(outgoing, { 'x-ores-trace-id': id });
  assert.equal(Object.isFrozen(outgoing), true);
  assert.equal(readOresTraceIdHeader({ 'X-ORES-TRACE-ID': id }), id);
  assert.equal(readOresTraceIdHeader(new Headers({ 'X-Ores-Trace-Id': id })), id);
  assert.equal(readOresTraceIdHeader({}), undefined);
  assert.throws(
    () => readOresTraceIdHeader({ 'x-ores-trace-id': legacyTraceId('legacy') }),
    /invalid x-ores-trace-id/u,
  );
  assert.throws(
    () => readOresTraceIdHeader({ 'x-ores-trace-id': [id, id] }),
    /ambiguous x-ores-trace-id/u,
  );
});
