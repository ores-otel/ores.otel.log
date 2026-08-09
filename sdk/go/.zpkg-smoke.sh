#!/bin/sh
set -eu

test -f "$ZED_PKG_TEST_TARGET/.zpkg.toml"
test -f "$ZED_PKG_TEST_TARGET/go.mod"
test -f "$ZED_PKG_TEST_TARGET/logger.go"
grep -q '^module github.com/ORESoftware/next-loggers.ts/sdk/go$' "$ZED_PKG_TEST_TARGET/go.mod"
