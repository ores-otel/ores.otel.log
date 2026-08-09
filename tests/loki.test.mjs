import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LokiTransport } from '@oresoftware/next-loggers/loki';

const record = (overrides = {}) => ({
  schema: 'next-loggers/v1',
  id: 'record-1',
  timestamp: '2026-01-02T03:04:05.000Z',
  level: 'INFO',
  runtime: 'node',
  appName: 'checkout',
  message: 'hello',
  values: ['hello'],
  fields: {},
  traceId: 'trace-high-cardinality',
  ...overrides,
});

test('Loki transport batches JSON records and keeps trace IDs out of labels', async () => {
  const calls = [];
  const transport = new LokiTransport({
    endpoint: 'http://loki.observability.svc.cluster.local:3100/loki/api/v1/push',
    labels: { cluster: 'dd-ec2', environment: 'test' },
    tenantId: 'tenant-a',
    batchSize: 2,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });

  await Promise.all([
    transport.write(record()),
    transport.write(record({ id: 'record-2', level: 'ERROR' })),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['X-Scope-OrgID'], 'tenant-a');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.streams.length, 2);
  for (const stream of payload.streams) {
    assert.equal(stream.stream.cluster, 'dd-ec2');
    assert.equal(stream.stream.environment, 'test');
    assert.equal('traceId' in stream.stream, false);
    assert.equal('trace_id' in stream.stream, false);
  }
  assert.match(payload.streams[0].values[0][1], /trace-high-cardinality/);
  await transport.close();
});

test('Loki transport retries retryable responses with bounded backoff', async () => {
  let attempts = 0;
  const transport = new LokiTransport({
    endpoint: 'https://logs.example.test/loki/api/v1/push',
    batchSize: 1,
    maxRetries: 1,
    retryBaseMillis: 1,
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('busy', { status: 503 })
        : new Response(null, { status: 204 });
    },
  });
  await transport.write(record());
  assert.equal(attempts, 2);
  await transport.close();
});

test('Loki transport validates endpoints and rejects writes after close', async () => {
  assert.throws(() => new LokiTransport({ endpoint: 'ftp://example.test/logs' }), /http/);
  const transport = new LokiTransport({
    endpoint: 'https://logs.example.test/loki/api/v1/push',
    fetch: async () => new Response(null, { status: 204 }),
  });
  await transport.close();
  await assert.rejects(transport.write(record()), /closed/);
});
