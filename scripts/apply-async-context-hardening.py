#!/usr/bin/env python3
"""Apply the reviewed async-context hardening patch idempotently.

This script is deliberately exact: every replacement verifies the expected
source fragment before editing so drift fails closed instead of producing a
partial or conceptually unrelated patch.
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


def write_exact(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_text() == content:
        return
    if target.exists():
        raise RuntimeError(f"{path}: refusing to overwrite unexpected existing file")
    target.write_text(content)


# ---------------------------------------------------------------------------
# TypeScript: deep defensive snapshots for JSON-like nested context values.
# ---------------------------------------------------------------------------
replace_once(
    "src/context-shared.ts",
    """export function getGlobalAsyncLocalStorage(): AsyncLocalStorageConstructor | undefined {\n  const candidate = (globalThis as { AsyncLocalStorage?: AsyncLocalStorageConstructor })\n    .AsyncLocalStorage;\n  return typeof candidate === 'function' ? candidate : undefined;\n}\n\n/** Returns an isolated snapshot suitable for queues, callbacks, and detached tasks. */\nexport function cloneLogContext(context: LogContext): LogContext {\n""",
    """export function getGlobalAsyncLocalStorage(): AsyncLocalStorageConstructor | undefined {\n  const candidate = (globalThis as { AsyncLocalStorage?: AsyncLocalStorageConstructor })\n    .AsyncLocalStorage;\n  return typeof candidate === 'function' ? candidate : undefined;\n}\n\n/**\n * Deeply snapshots JSON-like context values while preserving non-plain host\n * objects by reference. Cycles among arrays/plain objects are retained in the\n * copied graph rather than pointing back into caller-owned state.\n */\nexport function cloneContextValue<T>(\n  value: T,\n  seen: WeakMap<object, unknown> = new WeakMap(),\n): T {\n  if (value === null || typeof value !== 'object') return value;\n  const object = value as object;\n  if (seen.has(object)) return seen.get(object) as T;\n  if (value instanceof Date) return new Date(value.getTime()) as T;\n  if (Array.isArray(value)) {\n    const copy: unknown[] = [];\n    seen.set(object, copy);\n    for (const item of value) copy.push(cloneContextValue(item, seen));\n    return copy as T;\n  }\n  const prototype = Object.getPrototypeOf(value);\n  if (prototype !== Object.prototype && prototype !== null) return value;\n  const copy: Record<string, unknown> = {};\n  seen.set(object, copy);\n  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {\n    copy[key] = cloneContextValue(item, seen);\n  }\n  return copy as T;\n}\n\n/** Returns an isolated snapshot suitable for queues, callbacks, and detached tasks. */\nexport function cloneLogContext(context: LogContext): LogContext {\n""",
)
replace_once(
    "src/context-shared.ts",
    """    ...(context.loggedInUser === undefined\n      ? {}\n      : { loggedInUser: { ...context.loggedInUser } }),\n    ...(context.users === undefined\n      ? {}\n      : { users: context.users.map((user) => ({ ...user })) }),\n    ...(context.fields === undefined ? {} : { fields: { ...context.fields } }),\n""",
    """    ...(context.loggedInUser === undefined\n      ? {}\n      : { loggedInUser: cloneContextValue(context.loggedInUser) }),\n    ...(context.users === undefined\n      ? {}\n      : { users: context.users.map((user) => cloneContextValue(user)) }),\n    ...(context.fields === undefined\n      ? {}\n      : { fields: cloneContextValue(context.fields) }),\n""",
)
replace_once(
    "src/execution-context-shared.ts",
    """import type { LogContextApi } from './context-shared.js';\n""",
    """import { cloneContextValue, type LogContextApi } from './context-shared.js';\n""",
)
replace_once(
    "src/execution-context-shared.ts",
    """    ...(context.loggedInUser ? { loggedInUser: { ...context.loggedInUser } } : {}),\n    ...(context.users ? { users: context.users.map((user) => ({ ...user })) } : {}),\n    ...(context.fields ? { fields: { ...context.fields } } : {}),\n    ...(context.traceIds ? { traceIds: [...context.traceIds] } : {}),\n    ...(context.baggage ? { baggage: { ...context.baggage } } : {}),\n    ...(context.tags ? { tags: [...context.tags] } : {}),\n    ...(context.context ? { context: [...context.context] } : {}),\n    ...(context.meta ? { meta: [...context.meta] } : {}),\n""",
    """    ...(context.loggedInUser\n      ? { loggedInUser: cloneContextValue(context.loggedInUser) }\n      : {}),\n    ...(context.users\n      ? { users: context.users.map((user) => cloneContextValue(user)) }\n      : {}),\n    ...(context.fields ? { fields: cloneContextValue(context.fields) } : {}),\n    ...(context.traceIds ? { traceIds: [...context.traceIds] } : {}),\n    ...(context.baggage ? { baggage: cloneContextValue(context.baggage) } : {}),\n    ...(context.tags ? { tags: [...context.tags] } : {}),\n    ...(context.context ? { context: cloneContextValue(context.context) } : {}),\n    ...(context.meta ? { meta: cloneContextValue(context.meta) } : {}),\n""",
)

write_exact(
    "tests/context-deep-snapshot.test.mjs",
    r"""import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureLogContext,
  getLogContext,
  runWithCapturedLogContext,
  runWithLogContext,
} from '../dist/context.js';
import {
  captureExecutionLogContext,
  getExecutionLogContext,
  runWithCapturedExecutionLogContext,
  runWithExecutionLogContext,
} from '../dist/execution-context.js';

test('captured base context deeply isolates caller-owned nested values', () => {
  const input = {
    profile: { roles: ['admin'], preferences: { locale: 'en' } },
  };
  let captured;
  runWithLogContext({ fields: { input } }, () => {
    captured = captureLogContext();
  });
  input.profile.roles[0] = 'mutated';
  input.profile.preferences.locale = 'xx';

  runWithCapturedLogContext(captured, () => {
    const seen = getLogContext().fields.input;
    assert.deepEqual(seen, {
      profile: { roles: ['admin'], preferences: { locale: 'en' } },
    });
    seen.profile.roles.push('reader');
  });

  runWithCapturedLogContext(captured, () => {
    assert.deepEqual(getLogContext().fields.input.profile.roles, ['admin']);
  });
  assert.equal(getLogContext(), undefined);
});

test('execution context snapshot isolates nested fields, baggage, context and meta', () => {
  const fields = { nested: { count: 1 } };
  const context = [{ request: { id: 'r-1' } }];
  const meta = [{ attempt: { value: 2 } }];
  let captured;
  runWithExecutionLogContext(
    { requestId: 'r-1', fields, baggage: { tenant: 'alpha' }, context, meta },
    () => { captured = captureExecutionLogContext(); },
  );

  fields.nested.count = 99;
  context[0].request.id = 'mutated';
  meta[0].attempt.value = 99;

  runWithCapturedExecutionLogContext(captured, () => {
    const seen = getExecutionLogContext();
    assert.equal(seen.fields.nested.count, 1);
    assert.equal(seen.context[0].request.id, 'r-1');
    assert.equal(seen.meta[0].attempt.value, 2);
  });
  assert.equal(getExecutionLogContext(), undefined);
});

test('rejection, absent capture, and high-concurrency reuse restore exact frames', async () => {
  await assert.rejects(
    runWithLogContext({ traceId: 'failing' }, async () => {
      await Promise.resolve();
      assert.equal(getLogContext().traceId, 'failing');
      throw new Error('expected');
    }),
    /expected/,
  );
  assert.equal(getLogContext(), undefined);

  const absent = captureLogContext();
  runWithLogContext({ traceId: 'outer' }, () => {
    runWithCapturedLogContext(absent, () => assert.equal(getLogContext(), undefined));
    assert.equal(getLogContext().traceId, 'outer');
  });

  const results = await Promise.all(
    Array.from({ length: 250 }, (_, index) =>
      runWithLogContext(
        { traceId: `trace-${index}`, fields: { nested: { index } } },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, index % 7));
          const captured = captureLogContext();
          await Promise.resolve();
          return runWithCapturedLogContext(captured, () => ({
            traceId: getLogContext().traceId,
            index: getLogContext().fields.nested.index,
          }));
        },
      ),
    ),
  );
  for (let index = 0; index < results.length; index += 1) {
    assert.deepEqual(results[index], { traceId: `trace-${index}`, index });
  }
  assert.equal(getLogContext(), undefined);
});
""",
)

# ---------------------------------------------------------------------------
# Python: represent explicit zero trace flags and pressure cancellation/thread
# handoff. Python already deep-copies maps via copy.deepcopy.
# ---------------------------------------------------------------------------
replace_once(
    "sdk/python/src/next_loggers/context.py",
    """    trace_flags: int = 0\n    trace_state: str = \"\"\n""",
    """    trace_flags: int = 0\n    trace_flags_set: bool = False\n    trace_state: str = \"\"\n""",
)
replace_once(
    "sdk/python/src/next_loggers/context.py",
    """            trace_flags=max(0, min(255, int(self.trace_flags))),\n            trace_state=str(self.trace_state or \"\")[:512],\n""",
    """            trace_flags=max(0, min(255, int(self.trace_flags))),\n            trace_flags_set=bool(\n                self.trace_flags_set or self.trace_flags != 0 or self.trace_id or self.span_id\n            ),\n            trace_state=str(self.trace_state or \"\")[:512],\n""",
)
replace_once(
    "sdk/python/src/next_loggers/context.py",
    """    outer = outer.snapshot()\n    inner = inner.snapshot()\n    logged_in_user = dict(outer.logged_in_user)\n""",
    """    outer = outer.snapshot()\n    inner = inner.snapshot()\n    inner_has_trace_flags = bool(\n        inner.trace_flags_set or inner.trace_id or inner.span_id\n    )\n    logged_in_user = dict(outer.logged_in_user)\n""",
)
replace_once(
    "sdk/python/src/next_loggers/context.py",
    """        trace_flags=(\n            inner.trace_flags\n            if inner.trace_id or inner.span_id or inner.trace_flags\n            else outer.trace_flags\n        ),\n        trace_state=inner.trace_state or outer.trace_state,\n""",
    """        trace_flags=(inner.trace_flags if inner_has_trace_flags else outer.trace_flags),\n        trace_flags_set=(inner_has_trace_flags or outer.trace_flags_set),\n        trace_state=inner.trace_state or outer.trace_state,\n""",
)
write_exact(
    "sdk/python/tests/test_context_adversarial.py",
    r'''import asyncio
import concurrent.futures
import unittest

from next_loggers.context import (
    LogContext,
    capture_log_context_callable,
    get_log_context,
    log_context,
    merge_log_context,
    run_with_log_context_async,
)


class ContextAdversarialTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_zero_trace_flags_override_sampled_parent(self) -> None:
        outer = LogContext(trace_id="outer", trace_flags=1, trace_flags_set=True)
        inner = LogContext(trace_flags=0, trace_flags_set=True)
        merged = merge_log_context(outer, inner)
        self.assertEqual(0, merged.trace_flags)
        self.assertTrue(merged.trace_flags_set)
        self.assertEqual("outer", merged.trace_id)

    async def test_cancelled_scope_restores_parent_and_does_not_leak(self) -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def work() -> None:
            entered.set()
            await release.wait()

        task = asyncio.create_task(
            run_with_log_context_async(LogContext(trace_id="cancelled"), work)
        )
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual("", get_log_context().trace_id)

    async def test_explicit_executor_capture_and_unwrapped_absence(self) -> None:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            with log_context(LogContext(trace_id="captured")):
                wrapped = capture_log_context_callable(
                    lambda: get_log_context().trace_id
                )
                wrapped_result = await asyncio.get_running_loop().run_in_executor(
                    executor, wrapped
                )
                plain_result = await asyncio.get_running_loop().run_in_executor(
                    executor, lambda: get_log_context().trace_id
                )
            self.assertEqual("captured", wrapped_result)
            self.assertEqual("", plain_result)

    async def test_nested_values_are_deep_snapshots(self) -> None:
        fields = {"profile": {"roles": ["admin"]}}
        value = LogContext(fields=fields).snapshot()
        fields["profile"]["roles"][0] = "mutated"
        self.assertEqual(["admin"], value.fields["profile"]["roles"])


if __name__ == "__main__":
    unittest.main()
''',
)

# ---------------------------------------------------------------------------
# Go: recursively clone JSON-like map/slice values used by context snapshots.
# ---------------------------------------------------------------------------
replace_once(
    "sdk/go/logger.go",
    """func cloneMap(source map[string]any) map[string]any {\n\ttarget := make(map[string]any, len(source))\n\tfor key, value := range source {\n\t\ttarget[key] = value\n\t}\n\treturn target\n}\n""",
    """func cloneValue(source any) any {\n\tswitch value := source.(type) {\n\tcase map[string]any:\n\t\treturn cloneMap(value)\n\tcase map[string]string:\n\t\treturn cloneStringMap(value)\n\tcase []any:\n\t\treturn cloneAnySlice(value)\n\tcase []map[string]any:\n\t\treturn cloneUserList(value)\n\tcase []string:\n\t\treturn append([]string(nil), value...)\n\tcase []byte:\n\t\treturn append([]byte(nil), value...)\n\tdefault:\n\t\treturn source\n\t}\n}\n\nfunc cloneAnySlice(source []any) []any {\n\tif source == nil {\n\t\treturn nil\n\t}\n\ttarget := make([]any, len(source))\n\tfor index, value := range source {\n\t\ttarget[index] = cloneValue(value)\n\t}\n\treturn target\n}\n\nfunc cloneMap(source map[string]any) map[string]any {\n\tif source == nil {\n\t\treturn nil\n\t}\n\ttarget := make(map[string]any, len(source))\n\tfor key, value := range source {\n\t\ttarget[key] = cloneValue(value)\n\t}\n\treturn target\n}\n""",
)
replace_once(
    "sdk/go/context.go",
    """\tvalue.Context = append([]any(nil), value.Context...)\n\tvalue.Meta = append([]any(nil), value.Meta...)\n""",
    """\tvalue.Context = cloneAnySlice(value.Context)\n\tvalue.Meta = cloneAnySlice(value.Meta)\n""",
)
replace_once(
    "sdk/go/context.go",
    """\tfor key, value := range patch.LoggedInUser {\n\t\tmerged.LoggedInUser[key] = value\n\t}\n""",
    """\tfor key, value := range patch.LoggedInUser {\n\t\tmerged.LoggedInUser[key] = cloneValue(value)\n\t}\n""",
)
replace_once(
    "sdk/go/context.go",
    """\tfor key, value := range patch.Fields {\n\t\tmerged.Fields[key] = value\n\t}\n""",
    """\tfor key, value := range patch.Fields {\n\t\tmerged.Fields[key] = cloneValue(value)\n\t}\n""",
)
replace_once(
    "sdk/go/context.go",
    """\tmerged.Context = append(merged.Context, patch.Context...)\n\tmerged.Meta = append(merged.Meta, patch.Meta...)\n""",
    """\tmerged.Context = append(merged.Context, cloneAnySlice(patch.Context)...)\n\tmerged.Meta = append(merged.Meta, cloneAnySlice(patch.Meta)...)\n""",
)
write_exact(
    "sdk/go/context_deep_snapshot_test.go",
    r'''package nextloggers

import (
	"context"
	"sync"
	"testing"
)

func TestLogContextDeepSnapshotDoesNotAliasCallerOrReader(t *testing.T) {
	input := map[string]any{
		"profile": map[string]any{"roles": []any{"admin"}},
	}
	ctx := WithLogContext(context.Background(), LogContext{
		Fields:  map[string]any{"input": input},
		Context: []any{map[string]any{"request": map[string]any{"id": "r-1"}}},
	})
	input["profile"].(map[string]any)["roles"].([]any)[0] = "mutated"

	first, ok := LogContextFrom(ctx)
	if !ok {
		t.Fatal("context missing")
	}
	roles := first.Fields["input"].(map[string]any)["profile"].(map[string]any)["roles"].([]any)
	if roles[0] != "admin" {
		t.Fatalf("caller mutation leaked into stored snapshot: %#v", roles)
	}
	roles[0] = "reader-mutated"
	first.Context[0].(map[string]any)["request"].(map[string]any)["id"] = "reader-mutated"

	second, _ := LogContextFrom(ctx)
	secondRoles := second.Fields["input"].(map[string]any)["profile"].(map[string]any)["roles"].([]any)
	if secondRoles[0] != "admin" {
		t.Fatalf("reader mutation leaked back into stored snapshot: %#v", secondRoles)
	}
	requestID := second.Context[0].(map[string]any)["request"].(map[string]any)["id"]
	if requestID != "r-1" {
		t.Fatalf("nested context mutation leaked: %v", requestID)
	}
}

func TestConcurrentDerivedContextsRemainIsolatedUnderRaceDetector(t *testing.T) {
	const count = 200
	parent := WithLogContext(context.Background(), LogContext{
		Fields: map[string]any{"nested": map[string]any{"parent": true}},
	})
	var wait sync.WaitGroup
	wait.Add(count)
	failures := make(chan string, count)
	for index := 0; index < count; index++ {
		index := index
		go func() {
			defer wait.Done()
			child := WithLogContext(parent, LogContext{
				TraceID: "trace",
				Fields: map[string]any{
					"nested": map[string]any{"index": index},
				},
			})
			value, _ := LogContextFrom(child)
			nested := value.Fields["nested"].(map[string]any)
			if nested["index"] != index {
				failures <- "cross-request nested field leakage"
			}
		}()
	}
	wait.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
}
''',
)

# ---------------------------------------------------------------------------
# Java: deep immutable snapshots and explicit executor/virtual-thread handoff.
# ---------------------------------------------------------------------------
replace_once(
    "sdk/java/src/main/java/com/oresoftware/nextloggers/NextLoggers.java",
    """import java.util.concurrent.CopyOnWriteArrayList;\nimport java.util.function.Supplier;\n""",
    """import java.util.concurrent.Callable;\nimport java.util.concurrent.CopyOnWriteArrayList;\nimport java.util.function.Supplier;\n""",
)
replace_once(
    "sdk/java/src/main/java/com/oresoftware/nextloggers/NextLoggers.java",
    """  public static TraceContext currentContext() {\n    Deque<TraceContext> stack = CONTEXT.get();\n    return stack.isEmpty() ? null : stack.peek();\n  }\n\n  public static final class Scope implements AutoCloseable {\n""",
    """  public static TraceContext currentContext() {\n    Deque<TraceContext> stack = CONTEXT.get();\n    return stack.isEmpty() ? null : stack.peek();\n  }\n\n  /** Captures the current immutable frame for an explicit executor handoff. */\n  public static TraceContext captureContext() {\n    return currentContext();\n  }\n\n  private static <T> T callWithExactContext(TraceContext captured, Callable<T> task)\n      throws Exception {\n    Objects.requireNonNull(task, \"task\");\n    Deque<TraceContext> stack = CONTEXT.get();\n    Deque<TraceContext> previous = new ArrayDeque<>(stack);\n    stack.clear();\n    if (captured != null) stack.push(captured);\n    try {\n      return task.call();\n    } finally {\n      stack.clear();\n      stack.addAll(previous);\n      if (stack.isEmpty()) CONTEXT.remove();\n    }\n  }\n\n  /** Wraps a Runnable with the exact current frame, including captured absence. */\n  public static Runnable wrapContext(Runnable task) {\n    Objects.requireNonNull(task, \"task\");\n    TraceContext captured = captureContext();\n    return () -> {\n      try {\n        callWithExactContext(captured, () -> { task.run(); return null; });\n      } catch (RuntimeException | Error error) {\n        throw error;\n      } catch (Exception error) {\n        throw new RuntimeException(error);\n      }\n    };\n  }\n\n  /** Wraps a Callable with the exact current frame, including captured absence. */\n  public static <T> Callable<T> wrapContext(Callable<T> task) {\n    Objects.requireNonNull(task, \"task\");\n    TraceContext captured = captureContext();\n    return () -> callWithExactContext(captured, task);\n  }\n\n  public static final class Scope implements AutoCloseable {\n""",
)
replace_once(
    "sdk/java/src/main/java/com/oresoftware/nextloggers/NextLoggers.java",
    """  private static <K, V> Map<K, V> immutableCopy(Map<K, V> value) {\n    return value == null || value.isEmpty() ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(value));\n  }\n\n  private static <K, V> Map<K, V> mutableCopy(Map<K, V> value) {\n""",
    """  @SuppressWarnings(\"unchecked\")\n  private static <K, V> Map<K, V> immutableCopy(Map<K, V> value) {\n    if (value == null || value.isEmpty()) return Map.of();\n    Map<K, V> copy = new LinkedHashMap<>();\n    for (Map.Entry<K, V> entry : value.entrySet()) {\n      copy.put(entry.getKey(), (V) immutableValue(entry.getValue()));\n    }\n    return Collections.unmodifiableMap(copy);\n  }\n\n  private static Object immutableValue(Object value) {\n    if (value instanceof Map<?, ?> map) {\n      Map<Object, Object> copy = new LinkedHashMap<>();\n      for (Map.Entry<?, ?> entry : map.entrySet()) {\n        copy.put(entry.getKey(), immutableValue(entry.getValue()));\n      }\n      return Collections.unmodifiableMap(copy);\n    }\n    if (value instanceof Set<?> set) {\n      Set<Object> copy = new LinkedHashSet<>();\n      for (Object item : set) copy.add(immutableValue(item));\n      return Collections.unmodifiableSet(copy);\n    }\n    if (value instanceof Collection<?> collection) {\n      List<Object> copy = new ArrayList<>(collection.size());\n      for (Object item : collection) copy.add(immutableValue(item));\n      return Collections.unmodifiableList(copy);\n    }\n    if (value != null && value.getClass().isArray()) {\n      int length = java.lang.reflect.Array.getLength(value);\n      List<Object> copy = new ArrayList<>(length);\n      for (int index = 0; index < length; index++) {\n        copy.add(immutableValue(java.lang.reflect.Array.get(value, index)));\n      }\n      return Collections.unmodifiableList(copy);\n    }\n    return value;\n  }\n\n  private static <K, V> Map<K, V> mutableCopy(Map<K, V> value) {\n""",
)
write_exact(
    "sdk/java/src/test/java/com/oresoftware/nextloggers/NextLoggersContextExecutorTest.java",
    r'''package com.oresoftware.nextloggers;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicReference;

public final class NextLoggersContextExecutorTest {
  public static void main(String[] args) throws Exception {
    nestedValuesAreDeeplyImmutable();
    fixedThreadPoolUsesExplicitCaptureAndRestoresWorkerState();
    virtualThreadHandoffWhenAvailable();
  }

  private static void nestedValuesAreDeeplyImmutable() {
    Map<String, Object> nested = new LinkedHashMap<>();
    List<Object> roles = new ArrayList<>();
    roles.add("admin");
    nested.put("roles", roles);
    Map<String, Object> fields = new LinkedHashMap<>();
    fields.put("profile", nested);

    NextLoggers.TraceContext context = new NextLoggers.TraceContext(
        "trace", "span", 1, "", Map.of(), fields, List.of("request"));
    roles.set(0, "mutated");

    Map<?, ?> profile = (Map<?, ?>) context.fields().get("profile");
    List<?> capturedRoles = (List<?>) profile.get("roles");
    assert capturedRoles.equals(List.of("admin"));
    assertThrows(UnsupportedOperationException.class, () ->
        ((List<Object>) capturedRoles).add("reader"));
  }

  @SuppressWarnings("try")
  private static void fixedThreadPoolUsesExplicitCaptureAndRestoresWorkerState()
      throws Exception {
    ExecutorService executor = Executors.newSingleThreadExecutor();
    try {
      Future<String> first;
      Future<String> second;
      try (NextLoggers.Scope ignored = NextLoggers.withContext(
          new NextLoggers.TraceContext("first", "span-first", 1))) {
        first = executor.submit(NextLoggers.wrapContext(
            () -> NextLoggers.currentContext().traceId()));
      }
      try (NextLoggers.Scope ignored = NextLoggers.withContext(
          new NextLoggers.TraceContext("second", "span-second", 1))) {
        second = executor.submit(NextLoggers.wrapContext(
            () -> NextLoggers.currentContext().traceId()));
      }
      assert first.get().equals("first");
      assert second.get().equals("second");
      assert executor.submit(() -> NextLoggers.currentContext() == null).get();

      AtomicReference<NextLoggers.Scope> stale = new AtomicReference<>();
      executor.submit(() -> stale.set(NextLoggers.withContext(
          new NextLoggers.TraceContext("worker-stale", "span", 1)))).get();
      java.util.concurrent.Callable<Boolean> capturedAbsence = NextLoggers.wrapContext(
          () -> NextLoggers.currentContext() == null);
      assert executor.submit(capturedAbsence).get();
      assert executor.submit(() -> NextLoggers.currentContext().traceId()).get()
          .equals("worker-stale");
      executor.submit(() -> stale.get().close()).get();
    } finally {
      executor.shutdownNow();
    }
  }

  @SuppressWarnings("try")
  private static void virtualThreadHandoffWhenAvailable() throws Exception {
    Method startVirtualThread;
    try {
      startVirtualThread = Thread.class.getMethod("startVirtualThread", Runnable.class);
    } catch (NoSuchMethodException javaBefore21) {
      return;
    }
    AtomicReference<String> observed = new AtomicReference<>();
    Thread thread;
    try (NextLoggers.Scope ignored = NextLoggers.withContext(
        new NextLoggers.TraceContext("virtual", "span", 1))) {
      thread = (Thread) startVirtualThread.invoke(
          null,
          NextLoggers.wrapContext(() -> observed.set(
              NextLoggers.currentContext().traceId())));
    }
    thread.join();
    assert observed.get().equals("virtual");
    assert NextLoggers.currentContext() == null;
  }

  private static <T extends Throwable> T assertThrows(
      Class<T> type, ThrowingRunnable action) {
    try {
      action.run();
    } catch (Throwable error) {
      if (type.isInstance(error)) return type.cast(error);
      throw new AssertionError("unexpected exception type", error);
    }
    throw new AssertionError("expected " + type.getName());
  }

  @FunctionalInterface
  private interface ThrowingRunnable {
    void run() throws Exception;
  }
}
''',
)
replace_once(
    "sdk/java/test.sh",
    """java -ea -cp \"$out\" com.oresoftware.nextloggers.NextLoggersAdversarialTest\n""",
    """java -ea -cp \"$out\" com.oresoftware.nextloggers.NextLoggersAdversarialTest\njava -ea -cp \"$out\" com.oresoftware.nextloggers.NextLoggersContextExecutorTest\n""",
)

# ---------------------------------------------------------------------------
# Ruby: fiber-local dynamic scope, deep immutable Context values, and explicit
# capture/wrap helpers for child fibers and threads.
# ---------------------------------------------------------------------------
replace_once(
    "sdk/ruby/lib/oresoftware/next_loggers.rb",
    """    CONTEXT_KEY = :__oresoftware_next_loggers_context\n\n    Context = Struct.new(\n""",
    """    CONTEXT_KEY = :__oresoftware_next_loggers_context\n    CAPTURE_CURRENT = Object.new.freeze\n\n    def self.snapshot_context_value(value, seen = {})\n      case value\n      when nil, true, false, Numeric, Symbol\n        value\n      when String\n        value.dup.freeze\n      when Hash\n        identity = value.object_id\n        raise ArgumentError, \"context contains a cycle\" if seen[identity]\n        seen[identity] = true\n        copy = value.each_with_object({}) do |(key, item), out|\n          out[key.to_s.dup.freeze] = snapshot_context_value(item, seen)\n        end\n        seen.delete(identity)\n        copy.freeze\n      when Array\n        identity = value.object_id\n        raise ArgumentError, \"context contains a cycle\" if seen[identity]\n        seen[identity] = true\n        copy = value.map { |item| snapshot_context_value(item, seen) }\n        seen.delete(identity)\n        copy.freeze\n      else\n        begin\n          value.dup.freeze\n        rescue TypeError\n          value\n        end\n      end\n    end\n\n    Context = Struct.new(\n""",
)
replace_once(
    "sdk/ruby/lib/oresoftware/next_loggers.rb",
    """      def initialize(**values)\n        super\n        self.trace_flags = trace_flags.nil? ? 1 : Integer(trace_flags)\n        self.fields = (fields || {}).each_with_object({}) do |(key, value), out|\n          out[key.to_s] = value\n        end.freeze\n        self.tags = Array(tags).map(&:to_s).uniq.freeze\n        freeze\n      end\n""",
    """      def initialize(**values)\n        super\n        self.trace_id = trace_id.nil? ? nil : trace_id.to_s.dup.freeze\n        self.span_id = span_id.nil? ? nil : span_id.to_s.dup.freeze\n        self.trace_flags = trace_flags.nil? ? 1 : Integer(trace_flags)\n        self.trace_state = trace_state.nil? ? nil : trace_state.to_s.dup.freeze\n        self.fields = ORESoftware::NextLoggers.snapshot_context_value(fields || {})\n        self.tags = Array(tags).map { |tag| tag.to_s.dup.freeze }.uniq.freeze\n        freeze\n      end\n""",
)
replace_once(
    "sdk/ruby/lib/oresoftware/next_loggers.rb",
    """    def current_context\n      Thread.current.thread_variable_get(CONTEXT_KEY)\n    end\n\n    # Install context for the current thread and always restore the prior frame.\n    def with_context(context)\n      previous = current_context\n      Thread.current.thread_variable_set(CONTEXT_KEY, normalize_context(context))\n      yield\n    ensure\n      Thread.current.thread_variable_set(CONTEXT_KEY, previous)\n    end\n""",
    """    def current_context\n      Thread.current[CONTEXT_KEY]\n    end\n\n    # Thread#[] storage follows the logical Fiber, unlike thread variables which\n    # are shared by every Fiber multiplexed on the same worker thread.\n    def with_context(context)\n      previous = current_context\n      Thread.current[CONTEXT_KEY] = normalize_context(context)\n      yield\n    ensure\n      Thread.current[CONTEXT_KEY] = previous\n    end\n\n    # Capture an immutable frame for explicit child Fiber/thread handoff.\n    def capture_context\n      current_context\n    end\n\n    def run_with_captured_context(context = CAPTURE_CURRENT)\n      captured = context.equal?(CAPTURE_CURRENT) ? capture_context : normalize_context(context)\n      with_context(captured) { yield }\n    end\n\n    def wrap_context(context = CAPTURE_CURRENT, &block)\n      raise ArgumentError, \"block is required\" unless block\n\n      captured = context.equal?(CAPTURE_CURRENT) ? capture_context : normalize_context(context)\n      lambda do |*args, **kwargs, &nested|\n        with_context(captured) { block.call(*args, **kwargs, &nested) }\n      end\n    end\n""",
)
write_exact(
    "sdk/ruby/test/context_adversarial_test.rb",
    r'''# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/oresoftware/next_loggers"

class NextLoggersContextAdversarialTest < Minitest::Test
  NL = ORESoftware::NextLoggers

  def test_interleaved_fibers_keep_independent_dynamic_scopes
    observed = []
    first = Fiber.new do
      NL.with_context(trace_id: "first", fields: { tenant: { id: "a" } }) do
        observed << NL.current_context.trace_id
        Fiber.yield
        observed << NL.current_context.trace_id
      end
    end
    second = Fiber.new do
      NL.with_context(trace_id: "second", fields: { tenant: { id: "b" } }) do
        observed << NL.current_context.trace_id
        Fiber.yield
        observed << NL.current_context.trace_id
      end
    end

    first.resume
    second.resume
    first.resume
    second.resume

    assert_equal %w[first second first second], observed
    assert_nil NL.current_context
  end

  def test_context_deeply_snapshots_nested_values_and_strings
    trace = +"trace-original"
    roles = ["admin"]
    fields = { profile: { roles: roles } }
    context = NL::Context.new(trace_id: trace, fields: fields, tags: ["request"])

    trace.replace("trace-mutated")
    roles[0] = "mutated"
    fields[:profile][:new_value] = true

    assert_equal "trace-original", context.trace_id
    assert_equal ["admin"], context.fields.fetch("profile").fetch("roles")
    refute context.fields.fetch("profile").key?("new_value")
    assert_raises(FrozenError) do
      context.fields.fetch("profile").fetch("roles") << "reader"
    end
  end

  def test_explicit_capture_propagates_to_thread_and_plain_thread_stays_empty
    wrapped = nil
    NL.with_context(trace_id: "captured") do
      wrapped = NL.wrap_context { NL.current_context&.trace_id }
    end

    assert_equal "captured", Thread.new(&wrapped).value
    assert_nil Thread.new { NL.current_context }.value
    assert_nil NL.current_context
  end

  def test_captured_absence_masks_and_restores_an_outer_scope
    absent = NL.capture_context
    NL.with_context(trace_id: "outer") do
      seen = NL.run_with_captured_context(absent) { NL.current_context }
      assert_nil seen
      assert_equal "outer", NL.current_context.trace_id
    end
    assert_nil NL.current_context
  end
end
''',
)

print("async-context hardening patch applied")
