#!/bin/sh
set -eu

test -f "$ZED_PKG_TEST_TARGET/.zpkg.toml"
test -f "$ZED_PKG_TEST_TARGET/pyproject.toml"
test -f "$ZED_PKG_TEST_TARGET/src/next_loggers/__init__.py"
grep -q 'name = "oresoftware-next-loggers"' "$ZED_PKG_TEST_TARGET/pyproject.toml"
