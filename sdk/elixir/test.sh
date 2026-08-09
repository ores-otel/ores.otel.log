#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
elixir -r "$root/lib/next_loggers.ex" "$root/test/next_loggers_test.exs"
