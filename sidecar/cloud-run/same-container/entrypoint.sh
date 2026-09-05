#!/bin/sh
set -u

collector_binary=${ORES_OTEL_COLLECTOR_BINARY:-/usr/local/bin/otelcol-contrib}
collector_config=${ORES_OTEL_COLLECTOR_CONFIG:-/etc/ores-otel/config.yaml}
health_url=${ORES_OTEL_HEALTH_URL:-http://127.0.0.1:13133/}
ready_attempts=${ORES_OTEL_READY_ATTEMPTS:-100}
shutdown_attempts=${ORES_OTEL_SHUTDOWN_ATTEMPTS:-8}
collector_pid=
app_pid=
signal_received=false

log_event() {
  severity=$1
  event=$2
  printf '%s\n' "{\"severity\":\"$severity\",\"service.name\":\"ores-otel-sidecar\",\"ores.telemetry.source\":\"https://github.com/ores-otel\",\"event\":\"$event\",\"runtime\":\"cloud-run-same-container\"}" >&2
}

fail() {
  log_event ERROR "$1"
  exit "$2"
}

bounded_positive_integer() {
  value=$1
  maximum=$2
  case $value in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$value" -ge 1 ] && [ "$value" -le "$maximum" ]
}

terminate_children() {
  [ -z "$app_pid" ] || kill -TERM "$app_pid" 2>/dev/null || true
  [ -z "$collector_pid" ] || kill -TERM "$collector_pid" 2>/dev/null || true
}

# ShellCheck does not model trap-dispatched function calls.
# shellcheck disable=SC2317,SC2329
on_signal() {
  signal_received=true
  log_event INFO shutdown_requested
  terminate_children
}

trap on_signal HUP INT TERM

[ -x "$collector_binary" ] || fail collector_binary_not_executable 66
[ -r "$collector_config" ] || fail collector_config_not_readable 66
[ "$#" -gt 0 ] || fail application_command_missing 64
[ -n "${ORES_OTEL_UPSTREAM_ENDPOINT:-}" ] || fail upstream_endpoint_missing 78
[ -n "${ORES_OTEL_UPSTREAM_BEARER_TOKEN:-}" ] || fail upstream_bearer_token_missing 78
bounded_positive_integer "$ready_attempts" 600 || fail ready_attempts_invalid 78
bounded_positive_integer "$shutdown_attempts" 9 || fail shutdown_attempts_invalid 78

case ${ORES_OTEL_UPSTREAM_INSECURE:-false} in
  true|false) ;;
  *) fail upstream_insecure_not_boolean 78 ;;
esac

case $health_url in
  http://127.0.0.1:*/*) ;;
  *) fail health_url_must_be_loopback 78 ;;
esac

log_event INFO collector_starting
"$collector_binary" "--config=$collector_config" &
collector_pid=$!

attempt=0
while [ "$attempt" -lt "$ready_attempts" ]; do
  if ! kill -0 "$collector_pid" 2>/dev/null; then
    wait "$collector_pid"
    status=$?
    log_event ERROR collector_exited_before_ready
    [ "$status" -ne 0 ] || status=70
    exit "$status"
  fi
  if wget -q -T 1 -O /dev/null "$health_url" 2>/dev/null; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done

if [ "$attempt" -ge "$ready_attempts" ]; then
  log_event ERROR collector_readiness_timeout
  terminate_children
  wait "$collector_pid" 2>/dev/null || true
  exit 70
fi

log_event INFO application_starting
"$@" &
app_pid=$!

while kill -0 "$collector_pid" 2>/dev/null && kill -0 "$app_pid" 2>/dev/null; do
  sleep 0.2
done

if [ "$signal_received" = true ]; then
  terminate_children
  attempt=0
  while [ "$attempt" -lt "$shutdown_attempts" ] &&
        { kill -0 "$collector_pid" 2>/dev/null || kill -0 "$app_pid" 2>/dev/null; }; do
    attempt=$((attempt + 1))
    sleep 1
  done
  kill -KILL "$app_pid" 2>/dev/null || true
  kill -KILL "$collector_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  wait "$collector_pid" 2>/dev/null || true
  log_event INFO shutdown_complete
  exit 143
fi

if ! kill -0 "$app_pid" 2>/dev/null; then
  wait "$app_pid"
  app_status=$?
  log_event INFO application_exited
  kill -TERM "$collector_pid" 2>/dev/null || true
  wait "$collector_pid" 2>/dev/null || true
  exit "$app_status"
fi

wait "$collector_pid"
collector_status=$?
log_event ERROR collector_exited_while_application_running
kill -TERM "$app_pid" 2>/dev/null || true
wait "$app_pid" 2>/dev/null || true
[ "$collector_status" -ne 0 ] || collector_status=70
exit "$collector_status"
