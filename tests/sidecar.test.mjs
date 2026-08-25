import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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

const expectedRepositories = [
  '3FA-app/3fa-backend.rs',
  '3FA-app/3fa-web-server.rs',
  'ORESoftware/mip-solver-node.rs',
  'ORESoftware/tor-server.rs',
  'athlet-o/athleto-app-rs',
  'athlet-o/athleto-backend.rs',
  'benefactor-cc/backend.rs',
  'daedalus-fab/daedalus-api-server.rs',
  'daedalus-fab/daedalus-web-server.rs',
  'daedalus-fab/fabrication-server.rs',
  'quaestor-ledger/quaestor-ledger-server.rs',
  'scintilla-run/gleam-lambda-runner',
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

test('catalog is bounded to 12 unique exact-head Kubernetes candidates', () => {
  assert.equal(catalog.schemaVersion, '1.0.0');
  assert.equal(catalog.policy.minimumCandidates, 7);
  assert.equal(catalog.policy.maximumCandidates, 15);
  assert.equal(catalog.policy.sidecarVersion, '0.1.0');
  assert.equal(catalog.policy.productionMutation, false);
  assert.equal(catalog.candidates.length, 12);
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

test('catalog pins one official multi-architecture collector release', () => {
  const image = catalog.policy.collectorImage;
  assert.equal(image.repository, 'otel/opentelemetry-collector-contrib');
  assert.equal(image.tag, '0.159.0');
  assert.equal(
    image.digest,
    'sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc',
  );
  assert.equal(image.releaseUrl.endsWith('/v0.159.0'), true);
  assert.match(image.publishedAt, /^2026-08-18T/u);
});

test('catalog schema preserves the 7-15 cohort boundary and fails closed', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.candidates.minItems, 7);
  assert.equal(schema.properties.candidates.maxItems, 15);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.candidates.items.additionalProperties, false);
  assert.equal(schema.properties.policy.properties.productionMutation.const, false);
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
});

test('Kustomize base creates one stable, labeled ConfigMap', () => {
  assert.match(kustomization, /kind: Kustomization/u);
  assert.match(kustomization, /name: ores-otel-sidecar-v1/u);
  assert.match(kustomization, /config\.yaml=collector\.yaml/u);
  assert.match(kustomization, /disableNameSuffixHash: true/u);
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
  ]) {
    assert.ok(documentation.includes(fragment), `sidecar documentation is missing: ${fragment}`);
  }
  assert.equal(credentialPattern.test(documentation), false);
});
