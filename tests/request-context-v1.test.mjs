import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  REQUEST_CONTEXT_SCHEMA,
  captureExecutionLogContext,
  getCorrelationId,
  getExecutionLogContext,
  getLoggedInUserId,
  getRequestId,
  getSessionId,
  getTenantId,
  runWithCapturedExecutionLogContext,
  runWithExecutionLoggedInUser,
  runWithExecutionLogContext,
  toLoggerLogContext,
} from '../dist/execution-context.js';
import {
  getLogContext as getWorkerdLogContext,
  isAsyncContextTracked as isWorkerdAsyncContextTracked,
  runWithLogContext as runWithWorkerdLogContext,
} from '../dist/context-workerd.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('request identity getters remain isolated across concurrent async chains', async () => {
  await Promise.all(
    ['alpha', 'beta', 'gamma'].map((id) =>
      runWithExecutionLogContext(
        {
          requestId: `request-${id}`,
          loggedInUserId: `user-${id}`,
          tenantId: `tenant-${id}`,
          sessionId: `session-${id}`,
          correlationId: `correlation-${id}`,
          traceId: id.padEnd(32, '0').slice(0, 32),
        },
        async () => {
          await turn();
          assert.equal(getRequestId(), `request-${id}`);
          assert.equal(getLoggedInUserId(), `user-${id}`);
          assert.equal(getTenantId(), `tenant-${id}`);
          assert.equal(getSessionId(), `session-${id}`);
          assert.equal(getCorrelationId(), `correlation-${id}`);
          assert.equal(getExecutionLogContext().loggedInUser.id, `user-${id}`);
        },
      ),
    ),
  );
  assert.equal(getRequestId(), undefined);
  assert.equal(getLoggedInUserId(), undefined);
});

test('immutable child scopes isolate sibling enrichment and restore their parent', async () => {
  await runWithExecutionLogContext(
    { requestId: 'request-parent', tenantId: 'tenant-parent' },
    async () => {
      const observed = await Promise.all(
        ['alpha', 'beta', 'gamma'].map((id, index) =>
          runWithExecutionLoggedInUser({ id: `user-${id}` }, () =>
            runWithExecutionLogContext({ sessionId: `session-${id}` }, async () => {
              await new Promise((resolve) => setTimeout(resolve, (3 - index) * 5));
              return {
                requestId: getRequestId(),
                userId: getLoggedInUserId(),
                tenantId: getTenantId(),
                sessionId: getSessionId(),
              };
            }),
          ),
        ),
      );

      for (const [index, id] of ['alpha', 'beta', 'gamma'].entries()) {
        assert.deepEqual(observed[index], {
          requestId: 'request-parent',
          userId: `user-${id}`,
          tenantId: 'tenant-parent',
          sessionId: `session-${id}`,
        });
      }

      assert.equal(getRequestId(), 'request-parent');
      assert.equal(getTenantId(), 'tenant-parent');
      assert.equal(getLoggedInUserId(), undefined);
      assert.equal(getSessionId(), undefined);
    },
  );

  assert.equal(getRequestId(), undefined);
});

test('captured contexts explicitly cross detached task and queue boundaries', async () => {
  let snapshot;
  await runWithExecutionLogContext(
    { requestId: 'request-parent', loggedInUserId: 'user-parent' },
    () =>
      runWithExecutionLogContext({ tenantId: 'tenant-parent' }, () => {
        snapshot = captureExecutionLogContext();
      }),
  );

  assert.equal(getRequestId(), undefined);
  await runWithCapturedExecutionLogContext(snapshot, async () => {
    await turn();
    assert.equal(getRequestId(), 'request-parent');
    assert.equal(getLoggedInUserId(), 'user-parent');
    assert.equal(getTenantId(), 'tenant-parent');
  });
});

test('captured absence clears an invoking request and restores it afterward', async () => {
  const noContext = captureExecutionLogContext();
  assert.equal(noContext, undefined);

  await runWithExecutionLogContext(
    { requestId: 'request-invoker', loggedInUserId: 'user-invoker' },
    async () => {
      assert.equal(getRequestId(), 'request-invoker');
      assert.equal(getLoggedInUserId(), 'user-invoker');

      await runWithCapturedExecutionLogContext(noContext, async () => {
        await turn();
        assert.equal(getRequestId(), undefined);
        assert.equal(getLoggedInUserId(), undefined);
        assert.equal(getExecutionLogContext(), undefined);
      });

      assert.equal(getRequestId(), 'request-invoker');
      assert.equal(getLoggedInUserId(), 'user-invoker');
    },
  );

  assert.equal(getRequestId(), undefined);
  assert.equal(getLoggedInUserId(), undefined);
});

test('read snapshots cannot mutate the active request context', () => {
  runWithExecutionLogContext(
    {
      requestId: 'request-stable',
      loggedInUserId: 'user-stable',
      fields: { stable: true },
    },
    () => {
      const snapshot = getExecutionLogContext();
      snapshot.requestId = 'request-mutated';
      snapshot.loggedInUser.id = 'user-mutated';
      snapshot.fields.stable = false;

      assert.equal(getRequestId(), 'request-stable');
      assert.equal(getLoggedInUserId(), 'user-stable');
      assert.equal(getExecutionLogContext().fields.stable, true);
    },
  );
});

test('request identity projects into stable structured logger fields', () => {
  const projected = toLoggerLogContext({
    requestId: 'request-1',
    loggedInUserId: 'user-1',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    correlationId: 'correlation-1',
    parentRequestId: 'request-0',
    operation: 'GET /v1/profile',
    serviceName: 'profile-api',
    startedAtUnixMs: 1_000,
    deadlineUnixMs: 2_000,
    locale: 'en-US',
  });

  assert.equal(REQUEST_CONTEXT_SCHEMA, 'ores.request-context.v1');
  assert.equal(projected.loggedInUser.id, 'user-1');
  assert.deepEqual(projected.fields, {
    'request.id': 'request-1',
    'user.id': 'user-1',
    'tenant.id': 'tenant-1',
    'session.id': 'session-1',
    'correlation.id': 'correlation-1',
    'request.parent_id': 'request-0',
    'operation.name': 'GET /v1/profile',
    'service.name': 'profile-api',
    'request.locale': 'en-US',
    'request.started_at_unix_ms': 1_000,
    'request.deadline_unix_ms': 2_000,
  });
});

test('workerd without native ALS fails closed instead of sharing a global frame', async () => {
  if (isWorkerdAsyncContextTracked()) return;
  await runWithWorkerdLogContext({ fields: { request: 'unsafe' } }, async () => {
    await turn();
    assert.equal(getWorkerdLogContext(), undefined);
  });
});

test('TypeSpec and JSON Schema are peer human-authored authorities', async () => {
  const [schemaText, typeSpec] = await Promise.all([
    readFile(new URL('../contracts/request-context.v1.schema.json', import.meta.url), 'utf8'),
    readFile(new URL('../contracts/request-context.v1.tsp', import.meta.url), 'utf8'),
  ]);
  const schema = JSON.parse(schemaText);
  const fields = [
    'requestId',
    'loggedInUserId',
    'tenantId',
    'sessionId',
    'correlationId',
    'parentRequestId',
    'traceId',
    'spanId',
    'operation',
    'serviceName',
    'locale',
    'startedAtUnixMs',
    'deadlineUnixMs',
    'baggage',
  ];

  for (const field of fields) {
    assert.ok(Object.hasOwn(schema.properties, field), `JSON Schema missing ${field}`);
    assert.match(typeSpec, new RegExp(`\\b${field}\\??:`), `TypeSpec missing ${field}`);
  }
  assert.match(typeSpec, /peer of request-context\.v1\.schema\.json, not generated from it/);
});
