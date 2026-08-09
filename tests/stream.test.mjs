import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import { BrowserStreamTransport } from '@oresoftware/next-loggers/browser-stream';

/** Scriptable WebSocket double: opens on demand, records every frame sent. */
class FakeSocket {
  constructor(url, { autoOpen = true, failOpen = false } = {}) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closes = [];
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    queueMicrotask(() => {
      if (failOpen) {
        this.readyState = 3;
        this.onerror?.({});
        return;
      }
      if (autoOpen) {
        this.readyState = 1;
        this.onopen?.({});
      }
    });
  }

  send(data) {
    if (this.readyState !== 1) {
      throw new Error('socket not open');
    }
    this.sent.push(data);
  }

  close(code, reason) {
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.onclose?.({});
  }
}

const record = (level, message, index = 0) => ({
  schema: 'next-loggers/v1',
  id: `id-${index}`,
  timestamp: '2026-01-01T00:00:00.000Z',
  level,
  runtime: 'browser',
  appName: 'test',
  message,
  values: [message],
  fields: {},
});

test('stream transport batches records into a single frame', async () => {
  let socket;
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.com/logs',
    socketFactory: (url) => (socket = new FakeSocket(url)),
    flushOnPageHide: false,
  });

  for (let i = 0; i < 5; i += 1) {
    transport.write(record('INFO', `msg-${i}`, i));
  }
  assert.equal(transport.queued, 5);

  await transport.flush();

  assert.equal(socket.sent.length, 1, 'five records should ship as one batch');
  const payload = JSON.parse(socket.sent[0]);
  assert.equal(payload.type, 'log-batch');
  assert.equal(payload.records.length, 5);
  assert.equal(payload.records[0].message, 'msg-0');
  assert.equal(transport.queued, 0);
  await transport.close();
});

test('stream transport splits oversized queues across batches', async () => {
  let socket;
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.com/logs',
    socketFactory: (url) => (socket = new FakeSocket(url)),
    batchSize: 2,
    flushOnPageHide: false,
  });

  for (let i = 0; i < 5; i += 1) {
    transport.write(record('INFO', `m${i}`, i));
  }
  await transport.flush();

  assert.deepEqual(
    socket.sent.map((frame) => JSON.parse(frame).records.length),
    [2, 2, 1],
  );
  await transport.close();
});

test('stream transport drops oldest records past maxQueueSize and reports the loss', async () => {
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.com/logs',
    socketFactory: (url) => new FakeSocket(url, { autoOpen: false }),
    connectTimeoutMillis: 50,
    maxQueueSize: 3,
    flushOnPageHide: false,
  });

  for (let i = 0; i < 10; i += 1) {
    transport.write(record('INFO', `m${i}`, i));
  }

  assert.equal(transport.queued, 3);
  assert.equal(transport.dropped, 7, 'silent log loss must be observable');
  await transport.close();
});

test('stream transport keeps records queued when the socket never opens', async () => {
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.com/logs',
    socketFactory: (url) => new FakeSocket(url, { failOpen: true }),
    connectTimeoutMillis: 50,
    flushOnPageHide: false,
  });

  transport.write(record('ERROR', 'boom'));
  await assert.rejects(() => transport.flush());
  assert.equal(transport.queued, 1, 'a failed send must not lose the record');
  await transport.close();
});

test('stream transport gives up on a socket wedged in CONNECTING', async () => {
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.com/logs',
    // Never opens, never errors — the captive-portal case.
    socketFactory: (url) => new FakeSocket(url, { autoOpen: false }),
    connectTimeoutMillis: 40,
    flushOnPageHide: false,
  });

  transport.write(record('INFO', 'stuck'));
  await assert.rejects(() => transport.flush(), /timed out/);
  assert.equal(transport.queued, 1, 'the record survives for the next attempt');
  await transport.close();
});

test('stream transport reconnects and replays after a socket close', async () => {
  const sockets = [];
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.com/logs',
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    flushOnPageHide: false,
  });

  transport.write(record('INFO', 'before'));
  await transport.flush();
  assert.equal(sockets.length, 1);

  sockets[0].close(1006, 'network blip');

  transport.write(record('INFO', 'after'));
  await transport.flush();

  assert.equal(sockets.length, 2, 'a dead socket should be replaced');
  assert.equal(JSON.parse(sockets[1].sent[0]).records[0].message, 'after');
  await transport.close();
});

test('stream transport delegates to an inner transport when given one', async () => {
  const written = [];
  const transport = new BrowserStreamTransport({
    transport: { name: 'inner', write: (r) => void written.push(r.message) },
    flushOnPageHide: false,
  });

  transport.write(record('INFO', 'a'));
  transport.write(record('INFO', 'b'));
  await transport.flush();

  assert.deepEqual(written, ['a', 'b']);
  await transport.close();
});

test('stream transport beacons the queue out on exit', async () => {
  const beacons = [];
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.com/logs',
    socketFactory: (url) => new FakeSocket(url, { autoOpen: false }),
    connectTimeoutMillis: 50,
    beaconUrl: 'https://collector.example.com/beacon',
    sendBeacon: (url, body) => {
      beacons.push({ url, body });
      return true;
    },
    flushOnPageHide: false,
  });

  transport.write(record('ERROR', 'last gasp'));
  transport.flushOnExit([]);

  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, 'https://collector.example.com/beacon');
  assert.equal(JSON.parse(beacons[0].body).records[0].message, 'last gasp');
  assert.equal(transport.queued, 0);
  await transport.close();
});

test('stream transport requires a destination', () => {
  assert.throws(() => new BrowserStreamTransport({}), /requires either url or transport/);
});

test('a logger delivers records through the stream transport', async () => {
  let socket;
  const transport = new BrowserStreamTransport({
    url: 'wss://collector.example.com/logs',
    socketFactory: (url) => (socket = new FakeSocket(url)),
    flushOnPageHide: false,
  });
  const logger = createLogger({ console: false, transports: transport });

  await logger.error('stream me').send();
  await transport.flush();

  assert.equal(JSON.parse(socket.sent[0]).records[0].message, 'stream me');
  await logger.close();
});
