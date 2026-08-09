import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LokiTransport, createLokiTransport } from '@oresoftware/next-loggers/loki';

function record(index, overrides = {}) {
  return {
    schema: 'next-loggers/v1',
    id: `matrix-${index}`,
    timestamp: '2026-08-03T12:00:00.000Z',
    level: 'INFO',
    runtime: 'node',
    appName: 'matrix-service',
    message: `message-${index}`,
    values: [`message-${index}`],
    fields: {},
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

function payloadIds(payload) {
  return payload.streams.flatMap((stream) =>
    stream.values.map(([, line]) => JSON.parse(line).id),
  );
}

test('factory returns the concrete Loki transport', () => {
  const transport = createLokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    fetch: async () => new Response(null, { status: 204 }),
  });
  assert.equal(transport instanceof LokiTransport, true);
  assert.equal(transport.name, 'loki');
});

test('endpoint is normalized by the URL parser', () => {
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test',
    fetch: async () => new Response(null, { status: 204 }),
  });
  assert.equal(transport.endpoint, 'https://loki.example.test/');
});

test('empty static label values are omitted from the stream', async () => {
  let payload;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    labels: { environment: '', cluster: 'prod' },
    batchSize: 1,
    fetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    },
  });
  await transport.write(record(1));
  assert.deepEqual(payload.streams[0].stream, {
    service_name: 'matrix-service',
    runtime: 'node',
    level: 'info',
    cluster: 'prod',
  });
  await transport.close();
});

test('Unicode static label values are preserved exactly', async () => {
  let payload;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    labels: { region: 'sa-east-1-東京', team: 'audio-🎧' },
    batchSize: 1,
    fetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    },
  });
  await transport.write(record(1));
  assert.equal(payload.streams[0].stream.region, 'sa-east-1-東京');
  assert.equal(payload.streams[0].stream.team, 'audio-🎧');
  await transport.close();
});

test('static labels are copied at construction and ignore later caller mutation', async () => {
  const labels = { cluster: 'before' };
  let payload;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    labels,
    batchSize: 1,
    fetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    },
  });
  labels.cluster = 'after';
  await transport.write(record(1));
  assert.equal(payload.streams[0].stream.cluster, 'before');
  await transport.close();
});

test('fractional batch sizes are floored', async () => {
  const payloads = [];
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 2.9,
    flushIntervalMillis: 60_000,
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    },
  });
  await Promise.all([transport.write(record(1)), transport.write(record(2))]);
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloadIds(payloads[0]), ['matrix-1', 'matrix-2']);
  await transport.close();
});

test('zero and negative batch sizes are clamped to one', async () => {
  for (const batchSize of [0, -10]) {
    let pushes = 0;
    const transport = new LokiTransport({
      endpoint: 'https://loki.example.test/loki/api/v1/push',
      batchSize,
      fetch: async () => {
        pushes += 1;
        return new Response(null, { status: 204 });
      },
    });
    await transport.write(record(batchSize));
    assert.equal(pushes, 1);
    await transport.close();
  }
});

test('flush on an empty transport is a no-op', async () => {
  let pushes = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    fetch: async () => {
      pushes += 1;
      return new Response(null, { status: 204 });
    },
  });
  await transport.flush();
  await transport.flushOnExit();
  assert.equal(pushes, 0);
  await transport.close();
});

test('the flush timer sends a partial batch', async () => {
  const payloads = [];
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 100,
    flushIntervalMillis: 1,
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    },
  });
  const write = transport.write(record(1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await write;
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloadIds(payloads[0]), ['matrix-1']);
  await transport.close();
});

test('timeoutMillis zero disables the abort timer', async () => {
  let aborted = false;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    timeoutMillis: 0,
    fetch: async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      aborted = init.signal.aborted;
      return new Response(null, { status: 204 });
    },
  });
  await transport.write(record(1));
  assert.equal(aborted, false);
  await transport.close();
});

test('negative retry counts perform only the initial attempt', async () => {
  let attempts = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    maxRetries: -20,
    fetch: async () => {
      attempts += 1;
      return new Response('unavailable', { status: 503 });
    },
  });
  await assert.rejects(transport.write(record(1)), /503/);
  assert.equal(attempts, 1);
  await transport.close();
});

test('redirect responses are terminal rather than retried as server failures', async () => {
  let attempts = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    maxRetries: 3,
    retryBaseMillis: 1,
    fetch: async () => {
      attempts += 1;
      return new Response(null, { status: 302, statusText: 'Found' });
    },
  });
  await assert.rejects(transport.write(record(1)), /302 Found/);
  assert.equal(attempts, 1);
  await transport.close();
});

test('invalid record timestamps fall back to a current nanosecond timestamp', async () => {
  let payload;
  const before = BigInt(Date.now()) * 1_000_000n;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    fetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    },
  });
  await transport.write(record(1, { timestamp: 'not-a-date' }));
  const after = BigInt(Date.now()) * 1_000_000n;
  const timestamp = BigInt(payload.streams[0].values[0][0]);
  assert.equal(timestamp >= before, true);
  assert.equal(timestamp <= after, true);
  await transport.close();
});

test('onDrop exceptions are isolated from queue eviction behavior', async () => {
  const gate = deferred();
  let pushes = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 2,
    maxQueueSize: 2,
    onDrop() {
      throw new Error('diagnostic failure');
    },
    fetch: async () => {
      pushes += 1;
      if (pushes === 1) await gate.promise;
      return new Response(null, { status: 204 });
    },
  });
  const one = transport.write(record(1));
  const two = transport.write(record(2));
  const evicted = transport.write(record(3));
  const four = transport.write(record(4));
  const five = transport.write(record(5));
  await assert.rejects(evicted, /queue capacity exceeded/);
  gate.resolve();
  await Promise.all([one, two, four, five]);
  await transport.close();
});

test('the onDrop callback observes the same error used to reject the evicted write', async () => {
  const gate = deferred();
  let dropped;
  let pushes = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 2,
    maxQueueSize: 2,
    onDrop: (value, reason) => {
      dropped = { value, reason };
    },
    fetch: async () => {
      pushes += 1;
      if (pushes === 1) await gate.promise;
      return new Response(null, { status: 204 });
    },
  });
  const one = transport.write(record(1));
  const two = transport.write(record(2));
  const three = transport.write(record(3));
  const four = transport.write(record(4));
  const five = transport.write(record(5));
  const rejection = await three.catch((error) => error);
  assert.equal(dropped.value.id, 'matrix-3');
  assert.equal(dropped.reason, rejection);
  gate.resolve();
  await Promise.all([one, two, four, five]);
  await transport.close();
});

test('close waits for an in-flight request before resolving', async () => {
  const gate = deferred();
  let completed = false;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    fetch: async () => {
      await gate.promise;
      completed = true;
      return new Response(null, { status: 204 });
    },
  });
  const write = transport.write(record(1));
  const close = transport.close();
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  gate.resolve();
  await Promise.all([write, close]);
  assert.equal(completed, true);
  assert.equal(closed, true);
});

test('flushOnExit drains every queued batch in original order', async () => {
  const payloads = [];
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 3,
    flushIntervalMillis: 60_000,
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    },
  });
  const writes = Array.from({ length: 10 }, (_, index) =>
    transport.write(record(index + 1)),
  );
  await transport.flushOnExit();
  await Promise.all(writes);
  assert.deepEqual(payloads.flatMap(payloadIds), [
    'matrix-1',
    'matrix-2',
    'matrix-3',
    'matrix-4',
    'matrix-5',
    'matrix-6',
    'matrix-7',
    'matrix-8',
    'matrix-9',
    'matrix-10',
  ]);
  await transport.close();
});

test('a failed batch does not make a later close call fail again', async () => {
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 1,
    maxRetries: 0,
    fetch: async () => {
      throw new Error('terminal');
    },
  });
  await assert.rejects(transport.write(record(1)), /terminal/);
  await transport.close();
  await transport.close();
});

test('writes after close reject without invoking fetch', async () => {
  let pushes = 0;
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    fetch: async () => {
      pushes += 1;
      return new Response(null, { status: 204 });
    },
  });
  await transport.close();
  await assert.rejects(transport.write(record(1)), /closed/);
  assert.equal(pushes, 0);
});

test('one hundred records are delivered exactly once across chained batches', async () => {
  const delivered = [];
  const transport = new LokiTransport({
    endpoint: 'https://loki.example.test/loki/api/v1/push',
    batchSize: 7,
    flushIntervalMillis: 60_000,
    fetch: async (_url, init) => {
      delivered.push(...payloadIds(JSON.parse(init.body)));
      return new Response(null, { status: 204 });
    },
  });
  await Promise.all(
    Array.from({ length: 100 }, (_, index) => transport.write(record(index + 1))),
  );
  await transport.close();
  assert.equal(delivered.length, 100);
  assert.deepEqual(
    delivered,
    Array.from({ length: 100 }, (_, index) => `matrix-${index + 1}`),
  );
  assert.equal(new Set(delivered).size, 100);
});
