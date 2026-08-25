#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sidecarRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultCatalogPath = resolve(sidecarRoot, 'adoption-candidates.json');
const kubernetesName = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const upstreamEndpoint = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?:[0-9]{2,5}$/u;

function fail(message) {
  process.stderr.write(`render-patch: ${message}\n`);
  process.exitCode = 2;
}

function parseArguments(argv) {
  const result = { all: false, list: false };
  const valueFlags = new Set([
    '--catalog',
    '--repository',
    '--workload',
    '--container',
    '--kind',
    '--protocol',
    '--upstream',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--all') {
      result.all = true;
      continue;
    }
    if (argument === '--list') {
      result.list = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    if (!valueFlags.has(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    result[argument.slice(2)] = value;
    index += 1;
  }
  return result;
}

function quote(value) {
  return JSON.stringify(String(value));
}

function validateInput(input) {
  if (!repositoryName.test(input.repository ?? '')) {
    throw new Error('--repository must use owner/name');
  }
  if (!kubernetesName.test(input.workload ?? '') || input.workload.length > 253) {
    throw new Error('--workload must be a Kubernetes DNS name');
  }
  if (!kubernetesName.test(input.container ?? '') || input.container.length > 253) {
    throw new Error('--container must be a Kubernetes container name');
  }
  if (!['Deployment', 'StatefulSet'].includes(input.kind)) {
    throw new Error('--kind must be Deployment or StatefulSet');
  }
  if (!['grpc', 'http/protobuf'].includes(input.protocol)) {
    throw new Error('--protocol must be grpc or http/protobuf');
  }
  if (!upstreamEndpoint.test(input.upstream ?? '')) {
    throw new Error('--upstream must be an unencrypted in-cluster host:port endpoint');
  }
}

function renderPatch(input, catalog) {
  validateInput(input);
  const image = [
    catalog.policy.collectorImage.repository,
    ':',
    catalog.policy.collectorImage.tag,
    '@',
    catalog.policy.collectorImage.digest,
  ].join('');
  const localEndpoint = input.protocol === 'grpc'
    ? 'http://127.0.0.1:4317'
    : 'http://127.0.0.1:4318';

  return `apiVersion: apps/v1
kind: ${input.kind}
metadata:
  name: ${quote(input.workload)}
spec:
  template:
    metadata:
      annotations:
        ores-otel.dev/sidecar-package: ${quote(`${catalog.policy.sidecarPackage}@${catalog.policy.sidecarVersion}`)}
        ores-otel.dev/collector-image: ${quote(image)}
    spec:
      containers:
        - name: ${quote(input.container)}
          env:
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: ${quote(localEndpoint)}
            - name: OTEL_EXPORTER_OTLP_PROTOCOL
              value: ${quote(input.protocol)}
        - name: ores-otel-sidecar
          image: ${quote(image)}
          imagePullPolicy: IfNotPresent
          args:
            - --config=/etc/ores-otel/config.yaml
          env:
            - name: ORES_OTEL_UPSTREAM_ENDPOINT
              value: ${quote(input.upstream)}
            - name: ORES_OTEL_GITHUB_REPOSITORY
              value: ${quote(input.repository)}
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: GOMEMLIMIT
              value: "100MiB"
          ports:
            - name: otlp-grpc
              containerPort: 4317
              protocol: TCP
            - name: otlp-http
              containerPort: 4318
              protocol: TCP
            - name: health
              containerPort: 13133
              protocol: TCP
          startupProbe:
            httpGet:
              path: /
              port: health
            failureThreshold: 30
            periodSeconds: 1
            timeoutSeconds: 1
          readinessProbe:
            httpGet:
              path: /
              port: health
            failureThreshold: 3
            periodSeconds: 10
            timeoutSeconds: 2
          livenessProbe:
            httpGet:
              path: /
              port: health
            failureThreshold: 3
            periodSeconds: 20
            timeoutSeconds: 2
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 128Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            readOnlyRootFilesystem: true
            runAsGroup: 10001
            runAsNonRoot: true
            runAsUser: 10001
            seccompProfile:
              type: RuntimeDefault
          terminationMessagePolicy: FallbackToLogsOnError
          volumeMounts:
            - name: ores-otel-sidecar-config
              mountPath: /etc/ores-otel
              readOnly: true
      volumes:
        - name: ores-otel-sidecar-config
          configMap:
            name: ores-otel-sidecar-v1
            items:
              - key: config.yaml
                path: config.yaml
`;
}

function candidateInput(candidate, catalog) {
  return {
    repository: candidate.repository,
    workload: candidate.workload.name,
    container: candidate.workload.container,
    kind: candidate.workload.kind,
    protocol: candidate.current.protocol,
    upstream: catalog.policy.upstreamEndpoint,
  };
}

function help() {
  return `Render a hardened Ores OTEL strategic-merge patch.

Usage:
  render-patch.mjs --repository OWNER/NAME
  render-patch.mjs --repository OWNER/NAME --workload NAME --container NAME \\
    [--kind Deployment|StatefulSet] [--protocol grpc|http/protobuf] \\
    [--upstream HOST:PORT]
  render-patch.mjs --list
  render-patch.mjs --all

With only --repository, the exact-head adoption catalog supplies workload,
container, protocol, and upstream values. Custom repositories must provide
--workload and --container. Output is YAML on stdout; diagnostics use stderr.
`;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
    return;
  }
  if (options.help) {
    process.stdout.write(help());
    return;
  }

  let catalog;
  try {
    catalog = JSON.parse(await readFile(resolve(options.catalog ?? defaultCatalogPath), 'utf8'));
  } catch (error) {
    fail(`cannot load catalog: ${error.message}`);
    return;
  }

  if (options.list) {
    process.stdout.write(`${catalog.candidates.map(({ repository }) => repository).join('\n')}\n`);
    return;
  }
  if (options.all) {
    const patches = catalog.candidates.map(candidate => renderPatch(candidateInput(candidate, catalog), catalog));
    process.stdout.write(patches.join('---\n'));
    return;
  }

  const candidate = catalog.candidates.find(item => item.repository === options.repository);
  const hasCustomWorkload = Boolean(options.workload || options.container || options.kind || options.protocol || options.upstream);
  let input;
  if (candidate && !hasCustomWorkload) {
    input = candidateInput(candidate, catalog);
  } else {
    input = {
      repository: options.repository,
      workload: options.workload,
      container: options.container,
      kind: options.kind ?? 'Deployment',
      protocol: options.protocol ?? 'grpc',
      upstream: options.upstream ?? catalog.policy.upstreamEndpoint,
    };
  }

  try {
    process.stdout.write(renderPatch(input, catalog));
  } catch (error) {
    fail(error.message);
  }
}

await main();
