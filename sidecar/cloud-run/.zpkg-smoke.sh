#!/bin/sh
set -eu

root=${ZED_PKG_TEST_TARGET:?ZED_PKG_TEST_TARGET is required}
test -f "$root/.zpkg.toml"
test -f "$root/README.md"
test -f "$root/collector.yaml"
test -f "$root/native/Dockerfile"
test -x "$root/native/entrypoint.sh"
test -f "$root/same-container/Dockerfile"
test -x "$root/same-container/entrypoint.sh"
test -f "$root/service.native.yaml"
test -f "$root/service.same-container.yaml"
grep -q 'ENTRYPOINT \["/usr/local/bin/entrypoint.sh"\]' "$root/native/Dockerfile"
grep -q 'ENTRYPOINT \["/usr/local/bin/entrypoint.sh"\]' "$root/same-container/Dockerfile"
grep -q 'CMD \[' "$root/native/Dockerfile"
grep -q 'CMD \[' "$root/same-container/Dockerfile"
grep -q 'https://github.com/ores-otel' "$root/collector.yaml"
