#!/bin/sh
set -eu

test -f "$ZED_PKG_TEST_TARGET/.zpkg.toml"
test -f "$ZED_PKG_TEST_TARGET/pom.xml"
test -f "$ZED_PKG_TEST_TARGET/src/main/java/cloud/oresoftware/nextloggers/NextLoggers.java"
grep -q '<artifactId>next-loggers</artifactId>' "$ZED_PKG_TEST_TARGET/pom.xml"
