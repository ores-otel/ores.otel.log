import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ORES_SUPABASE_WEBSOCKET_QUEUE_SCHEMA,
  PersistentSupabaseWebSocketIngestTransport,
} from '../dist/supabase-websocket-persistent.js';

const session = {
  appName: 'test-web',
  runtime: 'browser',
  sessionId: 'session-a',
  clientInstanceId: 'client-a',
};

const log = (id = 'log-a') => ({
  schema: 'next-loggers/v1',
  id,
  timestamp: '2026-08-24T00:00:00.000Z',
  level: 'INFO',
  runtime: 'browser',
  appName: 'test-web',
  message: id,
  values: [],
  fields: {},
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(storage, delegateOverrides = {}, optionOverrides = {}) {
  const state = { ids: [], records: [] };
  let innerOptions;
  const delegate = {
    write(record) {
      state.ids.push(innerOptions.recordIdFactory());
      state.records.push(record);
    },
    flush: async () => undefined,
    flushOnExit: async () => undefined,
    close: async () => undefined,
    ...delegateOverrides,
  };
  const options = {
    storage,
    session,
    ticketProvider: async () => ({
      url: 'wss://project.functions.supabase.co/ingest',
      ticket: 'ticket',
      expiresAt: '2026-08-24T01:00:00.000Z',
    }),
    allowedHosts: ['project.functions.supabase.co'],
    reconnect: false,
    autoReplay: false,
    recordIdFactory: (() => {
      let value = 0;
      return () => `stable-${++value}`;
    })(),
    transportFactory(value) {
      innerOptions = value;
      return delegate;
    },
    ...optionOverrides,
  };
  return { options, delegate, state };
}

test('published queue schema pins the durable replay protocol', async () => {
  const schema = JSON.parse(await readFile(new URL(
    '../contracts/schemas/supabase-websocket-persistent-queue.schema.json',
    import.meta.url,
  ), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.schema.const, ORES_SUPABASE_WEBSOCKET_QUEUE_SCHEMA);
  assert.equal(schema.properties.protocol.const, 'ores-otel/ws-ingest/v1');
  assert.equal(
    schema.$defs.entry.properties.record.$ref.endsWith('/contracts/log-record.schema.json'),
    true,
  );
});

test('persists before socket enqueue and clears only after commit completion', async () => {
  const storage = memoryStorage();
  const gate = deferred();
  const configured = setup(storage, { flush: () => gate.promise });
  const transport = new PersistentSupabaseWebSocketIngestTransport(configured.options);

  await transport.write(log());
  await tick();
  const persisted = JSON.parse([...storage.values.values()][0]);
  assert.equal(persisted.entries[0].recordId, 'stable-1');
  assert.equal(configured.state.ids[0], 'stable-1');

  gate.resolve();
  await transport.flush();
  assert.equal(storage.values.size, 0);
});

test('reload replays the same stable id after an interrupted drain', async () => {
  const storage = memoryStorage();
  const first = setup(storage, { flush: async () => { throw new Error('offline'); } });
  const transport = new PersistentSupabaseWebSocketIngestTransport(first.options);
  await transport.write(log('replay'));
  await tick();
  const originalId = JSON.parse([...storage.values.values()][0]).entries[0].recordId;

  const second = setup(storage);
  const replay = new PersistentSupabaseWebSocketIngestTransport({
    ...second.options,
    autoReplay: true,
  });
  await replay.flush();
  assert.equal(second.state.ids[0], originalId);
  assert.equal(storage.values.size, 0);
});

test('cross-session and expired state is not replayed', () => {
  const storage = memoryStorage();
  const fingerprint = JSON.stringify([
    session.appName,
    session.runtime,
    session.sessionId,
    session.clientInstanceId,
    null,
    null,
  ]);
  const key = `ores-otel:supabase-websocket-queue:v1:${encodeURIComponent(session.appName)}`;
  const state = {
    schema: ORES_SUPABASE_WEBSOCKET_QUEUE_SCHEMA,
    protocol: 'ores-otel/ws-ingest/v1',
    sessionFingerprint: fingerprint,
    savedAtMillis: 0,
    nextSequence: 1,
    entries: [{ recordId: 'old', sequence: 0, createdAtMillis: 0, record: log('old') }],
  };
  storage.setItem(key, JSON.stringify(state));
  const expired = setup(storage, {}, {
    clock: () => new Date(10_000),
    maxPersistedAgeMillis: 1,
  });
  const first = new PersistentSupabaseWebSocketIngestTransport(expired.options);
  assert.equal(first.snapshot().persisted, 0);

  storage.setItem(key, JSON.stringify(state));
  const mismatch = setup(storage, {}, {
    session: { ...session, sessionId: 'session-b' },
  });
  const second = new PersistentSupabaseWebSocketIngestTransport(mismatch.options);
  assert.equal(second.snapshot().persisted, 0);
  assert.equal(storage.values.size, 0);
});

test('bounded persistence never evicts a record already resident in the delegate', async () => {
  const storage = memoryStorage();
  const gate = deferred();
  const drops = [];
  const configured = setup(storage, { flush: () => gate.promise }, {
    maxPersistedRecords: 2,
    onPersistentDrop: (drop) => drops.push(drop),
  });
  const transport = new PersistentSupabaseWebSocketIngestTransport(configured.options);
  await transport.write(log('one'));
  await transport.write(log('two'));
  await tick();
  await transport.write(log('three'));

  const persisted = JSON.parse([...storage.values.values()][0]);
  assert.deepEqual(persisted.entries.map((entry) => entry.record.id), ['one', 'three']);
  assert.equal(drops.at(-1).reason, 'persistent-queue-full');
  assert.equal(drops.at(-1).record.id, 'two');
  gate.resolve();
  await transport.flush();
});

test('storage failure prevents socket enqueue', async () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: () => undefined,
  };
  const errors = [];
  const configured = setup(storage, {}, {
    onPersistenceError: (error) => errors.push(error),
  });
  const transport = new PersistentSupabaseWebSocketIngestTransport(configured.options);

  await assert.rejects(() => transport.write(log()), /quota exceeded/);
  assert.equal(configured.state.records.length, 0);
  assert.equal(errors.length, 1);
});

test('failed close retains unacknowledged records for reload replay', async () => {
  const storage = memoryStorage();
  const configured = setup(storage, {
    flush: async () => { throw new Error('offline'); },
    flushOnExit: async () => { throw new Error('fallback unavailable'); },
    close: async () => { throw new Error('close failed'); },
  });
  const transport = new PersistentSupabaseWebSocketIngestTransport(configured.options);

  await transport.write(log('close-replay'));
  await tick();
  await assert.rejects(() => transport.close(), /offline|fallback|close/);
  const persisted = JSON.parse([...storage.values.values()][0]);
  assert.equal(persisted.entries[0].record.id, 'close-replay');
});

test('oversized restored records are dropped', () => {
  const storage = memoryStorage();
  const fingerprint = JSON.stringify([
    session.appName,
    session.runtime,
    session.sessionId,
    session.clientInstanceId,
    null,
    null,
  ]);
  storage.setItem(
    `ores-otel:supabase-websocket-queue:v1:${encodeURIComponent(session.appName)}`,
    JSON.stringify({
      schema: ORES_SUPABASE_WEBSOCKET_QUEUE_SCHEMA,
      protocol: 'ores-otel/ws-ingest/v1',
      sessionFingerprint: fingerprint,
      savedAtMillis: 0,
      nextSequence: 1,
      entries: [{
        recordId: 'oversized',
        sequence: 0,
        createdAtMillis: 0,
        record: { ...log('oversized'), message: 'x'.repeat(1_000) },
      }],
    }),
  );
  const configured = setup(storage, {}, {
    maxRecordBytes: 100,
    maxPersistedAgeMillis: 10_000,
    clock: () => new Date(1),
  });
  const transport = new PersistentSupabaseWebSocketIngestTransport(configured.options);
  assert.equal(transport.snapshot().persisted, 0);
  assert.equal(storage.values.size, 0);
});
