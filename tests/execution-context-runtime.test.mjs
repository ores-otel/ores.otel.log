import assert from 'node:assert/strict';
import test from 'node:test';

import { BaseLogger } from '../dist/base-logger.js';
import {
  enrichEventFromExecutionContext,
  getExecutionLogContext,
  installExecutionLogContextProvider,
  runWithExecutionLoggedInUser,
  runWithExecutionLogContext,
} from '../dist/execution-context.js';

test('AsyncLocalStorage execution context isolates requests and enriches records', async () => {
  const records = [];
  const logger = new BaseLogger({
    appName: 'execution-context-test',
    console: false,
    transports: { write: (record) => records.push(record) },
  });
  const uninstall = installExecutionLogContextProvider();
  try {
    await Promise.all(
      ['a', 'b'].map((id) =>
        runWithExecutionLogContext(
          {
            loggedInUser: { id: `user-${id}` },
            traceId: `trace-${id}`,
            spanId: `span-${id}`,
            traceFlags: id === 'a' ? 0 : 1,
            baggage: { request: id },
            context: [{ requestId: id }],
            meta: [{ source: 'test' }],
          },
          () =>
            runWithExecutionLoggedInUser({ role: 'member' }, async () => {
              await new Promise((resolve) => setImmediate(resolve));
              assert.equal(getExecutionLogContext().loggedInUser.id, `user-${id}`);
              assert.equal(getExecutionLogContext().loggedInUser.role, 'member');
              await enrichEventFromExecutionContext(logger.info(`request-${id}`)).send();
            }),
        ),
      ),
    );
  } finally {
    uninstall();
    await logger.close();
  }

  assert.equal(records.length, 2);
  for (const record of records) {
    const id = record.message.at(-1);
    assert.equal(record.loggedInUser.id, `user-${id}`);
    assert.equal(record.loggedInUser.role, 'member');
    assert.equal(record.traceId, `trace-${id}`);
    assert.equal(record.fields['otel.span_id'], `span-${id}`);
    assert.equal(record.fields['otel.trace_flags'], id === 'a' ? 0 : 1);
    assert.deepEqual(record.context, [{ requestId: id }]);
    assert.deepEqual(record.meta, [{ source: 'test' }]);
  }
  assert.equal(getExecutionLogContext(), undefined);
});
