# Ores OTEL Kubernetes and Cloud Run sidecars

`oresoftware/otel-k8s-sidecar` is an opt-in Zed package target containing a
hardened OpenTelemetry Collector sidecar configuration, a reproducible
Dockerfile, a Kustomize ConfigMap base, a deterministic patch renderer, and an
exact-head adoption catalog. `oresoftware/otel-cloud-run-sidecar` adds native
multi-container and same-container Cloud Run layouts.

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
- The collector image is `0.160.0` pinned to the official multi-architecture
  digest `sha256:799dc6cf12c96192af37b5bdba804da8c10b3bc563b43cb90c3f3c58d9572ad6`.
- `k8s/Dockerfile` has an explicit `entrypoint.sh` `ENTRYPOINT` and collector
  `CMD`; it adds only a pinned BusyBox runtime around the pinned collector.
- Application signals and collector self-telemetry identify Ores with
  `ores.telemetry.source=https://github.com/ores-otel`.
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

Build the sidecar itself from the installed package rather than treating its
configuration as a loose file:

```sh
docker build \
  --file zed_modules/oresoftware/otel-k8s-sidecar/k8s/Dockerfile \
  --tag ghcr.io/ores-otel/otel-k8s-sidecar:0.1.0 \
  zed_modules/oresoftware/otel-k8s-sidecar
```

The renderer continues to use the pinned upstream collector image until the
Ores wrapper image is published and its immutable digest is recorded. Generated
patches are review artifacts, not permission to deploy an unpinned wrapper.

## Cloud Run

Install the dedicated target when a workload is moving to Cloud Run:

```sh
zed add oresoftware/otel-cloud-run-sidecar@=0.1.0
zed install --frozen --install-mode copy --target cloud-run-sidecar
```

[`cloud-run/README.md`](cloud-run/README.md) covers two supported layouts. The
preferred layout uses Cloud Run's native multi-container model. The fallback
layout runs the collector and application under one shell supervisor, whose
Dockerfile still keeps `ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]` separate
from the application `CMD`. Both layouts keep OTLP on loopback and require an
authenticated TLS upstream.

There is deliberately no stdout named pipe. Applications install the matching
Ores Rust, TypeScript/Node, or Dart SDK through Zed and send typed OTLP locally;
Cloud Run continues to capture stdout/stderr independently. This avoids making
application availability depend on pipe consumers or telemetry backpressure.

## Evidence-backed candidate cohort

The catalog was refreshed against each default branch on 2026-09-04. All 17
repositories had an exact-head Kubernetes workload, a direct remote OTLP
endpoint in the manifest or runtime default, and no pod-local collector. The
five additions deliberately span five more GitHub organizations.

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
| 5 | `sonus-auris/sonus-auris-api-server.rs` | `dd-sound-recorder-rs` | gRPC `:4317` |
| 5 | `akrion-sim/akrion-backend.rs` | `dd-soccer-rs` | HTTP/protobuf `:4318` |
| 5 | `canonical-cloud/canonical-web-server.rs` | `canonical-cloud-web` | gRPC `:4317` |
| 5 | `sagitta-stack/dart-server` | `dd-dart-server` | HTTP/protobuf `:4318` runtime default |
| 5 | `shared-auth/shared-auth-server.rs` | `dd-shared-auth` | HTTP/protobuf `:4318` |

`adoption-candidates.json` records the exact 40-character source ref and
deployment manifest path for every row. Where `ORESoftware/k8s-cluster` is the
deployment authority, the workload also records that repository and its exact
ref instead of pretending the application repo owns the manifest. It is
selection evidence, not an auto-deployment list. Refresh both refs and re-audit
the manifest before opening each consumer PR.

`claritas-viz/data-viz-server.rs` was inspected but is not counted: its current
application and deployment do not emit OTLP, so a collector-only change would
create an empty sidecar. Instrument that service with an Ores SDK first, then
add it in a later cohort.

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
