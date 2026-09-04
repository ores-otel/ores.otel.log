ARG COLLECTOR_IMAGE=otel/opentelemetry-collector-contrib:0.160.0@sha256:799dc6cf12c96192af37b5bdba804da8c10b3bc563b43cb90c3f3c58d9572ad6
ARG RUNTIME_IMAGE=busybox:1.37.0-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23

FROM ${COLLECTOR_IMAGE} AS collector
FROM ${RUNTIME_IMAGE}

LABEL org.opencontainers.image.source="https://github.com/ores-otel/ores.otel.log" \
      org.opencontainers.image.title="Ores OTEL Cloud Run supervisor" \
      org.opencontainers.image.description="Collector and application supervisor for one-container Cloud Run services"

COPY --from=collector /otelcol-contrib /usr/local/bin/otelcol-contrib
COPY --from=collector /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=0444 collector.yaml /etc/ores-otel/config.yaml
COPY --chmod=0555 same-container/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chmod=0555 same-container/app-required.sh /usr/local/bin/ores-otel-app-required

ENV HOME=/tmp \
    ORES_OTEL_COLLECTOR_CONFIG=/etc/ores-otel/config.yaml \
    ORES_OTEL_UPSTREAM_INSECURE=false \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/local/bin/ores-otel-app-required"]
