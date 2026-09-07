# syntax=docker/dockerfile:1
# Test-only image: the standalone probe is not part of consumer service images.
FROM rust:1.90-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --locked --release -p oresoftware-next-loggers --features launcher --bin ores-launcher \
    && rustc --edition=2021 sdk/rust/tests/fixtures/launcher_probe.rs -o /launcher-probe

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/ores-launcher /ores-launcher
COPY --from=build /launcher-probe /launcher-probe
ENV OTEL_SERVICE_NAME=ores-launcher-container-test
USER 65532:65532
ENTRYPOINT ["/ores-launcher", "/launcher-probe"]
CMD []
