#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
out=${1:-}
if [[ -z "$out" ]]; then
  out=$(mktemp -d "${TMPDIR:-/tmp}/next-loggers-java.XXXXXX")
else
  mkdir -p "$out"
fi

find "$root/src/main/java" "$root/src/test/java" -name '*.java' -print0 \
  | xargs -0 javac --release 17 -Werror -Xlint:all -d "$out"
java -ea -cp "$out" cloud.oresoftware.nextloggers.NextLoggersTest
java -ea -cp "$out" cloud.oresoftware.nextloggers.NextLoggersAdversarialTest
java -ea -cp "$out" com.oresoftware.nextloggers.NextLoggersTest
java -ea -cp "$out" com.oresoftware.nextloggers.NextLoggersAdversarialTest
