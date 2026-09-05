#!/bin/sh
set -eu

root=${ZED_PKG_TEST_TARGET:?ZED_PKG_TEST_TARGET is required}
test -f "$root/.zpkg.toml"
test -f "$root/README.md"
test -f "$root/adoption-candidates.json"
test -f "$root/adoption-candidates.schema.json"
test -f "$root/k8s/base/collector.yaml"
test -f "$root/k8s/base/kustomization.yaml"
test -f "$root/k8s/Dockerfile"
test -x "$root/k8s/entrypoint.sh"
test -f "$root/cloud-run/native/Dockerfile"
test -f "$root/cloud-run/same-container/Dockerfile"
test -x "$root/bin/render-patch.mjs"
grep -q 'otel-k8s-sidecar' "$root/README.md"
grep -q 'sha256:799dc6cf12c96192af37b5bdba804da8c10b3bc563b43cb90c3f3c58d9572ad6' "$root/adoption-candidates.json"
grep -q 'ENTRYPOINT \["/usr/local/bin/entrypoint.sh"\]' "$root/k8s/Dockerfile"
grep -q 'CMD \[' "$root/k8s/Dockerfile"
grep -q 'https://github.com/ores-otel' "$root/k8s/base/collector.yaml"
