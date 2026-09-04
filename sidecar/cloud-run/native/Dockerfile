ARG COLLECTOR_IMAGE=otel/opentelemetry-collector-contrib:0.160.0@sha256:799dc6cf12c96192af37b5bdba804da8c10b3bc563b43cb90c3f3c58d9572ad6
ARG RUNTIME_IMAGE=busybox:1.37.0-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23

FROM ${COLLECTOR_IMAGE} AS collector
FROM ${RUNTIME_IMAGE}

LABEL org.opencontainers.image.source="https://github.com/ores-otel/ores.otel.log" \
      org.opencontainers.image.title="Ores OTEL Cloud Run sidecar" \
      org.opencontainers.image.description="Loopback OTLP sidecar for Cloud Run multi-container services"

COPY --from=collector /otelcol-contrib /usr/local/bin/otelcol-contrib
COPY --from=collector /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=0444 collector.yaml /etc/ores-otel/config.yaml
COPY --chmod=0555 native/entrypoint.sh /usr/local/bin/entrypoint.sh

ENV HOME=/tmp \
    ORES_OTEL_UPSTREAM_INSECURE=false

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["--config=/etc/ores-otel/config.yaml"]
