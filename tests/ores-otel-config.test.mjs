import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadOresOtelConfig,
  oresOtelConfigToLoggerOptions,
  parseOresOtelToml,
  resolveOresOtelConfig,
  resolveOresOtelExporterEndpoint,
} from '../dist/config.js';

const MIXED = `
version = 1

[common]
enabled = true
environment = "test"

[common.logging]
enabled = true
level = "info"
console = true

[common.tracing]
enabled = true
sample_ratio = 0.25
propagators = ["tracecontext", "baggage"]

[client]
service_name = "web-client"

[client.logging]
console = false

[client.exporter]
protocol = "otlp_http"
endpoint_env = "CLIENT_OTEL_ENDPOINT"

[server]
service_name = "api-server"

[server.logging]
level = "debug"

[server.tracing]
sample_ratio = 1.0

[server.exporter]
protocol = "otlp_grpc"
endpoint_env = "SERVER_OTEL_ENDPOINT"
`;

test('parses common-only configuration as the contract-governed snake_case object', () => {
  const parsed = parseOresOtelToml(`
version = 1
[common]
service_name = "orders"
[common.logging]
level = "warn"
`);
  assert.deepEqual(parsed, {
    version: 1,
    common: {
      service_name: 'orders',
      logging: { level: 'warn' },
    },
  });
});

test('fails closed when a mixed client/server repository does not select a role', () => {
  const parsed = parseOresOtelToml(MIXED);
  assert.throws(
    () => resolveOresOtelConfig(parsed, { env: {} }),
    /both client and server sections exist/u,
  );
});

test('selects client and server overlays independently in the same repository', () => {
  const parsed = parseOresOtelToml(MIXED);
  const client = resolveOresOtelConfig(parsed, { env: {}, role: 'client' });
  const server = resolveOresOtelConfig(parsed, { env: {}, role: 'server' });

  assert.equal(client.role, 'client');
  assert.equal(client.serviceName, 'web-client');
  assert.equal(client.logging.level, 'info');
  assert.equal(client.logging.console, false);
  assert.equal(client.tracing.sampleRatio, 0.25);
  assert.equal(client.exporter.endpointEnv, 'CLIENT_OTEL_ENDPOINT');

  assert.equal(server.role, 'server');
  assert.equal(server.serviceName, 'api-server');
  assert.equal(server.logging.level, 'debug');
  assert.equal(server.logging.console, true);
  assert.equal(server.tracing.sampleRatio, 1);
  assert.equal(server.exporter.endpointEnv, 'SERVER_OTEL_ENDPOINT');
});

test('applies environment then explicit runtime overrides after file layers', () => {
  const parsed = parseOresOtelToml(MIXED);
  const resolved = resolveOresOtelConfig(parsed, {
    role: 'server',
    env: {
      ORES_OTEL_LOG_LEVEL: 'error',
      ORES_OTEL_TRACE_SAMPLE_RATIO: '0.5',
      ORES_OTEL_METRICS_ENABLED: 'false',
    },
    overrides: {
      logging: { level: 'fatal' },
      tracing: { sampleRatio: 0.75 },
    },
  });
  assert.equal(resolved.logging.level, 'fatal');
  assert.equal(resolved.tracing.sampleRatio, 0.75);
  assert.equal(resolved.metrics.enabled, false);
});

test('rejects unknown and secret-shaped TOML keys before telemetry can start', () => {
  assert.throws(
    () => parseOresOtelToml(`
version = 1
[server.exporter]
protocol = "otlp_http"
authorization = "do-not-store-this"
`),
    /forbidden/u,
  );
  assert.throws(
    () => parseOresOtelToml(`
version = 1
[server]
service = "typo"
`),
    /not a supported/u,
  );
});

test('rejects malformed semantic values rather than silently coercing them', () => {
  assert.throws(() => parseOresOtelToml('version = 2\n'), /version must equal 1/u);
  assert.throws(
    () => parseOresOtelToml('version = 1\n[client.logging]\nlevel = "verbose"\n'),
    /trace\|debug\|info/u,
  );
  assert.throws(
    () => parseOresOtelToml('version = 1\n[client.tracing]\nsample_ratio = 1.01\n'),
    /between 0 and 1/u,
  );
  assert.throws(
    () => parseOresOtelToml('version = 1\n[client.tracing]\npropagators = ["tracecontext", "tracecontext"]\n'),
    /must not contain duplicates/u,
  );
});

test('loads the root file and infers a single role, while a missing file remains backwards compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ores-otel-config-'));
  await writeFile(
    join(root, '.ores-otel.toml'),
    'version = 1\n[server]\nservice_name = "inventory"\n[server.logging]\nlevel = "warn"\n',
  );
  const loaded = await loadOresOtelConfig({ cwd: root, env: {} });
  assert.equal(loaded.config.role, 'server');
  assert.equal(loaded.config.serviceName, 'inventory');
  assert.equal(loaded.config.logging.level, 'warn');
  assert.equal(loaded.filePath, join(root, '.ores-otel.toml'));

  const missingRoot = await mkdtemp(join(tmpdir(), 'ores-otel-config-missing-'));
  const missing = await loadOresOtelConfig({ cwd: missingRoot, env: {} });
  assert.equal(missing.filePath, null);
  assert.equal(missing.config.role, 'shared');
  assert.equal(missing.config.logging.level, 'info');
});

test('resolves exporter endpoints only from runtime environment and maps logging policy safely', () => {
  const parsed = parseOresOtelToml(`
version = 1
[server]
service_name = "billing"
[server.logging]
level = "error"
console = false
[server.exporter]
protocol = "otlp_http"
endpoint_env = "BILLING_OTEL_ENDPOINT"
`);
  const config = resolveOresOtelConfig(parsed, { role: 'server', env: {} });
  assert.equal(
    resolveOresOtelExporterEndpoint(config, { BILLING_OTEL_ENDPOINT: 'https://collector.invalid/v1' }),
    'https://collector.invalid/v1',
  );
  assert.equal(resolveOresOtelExporterEndpoint(config, {}), undefined);
  assert.deepEqual(oresOtelConfigToLoggerOptions(config), {
    appName: 'billing',
    maxLevel: 'ERROR',
    console: false,
    autoSend: false,
  });
});
