#!/bin/sh
set -eu

root=${ZED_PKG_TEST_TARGET:?ZED_PKG_TEST_TARGET is required}
test -f "$root/.zpkg.toml"
test -f "$root/package.json"
test -f "$root/sdk/nodejs/package.json"
test -f "$root/sdk/nodejs/dist/base-logger.js"
test -f "$root/sdk/python/pyproject.toml"
test -f "$root/sdk/go/go.mod"
test -f "$root/sdk/rust/Cargo.toml"
test -f "$root/sdk/wasm/Cargo.toml"
test -f "$root/sdk/java/pom.xml"
test -f "$root/sdk/dart/pubspec.yaml"
test -f "$root/sdk/dart/lib/supabase_realtime_transport.dart"
test -f "$root/sdk/ruby/oresoftware-next-loggers.gemspec"
test -f "$root/sdk/gleam/gleam.toml"
test -f "$root/sdk/erlang/rebar.config"
test -f "$root/sdk/elixir/mix.exs"
test -f "$root/sidecar/adoption-candidates.json"
test -f "$root/sidecar/k8s/base/collector.yaml"
test -x "$root/sidecar/bin/render-patch.mjs"
