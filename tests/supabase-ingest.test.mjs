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
    timestamp: '2026-08-02T00:00:00.000Z',
    level: 'INFO',
    runtime: 'browser',
    appName: 'web',
    message: `message-${id}`,
    values: [`message-${id}`],
    fields: {},
    ...overrides,
  };
}

function response(status = 202, requestId = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 202 ? 'Accepted' : 'Unavailable',
    headers: new Headers(requestId ? { 'x-request-id': requestId } : {}),
    text() {
      throw new Error('response body must not be read');
    },
  };
}

function jwt(role) {
  const payload = Buffer.from(JSON.stringify({ role })).toString('base64url');
  return `header.${payload}.signature`;
}

test('batches authenticated records to a sanitized Edge Function URL without reading response bodies', async () => {
  const requests = [];
  const transport = createSupabaseIngestTransport({
    url: 'https://project.supabase.co/?secret=query#fragment',
    publishableKey: 'sb_publishable_example',
    accessToken: jwt('authenticated'),
    batchSize: 2,
    flushIntervalMillis: 60_000,
    clock: () => new Date('2026-08-02T01:02:03.000Z'),
    fetch: async (url, init) => {
      requests.push({ url, init });
      return response();
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
  assert.equal(requests[0].init.headers.apikey, 'sb_publishable_example');
  assert.equal(requests[0].init.headers.authorization, `Bearer ${jwt('authenticated')}`);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.schema, 'next-loggers/batch/v1');
  assert.equal(body.sentAt, '2026-08-02T01:02:03.000Z');
  assert.deepEqual(body.records.map((value) => value.id), ['one', 'two']);
  assert.match(body.batchId, /^nl-2-[0-9a-f]{8}$/u);
  await transport.close();
});

test('rejects secret and service-role credentials and requires user authentication by default', async () => {
  assert.throws(
    () => new SupabaseIngestTransport({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_secret_never-on-a-client',
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
      publishableKey: 'sb_publishable_example',
    }),
    /must not contain embedded credentials/u,
  );
  assert.throws(
    () => new SupabaseIngestTransport({
      url: 'https://project.supabase.co/functions/v1/',
      publishableKey: 'sb_publishable_example',
    }),
    /must include an Edge Function name/u,
  );

  const noToken = new SupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_example',
    awaitDelivery: true,
    fetch: async () => response(),
  });
  await assert.rejects(noToken.write(record('missing-token')), /requires a user access token/u);

  const badToken = new SupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_example',
    accessToken: jwt('service_role'),
    awaitDelivery: true,
    fetch: async () => response(),
  });
  await assert.rejects(badToken.write(record('service-role')), /service-role JWT/u);

  const unauthenticated = new SupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_example',
    allowUnauthenticated: true,
    awaitDelivery: true,
    fetch: async () => response(),
  });
  await unauthenticated.write(record('public-function'));
  await unauthenticated.close();
});

test('bounds queue and record size with observable drop reasons', async () => {
  const drops = [];
  const requests = [];
  const transport = new SupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_example',
    accessToken: jwt('authenticated'),
    batchSize: 100,
    maxQueueSize: 2,
    maxRecordBytes: 512,
    flushIntervalMillis: 60_000,
    onDrop: (drop) => drops.push(drop),
    fetch: async (url, init) => {
      requests.push({ url, init });
      return response();
    },
  });

  await transport.write(record('one'));
  await transport.write(record('two'));
  await transport.write(record('three'));
  await transport.write(record('too-large', { fields: { payload: 'x'.repeat(2_000) } }));

  assert.equal(transport.snapshot().queued, 2);
  assert.deepEqual(drops.map((drop) => [drop.reason, drop.record.id]), [
    ['queue-full', 'one'],
    ['record-too-large', 'too-large'],
  ]);
  await transport.close();
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.records.map((value) => value.id), ['two', 'three']);
});

test('failed delivery restores order and reuses the deterministic batch id on retry', async () => {
  const requests = [];
  const errors = [];
  let attempt = 0;
  const transport = new SupabaseIngestTransport({
    url: 'https://project.supabase.co/functions/v1/client-logs?ignored=yes',
    publishableKey: 'sb_publishable_example',
    accessToken: jwt('authenticated'),
    awaitDelivery: true,
    retryBaseMillis: 10,
    retryMaxMillis: 10,
    random: () => 0,
    onError: (error, snapshot) => errors.push([error.message, snapshot.queued]),
    fetch: async (url, init) => {
      requests.push({ url, init });
      attempt += 1;
      return attempt === 1 ? response(503, 'request-1') : response();
    },
  });

  await assert.rejects(
    transport.write(record('retry-me')),
    /503 Unavailable \(request request-1\)/u,
  );
  assert.equal(transport.snapshot().queued, 1);
  assert.equal(transport.snapshot().failures, 1);
  await transport.flush();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://project.supabase.co/functions/v1/client-logs');
  assert.equal(
    JSON.parse(requests[0].init.body).batchId,
    JSON.parse(requests[1].init.body).batchId,
  );
  assert.deepEqual(
    requests.map((request) => JSON.parse(request.init.body).records[0].id),
    ['retry-me', 'retry-me'],
  );
  assert.deepEqual(errors, [['Supabase telemetry ingest returned 503 Unavailable (request request-1)', 1]]);
  await transport.close();
});

test('close is idempotent, uses keepalive only within the exit budget, and rejects new records by dropping them', async () => {
  const requests = [];
  const drops = [];
  const transport = new SupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_example',
    accessToken: jwt('authenticated'),
    batchSize: 100,
    maxExitBatchBytes: 60 * 1_024,
    flushIntervalMillis: 60_000,
    onDrop: (drop) => drops.push(drop),
    fetch: async (url, init) => {
      requests.push({ url, init });
      return response();
    },
  });
  await transport.write(record('exit'));
  const first = transport.close();
  const second = transport.close();
  assert.equal(first, second);
  await first;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.keepalive, true);
  assert.equal(transport.snapshot().closed, true);

  await transport.write(record('after-close'));
  assert.deepEqual(drops.map((drop) => [drop.reason, drop.record.id]), [
    ['closed', 'after-close'],
  ]);
  await transport.close();

  const oversizedExitRequests = [];
  const oversizedExit = new SupabaseIngestTransport({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_example',
    accessToken: jwt('authenticated'),
    batchSize: 100,
    maxRecordBytes: 8 * 1_024,
    maxExitBatchBytes: 1_024,
    flushIntervalMillis: 60_000,
    fetch: async (url, init) => {
      oversizedExitRequests.push({ url, init });
      return response();
    },
  });
  await oversizedExit.write(record('large-exit', { fields: { payload: 'x'.repeat(2_000) } }));
  await oversizedExit.close();
  assert.equal(oversizedExitRequests.length, 1);
  assert.equal(oversizedExitRequests[0].init.keepalive, false);
});
