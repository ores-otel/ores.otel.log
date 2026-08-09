import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BrowserStreamTransport,
  createBrowserStreamTransport,
} from '@oresoftware/next-loggers/browser-stream';

function record(index, level = 'INFO') {
  return {
    schema: 'next-loggers/v1',
    id: `browser-${index}`,
    timestamp: '2026-08-03T12:00:00.000Z',
    level,
    runtime: 'browser',
    appName: 'browser-app',
    message: `message-${index}`,
    values: [`message-${index}`],
    fields: {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class SocketDouble {
  constructor(url, { autoOpen = true } = {}) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closes = [];
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    if (autoOpen) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.({});
      });
    }
  }

  send(value) {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(value);
  }

  close(code, reason) {
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.onclose?.({});
  }
}

test('factory returns the concrete browser stream transport', () => {
  const transport = createBrowserStreamTransport({
    transport: { write() {} },
    flushOnPageHide: false,
  });
  assert.equal(transport instanceof BrowserStreamTransport, true);
  assert.equal(transport.name, 'browser-stream');
});

test('zero maxQueueSize drops every record deterministically', () => {
  const transport = new BrowserStreamTransport({
    transport: { write() {} },
    maxQueueSize: 0,
    flushOnPageHide: false,
  });
  for (let index = 0; index < 10; index += 1) transport.write(record(index));
  assert.equal(transport.queued, 0);
  assert.equal(transport.dropped, 10);
});

test('negative maxQueueSize also keeps no records', () => {
  const transport = new BrowserStreamTransport({
    transport: { write() {} },
    maxQueueSize: -10,
    flushOnPageHide: false,
  });
  transport.write(record(1));
  assert.equal(transport.queued, 0);
  assert.equal(transport.dropped, 1);
});

test('zero batchSize is clamped to one record per iteration', async () => {
  const delivered = [];
  const transport = new BrowserStreamTransport({
    transport: { write: (value) => delivered.push(value.id) },
    batchSize: 0,
    flushOnPageHide: false,
  });
  transport.write(record(1));
  transport.write(record(2));
  await transport.flush();
  assert.deepEqual(delivered, ['browser-1', 'browser-2']);
  assert.equal(transport.queued, 0);
  await transport.close();
});

test('an urgent record preempts a pending idle timer', async () => {
  const delivered = [];
  const transport = new BrowserStreamTransport({
    transport: { write: (value) => delivered.push(value.id) },
    flushIntervalMillis: 60_000,
    urgentFlushDelayMillis: 1,
    flushOnPageHide: false,
  });
  transport.write(record(1, 'INFO'));
  transport.write(record(2, 'ERROR'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(delivered, ['browser-1', 'browser-2']);
  assert.equal(transport.queued, 0);
  await transport.close();
});

test('a later non-urgent write does not postpone an urgent timer', async () => {
  const delivered = [];
  const transport = new BrowserStreamTransport({
    transport: { write: (value) => delivered.push(value.id) },
    flushIntervalMillis: 60_000,
    urgentFlushDelayMillis: 1,
    flushOnPageHide: false,
  });
  transport.write(record(1, 'ERROR'));
  transport.write(record(2, 'INFO'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(delivered, ['browser-1', 'browser-2']);
  await transport.close();
});

test('custom urgent levels can make WARN fast without treating ERROR as urgent', async () => {
  const delivered = [];
  const transport = new BrowserStreamTransport({
    transport: { write: (value) => delivered.push(value.id) },
    urgentLevels: ['WARN'],
    flushIntervalMillis: 60_000,
    urgentFlushDelayMillis: 1,
    flushOnPageHide: false,
  });
  transport.write(record(1, 'ERROR'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(delivered, []);
  transport.write(record(2, 'WARN'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(delivered, ['browser-1', 'browser-2']);
  await transport.close();
});

test('records written during an in-flight flush are drained before it resolves', async () => {
  const gate = deferred();
  const delivered = [];
  let first = true;
  const transport = new BrowserStreamTransport({
    transport: {
      async write(value) {
        if (first) {
          first = false;
          await gate.promise;
        }
        delivered.push(value.id);
      },
    },
    batchSize: 2,
    flushOnPageHide: false,
  });
  transport.write(record(1));
  const flushing = transport.flush();
  transport.write(record(2));
  transport.write(record(3));
  gate.resolve();
  await flushing;
  assert.deepEqual(delivered, ['browser-1', 'browser-2', 'browser-3']);
  assert.equal(transport.queued, 0);
  await transport.close();
});

test('concurrent flush calls do not duplicate delivery', async () => {
  const gate = deferred();
  const delivered = [];
  const transport = new BrowserStreamTransport({
    transport: {
      async write(value) {
        await gate.promise;
        delivered.push(value.id);
      },
    },
    flushOnPageHide: false,
  });
  transport.write(record(1));
  const first = transport.flush();
  const second = transport.flush();
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(delivered, ['browser-1']);
  assert.equal(transport.queued, 0);
  await transport.close();
});

test('inner transport failure retains the whole current batch for at-least-once retry', async () => {
  const attempts = [];
  let failSecond = true;
  const transport = new BrowserStreamTransport({
    transport: {
      write(value) {
        attempts.push(value.id);
        if (value.id === 'browser-2' && failSecond) {
          failSecond = false;
          throw new Error('Supabase unavailable');
        }
      },
    },
    batchSize: 3,
    flushOnPageHide: false,
  });
  transport.write(record(1));
  transport.write(record(2));
  transport.write(record(3));
  await assert.rejects(transport.flush(), /Supabase unavailable/);
  assert.equal(transport.queued, 3);
  await transport.flush();
  assert.deepEqual(attempts, [
    'browser-1',
    'browser-2',
    'browser-1',
    'browser-2',
    'browser-3',
  ]);
  assert.equal(transport.queued, 0);
  await transport.close();
});

test('socket factory failures leave records queued for a later retry', async () => {
  let attempts = 0;
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.test/logs',
    socketFactory() {
      attempts += 1;
      throw new Error('WebSocket unavailable');
    },
    flushOnPageHide: false,
  });
  transport.write(record(1));
  await assert.rejects(transport.flush(), /WebSocket unavailable/);
  assert.equal(attempts, 1);
  assert.equal(transport.queued, 1);
  await transport.close();
});

test('connection timeout closes the wedged socket with code 1011', async () => {
  let socket;
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.test/logs',
    socketFactory: (url) => (socket = new SocketDouble(url, { autoOpen: false })),
    connectTimeoutMillis: 2,
    flushOnPageHide: false,
  });
  transport.write(record(1));
  await assert.rejects(transport.flush(), /timed out/);
  assert.deepEqual(socket.closes, [
    { code: 1011, reason: 'log stream connect failed' },
  ]);
  assert.equal(transport.queued, 1);
  await transport.close();
});

test('mapBatch receives immutable-looking ordered records and controls wire format', async () => {
  let socket;
  const seen = [];
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.test/logs',
    socketFactory: (url) => (socket = new SocketDouble(url)),
    mapBatch(records) {
      seen.push(records.map((value) => value.id));
      return JSON.stringify({ custom: records.map((value) => value.message) });
    },
    flushOnPageHide: false,
  });
  transport.write(record(1));
  transport.write(record(2));
  await transport.flush();
  assert.deepEqual(seen, [['browser-1', 'browser-2']]);
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    custom: ['message-1', 'message-2'],
  });
  await transport.close();
});

test('flushOnExit combines queued and explicitly supplied records in FIFO order', () => {
  const beacons = [];
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.test/logs',
    beaconUrl: 'https://collector.example.test/beacon',
    sendBeacon: (url, body) => {
      beacons.push({ url, body });
      return true;
    },
    socketFactory: (url) => new SocketDouble(url, { autoOpen: false }),
    flushOnPageHide: false,
  });
  transport.write(record(1));
  transport.write(record(2));
  transport.flushOnExit([record(3), record(4)]);
  assert.equal(beacons.length, 1);
  assert.deepEqual(
    JSON.parse(beacons[0].body).records.map((value) => value.id),
    ['browser-1', 'browser-2', 'browser-3', 'browser-4'],
  );
  assert.equal(transport.queued, 0);
});

test('flushOnExit without a beacon leaves the queue available for normal delivery', () => {
  const transport = new BrowserStreamTransport({
    transport: { write() {} },
    flushOnPageHide: false,
  });
  transport.write(record(1));
  transport.flushOnExit([]);
  assert.equal(transport.queued, 1);
});

test('beacon failures are reported and retain the queue', () => {
  const errors = [];
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.test/logs',
    beaconUrl: 'https://collector.example.test/beacon',
    sendBeacon() {
      throw new Error('beacon unavailable');
    },
    onError: (error) => errors.push(error),
    socketFactory: (url) => new SocketDouble(url, { autoOpen: false }),
    flushOnPageHide: false,
  });
  transport.write(record(1));
  transport.flushOnExit([]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /beacon unavailable/);
  assert.equal(transport.queued, 1);
});

test('close drains the queue, closes the socket, and closes the inner transport once', async () => {
  let socket;
  let innerCloses = 0;
  const delivered = [];
  const websocket = new BrowserStreamTransport({
    url: 'wss://collector.example.test/logs',
    socketFactory: (url) => (socket = new SocketDouble(url)),
    flushOnPageHide: false,
  });
  websocket.write(record(1));
  await websocket.flush();
  await websocket.close();
  await websocket.close();
  assert.deepEqual(socket.closes.at(-1), {
    code: 1000,
    reason: 'next-loggers stream closed',
  });

  const delegated = new BrowserStreamTransport({
    transport: {
      write: (value) => delivered.push(value.id),
      close() {
        innerCloses += 1;
      },
    },
    flushOnPageHide: false,
  });
  delegated.write(record(2));
  await delegated.close();
  await delegated.close();
  assert.deepEqual(delivered, ['browser-2']);
  assert.equal(innerCloses, 1);
});

test('writes after close are ignored without increasing drop counts', async () => {
  const delivered = [];
  const transport = new BrowserStreamTransport({
    transport: { write: (value) => delivered.push(value.id) },
    flushOnPageHide: false,
  });
  await transport.close();
  transport.write(record(1));
  await transport.flush();
  assert.equal(transport.queued, 0);
  assert.equal(transport.dropped, 0);
  assert.deepEqual(delivered, []);
});

test('ten thousand disconnected writes retain only the newest bounded window', async () => {
  const delivered = [];
  const transport = new BrowserStreamTransport({
    transport: { write: (value) => delivered.push(value.id) },
    maxQueueSize: 100,
    batchSize: 13,
    flushIntervalMillis: 60_000,
    flushOnPageHide: false,
  });
  for (let index = 0; index < 10_000; index += 1) {
    transport.write(record(index));
  }
  assert.equal(transport.queued, 100);
  assert.equal(transport.dropped, 9_900);
  await transport.flush();
  assert.deepEqual(
    delivered,
    Array.from({ length: 100 }, (_, index) => `browser-${9_900 + index}`),
  );
  await transport.close();
});
