import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SupabaseRealtimeAckTransport,
  SupabaseSessionTransport,
} from '@oresoftware/next-loggers/observability';

const record = (id, message = id) => ({
  schema: 'next-loggers/v1',
  id,
  timestamp: '2026-08-23T00:00:00.000Z',
  level: 'INFO',
  runtime: 'browser',
  appName: 'audit-app',
  message,
  values: [message],
  fields: { sessionId: 'session-1' },
});

class MockWebSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(sink, { ackBroadcast = false, ackHeartbeat = true } = {}) {
    this.sink = sink;
    this.ackBroadcast = ackBroadcast;
    this.ackHeartbeat = ackHeartbeat;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data) {
    const message = JSON.parse(data);
    this.sink.push(message);
    if (message.event === 'phx_join') {
      queueMicrotask(() => this.reply(message, 'ok'));
    } else if (message.event === 'broadcast' && this.ackBroadcast) {
      queueMicrotask(() => this.reply(message, 'ok'));
    } else if (message.event === 'heartbeat' && this.ackHeartbeat) {
      queueMicrotask(() => this.reply(message, 'ok'));
    }
  }

  reply(message, status) {
    this.onmessage?.({
      data: JSON.stringify({
        topic: message.topic,
        event: 'phx_reply',
        payload: { status, response: {} },
        ref: message.ref,
      }),
    });
  }

  serverSend(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('write awaits the matching broadcast acknowledgement, not socket.send', async () => {
  const sink = [];
  let socket;
  const transport = new SupabaseRealtimeAckTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    accessToken: 'user-token',
    awaitDelivery: true,
    heartbeatMillis: 0,
    reconnect: false,
    webSocketFactory() {
      socket = new MockWebSocket(sink);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });

  let settled = false;
  const delivery = transport.write(record('ack-1')).then(() => {
    settled = true;
  });
  await tick();
  await tick();
  const join = sink.find((message) => message.event === 'phx_join');
  assert.equal(join.payload.config.private, true);
  assert.equal(join.payload.access_token, 'user-token');
  const broadcast = sink.find((message) => message.event === 'broadcast');
  assert.ok(broadcast, 'broadcast should be sent after joining');
  assert.equal(settled, false, 'socket.send alone must not resolve delivery');
  socket.reply(broadcast, 'ok');
  await delivery;
  assert.equal(settled, true);
  assert.equal(transport.snapshot().acknowledged, 1);
  await transport.close();
});

test('unacknowledged records are replayed after reconnect with the same record id', async () => {
  const sink = [];
  const sockets = [];
  let tokenCalls = 0;
  const transport = new SupabaseRealtimeAckTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    accessToken: async () => `user-token-${++tokenCalls}`,
    awaitDelivery: true,
    heartbeatMillis: 0,
    retryBaseMillis: 1,
    retryMaxMillis: 1,
    random: () => 0,
    webSocketFactory() {
      const socket = new MockWebSocket(sink, { ackBroadcast: sockets.length > 0 });
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });

  const delivery = transport.write(record('stable-id'));
  while (!sink.some((message) => message.event === 'broadcast')) {
    await tick();
  }
  sockets[0].close();
  // Keep one ref'd timer alive while the transport's intentionally unref'd
  // reconnect timer schedules the replacement socket.
  while (sockets.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await delivery;

  const broadcasts = sink.filter((message) => message.event === 'broadcast');
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(
    broadcasts.map((message) => message.payload.payload.id),
    ['stable-id', 'stable-id'],
  );
  assert.equal(tokenCalls >= 2, true, 'reconnect must resolve a fresh user token');
  await transport.close();
});

test('bounded offline queues report displaced and terminally undeliverable records', async () => {
  const dropped = [];
  const transport = new SupabaseRealtimeAckTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    accessToken: 'user-token',
    maxQueueSize: 2,
    reconnect: false,
    flushTimeoutMillis: 5,
    onDrop: (drop) => dropped.push([drop.reason, drop.record.id]),
    webSocketFactory() {
      throw new Error('offline');
    },
  });

  await transport.write(record('first'));
  await transport.write(record('second'));
  await transport.write(record('third'));
  await tick();
  assert.deepEqual(dropped, [
    ['queue-full', 'first'],
    ['delivery-failed', 'second'],
    ['delivery-failed', 'third'],
  ]);
  assert.equal(transport.snapshot().queued, 0);
  await transport.close();
});

test('awaited writes reject on a terminal connection failure', async () => {
  const transport = new SupabaseRealtimeAckTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    accessToken: 'user-token',
    awaitDelivery: true,
    reconnect: false,
    heartbeatMillis: 0,
    webSocketFactory() {
      throw new Error('offline');
    },
  });

  await assert.rejects(transport.write(record('terminal')), /offline/);
  assert.equal(transport.snapshot().dropped, 1);
  await transport.close();
});

test('reconnect retries are bounded even when jitter hooks fail', async () => {
  let attempts = 0;
  const errors = [];
  const transport = new SupabaseRealtimeAckTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    accessToken: 'user-token',
    awaitDelivery: true,
    heartbeatMillis: 0,
    maxReconnectAttempts: 2,
    retryBaseMillis: 1,
    retryMaxMillis: 1,
    random() {
      throw new Error('bad random source');
    },
    onError: (error) => errors.push(String(error)),
    webSocketFactory() {
      attempts += 1;
      throw new Error('offline');
    },
  });

  await assert.rejects(transport.write(record('bounded-retry')), /exhausted 2/);
  assert.equal(attempts, 3, 'initial connection plus two retries');
  assert.equal(errors.some((error) => error.includes('exhausted 2')), true);
  assert.equal(transport.snapshot().dropped, 1);
  await transport.close();
});

test('session transport keeps durable ingest authoritative during a Realtime outage', async () => {
  const requests = [];
  const realtimeErrors = [];
  const transport = new SupabaseSessionTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    accessToken: 'user-token',
    session: { appName: 'audit-app', sessionId: 'session-1' },
    onRealtimeError: (error) => realtimeErrors.push(String(error)),
    realtime: {
      awaitDelivery: true,
      reconnect: false,
      heartbeatMillis: 0,
      webSocketFactory() {
        throw new Error('live tail offline');
      },
    },
    ingest: {
      awaitDelivery: true,
      fetch: async (url, init) => {
        const payload = JSON.parse(String(init.body));
        requests.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            schema: 'next-loggers/ingest-ack/v1',
            batchId: payload.batchId,
            accepted: payload.records.length,
            duplicates: 0,
            requested: payload.records.length,
            committedAt: '2026-08-24T01:30:00.000Z',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    },
  });

  await transport.write(record('durable-1'));
  assert.equal(requests.length, 1);
  const payload = JSON.parse(String(requests[0].init.body));
  assert.equal(payload.records[0].id, 'durable-1');
  assert.equal(payload.records[0].fields.sessionId, 'session-1');
  assert.equal(realtimeErrors.some((error) => error.includes('live tail offline')), true);
  await transport.close();
});

test('user access tokens with the service_role claim are rejected', async () => {
  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
  const transport = new SupabaseRealtimeAckTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    accessToken: `header.${payload}.signature`,
    awaitDelivery: true,
    reconnect: false,
  });

  await assert.rejects(transport.write(record('bad-role')), /user-scoped credential/);
  await transport.close();
});

test('browser transport rejects elevated credentials', () => {
  assert.throws(
    () =>
      new SupabaseRealtimeAckTransport({
        url: 'https://project.supabase.co',
        publishableKey: 'sb_secret_do_not_ship',
        allowUnauthenticated: true,
      }),
    /publishable or user-scoped/,
  );
});
