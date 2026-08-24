import assert from 'node:assert/strict';
import test from 'node:test';

import { SupabaseIngestTransport } from '../dist/supabase-ingest.js';

function okAck(batchId, accepted = 1, duplicate = false) {
  return new Response(JSON.stringify({ ok: true, batchId, accepted, duplicate }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' },
  });
}

function options(fetchImpl, overrides = {}) {
  return {
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    accessToken: 'user-token',
    fetch: fetchImpl,
    awaitDelivery: true,
    batchIdFactory: () => 'batch-fixed',
    ...overrides,
  };
}

test('sends the stable batch ID in the body and header and accepts only commit ACK', async () => {
  let observed;
  const transport = new SupabaseIngestTransport(options(async (_url, init) => {
    const body = JSON.parse(init.body);
    observed = { body, headers: init.headers };
    return okAck(body.batchId);
  }));

  await transport.write({ message: 'hello' });

  assert.equal(observed.body.batchId, 'batch-fixed');
  assert.equal(observed.headers['x-next-loggers-batch-id'], 'batch-fixed');
  assert.equal(transport.snapshot().acknowledged, 1);
  assert.equal(transport.snapshot().inFlight, 0);
});

test('preserves batch ID and records across a retryable response', async () => {
  const batchIds = [];
  let calls = 0;
  const transport = new SupabaseIngestTransport(options(async (_url, init) => {
    const body = JSON.parse(init.body);
    batchIds.push(body.batchId);
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: 'busy' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'retry-after': '0' },
      });
    }
    return okAck(body.batchId);
  }));

  await assert.rejects(() => transport.write({ message: 'retry me' }), /503/);
  assert.equal(transport.snapshot().inFlight, 1);
  await transport.flush();

  assert.deepEqual(batchIds, ['batch-fixed', 'batch-fixed']);
  assert.equal(transport.snapshot().acknowledged, 1);
  assert.equal(transport.snapshot().inFlight, 0);
});

test('retains a batch when a success response carries the wrong ACK ID', async () => {
  let calls = 0;
  const transport = new SupabaseIngestTransport(options(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls += 1;
    return calls === 1 ? okAck('wrong-batch') : okAck(body.batchId);
  }));

  await assert.rejects(() => transport.write({ message: 'ack checked' }), /batchId mismatch/);
  assert.equal(transport.snapshot().inFlight, 1);
  await transport.flush();
  assert.equal(transport.snapshot().acknowledged, 1);
});

test('retains the batch when the ACK does not account for every record', async () => {
  let calls = 0;
  const transport = new SupabaseIngestTransport(options(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls += 1;
    return calls === 1 ? okAck(body.batchId, 0, false) : okAck(body.batchId, 1, false);
  }));

  await assert.rejects(
    () => transport.write({ message: 'no partial commit ambiguity' }),
    /complete batch/,
  );
  assert.equal(transport.snapshot().inFlight, 1);
  await transport.flush();
  assert.equal(transport.snapshot().acknowledged, 1);
});

test('drops a terminally rejected poison batch and exposes rejection accounting', async () => {
  const rejected = [];
  const transport = new SupabaseIngestTransport(options(async () => new Response(
    JSON.stringify({ error: 'invalid record' }),
    { status: 400, statusText: 'Bad Request' },
  ), {
    onRejectedBatch: (value) => rejected.push(value),
  }));

  await assert.rejects(() => transport.write({ message: 'bad' }), /400/);

  assert.equal(transport.snapshot().inFlight, 0);
  assert.equal(transport.snapshot().rejected, 1);
  assert.equal(transport.snapshot().dropped, 1);
  assert.equal(rejected[0].batchId, 'batch-fixed');
});

test('requires HTTPS except explicitly enabled localhost development', () => {
  assert.throws(
    () => new SupabaseIngestTransport(options(async () => okAck('batch-fixed'), {
      url: 'http://example.com',
    })),
    /must use HTTPS/,
  );

  assert.doesNotThrow(
    () => new SupabaseIngestTransport(options(async () => okAck('batch-fixed'), {
      url: 'http://localhost:54321',
      allowInsecureLocalhost: true,
    })),
  );
});

test('enforces an optional exact host allow-list', () => {
  assert.throws(
    () => new SupabaseIngestTransport(options(async () => okAck('batch-fixed'), {
      allowedHosts: ['other.supabase.co'],
    })),
    /not in allowedHosts/,
  );
});
