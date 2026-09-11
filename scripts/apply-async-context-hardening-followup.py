#!/usr/bin/env python3
"""Apply follow-up repairs discovered by the fail-closed hardening run.

This script runs after apply-async-context-hardening.py.  It is independently
idempotent so the verification step can execute it again without asking the
original generator to recreate files that this follow-up intentionally refines.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one source fragment, found {count}")
    target.write_text(text.replace(old, new, 1))


# A zero-value Go context has nil maps. MergeLogContexts must allocate only the
# maps it is about to populate; otherwise a perfectly valid first scope panics.
replace_once(
    "sdk/go/context.go",
    """\tfor key, value := range patch.LoggedInUser {\n\t\tmerged.LoggedInUser[key] = cloneValue(value)\n\t}\n""",
    """\tif merged.LoggedInUser == nil && len(patch.LoggedInUser) > 0 {\n\t\tmerged.LoggedInUser = make(map[string]any, len(patch.LoggedInUser))\n\t}\n\tfor key, value := range patch.LoggedInUser {\n\t\tmerged.LoggedInUser[key] = cloneValue(value)\n\t}\n""",
)
replace_once(
    "sdk/go/context.go",
    """\tfor key, value := range patch.Fields {\n\t\tmerged.Fields[key] = cloneValue(value)\n\t}\n""",
    """\tif merged.Fields == nil && len(patch.Fields) > 0 {\n\t\tmerged.Fields = make(map[string]any, len(patch.Fields))\n\t}\n\tfor key, value := range patch.Fields {\n\t\tmerged.Fields[key] = cloneValue(value)\n\t}\n""",
)

# Java has Runnable and Callable wrappers by design. Cast value-returning
# lambdas in the adversarial test so javac proves the intended overload rather
# than relying on target-type inference at the nested submit call.
replace_once(
    "sdk/java/src/test/java/com/oresoftware/nextloggers/NextLoggersContextExecutorTest.java",
    """  private static void nestedValuesAreDeeplyImmutable() {\n""",
    """  @SuppressWarnings(\"unchecked\")\n  private static void nestedValuesAreDeeplyImmutable() {\n""",
)
replace_once(
    "sdk/java/src/test/java/com/oresoftware/nextloggers/NextLoggersContextExecutorTest.java",
    """        first = executor.submit(NextLoggers.wrapContext(\n            () -> NextLoggers.currentContext().traceId()));\n""",
    """        first = executor.submit(NextLoggers.wrapContext(\n            (java.util.concurrent.Callable<String>)\n                () -> NextLoggers.currentContext().traceId()));\n""",
)
replace_once(
    "sdk/java/src/test/java/com/oresoftware/nextloggers/NextLoggersContextExecutorTest.java",
    """        second = executor.submit(NextLoggers.wrapContext(\n            () -> NextLoggers.currentContext().traceId()));\n""",
    """        second = executor.submit(NextLoggers.wrapContext(\n            (java.util.concurrent.Callable<String>)\n                () -> NextLoggers.currentContext().traceId()));\n""",
)
replace_once(
    "sdk/java/src/test/java/com/oresoftware/nextloggers/NextLoggersContextExecutorTest.java",
    """      java.util.concurrent.Callable<Boolean> capturedAbsence = NextLoggers.wrapContext(\n          () -> NextLoggers.currentContext() == null);\n""",
    """      java.util.concurrent.Callable<Boolean> capturedAbsence = NextLoggers.wrapContext(\n          (java.util.concurrent.Callable<Boolean>)\n              () -> NextLoggers.currentContext() == null);\n""",
)

print("async-context follow-up repairs applied")
