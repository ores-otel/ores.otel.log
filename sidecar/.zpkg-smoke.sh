#!/bin/sh
set -eu

root=${ZED_PKG_TEST_TARGET:?ZED_PKG_TEST_TARGET is required}
test -f "$root/.zpkg.toml"
test -f "$root/README.md"
test -f "$root/adoption-candidates.json"
test -f "$root/adoption-candidates.schema.json"
test -f "$root/k8s/base/collector.yaml"
test -f "$root/k8s/base/kustomization.yaml"
test -x "$root/bin/render-patch.mjs"
grep -q 'otel-k8s-sidecar' "$root/README.md"
grep -q 'sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc' "$root/adoption-candidates.json"
