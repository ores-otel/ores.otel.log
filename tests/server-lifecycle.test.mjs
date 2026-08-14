import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  createNodeLoggerShutdownSink,
  installNodeServerShutdown,
  nextShutdownAction,
} from '../dist/server-lifecycle.js';

class FakeProcess extends EventEmitter {
  exitCode = undefined;
}

class FakeStdin extends EventEmitter {
  constructor(isTTY) {
    super();
    this.isTTY = isTTY;
    this.resumed = false;
    this.paused = false;
    this.readableFlowing = false;
  }

  resume() {
    this.resumed = true;
    this.readableFlowing = true;
  }

  pause() {
    this.paused = true;
    this.readableFlowing = false;
  }
}

class FakeServer {
  closeCalls = 0;
  idleCalls = 0;
  forceCalls = 0;
  callbacks = [];

  close(callback) {
    this.closeCalls += 1;
    this.callbacks.push(callback);
    return this;
  }

  closeIdleConnections() {
    this.idleCalls += 1;
  }

  closeAllConnections() {
    this.forceCalls += 1;
    this.finish();
  }

  finish(error) {
    const callbacks = this.callbacks.splice(0);
    for (const callback of callbacks) callback(error);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('interactive stdin remains untouched until first SIGINT', async () => {
  const runtime = new FakeProcess();
  const stdin = new FakeStdin(true);
  const server = new FakeServer();
  const events = [];
  const controller = installNodeServerShutdown({
    servers: server,
    process: runtime,
    stdin,
    timeoutMillis: 10_000,
    onLog: (event) => events.push(event),
  });

  assert.equal(stdin.resumed, false);
  assert.equal(stdin.listenerCount('end'), 0);
  stdin.emit('end');
  await tick();
  assert.equal(controller.phase, 'running');
  assert.equal(server.closeCalls, 0);

  runtime.emit('SIGINT');
  await tick();
  assert.equal(controller.phase, 'draining');
  assert.equal(stdin.resumed, true);
  assert.equal(stdin.listenerCount('end'), 1);
  assert.equal(server.closeCalls, 1);
  assert.equal(server.idleCalls, 1);
  assert.equal(server.forceCalls, 0);

  runtime.emit('SIGINT');
  const result = await controller.done;
  assert.equal(result.phase, 'forced');
  assert.equal(result.cause, 'SIGINT');
  assert.equal(server.forceCalls, 1);
  assert.equal(runtime.exitCode, 0);
  assert.equal(stdin.paused, true);
  const forced = events.find((event) => event.phase === 'forced');
  assert.equal(forced?.signalCount, 2);
  assert.match(events[0].message, /Ctrl-D/);
});

test('Ctrl-D after first SIGINT replaces only the second Ctrl-C', async () => {
  const runtime = new FakeProcess();
  const stdin = new FakeStdin(true);
  const server = new FakeServer();
  const events = [];
  const controller = installNodeServerShutdown({
    servers: server,
    process: runtime,
    stdin,
    timeoutMillis: 10_000,
    onLog: (event) => events.push(event),
  });

  runtime.emit('SIGINT');
  await tick();
  stdin.emit('end');
  const result = await controller.done;
  assert.equal(result.phase, 'forced');
  assert.equal(result.cause, 'stdin-eof');
  assert.equal(server.forceCalls, 1);
  const forced = events.find((event) => event.phase === 'forced');
  assert.equal(forced?.signalCount, 1, 'EOF must not increment OS signal count');
});

test('TTY SIGTERM drains without arming or consuming stdin', async () => {
  const runtime = new FakeProcess();
  const stdin = new FakeStdin(true);
  const server = new FakeServer();
  const events = [];
  const controller = installNodeServerShutdown({
    servers: server,
    process: runtime,
    stdin,
    onLog: (event) => events.push(event),
  });

  runtime.emit('SIGTERM');
  await tick();
  assert.equal(controller.phase, 'draining');
  assert.equal(stdin.resumed, false);
  assert.equal(stdin.listenerCount('end'), 0);
  stdin.emit('end');
  await tick();
  assert.equal(controller.phase, 'draining');

  server.finish();
  const result = await controller.done;
  assert.equal(result.phase, 'closed');
  assert.equal(result.cause, 'SIGTERM');
  assert.equal(events.some((event) => /Ctrl-D/.test(event.message)), false);
  assert.equal(events.at(-1)?.signalCount, 1);
});

test('one non-TTY signal completes a graceful drain without stdin reads', async () => {
  const runtime = new FakeProcess();
  const stdin = new FakeStdin(false);
  const server = new FakeServer();
  const order = [];
  const events = [];
  const controller = installNodeServerShutdown({
    servers: server,
    process: runtime,
    stdin,
    beforeGraceful: () => order.push('before'),
    flush: () => order.push('flush'),
    afterGraceful: () => order.push('after'),
    onLog: (event) => events.push(event),
  });

  runtime.emit('SIGTERM');
  await tick();
  assert.equal(controller.phase, 'draining');
  assert.equal(stdin.resumed, false);
  assert.equal(stdin.listenerCount('end'), 0);
  server.finish();
  const result = await controller.done;
  assert.equal(result.phase, 'closed');
  assert.equal(result.cause, 'SIGTERM');
  assert.deepEqual(order, ['before', 'flush', 'after']);
  assert.equal(server.forceCalls, 0);
  assert.equal(events.at(-1)?.signalCount, 1);
});

test('timeout escalates after listener close was requested', async () => {
  const runtime = new FakeProcess();
  const server = new FakeServer();
  const events = [];
  const controller = installNodeServerShutdown({
    servers: server,
    process: runtime,
    interactive: false,
    watchStdinEof: false,
    timeoutMillis: 5,
    onLog: (event) => events.push(event),
  });

  runtime.emit('SIGINT');
  const result = await controller.done;
  assert.equal(result.phase, 'forced');
  assert.equal(result.cause, 'timeout');
  assert.ok(server.closeCalls >= 2);
  assert.equal(server.forceCalls, 1);
  assert.equal(events.find((event) => event.phase === 'forced')?.signalCount, 1);
});

test('already stopped servers are treated as gracefully closed', async () => {
  const runtime = new FakeProcess();
  const server = {
    close(callback) {
      callback(Object.assign(new Error('not running'), {
        code: 'ERR_SERVER_NOT_RUNNING',
      }));
    },
  };
  const controller = installNodeServerShutdown({
    servers: server,
    process: runtime,
    interactive: false,
    watchStdinEof: false,
    onLog: () => undefined,
  });
  runtime.emit('SIGTERM');
  const result = await controller.done;
  assert.equal(result.phase, 'closed');
  assert.equal(result.errors.length, 0);
});

test('transition helper is deterministic', () => {
  assert.equal(nextShutdownAction('running', 'SIGINT'), 'begin-graceful');
  assert.equal(nextShutdownAction('draining', 'stdin-eof'), 'force');
  assert.equal(nextShutdownAction('closed', 'SIGTERM'), 'ignore');
});

test('logger sink emits structured best-effort shutdown records', async () => {
  const records = [];
  const logger = Object.fromEntries(
    ['info', 'warn', 'error'].map((level) => [
      level,
      (...values) => ({
        fields: {},
        tags: [],
        addFields(fields) {
          this.fields = { ...this.fields, ...fields };
          return this;
        },
        addTags(...tags) {
          this.tags.push(...tags);
          return this;
        },
        send() {
          records.push({ level, values, fields: this.fields, tags: this.tags });
          return Promise.resolve();
        },
      }),
    ]),
  );
  const sink = createNodeLoggerShutdownSink(logger);
  sink({
    phase: 'draining',
    action: 'begin-graceful',
    cause: 'SIGTERM',
    interactive: false,
    signalCount: 1,
    message: 'draining',
  });
  await tick();
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'info');
  assert.equal(records[0].fields['shutdown.cause'], 'SIGTERM');
  assert.deepEqual(records[0].tags, ['shutdown', 'draining']);
});

test('flush runs exactly once when force races a graceful flush', async () => {
  const runtime = new FakeProcess();
  const server = new FakeServer();
  let flushCalls = 0;
  let releaseFlush;
  const flushBlocked = new Promise((resolve) => {
    releaseFlush = resolve;
  });
  const controller = installNodeServerShutdown({
    servers: server,
    process: runtime,
    interactive: true,
    watchStdinEof: false,
    timeoutMillis: 10_000,
    flush: async () => {
      flushCalls += 1;
      await flushBlocked;
    },
    onLog: () => undefined,
  });

  runtime.emit('SIGINT');
  await tick();
  server.finish();
  await tick();
  assert.equal(flushCalls, 1);
  runtime.emit('SIGINT');
  await tick();
  assert.equal(flushCalls, 1);
  releaseFlush();
  const result = await controller.done;
  assert.equal(result.phase, 'forced');
  assert.equal(flushCalls, 1);
});

test('a graceful listener-close failure escalates instead of reporting closed', async () => {
  const runtime = new FakeProcess();
  let forceCalls = 0;
  const server = {
    close(callback) {
      callback(new Error('listener close failed'));
    },
    closeAllConnections() {
      forceCalls += 1;
    },
  };
  const controller = installNodeServerShutdown({
    servers: server,
    process: runtime,
    interactive: false,
    watchStdinEof: false,
    onLog: () => undefined,
  });
  runtime.emit('SIGTERM');
  const result = await controller.done;
  assert.equal(result.phase, 'forced');
  assert.equal(forceCalls, 1);
  assert.equal(result.errors.length, 1);
});

test('force completion is bounded when hooks ignore cancellation', async () => {
  const runtime = new FakeProcess();
  const server = new FakeServer();
  const never = new Promise(() => undefined);
  const controller = installNodeServerShutdown({
    servers: server,
    process: runtime,
    interactive: true,
    watchStdinEof: false,
    timeoutMillis: 10_000,
    forceTimeoutMillis: 5,
    force: () => never,
    flush: () => never,
    onLog: () => undefined,
  });

  runtime.emit('SIGINT');
  await tick();
  runtime.emit('SIGINT');
  const result = await controller.done;
  assert.equal(result.phase, 'forced');
  assert.equal(result.errors.length, 2);
});
