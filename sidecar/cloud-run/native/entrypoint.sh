#!/bin/sh
set -eu

collector_binary=${ORES_OTEL_COLLECTOR_BINARY:-/usr/local/bin/otelcol-contrib}

fail() {
  printf '%s\n' "{\"severity\":\"ERROR\",\"service.name\":\"ores-otel-sidecar\",\"ores.telemetry.source\":\"https://github.com/ores-otel\",\"event\":\"$1\"}" >&2
  exit "$2"
}

[ -x "$collector_binary" ] || fail collector_binary_not_executable 66
[ "$#" -gt 0 ] || fail collector_command_missing 64
[ -n "${ORES_OTEL_UPSTREAM_ENDPOINT:-}" ] || fail upstream_endpoint_missing 78
[ -n "${ORES_OTEL_UPSTREAM_BEARER_TOKEN:-}" ] || fail upstream_bearer_token_missing 78

case ${ORES_OTEL_UPSTREAM_INSECURE:-false} in
  true|false) ;;
  *) fail upstream_insecure_not_boolean 78 ;;
esac

printf '%s\n' '{"severity":"INFO","service.name":"ores-otel-sidecar","ores.telemetry.source":"https://github.com/ores-otel","event":"collector_starting","runtime":"cloud-run-native-sidecar"}' >&2
exec "$collector_binary" "$@"
