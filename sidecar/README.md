# Ores OTEL Kubernetes sidecar

`oresoftware/otel-k8s-sidecar` is an opt-in Zed package target containing a
hardened OpenTelemetry Collector sidecar configuration, a Kustomize ConfigMap
base, a deterministic patch renderer, and an exact-head adoption catalog.

The sidecar accepts OTLP logs, metrics, and traces over `127.0.0.1:4317` and
`127.0.0.1:4318`. It adds pod, namespace, node, and GitHub-repository resource
attributes; removes common authorization, cookie, query-string, end-user, and
database-statement fields; applies bounded memory, batching, queueing, and
retry; and forwards all three signals to one explicit OTLP/gRPC gateway.

## Why a sidecar here

The selected workloads already export directly to a remote cluster collector.
A pod-local collector gives applications a stable loopback endpoint, centralizes
redaction and resource enrichment, and absorbs short collector/network outages
without embedding queue/retry policy in every language SDK. It also keeps
OpenTelemetry provider ownership in the application: the sidecar transports
signals but does not monkey-patch or initialize application runtimes.

This is not a replacement for node-level CRI log collection. The sidecar only
receives logs emitted through OTLP. Reading `/var/log/containers` from every pod
would require broad host mounts and would duplicate promtail/Fluent Bit/Loki
collection, so this package deliberately does not do that.

## Security and reliability contract

- OTLP receivers bind to pod-local loopback, not `0.0.0.0`.
- Kubelet health binds separately on port `13133`; no Service is created.
- The collector image is `0.159.0` pinned to the official multi-architecture
  digest `sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc`.
- The container runs as UID/GID `10001`, read-only, without privilege
  escalation or Linux capabilities, under `RuntimeDefault` seccomp.
- Memory is limited to `128Mi`; the collector limiter uses `96Mi`, with a
  bounded 2,048-item sending queue and a five-minute retry horizon.
- Authorization, cookies, response cookies, URL queries, end-user IDs, and
  database statements are deleted before export. Applications must still avoid
  putting secrets or high-cardinality identifiers in telemetry.
- Upstream transport is intentionally plain OTLP/gRPC only for an in-cluster
  service DNS name. Cross-cluster or public export requires TLS and a separate,
  reviewed configuration; do not pass an `http://` URL to the renderer.
- Adoption patches are generated but not enabled by this source PR. Each
  workload requires a small review branch, CI render check, resource observation,
  and a live synthetic-signal canary before rollout completion.

## Zed package workflow

After an immutable release exists, consumers add and install the sidecar through
Zed rather than copying this directory or hand-authoring a lock:

```sh
zed add oresoftware/otel-k8s-sidecar@=0.1.0
zed install --frozen --install-mode copy --target k8s-sidecar
```

As observed on 2026-08-25, `https://registry.zpkg.net` returned HTTP 502 while
resolving the existing `ores-otel/ores-interfaces` dependency. No registry lock
was fabricated. This repository's CI instead seeds the reviewed interface
package into an isolated `file://` registry and exercises `zed pack` plus `zed
r2g`; public consumer installation remains a release gate until the registry is
healthy and the new target is published immutably.

From an installed package, render a cataloged workload patch:

```sh
node zed_modules/oresoftware/otel-k8s-sidecar/bin/render-patch.mjs \
  --repository 3FA-app/3fa-backend.rs \
  > deploy/k8s/ores-otel-sidecar.patch.yaml
```

Or render a workload not yet in the catalog:

```sh
node zed_modules/oresoftware/otel-k8s-sidecar/bin/render-patch.mjs \
  --repository example-org/example-api \
  --workload example-api \
  --container server \
  --protocol http/protobuf \
  --upstream dd-otel-collector.observability.svc.cluster.local:4317 \
  > deploy/k8s/ores-otel-sidecar.patch.yaml
```

Reference the ConfigMap base and generated strategic-merge patch from the
consumer's Kustomization:

```yaml
resources:
  - ../../zed_modules/oresoftware/otel-k8s-sidecar/k8s/base

patches:
  - path: ores-otel-sidecar.patch.yaml
```

The generated patch changes only the named application's OTLP endpoint/protocol,
adds the `ores-otel-sidecar` container, and merges the sidecar ConfigMap volume.
Review the rendered diff; if the workload has more than one application
container, render or hand-review one explicit patch per emitting container.

## Evidence-backed candidate cohort

The catalog was refreshed against each default branch on 2026-08-25. All 12
repositories had an exact-head Kubernetes workload, a direct remote OTLP
endpoint, and no pod-local collector in that manifest.

| Wave | Repository | Workload | Current OTLP |
| ---: | --- | --- | --- |
| 1 | `3FA-app/3fa-backend.rs` | `threefa-sync-server` | HTTP/protobuf `:4318` |
| 1 | `3FA-app/3fa-web-server.rs` | `dd-threefa-web-server` | HTTP/protobuf `:4318` |
| 2 | `athlet-o/athleto-app-rs` | `athleto-app-rs` | gRPC `:4317` |
| 2 | `athlet-o/athleto-backend.rs` | `dd-athleto-backend` | gRPC `:4317` |
| 2 | `daedalus-fab/daedalus-api-server.rs` | `daedalus-api-server` | HTTP/protobuf `:4318` |
| 2 | `daedalus-fab/daedalus-web-server.rs` | `daedalus-web-server` | HTTP/protobuf `:4318` |
| 3 | `benefactor-cc/backend.rs` | `benefactor-backend-rs` | gRPC `:4317` |
| 3 | `quaestor-ledger/quaestor-ledger-server.rs` | `dd-billing-server-candidate` | HTTP/protobuf `:4318` |
| 3 | `daedalus-fab/fabrication-server.rs` | `dd-fabrication-server` | HTTP/protobuf `:4318` |
| 4 | `scintilla-run/gleam-lambda-runner` | `dd-gleam-lambda-runner` | gRPC `:4317` |
| 4 | `ORESoftware/mip-solver-node.rs` | `dd-in-house-mip-solver-node-master` | gRPC `:4317` |
| 4 | `ORESoftware/tor-server.rs` | `tor-client` | gRPC `:4317` |

`adoption-candidates.json` records the exact 40-character ref and source
manifest path for every row. It is selection evidence, not an auto-deployment
list. Refresh the ref and re-audit the manifest before opening each consumer PR.

## Per-workload acceptance

1. Render the base plus patch and validate it against the target cluster's
   Kubernetes version and admission policies.
2. Confirm the existing NetworkPolicy permits the pod to reach the upstream on
   TCP `4317`; keep OTLP receiver ports unexposed by a Service.
3. Roll out one replica and wait for both application and sidecar readiness.
4. Emit uniquely identified synthetic log, metric, and trace signals; prove all
   three arrive upstream with the expected resource attributes and no forbidden
   fields.
5. Interrupt upstream connectivity long enough to exercise retry/queue behavior,
   restore it, and prove bounded recovery without application unavailability.
6. Observe sidecar CPU, RSS, dropped/refused telemetry, queue size, export
   failures, and application latency before expanding the rollout.
7. Keep the consumer issue open until hosted CI and a deployed canary are both
   evidenced. Source-only or rendered-manifest checks are not deployment proof.
