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
  closeCode = undefined;
  closeReason = undefined;

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

  emitRaw(data) {
    this.onmessage?.({ data });
  }

  error() {
    this.onerror?.({});
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.closeCode = code;
    this.closeReason = reason;
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
  const transport = new SupabaseWebSocketIngestTransport(
    options(
      () => {
        socket = new FakeSocket();
        return socket;
      },
      { maxReconnectAttempts: 0 },
    ),
  );

  const delivery = transport.write(record());
  await waitUntil(() =>
    socket?.sent.some((message) => message.type === 'telemetry_batch'),
  );
  const batch = socket.sent.find(
    (message) => message.type === 'telemetry_batch',
  );

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
  const transport = new SupabaseWebSocketIngestTransport(
    options(
      () => {
        connection += 1;
        return new FakeSocket((message, socket) => {
          if (message.type !== 'telemetry_batch') return;
          batches.push(message);
          if (connection === 1) {
            queueMicrotask(() => socket.close(1012, 'worker rotation'));
          } else {
            queueMicrotask(() => socket.emit(ack(message)));
          }
        });
      },
      { maxReconnectAttempts: 1 },
    ),
  );

  await transport.write(record());

  assert.equal(batches.length, 2);
  assert.equal(batches[0].batchId, batches[1].batchId);
  assert.equal(batches[0].sequence, batches[1].sequence);
  assert.deepEqual(batches[0].records, batches[1].records);
  assert.equal(transport.snapshot().replayedBatches, 1);
  assert.equal(transport.snapshot().accepted, 1);
});

test('replays the identical batch after a post-open socket error', async () => {
  const batches = [];
  let connection = 0;
  const transport = new SupabaseWebSocketIngestTransport(
    options(
      () => {
        connection += 1;
        return new FakeSocket((message, socket) => {
          if (message.type !== 'telemetry_batch') return;
          batches.push(message);
          if (connection === 1) {
            queueMicrotask(() => socket.error());
          } else {
            queueMicrotask(() => socket.emit(ack(message)));
          }
        });
      },
      { maxReconnectAttempts: 1 },
    ),
  );

  await transport.write(record());

  assert.equal(batches.length, 2);
  assert.equal(batches[0].batchId, batches[1].batchId);
  assert.equal(batches[0].sequence, batches[1].sequence);
  assert.deepEqual(batches[0].records, batches[1].records);
  assert.equal(transport.snapshot().replayedBatches, 1);
  assert.equal(transport.snapshot().accepted, 1);
});

test('ignores delayed callbacks from a superseded socket generation', async () => {
  const sockets = [];
  const batches = [];
  let staleMessage;
  let staleClose;
  let connection = 0;
  const transport = new SupabaseWebSocketIngestTransport(
    options(
      () => {
        connection += 1;
        const socket = new FakeSocket((message, currentSocket) => {
          if (message.type !== 'telemetry_batch') return;
          batches.push(message);
          if (connection === 1) {
            staleMessage = currentSocket.onmessage;
            staleClose = currentSocket.onclose;
            queueMicrotask(() =>
              currentSocket.close(1012, 'worker rotation'),
            );
          }
        });
        sockets.push(socket);
        return socket;
      },
      { maxReconnectAttempts: 1 },
    ),
  );

  let settled = false;
  const delivery = transport.write(record()).finally(() => {
    settled = true;
  });
  await waitUntil(() => batches.length === 2);

  staleMessage?.({ data: JSON.stringify(ack(batches[1])) });
  staleClose?.({ code: 1012, reason: 'late-close', wasClean: false });
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(transport.snapshot().inFlight, 1);
  assert.equal(transport.snapshot().accepted, 0);
  assert.equal(transport.snapshot().protocolErrors, 0);

  sockets[1].emit(ack(batches[1]));
  await delivery;

  assert.equal(transport.snapshot().accepted, 1);
  assert.equal(transport.snapshot().inFlight, 0);
  assert.equal(transport.snapshot().protocolErrors, 0);
});

test('rejects a mismatched ACK without clearing the in-flight batch', async () => {
  const transport = new SupabaseWebSocketIngestTransport(
    options(
      () =>
        new FakeSocket((message, socket) => {
          if (message.type === 'telemetry_batch') {
            queueMicrotask(() =>
              socket.emit(ack(message, { batchId: 'wrong-batch' })),
            );
          }
        }),
      { maxReconnectAttempts: 0 },
    ),
  );

  await assert.rejects(
    () => transport.write(record()),
    /batchId or sequence mismatch/,
  );
  assert.equal(transport.snapshot().protocolErrors, 1);
  assert.equal(transport.snapshot().inFlight, 1);
  assert.equal(transport.snapshot().accepted, 0);
});

test('rejects oversized inbound messages without clearing the batch', async () => {
  let socket;
  const transport = new SupabaseWebSocketIngestTransport(
    options(
      () => {
        socket = new FakeSocket((message, currentSocket) => {
          if (message.type === 'telemetry_batch') {
            queueMicrotask(() =>
              currentSocket.emitRaw('x'.repeat(256 * 1024 + 1)),
            );
          }
        });
        return socket;
      },
      { maxReconnectAttempts: 0 },
    ),
  );

  await assert.rejects(
    () => transport.write(record()),
    /exceeds the protocol limit/,
  );
  assert.equal(transport.snapshot().protocolErrors, 1);
  assert.equal(transport.snapshot().inFlight, 1);
  assert.equal(transport.snapshot().accepted, 0);
  assert.equal(socket.closeCode, 1002);
});

test('uses the exact in-flight batch for authenticated HTTPS exit fallback', async () => {
  let persisted;
  const transport = new SupabaseWebSocketIngestTransport(
    options(() => new FakeSocket(), {
      awaitAcknowledgement: false,
      exitFallback: {
        persist: async (batch) => {
          persisted = batch;
          return ack(batch);
        },
      },
    }),
  );

  await transport.write(record());
  await transport.flushOnExit();

  assert.equal(persisted.batchId, 'batch-stable');
  assert.equal(persisted.records[0].recordId, 'record-stable');
  assert.equal(transport.snapshot().accepted, 1);
  assert.equal(transport.snapshot().inFlight, 0);
});

test('uses the injected clock for ticket expiration and batch timestamps', async () => {
  const clock = () => new Date(1_000);
  let socket;
  const transport = new SupabaseWebSocketIngestTransport(
    options(
      () => {
        socket = new FakeSocket((message, currentSocket) => {
          if (message.type === 'telemetry_batch') {
            queueMicrotask(() => currentSocket.emit(ack(message)));
          }
        });
        return socket;
      },
      {
        clock,
        ticketProvider: async () => ({
          url: 'wss://project.functions.supabase.co/telemetry-stream',
          ticket: 'one-time-ticket-1234567890',
          expiresAtMillis: 2_000,
        }),
        maxReconnectAttempts: 0,
      },
    ),
  );

  await transport.write(record());
  const batch = socket.sent.find(
    (message) => message.type === 'telemetry_batch',
  );
  assert.equal(batch.sentAt, '1970-01-01T00:00:01.000Z');
  assert.equal(transport.snapshot().accepted, 1);
});

test('requires WSS and a short-lived normalized ticket', async () => {
  const transport = new SupabaseWebSocketIngestTransport(
    options(() => new FakeSocket(), {
      ticketProvider: async () => ({
        url: 'ws://project.example.test/telemetry',
        ticket: 'one-time-ticket-1234567890',
      }),
      maxReconnectAttempts: 0,
    }),
  );

  await assert.rejects(() => transport.write(record()), /requires wss/);
  assert.equal(transport.snapshot().inFlight, 1);

  const padded = new SupabaseWebSocketIngestTransport(
    options(() => new FakeSocket(), {
      ticketProvider: async () => ({
        url: 'wss://project.example.test/telemetry',
        ticket: ' one-time-ticket-1234567890 ',
      }),
      maxReconnectAttempts: 0,
    }),
  );
  await assert.rejects(() => padded.write(record()), /normalized/);
});

test('rejects credential query parameters and fragments in ticket URLs', async () => {
  for (const url of [
    'wss://project.functions.supabase.co/telemetry-stream?apikey=secret',
    'wss://project.functions.supabase.co/telemetry-stream#secret',
  ]) {
    const transport = new SupabaseWebSocketIngestTransport(
      options(() => new FakeSocket(), {
        ticketProvider: async () => ({
          url,
          ticket: 'one-time-ticket-1234567890',
        }),
        maxReconnectAttempts: 0,
      }),
    );
    await assert.rejects(
      () => transport.write(record()),
      /credential query parameters|fragment/,
    );
    assert.equal(transport.snapshot().inFlight, 1);
  }
});

test('redacts ticket-provider and socket-constructor failures', async () => {
  const ticketFailure = new SupabaseWebSocketIngestTransport(
    options(() => new FakeSocket(), {
      ticketProvider: async () => {
        throw new Error('secret-ticket-value');
      },
      maxReconnectAttempts: 0,
    }),
  );
  await assert.rejects(
    () => ticketFailure.write(record()),
    (error) => {
      assert.equal(error.message, 'Supabase WebSocket ticket acquisition failed');
      assert.doesNotMatch(error.message, /secret-ticket-value/);
      return true;
    },
  );

  const constructorFailure = new SupabaseWebSocketIngestTransport(
    options(
      () => {
        throw new Error('wss://example.test/?ticket=secret-ticket-value');
      },
      { maxReconnectAttempts: 0 },
    ),
  );
  await assert.rejects(
    () => constructorFailure.write(record()),
    (error) => {
      assert.equal(error.message, 'Supabase WebSocket construction failed');
      assert.doesNotMatch(error.message, /secret-ticket-value/);
      return true;
    },
  );
});
