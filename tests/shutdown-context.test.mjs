import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  captureLogContext,
  getLogContext,
  runWithCapturedLogContext,
  runWithLogContext,
  runWithMergedLogContext,
} from '../dist/context.js';
import {
  createShutdownLoggerObserver,
  ShutdownCoordinator,
} from '../dist/shutdown.js';
import {
  createNodeHttpShutdown,
  installNodeShutdownSignals,
} from '../dist/node-shutdown.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('captured AsyncLocalStorage context can be re-entered without leaking', async () => {
  let captured;
  await runWithLogContext(
    {
      fields: { requestId: 'r1' },
      loggedInUser: { id: 'u1' },
      traceId: 'trace-1',
      tags: ['request'],
    },
    async () => {
      captured = captureLogContext();
      assert.equal(captured.loggedInUser.id, 'u1');
      await runWithMergedLogContext({ fields: { operation: 'charge' } }, async () => {
        assert.deepEqual(getLogContext().fields, {
          requestId: 'r1',
          operation: 'charge',
        });
      });
      assert.deepEqual(getLogContext().fields, { requestId: 'r1' });
    },
  );

  assert.equal(getLogContext(), undefined);
  await runWithCapturedLogContext(captured, async () => {
    assert.equal(getLogContext().traceId, 'trace-1');
    assert.equal(getLogContext().loggedInUser.id, 'u1');
  });
  assert.equal(getLogContext(), undefined);
});

test('TTY signal handling drains first and forces on Ctrl-D', async () => {
  const source = new EventEmitter();
  source.stdin = new EventEmitter();
  source.stdin.isTTY = true;
  source.stdin.resume = () => undefined;
  const draining = deferred();
  let forced = 0;
  const coordinator = new ShutdownCoordinator({
    gracePeriodMillis: 1_000,
    drain: () => draining.promise,
    force: () => {
      forced += 1;
    },
  });
  const dispose = installNodeShutdownSignals(coordinator, { source });
  source.emit('SIGINT');
  assert.equal(coordinator.phase, 'draining');
  source.stdin.emit('end');
  const result = await coordinator.wait();
  assert.equal(result.forced, true);
  assert.equal(forced, 1);
  dispose();
  draining.resolve();
});

test('Node HTTP drain and force paths stay separate', async () => {
  let closeCallback;
  const calls = [];
  const server = {
    close(callback) {
      calls.push('close');
      closeCallback = callback;
    },
    closeIdleConnections() {
      calls.push('idle');
    },
    closeAllConnections() {
      calls.push('all');
    },
  };
  const handle = createNodeHttpShutdown({
    servers: server,
    gracePeriodMillis: 1_000,
    installSignalHandlers: false,
  });
  void handle.request('SIGTERM');
  assert.deepEqual(calls, ['close', 'idle']);
  const result = await handle.request('SIGTERM', true);
  assert.equal(result.forced, true);
  assert.deepEqual(calls, ['close', 'idle', 'close', 'all']);
  closeCallback?.();
});

test('lifecycle logger observer finishes before flush', async () => {
  const records = [];
  const logger = {
    info: (...values) => event('INFO', values),
    warn: (...values) => event('WARN', values),
    error: (...values) => event('ERROR', values),
  };
  function event(level, values) {
    const record = { level, values, fields: {}, errors: [] };
    return {
      addFields(fields) {
        Object.assign(record.fields, fields);
        return this;
      },
      addError(error) {
        record.errors.push(error);
        return this;
      },
      async send() {
        await Promise.resolve();
        records.push(record);
      },
    };
  }

  const draining = deferred();
  let recordsAtFlush = 0;
  const coordinator = new ShutdownCoordinator({
    gracePeriodMillis: 1_000,
    drain: () => draining.promise,
    force: () => undefined,
    onEvent: createShutdownLoggerObserver(logger),
    flush: () => {
      recordsAtFlush = records.length;
    },
  });
  void coordinator.request('SIGINT', { interactive: true });
  const result = await coordinator.request('stdin-eof', {
    force: true,
    interactive: true,
  });
  assert.equal(result.forced, true);
  assert.equal(recordsAtFlush, 3);
  assert.deepEqual(
    records.map((record) => record.fields['shutdown.phase']),
    ['draining', 'forcing', 'stopped'],
  );
  draining.resolve();
});
