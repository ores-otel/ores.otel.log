#!/usr/bin/env python3
"""Apply the reviewed Go LogRecord ownership changes exactly once.

Every replacement is fail-closed and idempotent. Source drift aborts rather
than producing a partial transport-isolation patch.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one source fragment, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "sdk/go/logger.go",
    """\ttransport.Records = append(transport.Records, record)
""",
    """\ttransport.Records = append(transport.Records, cloneLogRecord(record))
""",
)

replace_once(
    "sdk/go/logger.go",
    """\ttransport.ExitRecords = append(transport.ExitRecords, records...)
""",
    """\ttransport.ExitRecords = append(transport.ExitRecords, cloneLogRecords(records)...)
""",
)

replace_once(
    "sdk/go/logger.go",
    """\tif event.record != nil {
\t\treturn *event.record
\t}
""",
    """\tif event.record != nil {
\t\treturn cloneLogRecord(*event.record)
\t}
""",
)

replace_once(
    "sdk/go/logger.go",
    """\tevent.record = &record
\treturn record
}
""",
    """\tevent.record = &record
\treturn cloneLogRecord(record)
}
""",
)

replace_once(
    "sdk/go/logger.go",
    """\t\tif err := transport.Write(record); err != nil {
""",
    """\t\tif err := transport.Write(cloneLogRecord(record)); err != nil {
""",
)

replace_once(
    "sdk/go/logger.go",
    """func flushTransportOnExit(ctx context.Context, transport Transport, records []LogRecord) error {
\tif flusher, ok := transport.(ContextExitFlusher); ok {
\t\treturn flusher.FlushOnExitContext(ctx, records)
\t}
\tif flusher, ok := transport.(ExitFlusher); ok {
\t\treturn runBounded(ctx, func() error { return flusher.FlushOnExit(records) })
\t}
\treturn nil
}
""",
    """func flushTransportOnExit(ctx context.Context, transport Transport, records []LogRecord) error {
\tsnapshot := cloneLogRecords(records)
\tif flusher, ok := transport.(ContextExitFlusher); ok {
\t\treturn flusher.FlushOnExitContext(ctx, snapshot)
\t}
\tif flusher, ok := transport.(ExitFlusher); ok {
\t\treturn runBounded(ctx, func() error { return flusher.FlushOnExit(snapshot) })
\t}
\treturn nil
}
""",
)

print("Go record transport isolation applied")
