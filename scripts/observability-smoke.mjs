import assert from 'node:assert/strict';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const CLIENT_SPAN_ID = '1111111111111111';
const SERVER_SPAN_ID = '2222222222222222';
const LOG_MARKER = `next-loggers-smoke-${Date.now()}`;
const SECRET_TOKEN = 'Bearer should-not-survive';
const SECRET_EMAIL = 'should-not-survive@example.invalid';
const GRAFANA_USER = process.env.GRAFANA_ADMIN_USER || 'admin';
const GRAFANA_PASSWORD = process.env.GRAFANA_ADMIN_PASSWORD;

assert.ok(GRAFANA_PASSWORD, 'GRAFANA_ADMIN_PASSWORD is required for the smoke test');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchWithTimeout(url, options = {}, timeoutMillis = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMillis);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(name, callback, { timeoutMillis = 120_000, intervalMillis = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMillis;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMillis);
  }
  throw new Error(`${name} did not become ready: ${lastError?.stack || lastError || 'condition remained false'}`);
}

async function expectOk(url, options) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${url} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function json(url, options) {
  const response = await expectOk(url, options);
  return response.json();
}

async function postOtlp(signal, payload) {
  await expectOk(`http://127.0.0.1:4318/v1/${signal}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function attr(key, value) {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') return { key, value: { intValue: String(value) } };
  return { key, value: { stringValue: String(value) } };
}

function resource(service) {
  return {
    attributes: [
      attr('service.name', service),
      attr('service.namespace', 'ci'),
      attr('deployment.environment.name', 'ci'),
      attr('service.instance.id', 'instance-high-cardinality'),
      attr('k8s.pod.name', 'pod-high-cardinality'),
      attr('k8s.cluster.name', 'next-loggers-ci'),
      attr('k8s.namespace.name', 'ci'),
    ],
  };
}

const startNanos = BigInt(Date.now() - 1_000) * 1_000_000n;
const middleNanos = startNanos + 20_000_000n;
const endNanos = startNanos + 40_000_000n;
const nowNanos = String(BigInt(Date.now()) * 1_000_000n);

await Promise.all([
  waitFor('Collector health', async () => (await fetchWithTimeout('http://127.0.0.1:13133/')).ok),
  waitFor('Loki readiness', async () => (await fetchWithTimeout('http://127.0.0.1:3100/ready')).ok),
  waitFor('Tempo readiness', async () => (await fetchWithTimeout('http://127.0.0.1:3200/ready')).ok),
  waitFor('Prometheus readiness', async () => (await fetchWithTimeout('http://127.0.0.1:9090/-/ready')).ok),
  waitFor('Grafana health', async () => {
    const health = await json('http://127.0.0.1:3000/api/health');
    return health.database === 'ok';
  }),
]);

await postOtlp('traces', {
  resourceSpans: [
    {
      resource: resource('next-loggers-smoke-client'),
      scopeSpans: [
        {
          scope: { name: 'next-loggers-smoke', version: '1.0.0' },
          spans: [
            {
              traceId: TRACE_ID,
              spanId: CLIENT_SPAN_ID,
              name: 'call smoke server',
              kind: 3,
              startTimeUnixNano: String(startNanos),
              endTimeUnixNano: String(endNanos),
              attributes: [attr('smoke.marker', LOG_MARKER)],
              status: { code: 1 },
            },
          ],
        },
      ],
    },
    {
      resource: resource('next-loggers-smoke-server'),
      scopeSpans: [
        {
          scope: { name: 'next-loggers-smoke', version: '1.0.0' },
          spans: [
            {
              traceId: TRACE_ID,
              spanId: SERVER_SPAN_ID,
              parentSpanId: CLIENT_SPAN_ID,
              name: 'handle smoke request',
              kind: 2,
              startTimeUnixNano: String(middleNanos),
              endTimeUnixNano: String(endNanos),
              attributes: [
                attr('smoke.marker', LOG_MARKER),
                attr('authorization', SECRET_TOKEN),
                attr('email', SECRET_EMAIL),
              ],
              status: { code: 1 },
            },
          ],
        },
      ],
    },
  ],
});

await postOtlp('logs', {
  resourceLogs: [
    {
      resource: resource('next-loggers-smoke-server'),
      scopeLogs: [
        {
          scope: { name: 'next-loggers-smoke', version: '1.0.0' },
          logRecords: [
            {
              timeUnixNano: nowNanos,
              observedTimeUnixNano: nowNanos,
              severityNumber: 9,
              severityText: 'INFO',
              body: { stringValue: `next-loggers smoke log ${LOG_MARKER}` },
              attributes: [
                attr('smoke.marker', LOG_MARKER),
                attr('authorization', SECRET_TOKEN),
                attr('email', SECRET_EMAIL),
              ],
              traceId: TRACE_ID,
              spanId: SERVER_SPAN_ID,
              flags: 1,
            },
          ],
        },
      ],
    },
  ],
});

await postOtlp('metrics', {
  resourceMetrics: [
    {
      resource: resource('next-loggers-smoke-server'),
      scopeMetrics: [
        {
          scope: { name: 'next-loggers-smoke', version: '1.0.0' },
          metrics: [
            {
              name: 'next_loggers_smoke_metric',
              description: 'End-to-end observability smoke metric',
              unit: '1',
              gauge: {
                dataPoints: [
                  {
                    timeUnixNano: nowNanos,
                    asInt: '1',
                    attributes: [attr('smoke.marker', 'bounded')],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
});

async function prometheusQuery(query) {
  return json(`http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(query)}`);
}

await waitFor('Collector-exported application metric', async () => {
  const result = await prometheusQuery('{__name__=~"next_loggers_smoke_metric.*"}');
  return result.status === 'success' && result.data?.result?.length > 0;
});

await waitFor('Tempo span metrics remote write', async () => {
  const result = await prometheusQuery('sum(traces_spanmetrics_calls_total)');
  const value = Number(result.data?.result?.[0]?.value?.[1] ?? 0);
  return value > 0;
});

await waitFor('Tempo service graph remote write', async () => {
  const result = await prometheusQuery('sum(traces_service_graph_request_total)');
  const value = Number(result.data?.result?.[0]?.value?.[1] ?? 0);
  return value > 0;
});

await waitFor('Prometheus scrape health', async () => {
  const result = await prometheusQuery('min(up{job=~"otel-collector-internal|otel-collector-exported|loki|tempo|prometheus"})');
  return Number(result.data?.result?.[0]?.value?.[1] ?? 0) === 1;
});

await waitFor('Tempo trace lookup', async () => {
  const response = await fetchWithTimeout(`http://127.0.0.1:3200/api/traces/${TRACE_ID}`);
  if (!response.ok) return false;
  return (await response.text()).includes(TRACE_ID);
});

const start = String(BigInt(Date.now() - 120_000) * 1_000_000n);
const end = String(BigInt(Date.now() + 60_000) * 1_000_000n);
const lokiResponse = await waitFor('Loki structured log', async () => {
  const query = `{service_name="next-loggers-smoke-server"} |= ${JSON.stringify(LOG_MARKER)}`;
  const result = await json(
    `http://127.0.0.1:3100/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&limit=20`,
  );
  return result.data?.result?.length > 0 ? result : false;
});

const serializedLoki = JSON.stringify(lokiResponse);
assert.ok(serializedLoki.includes(LOG_MARKER), 'Loki response must contain the smoke log');
assert.ok(serializedLoki.includes(TRACE_ID), 'Loki structured metadata must contain the trace ID');
assert.equal(serializedLoki.includes(SECRET_TOKEN), false, 'authorization value leaked to Loki');
assert.equal(serializedLoki.includes(SECRET_EMAIL), false, 'email value leaked to Loki');
for (const stream of lokiResponse.data.result.map((item) => item.stream || {})) {
  assert.equal('service_instance_id' in stream, false, 'service.instance.id became a Loki stream label');
  assert.equal('k8s_pod_name' in stream, false, 'k8s.pod.name became a Loki stream label');
  assert.equal('trace_id' in stream, false, 'trace ID became a Loki stream label');
  assert.equal('span_id' in stream, false, 'span ID became a Loki stream label');
}

const basic = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASSWORD}`).toString('base64');
await waitFor('Grafana dashboard provisioning', async () => {
  const result = await json('http://127.0.0.1:3000/api/search?query=Next%20Loggers', {
    headers: { authorization: `Basic ${basic}` },
  });
  return result.some((item) => item.uid === 'next-loggers-overview');
});

console.log(JSON.stringify({
  ok: true,
  marker: LOG_MARKER,
  traceId: TRACE_ID,
  verified: [
    'collector health and OTLP ingest',
    'credential/contact-field redaction',
    'native OTLP logs to Loki with structured trace metadata',
    'application metrics to Prometheus',
    'traces to Tempo',
    'Tempo span metrics and service graphs to Prometheus',
    'Grafana dashboard provisioning',
  ],
}, null, 2));
