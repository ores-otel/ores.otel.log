#!/bin/sh
set -eu

test -f "$ZED_PKG_TEST_TARGET/.zpkg.toml"
test -f "$ZED_PKG_TEST_TARGET/log-record.schema.json"
grep -q '"next-loggers/v1"' "$ZED_PKG_TEST_TARGET/log-record.schema.json"
