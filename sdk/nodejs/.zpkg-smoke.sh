#!/bin/sh
set -eu

test -f "$ZED_PKG_TEST_TARGET/.zpkg.toml"
test -f "$ZED_PKG_TEST_TARGET/package.json"
test -f "$ZED_PKG_TEST_TARGET/dist/base-logger.js"
test -x "$ZED_PKG_TEST_TARGET/dist/cli/main.js"
grep -q '"name": "@oresoftware/next-loggers"' "$ZED_PKG_TEST_TARGET/package.json"
