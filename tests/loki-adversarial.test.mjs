import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LokiTransport } from '@oresoftware/next-loggers/loki';

function record(index, overrides = {}) {
  return {
    schema: 'next-loggers/v1',
    id: `record-${index}`,
    timestamp: `2026-01-02T03:04:${String(index).padStart(2, '0')}.000Z`,
    level: 'INFO',
    runtime: 'node',
    appName: 'checkout',
    message: `message-${index}`,
    values: [`message-${index}`],
    fields: {},
    traceId: `trace-${index}`,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('records with identical low-cardinality labels share one ordered stream', async () => {
  const calls = [];
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    labels: { cluster: 'prod', environment: 'test' },
    batchSize: 3,
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    },
  });
  await Promise.all([
    transport.write(record(1)),
    transport.write(record(2)),
    transport.write(record(3)),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].streams.length, 1);
  const stream = calls[0].streams[0];
  assert.deepEqual(stream.stream, {
    service_name: 'checkout',
    runtime: 'node',
    level: 'info',
    cluster: 'prod',
    environment: 'test',
  });
  assert.deepEqual(
    stream.values.map(([, line]) => JSON.parse(line).id),
    ['record-1', 'record-2', 'record-3'],
  );
  assert.deepEqual(
    stream.values.map(([timestamp]) => timestamp),
    [
      '1767323041000000000',
      '1767323042000000000',
      '1767323043000000000',
    ],
  );
  await transport.close();
});

test('level, runtime, and service split records into separate streams', async () => {
  let payload;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 4,
    fetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    },
  });
  await Promise.all([
    transport.write(record(1)),
    transport.write(record(2, { level: 'ERROR' })),
    transport.write(record(3, { runtime: 'bun' })),
    transport.write(record(4, { appName: 'billing' })),
  ]);
  assert.equal(payload.streams.length, 4);
  await transport.close();
});

test('trace IDs and arbitrary fields stay in JSON and never become labels', async () => {
  let payload;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    fetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    },
  });
  await transport.write(
    record(1, {
      fields: { userId: 'high-cardinality-user', orderId: 'order-1' },
    }),
  );
  const stream = payload.streams[0];
  assert.equal('traceId' in stream.stream, false);
  assert.equal('trace_id' in stream.stream, false);
  assert.equal('userId' in stream.stream, false);
  assert.equal('orderId' in stream.stream, false);
  assert.match(stream.values[0][1], /high-cardinality-user/);
  assert.match(stream.values[0][1], /trace-1/);
  await transport.close();
});

test('static labels reject invalid and reserved names', () => {
  assert.throws(
    () =>
      new LokiTransport({
        endpoint: 'https://loki.example.test/loki/api/v1/push',
        labels: { 'bad-label': 'x' },
      }),
    /Invalid Loki label name/,
  );
  for (const reserved of ['service_name', 'runtime', 'level']) {
    assert.throws(
      () =>
        new LokiTransport({
          endpoint: 'https://loki.example.test/loki/api/v1/push',
          labels: { [reserved]: 'override' },
        }),
      /reserved Loki label/,
    );
  }
});

test('transport-owned content type and tenant headers cannot be overridden', async () => {
  let headers;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    tenantId: 'tenant-safe',
    headers: {
      'content-type': 'text/plain',
      'X-Scope-OrgID': 'tenant-unsafe',
      authorization: 'Bearer test',
    },
    batchSize: 1,
    fetch: async (_url, init) => {
      headers = new Headers(init.headers);
      return new Response(null, { status: 204 });
    },
  });
  await transport.write(record(1));
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('x-scope-orgid'), 'tenant-safe');
  assert.equal(headers.get('authorization'), 'Bearer test');
  await transport.close();
});

test('non-retryable client errors are attempted exactly once', async () => {
  let attempts = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    maxRetries: 5,
    retryBaseMillis: 1,
    fetch: async () => {
      attempts += 1;
      return new Response('bad request', {
        status: 400,
        statusText: 'Bad Request',
      });
    },
  });
  await assert.rejects(transport.write(record(1)), /400 Bad Request/);
  assert.equal(attempts, 1);
  await transport.close();
});

test('408, 429, and 5xx responses are retried and eventually succeed', async (t) => {
  for (const status of [408, 429, 500, 503]) {
    await t.test(String(status), async () => {
      let attempts = 0;
      const transport = new LokiTransport({
        endpoint: 'https://loki.example.test/loki/api/v1/push',
        batchSize: 1,
        maxRetries: 1,
        retryBaseMillis: 1,
        fetch: async () => {
          attempts += 1;
          return attempts === 1
            ? new Response('retry', { status })
            : new Response(null, { status: 204 });
        },
      });
      await transport.write(record(status));
      assert.equal(attempts, 2);
      await transport.close();
    });
  }
});

test('network failures are retried up to the configured limit', async () => {
  let attempts = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    maxRetries: 2,
    retryBaseMillis: 1,
    fetch: async () => {
      attempts += 1;
      throw new TypeError('network unavailable');
    },
  });
  await assert.rejects(transport.write(record(1)), /network unavailable/);
  assert.equal(attempts, 3);
  await transport.close();
});

test('request timeouts abort each attempt and honor retry bounds', async () => {
  let attempts = 0;
  let aborted = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    timeoutMillis: 2,
    maxRetries: 1,
    retryBaseMillis: 1,
    fetch: async (_url, init) => {
      attempts += 1;
      await new Promise((resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            aborted += 1;
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(transport.write(record(1)), /aborted/i);
  assert.equal(attempts, 2);
  assert.equal(aborted, 2);
  await transport.close();
});

test('concurrent flush calls share one in-flight push', async () => {
  const gate = deferred();
  let attempts = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 10,
    fetch: async () => {
      attempts += 1;
      await gate.promise;
      return new Response(null, { status: 204 });
    },
  });
  const write = transport.write(record(1));
  const first = transport.flush();
  const second = transport.flush();
  assert.equal(first, second);
  gate.resolve();
  await Promise.all([write, first, second]);
  assert.equal(attempts, 1);
  await transport.close();
});

test('bounded queue evicts the oldest queued record while a batch is in flight', async () => {
  const firstPush = deferred();
  const drops = [];
  let pushes = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 2,
    maxQueueSize: 2,
    maxRetries: 0,
    onDrop: (dropped, reason) => drops.push({ dropped, reason }),
    fetch: async () => {
      pushes += 1;
      if (pushes === 1) await firstPush.promise;
      return new Response(null, { status: 204 });
    },
  });

  const first = transport.write(record(1));
  const second = transport.write(record(2));
  const evicted = transport.write(record(3));
  const fourth = transport.write(record(4));
  const fifth = transport.write(record(5));

  await assert.rejects(evicted, /queue capacity exceeded/);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].dropped.id, 'record-3');
  firstPush.resolve();
  await Promise.all([first, second, fourth, fifth]);
  await transport.close();
});

test('close drains multiple batches and is idempotent', async () => {
  const payloads = [];
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 2,
    flushIntervalMillis: 60_000,
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    },
  });
  const writes = Array.from({ length: 5 }, (_, index) =>
    transport.write(record(index + 1)),
  );
  await Promise.all(writes);
  await transport.close();
  await transport.close();
  assert.equal(payloads.length, 3);
  assert.deepEqual(
    payloads.flatMap((payload) =>
      payload.streams.flatMap((stream) =>
        stream.values.map(([, line]) => JSON.parse(line).id),
      ),
    ),
    ['record-1', 'record-2', 'record-3', 'record-4', 'record-5'],
  );
});

test('all records in a failed batch reject with the same terminal error', async () => {
  const terminal = new Error('terminal push failure');
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 3,
    maxRetries: 0,
    fetch: async () => {
      throw terminal;
    },
  });
  const results = await Promise.allSettled([
    transport.write(record(1)),
    transport.write(record(2)),
    transport.write(record(3)),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['rejected', 'rejected', 'rejected'],
  );
  for (const result of results) {
    assert.equal(result.reason, terminal);
  }
  await transport.close();
});

test('endpoint validation rejects malformed and non-http URLs', () => {
  for (const endpoint of [
    'not a url',
    'ftp://example.test/logs',
    'file:///tmp/loki',
  ]) {
    assert.throws(() => new LokiTransport({ endpoint }), /URL|http/);
  }
});
