import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLogContext,
  httpRequestBoundary,
  runWithLogContext,
  runWithRequestBoundary,
  tcpConnectionBoundary,
  tcpMessageBoundary,
  webSocketMessageBoundary,
  webSocketSessionBoundary,
} from '../dist/context.js';
import {
  getLogContext as getBrowserLogContext,
  runWithRequestBoundary as runWithBrowserBoundary,
} from '../dist/context-browser.js';
import {
  getLogContext as getWorkerdLogContext,
  runWithRequestBoundary as runWithWorkerdBoundary,
} from '../dist/context-workerd.js';

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function contextFor(slot) {
  return {
    traceId: slot.toString(16).padStart(32, '0'),
    traceIds: [slot.toString(16).padStart(32, '0')],
    routineId: `request-${slot}`,
    fields: {
      'request.id': `request-${slot}`,
      'user.id': `user-${slot}`,
      'tenant.id': `tenant-${slot}`,
    },
    tags: ['request-boundary-test'],
  };
}

function boundaryFor(slot) {
  switch (slot % 5) {
    case 0:
      return httpRequestBoundary('handler', `http-${slot}`);
    case 1:
      return tcpConnectionBoundary('accept', `connection-${slot}`);
    case 2:
      return tcpMessageBoundary(
        'decode',
        `connection-${slot}`,
        `message-${slot}`,
      );
    case 3:
      return webSocketSessionBoundary('upgrade', `session-${slot}`);
    case 4:
      return webSocketMessageBoundary(
        'dispatch',
        `session-${slot}`,
        `message-${slot}`,
      );
    default:
      throw new Error('unreachable slot');
  }
}

test('parallel HTTP, TCP, and WebSocket failures remain pinned to one request', async () => {
  const reports = [];
  const count = 60;
  const results = await Promise.all(
    Array.from({ length: count }, async (_, slot) =>
      runWithRequestBoundary(
        contextFor(slot),
        boundaryFor(slot),
        async () => {
          await delay((count - slot) % 9);
          assert.equal(
            getLogContext()?.fields?.['request.id'],
            `request-${slot}`,
          );
          throw new Error(`failure-${slot}`);
        },
        {
          now: () => 1_000 + slot,
          report: async (failure) => {
            assert.equal(
              getLogContext()?.fields?.['request.id'],
              `request-${slot}`,
            );
            await delay(slot % 4);
            reports.push({
              requestId: failure.context.fields?.['request.id'],
              transport: failure.boundary.transport,
              scope: failure.boundary.scope,
              observedAtUnixMs: failure.observedAtUnixMs,
            });
          },
        },
      ),
    ),
  );

  assert.equal(getLogContext(), undefined);
  assert.equal(reports.length, count);
  assert.equal(results.length, count);
  for (let slot = 0; slot < count; slot += 1) {
    const result = results[slot];
    assert.equal(result.ok, false);
    assert.equal(result.failure.kind, 'exception');
    assert.equal(
      result.failure.context.fields?.['request.id'],
      `request-${slot}`,
    );
    assert.equal(result.failure.observedAtUnixMs, 1_000 + slot);
    assert.equal(result.failure.cause.message, `failure-${slot}`);
  }
});

test('nested failure boundaries restore the parent frame', async () => {
  const outer = contextFor(100);
  const inner = contextFor(101);

  await runWithLogContext(outer, async () => {
    assert.equal(getLogContext()?.fields?.['request.id'], 'request-100');
    const result = await runWithRequestBoundary(
      inner,
      webSocketMessageBoundary('dispatch', 'session-101', 'message-101'),
      async () => {
        assert.equal(getLogContext()?.fields?.['request.id'], 'request-101');
        throw new Error('inner failure');
      },
      {
        report(failure) {
          assert.equal(
            getLogContext()?.fields?.['request.id'],
            'request-101',
          );
          assert.equal(
            failure.context.fields?.['request.id'],
            'request-101',
          );
        },
      },
    );

    assert.equal(result.ok, false);
    assert.equal(getLogContext()?.fields?.['request.id'], 'request-100');
  });

  assert.equal(getLogContext(), undefined);
});

test('reporter failure cannot replace the original operation failure', async () => {
  const original = new Error('original request failure');
  const result = await runWithRequestBoundary(
    contextFor(200),
    httpRequestBoundary('finalize'),
    async () => {
      throw original;
    },
    {
      classify: () => 'timeout',
      report: async () => {
        throw new Error('telemetry sink unavailable');
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure.kind, 'timeout');
  assert.equal(result.failure.cause, original);
  assert.equal(getLogContext(), undefined);
});

test('successful boundaries preserve values and do not report failures', async () => {
  let reports = 0;
  const result = await runWithRequestBoundary(
    contextFor(300),
    tcpMessageBoundary('dispatch', 'connection-300', 'message-300'),
    async () => {
      await delay(1);
      return 42;
    },
    { report: () => { reports += 1; } },
  );

  assert.deepEqual(result, { ok: true, value: 42 });
  assert.equal(reports, 0);
  assert.equal(getLogContext(), undefined);
});

test('browser fallback carries explicit failure context without async ambient bleed', async () => {
  const count = 24;
  const results = await Promise.all(
    Array.from({ length: count }, async (_, slot) =>
      runWithBrowserBoundary(
        contextFor(slot),
        webSocketMessageBoundary(
          'browser-dispatch',
          `session-${slot}`,
          `message-${slot}`,
        ),
        async () => {
          await delay((count - slot) % 5);
          assert.equal(getBrowserLogContext(), undefined);
          throw new Error(`browser-${slot}`);
        },
      ),
    ),
  );

  assert.equal(getBrowserLogContext(), undefined);
  for (let slot = 0; slot < count; slot += 1) {
    assert.equal(results[slot].ok, false);
    assert.equal(
      results[slot].failure.context.fields?.['request.id'],
      `request-${slot}`,
    );
  }
});

test('workerd explicit-only fallback never exposes ambient request identity', async () => {
  const result = await runWithWorkerdBoundary(
    contextFor(400),
    tcpConnectionBoundary('workerd-connection', 'connection-400'),
    async () => {
      assert.equal(getWorkerdLogContext(), undefined);
      await delay(1);
      assert.equal(getWorkerdLogContext(), undefined);
      throw new Error('workerd failure');
    },
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.failure.context.fields?.['request.id'],
    'request-400',
  );
  assert.equal(getWorkerdLogContext(), undefined);
});
