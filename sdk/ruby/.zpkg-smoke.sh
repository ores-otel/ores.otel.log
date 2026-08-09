#!/bin/sh
set -eu

test -f "$ZED_PKG_TEST_TARGET/.zpkg.toml"
test -f "$ZED_PKG_TEST_TARGET/oresoftware-next-loggers.gemspec"
test -f "$ZED_PKG_TEST_TARGET/lib/oresoftware/next_loggers.rb"
grep -q 'spec.name = "oresoftware-next-loggers"' "$ZED_PKG_TEST_TARGET/oresoftware-next-loggers.gemspec"
