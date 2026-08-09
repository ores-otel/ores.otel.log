#!/bin/sh
set -eu

test -f "$ZED_PKG_TEST_TARGET/.zpkg.toml"
test -f "$ZED_PKG_TEST_TARGET/rebar.config"
test -f "$ZED_PKG_TEST_TARGET/src/next_loggers.erl"
test -f "$ZED_PKG_TEST_TARGET/src/oresoftware_next_loggers_erlang.app.src"
