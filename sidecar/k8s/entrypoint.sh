#!/bin/sh
set -eu

collector_binary=${ORES_OTEL_COLLECTOR_BINARY:-/usr/local/bin/otelcol-contrib}

if [ ! -x "$collector_binary" ]; then
  printf '%s\n' '{"severity":"ERROR","service.name":"ores-otel-sidecar","ores.telemetry.source":"https://github.com/ores-otel","event":"collector_binary_not_executable"}' >&2
  exit 66
fi

if [ "$#" -eq 0 ]; then
  printf '%s\n' '{"severity":"ERROR","service.name":"ores-otel-sidecar","ores.telemetry.source":"https://github.com/ores-otel","event":"collector_command_missing"}' >&2
  exit 64
fi

printf '%s\n' '{"severity":"INFO","service.name":"ores-otel-sidecar","ores.telemetry.source":"https://github.com/ores-otel","event":"collector_starting","runtime":"kubernetes"}' >&2
exec "$collector_binary" "$@"
