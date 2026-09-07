#!/usr/bin/env bash
set -euo pipefail
image=${1:?usage: smoke.sh IMAGE}
work=$(mktemp -d)
container=
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  rm -rf -- "$work"
}
trap cleanup EXIT
flags=(--read-only --network none --cap-drop ALL --security-opt no-new-privileges)
docker run --rm "${flags[@]}" "$image" 'two words' '' '*' >"$work/stdout" 2>"$work/stderr"
grep -qx 'pid=1' "$work/stdout"
grep -qx 'uid=65532' "$work/stdout"
grep -qx 'gid=65532' "$work/stdout"
grep -qx 'shell=false' "$work/stdout"
grep -qx 'arg0=74776f20776f726473' "$work/stdout"
grep -qx 'arg1=' "$work/stdout"
grep -qx 'arg2=2a' "$work/stdout"
jq -e -s 'length == 1 and .[0].schema == "next-loggers/v1" and .[0].fields["process.pid"] == 1 and .[0].fields["event.name"] == "process.exec.attempt"' "$work/stderr"
set +e
docker run --rm "${flags[@]}" -e ORES_LAUNCHER_TEST_EXIT=42 "$image" >"$work/exit-out" 2>"$work/exit-err"
code=$?
set -e
test "$code" = 42
set +e
docker run --rm "${flags[@]}" --entrypoint /ores-launcher "$image" >"$work/missing-out" 2>"$work/missing-err"
code=$?
set -e
test "$code" = 64
container=$(docker run -d "${flags[@]}" -e ORES_LAUNCHER_TEST_MODE=wait "$image")
ready=false
for ((attempt=0; attempt<100; attempt++)); do
  if docker logs "$container" 2>/dev/null | grep -qx ready; then ready=true; break; fi
  sleep 0.1
done
test "$ready" = true
docker stop --time 5 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 42
printf '%s\n' 'PASS: distroless PID 1, nonroot, literal argv, ores-otel JSON, exit status and SIGTERM'
