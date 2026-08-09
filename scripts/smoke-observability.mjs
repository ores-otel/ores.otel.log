import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const urls = {
  collector: process.env.OTEL_HTTP_URL ?? 'http://127.0.0.1:4318',
  grafana: process.env.GRAFANA_URL ?? 'http://127.0.0.1:3000',
  loki: process.env.LOKI_URL ?? 'http://127.0.0.1:3100',
  prometheus: process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090',
  tempo: process.env.TEMPO_URL ?? 'http://127.0.0.1:3200',
};
const grafanaUser = process.env.GRAFANA_ADMIN_USER ?? 'admin';
const grafanaPassword = process.env.GRAFANA_ADMIN_PASSWORD;
if (!grafanaPassword) {
  throw new Error('GRAFANA_ADMIN_PASSWORD is required for the Grafana smoke check');
}

const traceId = randomBytes(16).toString('hex');
const spanId = randomBytes(8).toString('hex');
const recordId = `smoke-${Date.now()}`;
const message = `next-loggers-observability-smoke ${recordId}`;
const nowMillis = Date.now();
const nowNanos = BigInt(nowMillis) * 1_000_000n;
const startNanos = nowNanos - 50_000_000n;

const resource = {
  attributes: [
    { key: 'service.name', value: { stringValue: 'next-loggers-smoke' } },
    { key: 'service.namespace', value: { stringValue: 'oresoftware' } },
    { key: 'service.version', value: { stringValue: 'ci' } },
    { key: 'deployment.environment.name', value: { stringValue: 'ci' } },
  ],
};
const scope = { name: '@oresoftware/next-loggers/smoke', version: '1' };

async function request(url, init = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
    ...init,
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 512);
    throw new Error(`${init.method ?? 'GET'} ${url} returned ${response.status}: ${body}`);
  }
  return response;
}

async function postOtlp(path, payload) {
  await request(`${urls.collector}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

await Promise.all([
  postOtlp('/v1/traces', {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope,
            spans: [
              {
                traceId,
                spanId,
                name: 'next-loggers smoke span',
                kind: 1,
                startTimeUnixNano: startNanos.toString(),
                endTimeUnixNano: nowNanos.toString(),
                attributes: [
                  { key: 'next_logger.schema', value: { stringValue: 'next-loggers/v1' } },
                  { key: 'next_logger.runtime', value: { stringValue: 'node' } },
                  { key: 'smoke.record_id', value: { stringValue: recordId } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  }),
  postOtlp('/v1/logs', {
    resourceLogs: [
      {
        resource,
        scopeLogs: [
          {
            scope,
            logRecords: [
              {
                timeUnixNano: nowNanos.toString(),
                observedTimeUnixNano: nowNanos.toString(),
                severityNumber: 9,
                severityText: 'INFO',
                body: { stringValue: message },
                traceId,
                spanId,
                flags: 1,
                attributes: [
                  { key: 'log.record.uid', value: { stringValue: recordId } },
                  { key: 'next_logger.schema', value: { stringValue: 'next-loggers/v1' } },
                  { key: 'next_logger.runtime', value: { stringValue: 'node' } },
                  { key: 'next_logger.level', value: { stringValue: 'INFO' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }),
]);

async function waitFor(name, callback, timeoutMillis = 75_000) {
  const deadline = Date.now() + timeoutMillis;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) {
        console.log(`smoke check passed: ${name}`);
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for ${name}${lastError ? `: ${lastError.message}` : ''}`);
}

await waitFor('Tempo trace lookup', async () => {
  const response = await fetch(`${urls.tempo}/api/traces/${traceId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Tempo returned ${response.status}`);
  const value = await response.json();
  return Array.isArray(value.batches) && value.batches.length > 0;
});

await waitFor('Loki correlated log lookup', async () => {
  const parameters = new URLSearchParams({
    query: '{service_name="next-loggers-smoke"}',
    limit: '100',
    direction: 'backward',
    start: (BigInt(nowMillis - 120_000) * 1_000_000n).toString(),
    end: (BigInt(nowMillis + 120_000) * 1_000_000n).toString(),
  });
  const response = await request(`${urls.loki}/loki/api/v1/query_range?${parameters}`);
  const value = await response.json();
  assert.equal(value.status, 'success');
  return JSON.stringify(value.data).includes(message) && JSON.stringify(value.data).includes(traceId);
});

await waitFor('Prometheus scrape targets', async () => {
  const expectedJobs = [
    'prometheus',
    'otel-collector-internal',
    'otel-collector-exported-metrics',
    'loki',
    'tempo',
  ];
  const query = encodeURIComponent(`up{job=~"${expectedJobs.join('|')}"}`);
  const response = await request(`${urls.prometheus}/api/v1/query?query=${query}`);
  const value = await response.json();
  assert.equal(value.status, 'success');
  const results = value.data?.result ?? [];
  const healthy = new Map(results.map((entry) => [entry.metric.job, entry.value?.[1]]));
  const unhealthyJobs = expectedJobs.filter((job) => healthy.get(job) !== '1');
  if (unhealthyJobs.length === 0) {
    return true;
  }

  const targetsResponse = await request(`${urls.prometheus}/api/v1/targets?state=active`);
  const targetsValue = await targetsResponse.json();
  const diagnostics = (targetsValue.data?.activeTargets ?? [])
    .filter((target) => expectedJobs.includes(target.labels?.job ?? target.discoveredLabels?.job))
    .map((target) => ({
      job: target.labels?.job ?? target.discoveredLabels?.job,
      health: target.health,
      lastError: target.lastError,
      scrapeUrl: target.scrapeUrl,
    }));
  throw new Error(
    `unhealthy Prometheus targets: ${JSON.stringify({ unhealthyJobs, diagnostics })}`,
  );
});

const authorization = `Basic ${Buffer.from(`${grafanaUser}:${grafanaPassword}`).toString('base64')}`;
await request(`${urls.grafana}/api/health`);
for (const uid of ['prometheus', 'loki', 'tempo']) {
  const response = await request(`${urls.grafana}/api/datasources/uid/${uid}`, {
    headers: { authorization },
  });
  const datasource = await response.json();
  assert.equal(datasource.uid, uid);
}

console.log(JSON.stringify({
  message: 'Observability smoke test passed.',
  recordId,
  spanId,
  traceId,
}));
