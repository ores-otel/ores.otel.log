import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

const [
  compose,
  collector,
  loki,
  tempo,
  prometheus,
  alerts,
  datasources,
  dashboardProvider,
  dashboardRaw,
  workflow,
  readme,
] = await Promise.all([
  read('observability/docker-compose.yml'),
  read('observability/otel-collector.yaml'),
  read('observability/loki.yaml'),
  read('observability/tempo.yaml'),
  read('observability/prometheus.yml'),
  read('observability/alerts.yml'),
  read('observability/grafana/provisioning/datasources/datasources.yaml'),
  read('observability/grafana/provisioning/dashboards/dashboards.yaml'),
  read('observability/grafana/dashboards/next-loggers-overview.json'),
  read('.github/workflows/observability.yml'),
  read('observability/README.md'),
]);
const dashboard = JSON.parse(dashboardRaw);

test('observability images are explicitly pinned and no service publishes a wildcard port', () => {
  const pins = [
    'otel/opentelemetry-collector-contrib:0.157.0',
    'grafana/loki:3.7.2',
    'grafana/tempo:2.10.5',
    'prom/prometheus:v3.13.1',
    'grafana/grafana:13.1.0',
  ];
  for (const pin of pins) assert.match(compose, new RegExp(`image: ${pin.replaceAll('.', '\\.')}`, 'u'));
  assert.equal(/image:\s+\S+:latest\b/u.test(compose), false);

  const published = [...compose.matchAll(/^\s+-\s+"([^"\n]+:\d+:\d+)"\s*$/gmu)].map((match) => match[1]);
  assert.ok(published.length >= 8, 'expected explicit host port mappings');
  assert.ok(published.every((mapping) => mapping.startsWith('127.0.0.1:')));
  assert.match(compose, /GF_SECURITY_ADMIN_PASSWORD: \$\{GRAFANA_ADMIN_PASSWORD:\?set GRAFANA_ADMIN_PASSWORD/u);
  assert.match(compose, /GF_SECURITY_SECRET_KEY: \$\{GRAFANA_SECRET_KEY:\?set GRAFANA_SECRET_KEY/u);
  assert.match(compose, /GF_AUTH_ANONYMOUS_ENABLED: "false"/u);
  assert.match(compose, /GF_PLUGINS_PREINSTALL_DISABLED: "true"/u);
  assert.match(compose, /internal: true/u);
  assert.match(compose, /--web\.enable-remote-write-receiver/u);
  assert.match(compose, /--enable-feature=exemplar-storage/u);
  assert.equal(compose.includes('privileged: true'), false);
  assert.match(compose, /no-new-privileges:true/u);
});

test('Collector routes explicit OTLP with bounded queues, redaction, no browser CORS, and self-observation', () => {
  assert.match(collector, /otlphttp\/loki:[\s\S]*endpoint: http:\/\/loki:3100\/otlp/u);
  assert.match(collector, /otlp\/tempo:[\s\S]*endpoint: tempo:4317/u);
  assert.match(collector, /prometheus:[\s\S]*endpoint: 0\.0\.0\.0:9464/u);
  assert.match(collector, /max_request_body_size: 8388608/u);
  assert.equal(/^\s+cors:\s*$/mu.test(collector), false);
  assert.match(collector, /resource\/redact:[\s\S]*http\.request\.header\.authorization/u);
  assert.match(collector, /attributes\/redact:[\s\S]*refresh_token/u);

  const expectedOrder = 'processors: [memory_limiter, resource/environment, resource/redact, attributes/redact, batch]';
  assert.equal(collector.split(expectedOrder).length - 1, 3);
  assert.equal((collector.match(/sending_queue:/gu) ?? []).length, 2);
  assert.equal((collector.match(/retry_on_failure:/gu) ?? []).length, 2);
  assert.match(collector, /metrics:[\s\S]*readers:[\s\S]*pull:[\s\S]*host: 0\.0\.0\.0[\s\S]*port: 8888/u);
  assert.equal(/registerInstrumentations|setGlobalTracerProvider|require-in-the-middle|shimmer/u.test(collector), false);
});

test('Loki keeps high-cardinality identity and trace values out of index labels', () => {
  assert.equal((loki.match(/^auth_enabled:/gmu) ?? []).length, 1);
  assert.match(loki, /allow_structured_metadata: true/u);
  assert.match(loki, /retention_enabled: true/u);
  assert.match(loki, /ignore_defaults: true/u);
  const labels = loki.match(/action: index_label\n\s+attributes:\n([\s\S]*?)(?=\n\s+- action:|\nanalytics:)/u)?.[1] ?? '';
  assert.match(labels, /service\.name/u);
  assert.match(labels, /service\.namespace/u);
  assert.match(labels, /deployment\.environment\.name/u);
  for (const forbidden of ['service.instance.id', 'k8s.pod.name', 'trace_id', 'span_id']) {
    assert.equal(new RegExp(`^\\s*-\\s+${forbidden.replaceAll('.', '\\.')}$`, 'mu').test(labels), false);
  }
});

test('Tempo actually generates RED/service-graph metrics and Prometheus accepts them', () => {
  assert.match(tempo, /metrics_generator:/u);
  assert.match(tempo, /url: http:\/\/prometheus:9090\/api\/v1\/write/u);
  assert.match(tempo, /send_exemplars: true/u);
  assert.match(tempo, /processors: \[span-metrics, service-graphs\]/u);
  assert.match(tempo, /max_active_series: 100000/u);
  assert.equal(/max_cardinality_per_label:/u.test(tempo), false);
  assert.match(tempo, /enable_target_info: false/u);
  assert.match(prometheus, /otel-collector:8888/u);
  assert.match(prometheus, /otel-collector:9464/u);
  assert.match(prometheus, /storage:[\s\S]*exemplars:/u);
  assert.match(alerts, /NextLoggersTransportFailureRatioHigh/u);
  assert.match(alerts, /OpenTelemetryCollectorExportFailures/u);
});

test('Grafana provisions bidirectional correlation, service graphs, and a real dashboard', () => {
  assert.match(datasources, /prune: true/u);
  assert.match(datasources, /exemplarTraceIdDestinations:/u);
  assert.match(datasources, /matcherType: label/u);
  assert.match(datasources, /matcherRegex: trace\[_\]\?id/u);
  assert.match(datasources, /url: '\$\$\{__value\.raw\}'/u);
  assert.match(datasources, /tracesToLogsV2:/u);
  assert.match(datasources, /filterByTraceID: true/u);
  assert.match(datasources, /tracesToMetrics:/u);
  assert.match(datasources, /serviceMap:[\s\S]*datasourceUid: prometheus/u);
  assert.match(datasources, /nodeGraph:[\s\S]*enabled: true/u);
  assert.match(dashboardProvider, /path: \/var\/lib\/grafana\/dashboards/u);
  assert.equal(dashboard.uid, 'next-loggers-overview');
  assert.ok(Array.isArray(dashboard.panels) && dashboard.panels.length >= 8);
  assert.ok(dashboard.panels.some((panel) => panel.type === 'logs'));
  assert.ok(dashboard.panels.some((panel) => String(panel.title).includes('Trace-derived')));
});

test('the dedicated CI job validates configs and executes an end-to-end telemetry smoke test', () => {
  assert.match(workflow, /opentelemetry-collector-contrib:0\.157\.0/u);
  assert.match(workflow, /validate --config=/u);
  assert.match(workflow, /grafana\/tempo:2\.10\.5[\s\S]*-config\.verify/u);
  assert.match(workflow, /promtool/u);
  assert.match(workflow, /docker compose[\s\S]*up -d/u);
  assert.match(workflow, /node scripts\/observability-smoke\.mjs/u);
  assert.match(workflow, /down -v --remove-orphans/u);
  assert.match(readme, /Browser and mobile boundary/u);
  assert.match(readme, /not a production multi-tenant deployment/u);
});
