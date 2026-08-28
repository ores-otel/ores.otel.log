import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORES_SUPABASE_WEBSOCKET_PROTOCOL,
  SupabaseWebSocketIngestTransport,
} from '../dist/supabase-websocket-ingest.js';

class FakeSocket {
  OPEN = 1;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];

  constructor(onSend) {
    this.onSend = onSend;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data) {
    assert.equal(this.readyState, 1);
    const message = JSON.parse(String(data));
    this.sent.push(message);
    this.onSend?.(message, this);
  }

  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}

const session = {
  appName: 'test-app',
  runtime: 'browser',
  sessionId: 'session-pseudonymous',
  clientInstanceId: 'client-instance',
};

function record(id = 'log-1') {
  return {
    schema: 'next-loggers/v1',
    id,
    timestamp: '2026-08-24T00:00:00.000Z',
    level: 'INFO',
    runtime: 'browser',
    appName: 'test-app',
    message: 'hello',
    values: [],
    fields: {},
  };
}

function ack(batch, overrides = {}) {
  return {
    type: 'commit_ack',
    protocol: ORES_SUPABASE_WEBSOCKET_PROTOCOL,
    batchId: batch.batchId,
    sequence: batch.sequence,
    accepted: batch.records.length,
    duplicates: 0,
    committedAt: '2026-08-24T00:00:01.000Z',
    ...overrides,
  };
}

function options(factory, overrides = {}) {
  return {
    ticketProvider: async () => ({
      url: 'wss://project.functions.supabase.co/telemetry-stream',
      ticket: 'one-time-ticket-1234567890',
    }),
    session,
    webSocketFactory: factory,
    batchSize: 1,
    awaitAcknowledgement: true,
    acknowledgementTimeoutMillis: 500,
    reconnectBaseMillis: 0,
    reconnectMaxMillis: 0,
    recordIdFactory: () => 'record-stable',
    batchIdFactory: () => 'batch-stable',
    ...overrides,
  };
}

async function waitUntil(predicate, timeoutMillis = 1000) {
  const deadline = Date.now() + timeoutMillis;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('retains records until a matching post-commit acknowledgement', async () => {
  let socket;
  const transport = new SupabaseWebSocketIngestTransport(options(() => {
    socket = new FakeSocket();
    return socket;
  }, { maxReconnectAttempts: 0 }));

  const delivery = transport.write(record());
  await waitUntil(() => socket?.sent.some((message) => message.type === 'telemetry_batch'));
  const batch = socket.sent.find((message) => message.type === 'telemetry_batch');

  assert.equal(transport.snapshot().inFlight, 1);
  assert.equal(transport.snapshot().accepted, 0);
  socket.emit(ack(batch));
  await delivery;

  assert.equal(transport.snapshot().inFlight, 0);
  assert.equal(transport.snapshot().accepted, 1);
  assert.equal(transport.snapshot().lastAcknowledgedSequence, 1);
});

test('replays the identical batch after disconnect-before-ACK', async () => {
  const batches = [];
  let connection = 0;
  const transport = new SupabaseWebSocketIngestTransport(options(() => {
    connection += 1;
    return new FakeSocket((message, socket) => {
      if (message.type !== 'telemetry_batch') return;
      batches.push(message);
      if (connection === 1) queueMicrotask(() => socket.close(1012, 'worker rotation'));
      else queueMicrotask(() => socket.emit(ack(message)));
    });
  }, { maxReconnectAttempts: 1 }));

  await transport.write(record());

  assert.equal(batches.length, 2);
  assert.equal(batches[0].batchId, batches[1].batchId);
  assert.equal(batches[0].sequence, batches[1].sequence);
  assert.deepEqual(batches[0].records, batches[1].records);
  assert.equal(transport.snapshot().replayedBatches, 1);
  assert.equal(transport.snapshot().accepted, 1);
});

test('rejects a mismatched ACK without clearing the in-flight batch', async () => {
  const transport = new SupabaseWebSocketIngestTransport(options(() => new FakeSocket((message, socket) => {
    if (message.type === 'telemetry_batch') {
      queueMicrotask(() => socket.emit(ack(message, { batchId: 'wrong-batch' })));
    }
  }), { maxReconnectAttempts: 0 }));

  await assert.rejects(() => transport.write(record()), /batchId or sequence mismatch/);
  assert.equal(transport.snapshot().protocolErrors, 1);
  assert.equal(transport.snapshot().inFlight, 1);
  assert.equal(transport.snapshot().accepted, 0);
});

test('uses the exact in-flight batch for authenticated HTTPS exit fallback', async () => {
  let persisted;
  const transport = new SupabaseWebSocketIngestTransport(options(
    () => new FakeSocket(),
    {
      awaitAcknowledgement: false,
      exitFallback: {
        persist: async (batch) => {
          persisted = batch;
          return ack(batch);
        },
      },
    },
  ));

  await transport.write(record());
  await transport.flushOnExit();

  assert.equal(persisted.batchId, 'batch-stable');
  assert.equal(persisted.records[0].recordId, 'record-stable');
  assert.equal(transport.snapshot().accepted, 1);
  assert.equal(transport.snapshot().inFlight, 0);
});

test('requires WSS and a short-lived ticket', async () => {
  const transport = new SupabaseWebSocketIngestTransport(options(
    () => new FakeSocket(),
    {
      ticketProvider: async () => ({
        url: 'ws://project.example.test/telemetry',
        ticket: 'one-time-ticket-1234567890',
      }),
      maxReconnectAttempts: 0,
    },
  ));

  await assert.rejects(() => transport.write(record()), /requires wss/);
  assert.equal(transport.snapshot().inFlight, 1);
});
