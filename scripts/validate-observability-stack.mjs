import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (filename) => readFile(path.join(root, filename), 'utf8');

const [compose, collector, loki, tempo, prometheus, datasources, environment] = await Promise.all([
  read('observability/docker-compose.yml'),
  read('observability/otel-collector.yaml'),
  read('observability/loki.yaml'),
  read('observability/tempo.yaml'),
  read('observability/prometheus.yml'),
  read('observability/grafana/provisioning/datasources/datasources.yaml'),
  read('observability/.env.example'),
]);

const pinnedImages = [
  'otel/opentelemetry-collector-contrib:0.157.0',
  'grafana/loki:3.7.2',
  'prom/prometheus:v3.13.1',
  'grafana/tempo:2.10.5',
  'grafana/grafana:13.1.0',
];
for (const image of pinnedImages) {
  assert.match(compose, new RegExp(`image:\\s+${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
}
assert.doesNotMatch(compose, /image:\s+\S+:(?:latest|main|master)\b/iu);
assert.doesNotMatch(compose, /^\s*-\s+(?:0\.0\.0\.0|\$\{[^}]+\}):\d+:/gmu);
assert.match(compose, /127\.0\.0\.1:4318:4318/u);
assert.match(compose, /internal:\s+true/u);
assert.match(compose, /GF_SECURITY_ADMIN_PASSWORD:\s+\$\{GRAFANA_ADMIN_PASSWORD:\?/u);
assert.match(compose, /GF_SECURITY_SECRET_KEY:\s+\$\{GRAFANA_SECRET_KEY:\?/u);
assert.doesNotMatch(compose, /GF_SECURITY_ADMIN_PASSWORD:\s+["']?admin["']?\s*$/gmu);
assert.doesNotMatch(environment, /GRAFANA_ADMIN_PASSWORD=admin\s*$/mu);
assert.match(environment, /replace-with-a-long-random-password/u);

assert.match(collector, /memory_limiter:/u);
assert.match(collector, /max_request_body_size:\s+8388608/u);
assert.doesNotMatch(collector, /^\s+cors:\s*$/gmu);
assert.match(collector, /readers:\s*\n\s*- pull:/u);
assert.match(collector, /host:\s+0\.0\.0\.0\s*\n\s+port:\s+8888/u);
assert.equal((collector.match(/sending_queue:/gu) ?? []).length, 2);
assert.match(collector, /endpoint:\s+http:\/\/loki:3100\/otlp/u);
assert.match(collector, /attributes\/redact/u);
assert.doesNotMatch(
  collector,
  /registerInstrumentations|setGlobalTracerProvider|setGlobalMeterProvider|setGlobalLoggerProvider|require-in-the-middle|shimmer/iu,
);

assert.equal((loki.match(/^auth_enabled:/gmu) ?? []).length, 1);
assert.match(loki, /allow_structured_metadata:\s+true/u);
assert.match(loki, /ignore_defaults:\s+true/u);
const indexSection = loki.match(/action:\s+index_label[\s\S]*?(?=\n\s*- action:|\nanalytics:)/u)?.[0] ?? '';
for (const forbidden of ['trace_id', 'span_id', 'service.instance.id', 'k8s.pod.name', 'user.id']) {
  assert.doesNotMatch(indexSection, new RegExp(forbidden.replaceAll('.', '\\.'), 'u'));
}
for (const required of ['service.name', 'service.namespace', 'deployment.environment.name']) {
  assert.match(indexSection, new RegExp(required.replaceAll('.', '\\.'), 'u'));
}

assert.match(tempo, /processors:\s+\[span-metrics, service-graphs\]/u);
assert.match(tempo, /send_exemplars:\s+true/u);
assert.match(tempo, /block_retention:\s+168h/u);

function scrapeJob(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return prometheus.match(
    new RegExp(`- job_name:\\s+${escaped}\\n[\\s\\S]*?(?=\\n\\s*- job_name:|$)`, 'u'),
  )?.[0] ?? '';
}

const collectorInternalJob = scrapeJob('otel-collector-internal');
assert.match(collectorInternalJob, /fallback_scrape_protocol:\s+PrometheusText0\.0\.4/u);
assert.match(collectorInternalJob, /otel-collector:8888/u);
const collectorExportedMetricsJob = scrapeJob('otel-collector-exported-metrics');
assert.match(collectorExportedMetricsJob, /fallback_scrape_protocol:\s+PrometheusText0\.0\.4/u);
assert.match(collectorExportedMetricsJob, /otel-collector:9464/u);
assert.match(compose, /--web\.enable-remote-write-receiver/u);

assert.match(datasources, /matcherType:\s+label/u);
assert.match(datasources, /matcherRegex:\s+trace(?:_id|\[_\]\?id)/u);
assert.match(datasources, /tracesToLogsV2:/u);
assert.match(datasources, /serviceMap:\s*\n\s+datasourceUid:\s+prometheus/u);

console.log('Observability stack static invariants passed.');
