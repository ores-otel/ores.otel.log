import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as base from '@oresoftware/next-loggers/base';
import {
  createLogger,
  serializeLogValue,
  waitForPendingLogs,
  HttpTransport,
  SupabaseRealtimeTransport,
} from '@oresoftware/next-loggers/base';
import { createEdgeLogger } from '@oresoftware/next-loggers/edge';
import { createNodeLogger } from '@oresoftware/next-loggers/node';

const RUNTIME_ENTRIES = ['browser', 'edge', 'cloudflare', 'node', 'bun', 'deno'];

test('every runtime entry re-exports the full base surface as `base`', async () => {
  const baseNames = Object.keys(base).filter((name) => name !== 'default');
  assert.equal(baseNames.length > 0, true);
  for (const entry of RUNTIME_ENTRIES) {
    const module = await import(`@oresoftware/next-loggers/${entry}`);
    assert.equal(
      typeof module.base,
      'object',
      `entry point "${entry}" is missing the "base" namespace`,
    );
    for (const name of baseNames) {
      assert.equal(
        name in module.base,
        true,
        `entry point "${entry}" is missing the base export "base.${name}"`,
      );
    }
    assert.equal(
      module.base.logger,
      base.logger,
      `entry "${entry}" must expose the shared base logger as base.logger`,
    );
    assert.notEqual(module.logger, base.logger, `entry "${entry}" must export its own logger`);
  }
});

test('serializeLogValue survives difficult values', () => {
  assert.equal(serializeLogValue(Number.NaN), 'NaN');
  assert.equal(serializeLogValue(Number.POSITIVE_INFINITY), 'Infinity');
  assert.equal(serializeLogValue(undefined), '[undefined]');
  assert.equal(serializeLogValue(123n), '123n');
  assert.equal(serializeLogValue(Symbol('tag')), 'Symbol(tag)');
  assert.equal(serializeLogValue(function named() {}), '[Function: named]');
  assert.equal(serializeLogValue(/ab+c/gi), '/ab+c/gi');
  assert.equal(serializeLogValue(new Date('invalid')), 'Invalid Date');
  assert.equal(serializeLogValue(new Date('2026-01-01T00:00:00.000Z')), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(serializeLogValue(new Map([['a', 1]])), [['a', 1]]);
  assert.deepEqual(serializeLogValue(new Set(['x', 'y'])), ['x', 'y']);

  class Widget {
    constructor() {
      this.kind = 'sprocket';
    }
  }
  assert.deepEqual(serializeLogValue(new Widget()), { kind: 'sprocket', __type: 'Widget' });

  const throwing = {};
  Object.defineProperty(throwing, 'bad', {
    enumerable: true,
    get() {
      throw new Error('getter exploded');
    },
  });
  const serialized = serializeLogValue({ throwing });
  assert.match(String(serialized.throwing.bad), /Unserializable: getter exploded/);
});

test('invalid maxLevel falls back to INFO', async () => {
  const records = [];
  const logger = createLogger({
    maxLevel: 'garbage',
    console: false,
    transports: { write: (record) => void records.push(record) },
  });
  await logger.debug('filtered').send();
  await logger.info('kept').send();
  assert.deepEqual(records.map((record) => record.message), ['kept']);
});

test('autoSend delivers events without an explicit send()', async () => {
  const records = [];
  const logger = createLogger({
    autoSend: true,
    console: false,
    transports: { write: (record) => void records.push(record) },
  });
  logger.info('automatic');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await logger.flush();
  assert.deepEqual(records.map((record) => record.message), ['automatic']);
});

test('anew preserves the subclass, runtime, and merged fields', () => {
  const parent = createNodeLogger({
    console: false,
    flushOnShutdown: false,
    appName: 'parent-app',
    fields: { region: 'us-east-1' },
  });
  const child = parent.anew({ fields: { service: 'api' }, flushOnShutdown: false });
  try {
    assert.equal(child.constructor.name, 'NodeLogger');
    assert.equal(child.runtime, 'node');
    assert.equal(child.appName, 'parent-app');
    assert.equal(child.fields.region, 'us-east-1');
    assert.equal(child.fields.service, 'api');
  } finally {
    void child.close();
    void parent.close();
  }
});

test('onTransportError receives the failing transport and record', async () => {
  const failures = [];
  const boom = new Error('write failed');
  const logger = createLogger({
    console: false,
    transports: {
      name: 'failing',
      write() {
        throw boom;
      },
    },
    onTransportError(error, transport, record) {
      failures.push({ error, transport: transport.name, message: record.message });
    },
  });
  await logger.error('will fail').send();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].error, boom);
  assert.equal(failures[0].transport, 'failing');
  assert.equal(failures[0].message, 'will fail');
});

test('HTTP transport reports non-2xx responses as transport errors', async () => {
  const failures = [];
  const logger = createLogger({
    console: false,
    transports: new HttpTransport({
      endpoint: 'https://logs.example.test/events',
      fetch: async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' }),
    }),
    onTransportError: (error) => void failures.push(error),
  });
  await logger.info('rejected upstream').send();
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /503/);
});

test('HTTP transport timeoutMillis of 0 disables the abort timer', async () => {
  let sawSignalAborted = null;
  const transport = new HttpTransport({
    endpoint: 'https://logs.example.test/slow',
    timeoutMillis: 0,
    fetch: async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      sawSignalAborted = init.signal.aborted;
      return new Response(null, { status: 202 });
    },
  });
  const logger = createLogger({ console: false, transports: transport });
  await logger.info('slow but fine').send();
  assert.equal(sawSignalAborted, false);
});

test('captureStackTrace records frames and drops next-loggers internals', async () => {
  const records = [];
  const logger = createLogger({
    console: false,
    transports: { write: (record) => void records.push(record) },
  });
  await logger.error('with stack').captureStackTrace().send();
  assert.equal(records.length, 1);
  const stack = records[0].stackTrace;
  assert.equal(Array.isArray(stack) && stack.length > 0, true);
  for (const line of stack) {
    assert.doesNotMatch(line, /node_modules[\\/](@oresoftware[\\/])?next-loggers/);
  }
});

test('edge logger routes a throwing waitUntil to onLifecycleError', async () => {
  const lifecycleErrors = [];
  const logger = createEdgeLogger({
    console: false,
    transports: { write: async () => undefined },
    executionContext: {
      waitUntil() {
        throw new Error('execution context is sealed');
      },
    },
    onLifecycleError: (error, hook) => void lifecycleErrors.push({ error, hook }),
  });
  await logger.info('edge lifecycle').send();
  assert.equal(lifecycleErrors.length, 1);
  assert.equal(lifecycleErrors[0].hook, 'waitUntil');
  assert.match(String(lifecycleErrors[0].error), /sealed/);
});

test('Supabase transport queues while offline and drains after reconnect', async () => {
  const sent = [];
  let attempts = 0;
  let socket;

  class MockWebSocket {
    readyState = 0;
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;

    send(data) {
      const message = JSON.parse(data);
      sent.push(message);
      if (message.event === 'phx_join') {
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify({
              topic: message.topic,
              event: 'phx_reply',
              payload: { status: 'ok', response: {} },
              ref: message.ref,
            }),
          });
        });
      }
    }

    open() {
      this.readyState = 1;
      this.onopen?.({});
    }

    close() {
      this.readyState = 3;
      this.onclose?.({});
    }
  }

  const transport = new SupabaseRealtimeTransport({
    url: 'https://project.supabase.co',
    anonKey: 'anon-key',
    reconnect: false,
    webSocketFactory() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('network down');
      }
      socket = new MockWebSocket();
      queueMicrotask(() => socket.open());
      return socket;
    },
  });

  const failures = [];
  const logger = createLogger({
    console: false,
    transports: transport,
    onTransportError: (error) => void failures.push(error),
  });

  await logger.warn('queued while offline').send();
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /network down/);

  await transport.flush();
  const broadcast = sent.find((message) => message.event === 'broadcast');
  assert.equal(broadcast.payload.payload.message, 'queued while offline');
  await logger.close();
});

test('waitForPendingLogs honors its timeout while a transport hangs', async () => {
  let release;
  const logger = createLogger({
    console: false,
    transports: {
      write: () => new Promise((resolve) => {
        release = resolve;
      }),
    },
  });
  const send = logger.info('slow delivery').send();
  const started = Date.now();
  await waitForPendingLogs({ timeoutMillis: 50 });
  assert.equal(Date.now() - started < 2_000, true);
  release();
  await send;
});
