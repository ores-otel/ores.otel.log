#!/bin/sh
set -eu

test -f "$ZED_PKG_TEST_TARGET/.zpkg.toml"
test -f "$ZED_PKG_TEST_TARGET/mix.exs"
test -f "$ZED_PKG_TEST_TARGET/lib/next_loggers.ex"
grep -q '@version "0.1.0"' "$ZED_PKG_TEST_TARGET/mix.exs"
