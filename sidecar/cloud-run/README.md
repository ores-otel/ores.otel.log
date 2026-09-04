# Ores OTEL on Cloud Run

This Zed package target supports both Cloud Run process layouts without
changing the Ores telemetry contract:

1. `native/Dockerfile` builds a standalone collector for Cloud Run's native
   multi-container sidecar model.
2. `same-container/Dockerfile` builds a supervisor layer for services that must
   place the collector and application in one container.

Both Dockerfiles set `ENTRYPOINT` to an `entrypoint.sh` file and keep `CMD`
separate. Both receive OTLP only over `127.0.0.1`, add
`ores.telemetry.source=https://github.com/ores-otel`, redact sensitive fields,
and export to an authenticated TLS OTLP/gRPC gateway. The Cloud Run service
identity must receive the upstream bearer token from Secret Manager; never put
that value in an image, manifest, command, or repository.

## Install with Zed

```sh
zed add oresoftware/otel-cloud-run-sidecar@=0.1.0
zed install --frozen --install-mode copy --target cloud-run-sidecar
```

Build the two images from the installed target:

```sh
docker build \
  --file zed_modules/oresoftware/otel-cloud-run-sidecar/native/Dockerfile \
  --tag ghcr.io/ores-otel/otel-cloud-run-sidecar:0.1.0 \
  zed_modules/oresoftware/otel-cloud-run-sidecar

docker build \
  --file zed_modules/oresoftware/otel-cloud-run-sidecar/same-container/Dockerfile \
  --tag ghcr.io/ores-otel/otel-cloud-run-supervisor:0.1.0 \
  zed_modules/oresoftware/otel-cloud-run-sidecar
```

Publish by immutable digest before deployment. The checked-in service files are
templates and deliberately contain `_AT_DIGEST` placeholders so an unreleased
tag cannot be mistaken for a production image.

## Native multi-container sidecar

Use `service.native.yaml` when the service can use Cloud Run's native sidecar
model. The application is the only ingress container and therefore the only
container that receives `PORT`. It must listen on `0.0.0.0:$PORT`; the collector
must not bind that port. The application depends on the collector's startup
probe, and both containers share the loopback network namespace.

The template disables CPU throttling because a collector must be able to flush
queued telemetry between requests. If the service intentionally uses
request-based billing, remove that annotation only after proving that delayed
metrics and shutdown flush behavior are acceptable.

## Same-container supervisor

Use `service.same-container.yaml` only when one image is required. Derive the
application image from the supervisor image for a statically linked executable:

```dockerfile
FROM ghcr.io/ores-otel/otel-cloud-run-supervisor@sha256:RELEASE_DIGEST
COPY --chmod=0555 target/app-server /usr/local/bin/app-server
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/local/bin/app-server", "serve"]
```

For dynamically linked Rust, Dart, or TypeScript runtimes, copy
`otelcol-contrib`, `collector.yaml`, `entrypoint.sh`, and a POSIX `sh` plus
`wget` into the application's normal runtime image instead. Keep the final
Dockerfile's entrypoint and command in the same explicit form.

The supervisor starts the collector, waits for its loopback health endpoint,
then starts the application. If either child exits unexpectedly it terminates
the other. It forwards shutdown, gives both children at most eight seconds,
and exits before Cloud Run's ten-second termination deadline.

Do not pipe application stdout through the collector. A named pipe couples
application availability to log backpressure, loses the typed log/metric/trace
contract, and competes with Cloud Run's native stdout capture. Instead install
the matching Ores SDK through Zed and send OTLP to the local collector:

```sh
zed add oresoftware/next-loggers-rust@=0.1.0
zed install --frozen --install-mode copy --target rust
```

The same pattern applies to the `nodejs` and `dart` Zed targets. The application
owns provider initialization and shutdown; the supervisor only owns process
lifecycle and collector transport.

## Required runtime configuration

- `ORES_OTEL_UPSTREAM_ENDPOINT`: TLS OTLP/gRPC `host:port` for the Ores gateway.
- `ORES_OTEL_UPSTREAM_BEARER_TOKEN`: secret bearer credential; required.
- `ORES_OTEL_UPSTREAM_INSECURE`: `false` by default. `true` is for an explicitly
  isolated development path, never a public endpoint.
- `OTEL_EXPORTER_OTLP_ENDPOINT`: defaults to `http://127.0.0.1:4318` in the
  same-container image and is set on the app in the native template.
- `OTEL_EXPORTER_OTLP_PROTOCOL`: defaults to `http/protobuf`.

Cloud Run-to-cluster traffic still needs a real network route. Use Direct VPC
egress or a private/authenticated gateway for the AWS or Hetzner cluster; TLS
plus a bearer token is necessary but does not create the route.

## Acceptance gates

1. Replace every image and endpoint placeholder and deploy one canary revision.
2. Prove only the application listens on `0.0.0.0:$PORT`; OTLP remains loopback.
3. Send a synthetic Ores log, metric, and trace and verify all three upstream.
4. Verify the Ores resource attributes and forbidden-field redaction.
5. Stop the upstream briefly, restore it, and prove bounded queue recovery.
6. Send `SIGTERM`; prove application/provider flush and collector exit complete
   within eight seconds.
7. Record Cloud Run revision, immutable image digests, hosted checks, and the
   live canary evidence in the owning Linear issue.
