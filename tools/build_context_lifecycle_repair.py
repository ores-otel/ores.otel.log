#!/usr/bin/env python3
"""Apply the narrow source repairs identified by the polyglot CI audit."""

from __future__ import annotations

from pathlib import Path
import re


def repair_go() -> None:
    path = Path("sdk/go/context_test.go")
    text = path.read_text()
    old = '''\tif value, exists := transport.Records[0].Fields["otel.trace_flags"]; !exists || value != byte(0) {
\t\tt.Fatalf("explicit zero trace flags missing from record: %#v", transport.Records[0].Fields)
\t}
'''
    new = '''\tvalue, exists := transport.Records[0].Fields["otel.trace_flags"]
\ttraceFlags, numeric := value.(float64)
\tif !exists || !numeric || traceFlags != 0 {
\t\tt.Fatalf("explicit zero trace flags missing from record: %#v", transport.Records[0].Fields)
\t}
'''
    if old in text:
        path.write_text(text.replace(old, new, 1))
        return
    if new not in text:
        raise RuntimeError("Go trace-flags assertion is not in an expected state")


def repair_dart() -> None:
    path = Path("sdk/dart/lib/next_loggers.dart")
    text = path.read_text()

    text = re.sub(
        r"(?m)^(\s*)await transport\.flush\(\);$",
        r"\1final flushable = transport as FlushableLogTransport;\n\1await flushable.flush();",
        text,
    )
    text = re.sub(
        r"(?m)^(\s*)await transport\.flushOnExit\(([^\n]*)\);$",
        r"\1final exitFlushable = transport as ExitFlushableLogTransport;\n\1await exitFlushable.flushOnExit(\2);",
        text,
    )
    text = re.sub(
        r"(?m)^(\s*)await transport\.close\(\);$",
        r"\1final closable = transport as ClosableLogTransport;\n\1await closable.close();",
        text,
    )

    flush_repaired = (
        "final flushable = transport as FlushableLogTransport;" in text
        or "transport as FlushableLogTransport).flush()" in text
    )
    exit_repaired = (
        "final exitFlushable = transport as ExitFlushableLogTransport;" in text
        or (
            "transport as ExitFlushableLogTransport" in text
            and ".flushOnExit(" in text
        )
    )
    close_repaired = (
        "final closable = transport as ClosableLogTransport;" in text
        or "transport as ClosableLogTransport).close()" in text
    )

    if not flush_repaired:
        raise RuntimeError("Dart flush dispatch is not in an expected repaired state")
    if not exit_repaired:
        raise RuntimeError("Dart exit-flush dispatch is not in an expected repaired state")
    if not close_repaired:
        raise RuntimeError("Dart close dispatch is not in an expected repaired state")

    path.write_text(text)


def main() -> None:
    repair_go()
    repair_dart()


if __name__ == "__main__":
    main()
