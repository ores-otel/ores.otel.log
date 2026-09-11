#!/usr/bin/env python3
"""Apply fail-closed follow-up repairs to the async-context hardening patch.

This script runs after apply-async-context-hardening.py. Every replacement is
exact and idempotent so source drift stops the workflow instead of producing a
partial or conceptually unrelated result.
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


# TypeScript: recursively detach structured values, preserve cycles/shared
# references inside each snapshot, bound work, and never execute accessors.
replace_once(
    "src/context-shared.ts",
    """/**
 * Deeply snapshots JSON-like context values while preserving non-plain host
 * objects by reference. Cycles among arrays/plain objects are retained in the
 * copied graph rather than pointing back into caller-owned state.
 */
export function cloneContextValue<T>(
  value: T,
  seen: WeakMap<object, unknown> = new WeakMap(),
): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return seen.get(object) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(object, copy);
    for (const item of value) copy.push(cloneContextValue(item, seen));
    return copy as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = {};
  seen.set(object, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = cloneContextValue(item, seen);
  }
  return copy as T;
}
""",
    """const CONTEXT_SNAPSHOT_MAX_DEPTH = 64;
const CONTEXT_SNAPSHOT_MAX_NODES = 4096;

interface ContextCloneState {
  readonly seen: WeakMap<object, unknown>;
  nodes: number;
}

function cloneOwnDataProperties(
  source: object,
  target: object,
  state: ContextCloneState,
  depth: number,
): void {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) {
      throw new TypeError('context snapshots do not support accessor properties');
    }
    Object.defineProperty(target, key, {
      ...descriptor,
      value: cloneContextValueInternal(descriptor.value, state, depth + 1),
    });
  }
}

function cloneContextValueInternal<T>(
  value: T,
  state: ContextCloneState,
  depth: number,
): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  const existing = state.seen.get(object);
  if (existing !== undefined || state.seen.has(object)) return existing as T;
  if (depth > CONTEXT_SNAPSHOT_MAX_DEPTH) {
    throw new RangeError(`context snapshot exceeds depth ${CONTEXT_SNAPSHOT_MAX_DEPTH}`);
  }
  state.nodes += 1;
  if (state.nodes > CONTEXT_SNAPSHOT_MAX_NODES) {
    throw new RangeError(`context snapshot exceeds ${CONTEXT_SNAPSHOT_MAX_NODES} objects`);
  }

  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    state.seen.set(object, copy);
    return copy as T;
  }
  if (value instanceof RegExp) {
    const copy = new RegExp(value.source, value.flags);
    copy.lastIndex = value.lastIndex;
    state.seen.set(object, copy);
    return copy as T;
  }
  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    state.seen.set(object, copy);
    return copy as T;
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const buffer = new Uint8Array(bytes).buffer;
    const copy: object = value instanceof DataView
      ? new DataView(buffer)
      : new (value.constructor as unknown as new (input: ArrayBuffer) => object)(buffer);
    state.seen.set(object, copy);
    return copy as T;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    state.seen.set(object, copy);
    for (const [key, item] of value) {
      copy.set(
        cloneContextValueInternal(key, state, depth + 1),
        cloneContextValueInternal(item, state, depth + 1),
      );
    }
    return copy as T;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    state.seen.set(object, copy);
    for (const item of value) {
      copy.add(cloneContextValueInternal(item, state, depth + 1));
    }
    return copy as T;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    state.seen.set(object, copy);
    for (const item of value) {
      copy.push(cloneContextValueInternal(item, state, depth + 1));
    }
    return copy as T;
  }
  if (value instanceof Error) {
    const copy = Object.create(Object.getPrototypeOf(value)) as object;
    state.seen.set(object, copy);
    cloneOwnDataProperties(object, copy, state, depth);
    return copy as T;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = Object.create(prototype) as object;
  state.seen.set(object, copy);
  cloneOwnDataProperties(object, copy, state, depth);
  return copy as T;
}

/**
 * Recursively snapshots structured context values with bounded work. Custom
 * host objects and functions are treated as opaque application-owned handles.
 */
export function cloneContextValue<T>(
  value: T,
  seen: WeakMap<object, unknown> = new WeakMap(),
): T {
  return cloneContextValueInternal(value, { seen, nodes: 0 }, 0);
}
""",
)
replace_once(
    "src/context-shared.ts",
    """export function cloneLogContext(context: LogContext): LogContext {
  return {
    ...context,
    ...(context.loggedInUser === undefined
      ? {}
      : { loggedInUser: cloneContextValue(context.loggedInUser) }),
    ...(context.users === undefined
      ? {}
      : { users: context.users.map((user) => cloneContextValue(user)) }),
    ...(context.fields === undefined
      ? {}
      : { fields: cloneContextValue(context.fields) }),
    ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    ...(context.traceIds === undefined ? {} : { traceIds: [...context.traceIds] }),
    ...(context.routineId === undefined ? {} : { routineId: context.routineId }),
    ...(context.tags === undefined ? {} : { tags: [...context.tags] }),
  };
}
""",
    """export function cloneLogContext(context: LogContext): LogContext {
  return cloneContextValue(context);
}
""",
)
replace_once(
    "src/context-shared.ts",
    """export function mergeLogContext(current: LogContext, patch: LogContext): void {
  if (patch.loggedInUser) {
    current.loggedInUser = { ...current.loggedInUser, ...patch.loggedInUser };
  }
  if (patch.users && patch.users.length > 0) {
    current.users = [...(current.users ?? []), ...patch.users.map((user) => ({ ...user }))];
  }
  if (patch.fields) {
    current.fields = { ...current.fields, ...patch.fields };
  }
  const existingTraces = current.traceIds ?? (current.traceId ? [current.traceId] : []);
  if (patch.traceId) {
    current.traceId = patch.traceId;
    current.traceIds = Array.from(new Set([...existingTraces, patch.traceId]));
  }
  if (patch.traceIds && patch.traceIds.length > 0) {
    current.traceIds = Array.from(
      new Set([...(current.traceIds ?? existingTraces), ...patch.traceIds]),
    );
  }
  if (patch.routineId) {
    current.routineId = patch.routineId;
  }
  if (patch.tags && patch.tags.length > 0) {
    current.tags = Array.from(new Set([...(current.tags ?? []), ...patch.tags]));
  }
}
""",
    """export function mergeLogContext(current: LogContext, patch: LogContext): void {
  const snapshot = cloneLogContext(patch);
  if (snapshot.loggedInUser) {
    current.loggedInUser = cloneContextValue({
      ...current.loggedInUser,
      ...snapshot.loggedInUser,
    });
  }
  if (snapshot.users && snapshot.users.length > 0) {
    current.users = cloneContextValue([...(current.users ?? []), ...snapshot.users]);
  }
  if (snapshot.fields) {
    current.fields = cloneContextValue({ ...current.fields, ...snapshot.fields });
  }
  const existingTraces = current.traceIds ?? (current.traceId ? [current.traceId] : []);
  if (snapshot.traceId) {
    current.traceId = snapshot.traceId;
    current.traceIds = Array.from(new Set([...existingTraces, snapshot.traceId]));
  }
  if (snapshot.traceIds && snapshot.traceIds.length > 0) {
    current.traceIds = Array.from(
      new Set([...(current.traceIds ?? existingTraces), ...snapshot.traceIds]),
    );
  }
  if (snapshot.routineId) {
    current.routineId = snapshot.routineId;
  }
  if (snapshot.tags && snapshot.tags.length > 0) {
    current.tags = Array.from(new Set([...(current.tags ?? []), ...snapshot.tags]));
  }
}
""",
)
replace_once(
    "src/context-shared.ts",
    """  const logContextProvider: LogContextProvider = () => logContextStorage.getStore();
""",
    """  const logContextProvider: LogContextProvider = () => {
    const current = logContextStorage.getStore();
    return current === undefined ? undefined : cloneLogContext(current);
  };
""",
)
replace_once(
    "src/context-shared.ts",
    """    getLogContext: () => logContextStorage.getStore(),
""",
    """    getLogContext: () => {
      const current = logContextStorage.getStore();
      return current === undefined ? undefined : cloneLogContext(current);
    },
""",
)
replace_once(
    "tests/context-deep-snapshot.test.mjs",
    """      cyclic.id = 'attacker';
      assert.equal(getLogContext().fields.cyclic.id, 'cycle');
      assert.equal(getLogContext().fields.cyclic.self, getLogContext().fields.cyclic);
""",
    """      cyclic.id = 'attacker';
      const observed = getLogContext();
      assert.equal(observed.fields.cyclic.id, 'cycle');
      assert.equal(observed.fields.cyclic.self, observed.fields.cyclic);
""",
)

# Go zero-value maps must be allocated only when a merge or OTEL projection
# writes them. The primary patch supplies recursive cloneValue helpers.
replace_once(
    "sdk/go/context.go",
    """\tfor key, value := range patch.LoggedInUser {
\t\tmerged.LoggedInUser[key] = cloneValue(value)
\t}
""",
    """\tif merged.LoggedInUser == nil && len(patch.LoggedInUser) > 0 {
\t\tmerged.LoggedInUser = make(map[string]any, len(patch.LoggedInUser))
\t}
\tfor key, value := range patch.LoggedInUser {
\t\tmerged.LoggedInUser[key] = cloneValue(value)
\t}
""",
)
replace_once(
    "sdk/go/context.go",
    """\tfor key, value := range patch.Fields {
\t\tmerged.Fields[key] = cloneValue(value)
\t}
""",
    """\tif merged.Fields == nil && len(patch.Fields) > 0 {
\t\tmerged.Fields = make(map[string]any, len(patch.Fields))
\t}
\tfor key, value := range patch.Fields {
\t\tmerged.Fields[key] = cloneValue(value)
\t}
""",
)
replace_once(
    "sdk/go/context.go",
    """\tfields := cloneMap(value.Fields)
\tif value.SpanID != "" {
""",
    """\tfields := cloneMap(value.Fields)
\tif fields == nil {
\t\tfields = make(map[string]any)
\t}
\tif value.SpanID != "" {
""",
)

# Java overload resolution must prove the intended Callable contract.
replace_once(
    "sdk/java/src/test/java/com/oresoftware/nextloggers/NextLoggersContextExecutorTest.java",
    """  private static void nestedValuesAreDeeplyImmutable() {
""",
    """  @SuppressWarnings("unchecked")
  private static void nestedValuesAreDeeplyImmutable() {
""",
)
replace_once(
    "sdk/java/src/test/java/com/oresoftware/nextloggers/NextLoggersContextExecutorTest.java",
    """        first = executor.submit(NextLoggers.wrapContext(
            () -> NextLoggers.currentContext().traceId()));
""",
    """        first = executor.submit(NextLoggers.wrapContext(
            (java.util.concurrent.Callable<String>)
                () -> NextLoggers.currentContext().traceId()));
""",
)
replace_once(
    "sdk/java/src/test/java/com/oresoftware/nextloggers/NextLoggersContextExecutorTest.java",
    """        second = executor.submit(NextLoggers.wrapContext(
            () -> NextLoggers.currentContext().traceId()));
""",
    """        second = executor.submit(NextLoggers.wrapContext(
            (java.util.concurrent.Callable<String>)
                () -> NextLoggers.currentContext().traceId()));
""",
)
replace_once(
    "sdk/java/src/test/java/com/oresoftware/nextloggers/NextLoggersContextExecutorTest.java",
    """      java.util.concurrent.Callable<Boolean> capturedAbsence = NextLoggers.wrapContext(
          () -> NextLoggers.currentContext() == null);
""",
    """      java.util.concurrent.Callable<Boolean> capturedAbsence = NextLoggers.wrapContext(
          (java.util.concurrent.Callable<Boolean>)
              () -> NextLoggers.currentContext() == null);
""",
)

print("async-context follow-up repairs applied")
