#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d "${TMPDIR:-/tmp}/next-loggers-erlang.XXXXXX")
erlc -Werror -o "$out" \
  "$root/src/next_loggers.erl" \
  "$root/test/next_loggers_tests.erl" \
  "$root/test/next_loggers_adversarial_tests.erl"
erl -noshell -pa "$out" -eval 'case eunit:test([next_loggers_tests, next_loggers_adversarial_tests], [verbose]) of ok -> halt(0); _ -> halt(1) end.'
