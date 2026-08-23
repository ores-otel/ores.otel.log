import assert from 'node:assert/strict';
import test from 'node:test';

import { SupabaseRealtimeBatchTransport } from '../dist/supabase-realtime-batch.js';

function record(id, message = id) {
  return {
    schema: 'next-loggers/v1',
    id,
    timestamp: '2026-08-23T00:00:00.000Z',
    level: 'INFO',
    runtime: 'browser',
    appName: 'test-app',
    message,
    values: [message],
    fields: {},
  };
}

class FakeSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  messages = [];
  closeCode = null;
  closeReason = null;

  constructor({ acknowledge = true } = {}) {
    this.acknowledge = acknowledge;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('socket is not open');
    const message = JSON.parse(data);
    this.messages.push(message);
    if (!this.acknowledge) return;
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

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

class MemoryFallback {
  name = 'memory-fallback';
  records = [];
  flushes = 0;
  closes = 0;

  async write(item) {
    this.records.push(item);
  }

  async flush() {
    this.flushes += 1;
  }

  async close() {
    this.closes += 1;
  }
}

test('joins an authenticated private channel and sends an acknowledged batch', async () => {
  let socket;
  const transport = new SupabaseRealtimeBatchTransport({
    url: 'https://project.supabase.co/realtime/v1/websocket',
    publishableKey: 'sb_publishable_client',
    accessToken: 'user-access-token',
    channel: 'session-logs:user-123',
    batchSize: 2,
    clock: () => new Date('2026-08-23T12:00:00.000Z'),
    webSocketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });

  assert.equal(
    transport.endpoint,
    'wss://project.supabase.co/realtime/v1/websocket?apikey=sb_publishable_client&vsn=1.0.0',
  );

  await transport.write(record('one'));
  await transport.write(record('two'));
  await transport.flush();

  const join = socket.messages.find((message) => message.event === 'phx_join');
  assert.ok(join);
  assert.equal(join.topic, 'realtime:session-logs:user-123');
  assert.equal(join.payload.config.private, true);
  assert.equal(join.payload.config.broadcast.ack, true);
  assert.equal(join.payload.access_token, 'user-access-token');

  const broadcast = socket.messages.find((message) => message.event === 'broadcast');
  assert.ok(broadcast);
  assert.equal(broadcast.payload.event, 'next-loggers-batch');
  assert.equal(broadcast.payload.payload.schema, 'next-loggers/realtime-batch/v1');
  assert.equal(broadcast.payload.payload.sentAt, '2026-08-23T12:00:00.000Z');
  assert.deepEqual(
    broadcast.payload.payload.records.map((item) => item.id),
    ['one', 'two'],
  );
  assert.match(broadcast.payload.payload.batchId, /^nl-rt-2-[0-9a-f]{16}$/u);
  assert.equal(transport.snapshot().queued, 0);
  await transport.close();
});

test('rejects secret and service-role credentials at the client boundary', () => {
  assert.throws(
    () => new SupabaseRealtimeBatchTransport({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_secret_do-not-ship',
      accessToken: 'user-token',
      channel: 'logs',
    }),
    /Secret\/service-role/u,
  );

  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
  const serviceRoleJwt = `header.${payload}.signature`;
  const transport = new SupabaseRealtimeBatchTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_client',
    accessToken: serviceRoleJwt,
    channel: 'logs',
    awaitDelivery: true,
    webSocketFactory: () => new FakeSocket(),
  });
  return assert.rejects(() => transport.write(record('secret')), /service-role JWT/u);
});

test('bounds the queue and drops the oldest record with diagnostics', async () => {
  const drops = [];
  const fallback = new MemoryFallback();
  const transport = new SupabaseRealtimeBatchTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_client',
    accessToken: 'user-token',
    channel: 'logs',
    batchSize: 100,
    maxQueueSize: 2,
    flushIntervalMillis: 60_000,
    fallback,
    fallbackAfterFailures: 0,
    onDrop: (drop) => drops.push(drop),
  });

  await transport.write(record('oldest'));
  await transport.write(record('middle'));
  await transport.write(record('newest'));

  assert.equal(transport.snapshot().queued, 2);
  assert.equal(transport.snapshot().dropped, 1);
  assert.equal(drops[0].reason, 'queue-full');
  assert.equal(drops[0].record.id, 'oldest');

  await transport.flush();
  assert.deepEqual(fallback.records.map((item) => item.id), ['middle', 'newest']);
  await transport.close();
});

test('uses a durable fallback after the configured WebSocket failure threshold', async () => {
  const fallback = new MemoryFallback();
  let attempts = 0;
  const transport = new SupabaseRealtimeBatchTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_client',
    accessToken: 'user-token',
    channel: 'logs',
    awaitDelivery: true,
    fallback,
    fallbackAfterFailures: 1,
    webSocketFactory: () => {
      attempts += 1;
      throw new Error('network unavailable');
    },
  });

  await transport.write(record('fallback-record'));
  assert.equal(attempts, 1);
  assert.deepEqual(fallback.records.map((item) => item.id), ['fallback-record']);
  assert.equal(transport.snapshot().queued, 0);
  await transport.close();
  assert.equal(fallback.closes, 1);
});
