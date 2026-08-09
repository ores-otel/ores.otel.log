#!/bin/sh
set -eu

test -f "$ZED_PKG_TEST_TARGET/.zpkg.toml"
test -f "$ZED_PKG_TEST_TARGET/gleam.toml"
test -f "$ZED_PKG_TEST_TARGET/src/oresoftware_next_loggers.gleam"
grep -q '^name = "oresoftware_next_loggers"$' "$ZED_PKG_TEST_TARGET/gleam.toml"
