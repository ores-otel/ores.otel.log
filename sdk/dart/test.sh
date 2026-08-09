#!/usr/bin/env sh
set -eu
dart pub get
dart analyze
dart test
