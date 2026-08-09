import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeExecutionLogContexts,
  toLoggerLogContext,
} from '../dist/execution-context-shared.js';

test('rich context merge is immutable and preserves explicit zero trace flags', () => {
  const user = { id: 'user-1' };
  const base = {
    loggedInUser: user,
    traceId: 'trace-1',
    traceFlags: 1,
    baggage: { tenant: 'alpha' },
    tags: ['http'],
    context: ['outer'],
  };
  const merged = mergeExecutionLogContexts(base, {
    loggedInUser: { role: 'admin' },
    traceIds: ['trace-1', 'trace-2'],
    traceFlags: 0,
    spanId: 'span-1',
    baggage: { region: 'us-east-1' },
    tags: ['http', 'auth'],
    meta: ['inner-meta'],
  });
  user.id = 'mutated';

  assert.deepEqual(merged.loggedInUser, { id: 'user-1', role: 'admin' });
  assert.deepEqual(merged.traceIds, ['trace-1', 'trace-2']);
  assert.equal(merged.traceFlags, 0);
  assert.deepEqual(merged.baggage, { tenant: 'alpha', region: 'us-east-1' });
  assert.deepEqual(merged.tags, ['http', 'auth']);
  assert.deepEqual(merged.context, ['outer']);
  assert.deepEqual(merged.meta, ['inner-meta']);
});

test('rich context projects OpenTelemetry and payload state into logger fields', () => {
  const projected = toLoggerLogContext({
    loggedInUser: { id: 'user-1' },
    traceId: 'trace-1',
    spanId: 'span-1',
    traceFlags: 1,
    traceState: 'vendor=value',
    baggage: { tenant: 'alpha' },
    context: [{ request: 'req-1' }],
    meta: [{ attempt: 2 }],
  });

  assert.equal(projected.fields['otel.span_id'], 'span-1');
  assert.equal(projected.fields['otel.trace_flags'], 1);
  assert.equal(projected.fields['otel.trace_state'], 'vendor=value');
  assert.deepEqual(projected.fields['otel.baggage'], { tenant: 'alpha' });
  assert.deepEqual(projected.fields['next_logger.context'], [{ request: 'req-1' }]);
  assert.deepEqual(projected.fields['next_logger.meta'], [{ attempt: 2 }]);
});
