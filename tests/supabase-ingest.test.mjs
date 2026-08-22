import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SupabaseIngestTransport,
  createSupabaseIngestTransport,
} from '@oresoftware/next-loggers/supabase-ingest';

function record(id, overrides = {}) {
  return {
    schema: 'next-loggers/v1',
    id,
    timestamp: '2026-08-03T00:00:00.000Z',
    level: 'INFO',
    runtime: 'browser',
    appName: 'web',
    message: `event ${id}`,
    values: [],
    fields: {},
    ...overrides,
  };
}

function jwt(role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ role })}.signature`;
}

test('client transport rejects secret credentials, embedded URL credentials, and missing authentication', async () => {
  assert.throws(
    () => new SupabaseIngestTransport({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_secret_do-not-use',
    }),
    /Secret\/service-role Supabase credentials/u,
  );
  assert.throws(
    () => new SupabaseIngestTransport({
      url: 'https://project.supabase.co',
      publishableKey: jwt('service_role'),
    }),
    /service-role JWT/u,
  );
  assert.throws(
    () => new SupabaseIngestTransport({
      url: 'https://user:password@project.supabase.co',
      publishableKey: 'sb_publishable_public',
    }),
    /embedded credentials/u,
  );

  let requests = 0;
  const transport = createSupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_public',
    awaitDelivery: true,
    fetch: async () => {
      requests += 1;
      return new Response(null, { status: 202 });
    },
  });
  await assert.rejects(
    transport.write(record('missing-auth')),
    /requires a user access token/u,
  );
  assert.equal(requests, 0);
  assert.equal(transport.snapshot().failures, 1);
});

test('authenticated batches use a normalized Edge Function URL and bounded client-safe headers', async () => {
  const requests = [];
  const transport = createSupabaseIngestTransport({
    url: 'https://project.supabase.co/some/path?leak=no#fragment',
    functionName: 'telemetry-ingest',
    publishableKey: '  sb_publishable_public  ',
    accessToken: async () => '  user-access-token  ',
    batchSize: 10,
    flushIntervalMillis: 60_000,
    clock: () => new Date('2026-08-03T12:34:56.000Z'),
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: 202 });
    },
  });

  await transport.write(record('one'));
  await transport.write(record('two'));
  await transport.flush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://project.supabase.co/functions/v1/telemetry-ingest');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.keepalive, false);
  assert.equal(requests[0].init.headers.apikey, 'sb_publishable_public');
  assert.equal(requests[0].init.headers.authorization, 'Bearer user-access-token');
  assert.equal(requests[0].init.headers['x-next-loggers-schema'], 'next-loggers/batch/v1');
  assert.match(requests[0].init.headers['x-next-loggers-batch-id'], /^nl-2-[0-9a-f]{16}$/u);
  assert.equal(requests[0].init.headers['x-client-info'], '@oresoftware/next-loggers');

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.schema, 'next-loggers/batch/v1');
  assert.equal(body.sentAt, '2026-08-03T12:34:56.000Z');
  assert.equal(body.batchId, requests[0].init.headers['x-next-loggers-batch-id']);
  assert.deepEqual(body.records.map(({ id }) => id), ['one', 'two']);
  assert.deepEqual(transport.snapshot(), {
    queued: 0,
    dropped: 0,
    failures: 0,
    retryAttempts: 0,
    accepting: true,
    closed: false,
  });
});

test('bounded queue drops the oldest record and isolates drop callbacks', async () => {
  const dropped = [];
  const delivered = [];
  const transport = createSupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_public',
    accessToken: 'user-token',
    maxQueueSize: 2,
    batchSize: 10,
    flushIntervalMillis: 60_000,
    onDrop(drop) {
      dropped.push([drop.reason, drop.record.id, drop.droppedTotal]);
      throw new Error('diagnostic unavailable');
    },
    fetch: async (_url, init) => {
      delivered.push(...JSON.parse(init.body).records.map(({ id }) => id));
      return new Response(null, { status: 202 });
    },
  });

  await transport.write(record('oldest'));
  await transport.write(record('middle'));
  await transport.write(record('newest'));
  await transport.flush();

  assert.deepEqual(dropped, [['queue-full', 'oldest', 1]]);
  assert.deepEqual(delivered, ['middle', 'newest']);
  assert.equal(transport.snapshot().dropped, 1);
});

test('failed delivery restores the exact batch order and retries with the same idempotency key', async () => {
  const requests = [];
  const errors = [];
  let attempt = 0;
  const transport = createSupabaseIngestTransport({
    url: 'https://project.supabase.co/functions/v1/telemetry-ingest?ignored=yes',
    publishableKey: 'sb_publishable_public',
    accessToken: 'user-token',
    batchSize: 10,
    flushIntervalMillis: 60_000,
    retryBaseMillis: 10,
    retryMaxMillis: 10,
    random: () => 0.5,
    onError(error, snapshot) {
      errors.push([error.message, snapshot.failures, snapshot.queued]);
    },
    fetch: async (_url, init) => {
      attempt += 1;
      requests.push({
        batchId: init.headers['x-next-loggers-batch-id'],
        ids: JSON.parse(init.body).records.map(({ id }) => id),
      });
      return attempt === 1
        ? new Response(null, { status: 503, statusText: 'Unavailable' })
        : new Response(null, { status: 202 });
    },
  });

  await transport.write(record('first'));
  await transport.write(record('second'));
  await assert.rejects(transport.flush(), /returned 503 Unavailable/u);
  assert.equal(transport.snapshot().failures, 1);
  assert.equal(transport.snapshot().queued, 2);
  assert.equal(transport.snapshot().retryAttempts, 1);

  await transport.flush();
  assert.deepEqual(requests.map(({ ids }) => ids), [
    ['first', 'second'],
    ['first', 'second'],
  ]);
  assert.equal(requests[0].batchId, requests[1].batchId);
  assert.deepEqual(errors, [['Supabase telemetry ingest returned 503 Unavailable', 1, 2]]);
  assert.equal(transport.snapshot().queued, 0);
  assert.equal(transport.snapshot().retryAttempts, 0);
});

test('failed in-flight delivery cannot overfill a queue refilled by producers', async () => {
  const dropped = [];
  const delivered = [];
  let releaseFirstRequest;
  let requestCount = 0;
  const firstResponse = new Promise((resolve) => {
    releaseFirstRequest = resolve;
  });
  const transport = createSupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_public',
    accessToken: 'user-token',
    maxQueueSize: 2,
    batchSize: 1,
    flushIntervalMillis: 60_000,
    retryBaseMillis: 60_000,
    retryMaxMillis: 60_000,
    onDrop: (drop) => dropped.push([drop.reason, drop.record.id]),
    fetch: async (_url, init) => {
      requestCount += 1;
      const ids = JSON.parse(init.body).records.map(({ id }) => id);
      if (requestCount === 1) {
        await firstResponse;
        return new Response(null, { status: 503, statusText: 'Unavailable' });
      }
      delivered.push(...ids);
      return new Response(null, { status: 202 });
    },
  });

  await transport.write(record('in-flight'));
  const failedFlush = transport.flush();
  await transport.write(record('queued-second'));
  await transport.write(record('queued-newest'));
  assert.equal(transport.snapshot().queued, 2);

  releaseFirstRequest();
  await assert.rejects(failedFlush, /returned 503 Unavailable/u);
  assert.equal(transport.snapshot().queued, 2);
  assert.equal(transport.snapshot().dropped, 1);
  assert.deepEqual(dropped, [['queue-full', 'queued-newest']]);

  await transport.flush();
  assert.deepEqual(delivered, ['in-flight', 'queued-second']);
  assert.equal(transport.snapshot().queued, 0);
});

test('oversized records are dropped before network delivery', async () => {
  const drops = [];
  let requests = 0;
  const transport = createSupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_public',
    accessToken: 'user-token',
    maxRecordBytes: 256,
    maxBatchBytes: 1_024,
    onDrop: (drop) => drops.push([drop.reason, drop.record.id]),
    fetch: async () => {
      requests += 1;
      return new Response(null, { status: 202 });
    },
  });

  await transport.write(record('large', { message: 'x'.repeat(2_000) }));
  await transport.flush();
  assert.deepEqual(drops, [['record-too-large', 'large']]);
  assert.equal(requests, 0);
});

test('close is idempotent, uses the exit keepalive budget, and drops later writes', async () => {
  const requests = [];
  const drops = [];
  const transport = createSupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_public',
    accessToken: 'user-token',
    maxExitBatchBytes: 60 * 1_024,
    flushIntervalMillis: 60_000,
    onDrop: (drop) => drops.push([drop.reason, drop.record.id]),
    fetch: async (_url, init) => {
      requests.push(init);
      return new Response(null, { status: 202 });
    },
  });

  await transport.write(record('before-close'));
  await Promise.all([transport.close(), transport.close()]);
  await transport.write(record('after-close'));
  await transport.close();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].keepalive, true);
  assert.deepEqual(drops, [['closed', 'after-close']]);
  assert.deepEqual(transport.snapshot(), {
    queued: 0,
    dropped: 1,
    failures: 0,
    retryAttempts: 0,
    accepting: false,
    closed: true,
  });
});

test('publishable-key-only mode must be explicitly enabled', async () => {
  const requests = [];
  const transport = createSupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_public',
    allowUnauthenticated: true,
    awaitDelivery: true,
    fetch: async (_url, init) => {
      requests.push(init);
      return new Response(null, { status: 202 });
    },
  });

  await transport.write(record('public'));
  assert.equal(requests.length, 1);
  assert.equal('authorization' in requests[0].headers, false);
});
