import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const renderer = fileURLToPath(new URL('../sidecar/bin/render-patch.mjs', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const catalog = JSON.parse(await read('sidecar/adoption-candidates.json'));
const schema = JSON.parse(await read('sidecar/adoption-candidates.schema.json'));
const config = await read('sidecar/k8s/base/collector.yaml');
const kustomization = await read('sidecar/k8s/base/kustomization.yaml');
const documentation = await read('sidecar/README.md');
const kubernetesDockerfile = await read('sidecar/k8s/Dockerfile');
const kubernetesEntrypoint = await read('sidecar/k8s/entrypoint.sh');
const cloudRunConfig = await read('sidecar/cloud-run/collector.yaml');
const cloudRunDocumentation = await read('sidecar/cloud-run/README.md');
const cloudRunNativeDockerfile = await read('sidecar/cloud-run/native/Dockerfile');
const cloudRunNativeEntrypoint = await read('sidecar/cloud-run/native/entrypoint.sh');
const cloudRunSupervisorDockerfile = await read('sidecar/cloud-run/same-container/Dockerfile');
const cloudRunSupervisorEntrypoint = await read('sidecar/cloud-run/same-container/entrypoint.sh');
const cloudRunNativeService = await read('sidecar/cloud-run/service.native.yaml');
const cloudRunSupervisorService = await read('sidecar/cloud-run/service.same-container.yaml');

const expectedRepositories = [
  '3FA-app/3fa-backend.rs',
  '3FA-app/3fa-web-server.rs',
  'ORESoftware/mip-solver-node.rs',
  'ORESoftware/tor-server.rs',
  'athlet-o/athleto-app-rs',
  'athlet-o/athleto-backend.rs',
  'benefactor-cc/backend.rs',
  'akrion-sim/akrion-backend.rs',
  'canonical-cloud/canonical-web-server.rs',
  'daedalus-fab/daedalus-api-server.rs',
  'daedalus-fab/daedalus-web-server.rs',
  'daedalus-fab/fabrication-server.rs',
  'quaestor-ledger/quaestor-ledger-server.rs',
  'sagitta-stack/dart-server',
  'scintilla-run/gleam-lambda-runner',
  'shared-auth/shared-auth-server.rs',
  'sonus-auris/sonus-auris-api-server.rs',
].sort();

const credentialPattern = new RegExp([
  'gh[pousr]_[A-Za-z0-9]{20,}',
  'lin_' + 'api_[A-Za-z0-9]+',
  'BEGIN [A-Z ]*PRIVATE KEY',
].join('|'), 'u');

function render(...args) {
  return spawnSync(process.execPath, [renderer, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

test('catalog is bounded to 17 unique exact-head Kubernetes candidates', () => {
  assert.equal(catalog.schemaVersion, '1.1.0');
  assert.equal(catalog.policy.minimumCandidates, 12);
  assert.equal(catalog.policy.maximumCandidates, 20);
  assert.equal(catalog.policy.sidecarVersion, '0.1.0');
  assert.equal(catalog.policy.productionMutation, false);
  assert.equal(catalog.candidates.length, 17);
  assert.deepEqual(
    catalog.candidates.map(candidate => candidate.repository).sort(),
    expectedRepositories,
  );

  const refs = new Set();
  const workloadKeys = new Set();
  for (const candidate of catalog.candidates) {
    assert.match(candidate.ref, /^[0-9a-f]{40}$/u);
    assert.equal(refs.has(candidate.ref), false, `${candidate.repository} duplicates a source ref`);
    refs.add(candidate.ref);
    assert.equal(candidate.workload.apiVersion, 'apps/v1');
    assert.ok(['Deployment', 'StatefulSet'].includes(candidate.workload.kind));
    assert.ok(candidate.workload.manifests.length >= 1);
    assert.equal(
      Boolean(candidate.workload.deploymentRepository),
      Boolean(candidate.workload.deploymentRef),
      `${candidate.repository} must pair deployment repository and ref`,
    );
    if (candidate.workload.deploymentRef) {
      assert.match(candidate.workload.deploymentRef, /^[0-9a-f]{40}$/u);
    }
    assert.ok(candidate.current.endpoint.includes('dd-otel-collector'));
    assert.ok(['grpc', 'http/protobuf'].includes(candidate.current.protocol));
    assert.equal(candidate.adoption.requiresLiveCanary, true);
    assert.ok(candidate.selectionEvidence.includes('kubernetes-workload-at-exact-head'));
    assert.ok(candidate.selectionEvidence.includes('direct-remote-otlp-export'));
    assert.ok(candidate.selectionEvidence.includes('no-pod-local-collector'));
    const workloadKey = `${candidate.repository}:${candidate.workload.name}:${candidate.workload.container}`;
    assert.equal(workloadKeys.has(workloadKey), false, `duplicate workload key: ${workloadKey}`);
    workloadKeys.add(workloadKey);
  }
});

test('catalog pins the current audited multi-architecture collector release', () => {
  const image = catalog.policy.collectorImage;
  assert.equal(image.repository, 'otel/opentelemetry-collector-contrib');
  assert.equal(image.tag, '0.160.0');
  assert.equal(
    image.digest,
    'sha256:799dc6cf12c96192af37b5bdba804da8c10b3bc563b43cb90c3f3c58d9572ad6',
  );
  assert.equal(image.releaseUrl.endsWith('/v0.160.0'), true);
  assert.match(image.publishedAt, /^2026-09-02T/u);
});

test('catalog schema preserves the expanded 12-20 cohort boundary and fails closed', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.candidates.minItems, 12);
  assert.equal(schema.properties.candidates.maxItems, 20);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.candidates.items.additionalProperties, false);
  assert.equal(schema.properties.policy.properties.productionMutation.const, false);
  assert.deepEqual(
    schema.properties.candidates.items.properties.workload.dependentRequired,
    {
      deploymentRepository: ['deploymentRef'],
      deploymentRef: ['deploymentRepository'],
    },
  );
});

test('collector binds OTLP locally and health separately', () => {
  assert.match(config, /grpc:\n\s+endpoint: 127\.0\.0\.1:4317/u);
  assert.match(config, /http:\n\s+endpoint: 127\.0\.0\.1:4318/u);
  assert.doesNotMatch(config, /endpoint: 0\.0\.0\.0:431[78]/u);
  assert.match(config, /health_check:\n\s+endpoint: 0\.0\.0\.0:13133/u);
});

test('collector bounds memory, queues, retries, and signal-specific redaction', () => {
  assert.match(config, /^  otlp_grpc\/upstream:$/mu);
  assert.doesNotMatch(config, /^  otlp\/upstream:$/mu);
  for (const fragment of [
    'limit_mib: 96',
    'spike_limit_mib: 24',
    'queue_size: 2048',
    'max_elapsed_time: 5m',
    'http.request.header.authorization',
    'http.request.header.cookie',
    'http.response.header.set-cookie',
    'db.statement',
    'url.query',
    'enduser.id',
  ]) {
    assert.ok(config.includes(fragment), `collector config is missing ${fragment}`);
  }
  const metricsPipeline = config.match(/    metrics:\n([\s\S]*?)    traces:/u)?.[1] ?? '';
  assert.doesNotMatch(metricsPipeline, /attributes\/security/u);
  assert.match(metricsPipeline, /resource\/pod/u);
  assert.match(metricsPipeline, /resource\/ores/u);
  assert.match(config, /ores\.telemetry\.source: https:\/\/github\.com\/ores-otel/u);
  assert.match(config, /service\.name: ores-otel-sidecar/u);
});

test('Kustomize base creates one stable, labeled ConfigMap', () => {
  assert.match(kustomization, /kind: Kustomization/u);
  assert.match(kustomization, /name: ores-otel-sidecar-v1/u);
  assert.match(kustomization, /config\.yaml=collector\.yaml/u);
  assert.match(kustomization, /disableNameSuffixHash: true/u);
});

test('every sidecar image pins its bases and separates entrypoint from command', () => {
  const dockerfiles = [
    ['kubernetes', kubernetesDockerfile],
    ['cloud-run-native', cloudRunNativeDockerfile],
    ['cloud-run-same-container', cloudRunSupervisorDockerfile],
  ];
  for (const [name, dockerfile] of dockerfiles) {
    assert.match(
      dockerfile,
      /otel\/opentelemetry-collector-contrib:0\.160\.0@sha256:799dc6cf12c96192af37b5bdba804da8c10b3bc563b43cb90c3f3c58d9572ad6/u,
      `${name} must pin the collector index`,
    );
    assert.match(
      dockerfile,
      /busybox:1\.37\.0-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23/u,
      `${name} must pin the runtime index`,
    );
    assert.match(dockerfile, /^USER 10001:10001$/mu, `${name} must run without root`);
    assert.match(
      dockerfile,
      /^ENTRYPOINT \["\/usr\/local\/bin\/entrypoint\.sh"\]$/mu,
      `${name} must enter through entrypoint.sh`,
    );
    assert.match(dockerfile, /^CMD \[[^\n]+\]$/mu, `${name} must declare a separate CMD`);
    assert.match(dockerfile, /https:\/\/github\.com\/ores-otel\/ores\.otel\.log/u);
  }
  assert.match(kubernetesEntrypoint, /^exec "\$collector_binary" "\$@"$/mu);
  assert.match(cloudRunNativeEntrypoint, /^exec "\$collector_binary" "\$@"$/mu);
  assert.match(cloudRunSupervisorEntrypoint, /^trap on_signal HUP INT TERM$/mu);
  assert.match(cloudRunSupervisorEntrypoint, /kill -TERM "\$app_pid"/u);
  assert.match(cloudRunSupervisorEntrypoint, /kill -TERM "\$collector_pid"/u);
  assert.match(cloudRunSupervisorEntrypoint, /\[ "\$status" -ne 0 \] \|\| status=70/u);
});

test('Cloud Run collector is loopback-only, Ores-attributed, authenticated, and TLS-first', () => {
  assert.match(cloudRunConfig, /grpc:\n\s+endpoint: 127\.0\.0\.1:4317/u);
  assert.match(cloudRunConfig, /http:\n\s+endpoint: 127\.0\.0\.1:4318/u);
  assert.doesNotMatch(cloudRunConfig, /endpoint: 0\.0\.0\.0:431[78]/u);
  assert.match(cloudRunConfig, /resourcedetection\/gcp/u);
  assert.match(cloudRunConfig, /ores\.telemetry\.source: https:\/\/github\.com\/ores-otel/u);
  assert.match(cloudRunConfig, /authorization: Bearer \$\{env:ORES_OTEL_UPSTREAM_BEARER_TOKEN\}/u);
  assert.match(cloudRunConfig, /insecure: \$\{env:ORES_OTEL_UPSTREAM_INSECURE\}/u);
  assert.match(cloudRunConfig, /service\.name: ores-otel-sidecar/u);
  for (const field of [
    'http.request.header.authorization',
    'http.request.header.cookie',
    'http.response.header.set-cookie',
    'db.statement',
    'url.query',
    'enduser.id',
  ]) {
    assert.ok(cloudRunConfig.includes(field), `Cloud Run config must redact ${field}`);
  }
});

test('Cloud Run templates distinguish native sidecar and same-container process models', () => {
  assert.match(
    cloudRunNativeService,
    /run\.googleapis\.com\/container-dependencies: '\{"app":\["ores-otel-sidecar"\]\}'/u,
  );
  assert.match(cloudRunNativeService, /name: ores-otel-sidecar/u);
  assert.match(cloudRunNativeService, /path: \/\n\s+port: 13133/u);
  assert.match(cloudRunNativeService, /name: OTEL_EXPORTER_OTLP_ENDPOINT\n\s+value: http:\/\/127\.0\.0\.1:4318/u);
  assert.match(cloudRunNativeService, /secretKeyRef:\n\s+name: ores-otel-upstream-token\n\s+key: latest/u);
  assert.equal((cloudRunSupervisorService.match(/^\s+- name: app$/gmu) ?? []).length, 1);
  assert.doesNotMatch(cloudRunSupervisorService, /container-dependencies/u);
  assert.match(cloudRunSupervisorService, /SUPERVISED_APP_IMAGE_AT_DIGEST/u);
  for (const template of [cloudRunNativeService, cloudRunSupervisorService]) {
    assert.match(template, /run\.googleapis\.com\/cpu-throttling: "false"/u);
    assert.doesNotMatch(template, /gh[pousr]_[A-Za-z0-9]{20,}/u);
  }
});

test('Cloud Run entrypoints fail closed when the authenticated upstream is incomplete', () => {
  const result = spawnSync('/bin/sh', [
    fileURLToPath(new URL('../sidecar/cloud-run/native/entrypoint.sh', import.meta.url)),
    '--config=/etc/ores-otel/config.yaml',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ORES_OTEL_COLLECTOR_BINARY: '/usr/bin/true',
      ORES_OTEL_UPSTREAM_ENDPOINT: 'collector.example.test:4317',
      ORES_OTEL_UPSTREAM_INSECURE: 'false',
    },
  });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /upstream_bearer_token_missing/u);
  assert.equal(credentialPattern.test(result.stderr), false);
});

test('same-container supervisor waits for collector, passes OTLP env, and returns app status', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'ores-otel-supervisor-'));
  const collector = join(fixture, 'collector.sh');
  const application = join(fixture, 'application.sh');
  const wget = join(fixture, 'wget');
  const configPath = join(fixture, 'collector.yaml');
  const evidencePath = join(fixture, 'application.env');
  await writeFile(collector, '#!/bin/sh\ntrap "exit 0" TERM INT HUP\nwhile :; do sleep 1; done\n');
  await writeFile(application, [
    '#!/bin/sh',
    'printf "%s\\n%s\\n" "$OTEL_EXPORTER_OTLP_ENDPOINT" "$OTEL_EXPORTER_OTLP_PROTOCOL" > "$TEST_EVIDENCE_PATH"',
    'exit 7',
    '',
  ].join('\n'));
  await writeFile(wget, '#!/bin/sh\nexit 0\n');
  await writeFile(configPath, 'service: {}\n');
  await Promise.all([collector, application, wget].map(path => chmod(path, 0o755)));

  const child = spawn('/bin/sh', [
    fileURLToPath(new URL('../sidecar/cloud-run/same-container/entrypoint.sh', import.meta.url)),
    application,
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${fixture}:${process.env.PATH ?? ''}`,
      ORES_OTEL_COLLECTOR_BINARY: collector,
      ORES_OTEL_COLLECTOR_CONFIG: configPath,
      ORES_OTEL_HEALTH_URL: 'http://127.0.0.1:13133/',
      ORES_OTEL_READY_ATTEMPTS: '2',
      ORES_OTEL_SHUTDOWN_ATTEMPTS: '1',
      ORES_OTEL_UPSTREAM_ENDPOINT: 'collector.example.test:4317',
      ORES_OTEL_UPSTREAM_BEARER_TOKEN: 'test-only-placeholder',
      ORES_OTEL_UPSTREAM_INSECURE: 'false',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      TEST_EVIDENCE_PATH: evidencePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(status, 7, stderr);
  assert.equal(
    await readFile(evidencePath, 'utf8'),
    'http://127.0.0.1:4318\nhttp/protobuf\n',
  );
  assert.match(stderr, /collector_starting/u);
  assert.match(stderr, /application_starting/u);
  assert.match(stderr, /application_exited/u);
  assert.equal(credentialPattern.test(stderr), false);
});

test('renderer creates one hardened strategic-merge patch per candidate', () => {
  const image = `${catalog.policy.collectorImage.repository}:${catalog.policy.collectorImage.tag}@${catalog.policy.collectorImage.digest}`;
  for (const candidate of catalog.candidates) {
    const result = render('--repository', candidate.repository);
    assert.equal(result.status, 0, `${candidate.repository}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, new RegExp(`name: ${JSON.stringify(candidate.workload.name).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
    assert.ok(result.stdout.includes(`- name: ${JSON.stringify(candidate.workload.container)}`));
    assert.ok(result.stdout.includes(`value: ${JSON.stringify(candidate.adoption.localEndpoint)}`));
    assert.ok(result.stdout.includes(`value: ${JSON.stringify(candidate.current.protocol)}`));
    assert.ok(result.stdout.includes(`image: ${JSON.stringify(image)}`));
    assert.ok(result.stdout.includes('oresoftware/otel-k8s-sidecar@0.1.0'));
    assert.ok(result.stdout.includes(`value: ${JSON.stringify(catalog.policy.upstreamEndpoint)}`));
    for (const hardening of [
      'allowPrivilegeEscalation: false',
      'readOnlyRootFilesystem: true',
      'runAsNonRoot: true',
      'runAsUser: 10001',
      'type: RuntimeDefault',
      '- ALL',
      'memory: 128Mi',
      'name: ores-otel-sidecar-config',
    ]) {
      assert.ok(result.stdout.includes(hardening), `${candidate.repository} patch lacks ${hardening}`);
    }
    assert.equal(credentialPattern.test(result.stdout), false);
  }
});

test('renderer supports explicit non-catalog workloads and rejects unsafe input', () => {
  const custom = render(
    '--repository', 'example-org/example-api',
    '--workload', 'example-api',
    '--container', 'server',
    '--protocol', 'http/protobuf',
    '--upstream', 'collector.observability.svc.cluster.local:4317',
  );
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.stdout, /name: "example-api"/u);
  assert.match(custom.stdout, /value: "http:\/\/127\.0\.0\.1:4318"/u);

  const publicUpstream = render(
    '--repository', 'example-org/example-api',
    '--workload', 'example-api',
    '--container', 'server',
    '--upstream', 'https://collector.example.com:4317',
  );
  assert.notEqual(publicUpstream.status, 0);
  assert.match(publicUpstream.stderr, /in-cluster host:port/u);

  const unknown = render('--repository', 'example-org/not-cataloged');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /--workload/u);
});

test('renderer list and all modes cover the same catalog', () => {
  const list = render('--list');
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.stdout.trim().split('\n').sort(), expectedRepositories);

  const all = render('--all');
  assert.equal(all.status, 0, all.stderr);
  assert.equal((all.stdout.match(/^kind: Deployment$/gmu) ?? []).length, catalog.candidates.length);
});

test('documentation keeps Zed, rollout, and source/runtime boundaries explicit', () => {
  for (const fragment of [
    'zed add oresoftware/otel-k8s-sidecar@=0.1.0',
    'zed install --frozen --install-mode copy --target k8s-sidecar',
    'No registry lock',
    'not a replacement for node-level CRI log collection',
    'live synthetic-signal canary',
    'Source-only or rendered-manifest checks are not deployment proof',
    'zed add oresoftware/otel-cloud-run-sidecar@=0.1.0',
    'There is deliberately no stdout named pipe',
    'claritas-viz/data-viz-server.rs',
  ]) {
    assert.ok(documentation.includes(fragment), `sidecar documentation is missing: ${fragment}`);
  }
  assert.equal(credentialPattern.test(documentation), false);
  for (const fragment of [
    'native/Dockerfile',
    'same-container/Dockerfile',
    'ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]',
    'CMD ["/usr/local/bin/app-server", "serve"]',
    'zed add oresoftware/next-loggers-rust@=0.1.0',
    'Do not pipe application stdout through the collector',
    'within eight seconds',
  ]) {
    assert.ok(cloudRunDocumentation.includes(fragment), `Cloud Run documentation is missing: ${fragment}`);
  }
  assert.equal(credentialPattern.test(cloudRunDocumentation), false);
});
